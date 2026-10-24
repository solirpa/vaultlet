//! End-to-end test of the backend on Tauri's mock runtime: every command the UI uses, the
//! Bitwarden import, external-change merging, and the full browser IPC protocol.

use std::path::Path;
use std::time::Duration;

use base64::Engine;
use crypto_box::aead::{Aead, AeadCore, OsRng};
use crypto_box::{Nonce, PublicKey, SalsaBox, SecretKey};
use interprocess::local_socket::tokio::{prelude::*, Stream};
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::Manager;
use vault_ipc::{read_frame, socket_name, write_frame};

use crate::state::AppState;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const B64URL: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;
const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../crates/vault-core/tests/fixtures/bitwarden.json");

fn invoke(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>, cmd: &str, args: Value) -> Result<Value, Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            // The origin the bundled frontend is served from, which the capability ACL checks.
            url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|b| b.deserialize::<Value>().unwrap())
}

fn ok(r: Result<Value, Value>) -> Value {
    match r {
        Ok(v) => v,
        Err(e) => panic!("command failed: {e}"),
    }
}

#[test]
fn backend_end_to_end() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::env::set_var("VAULTLET_CONFIG_DIR", root.join("config"));
    std::env::set_var("VAULTLET_DATA_DIR", root.join("data"));
    if cfg!(windows) {
        std::env::set_var("VAULTLET_SOCKET", format!("vaultlet-test-{}", std::process::id()));
    } else {
        std::env::set_var("VAULTLET_SOCKET", root.join("v.sock"));
    }

    let mut app = crate::configure(mock_builder()).build(mock_context(noop_assets())).unwrap();
    // The setup hook (state, IPC server, background tasks) runs on the first iteration.
    #[allow(deprecated)]
    app.run_iteration(|_, _| {});
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    let inv = |cmd: &str, args: Value| invoke(&webview, cmd, args);

    // --- first run --------------------------------------------------------------------------
    let st = ok(inv("vault_status", json!({})));
    assert_eq!(st["state"], "no-vault");

    let vault_path = root.join("cloud").join("Test.kdbx");
    ok(inv("vault_create", json!({ "path": vault_path, "password": "pw", "name": "Test" })));
    let st = ok(inv("vault_status", json!({})));
    assert_eq!(st["state"], "unlocked");
    assert_eq!(st["name"], "Test");
    assert!(vault_path.exists());
    assert!(ok(inv("items_list", json!({}))).as_array().unwrap().is_empty());

    // --- import ------------------------------------------------------------------------------
    let preview = ok(inv("import_bitwarden_preview", json!({ "path": FIXTURE })));
    assert_eq!(preview["items"], 6);
    assert_eq!(preview["needsPassword"], false);
    let imported = ok(inv("import_bitwarden", json!({ "path": FIXTURE })));
    assert_eq!(imported["imported"], 6);
    let items = ok(inv("items_list", json!({})));
    let items = items.as_array().unwrap();
    assert_eq!(items.len(), 6);
    let gh = items.iter().find(|i| i["title"] == "GitHub").unwrap();
    assert!(gh.get("password").is_none(), "summaries never carry passwords");
    assert_eq!(gh["hasTotp"], true);
    let gh_id = gh["id"].as_str().unwrap().to_string();

    let full = ok(inv("item_get", json!({ "id": gh_id })));
    assert_eq!(full["password"], "current-password");
    assert_eq!(full["urls"][1], "gist.github.com");
    let totp = ok(inv("totp_now", json!({ "id": gh_id })));
    assert_eq!(totp["code"].as_str().unwrap().len(), 6);

    // Encrypted export needs a password first.
    let enc = vault_core::import::encrypted::encrypt_export(
        &std::fs::read_to_string(FIXTURE).unwrap(),
        "export-pw",
        vault_core::import::encrypted::Kdf::Pbkdf2 { iterations: 1000 },
    )
    .unwrap();
    let enc_path = root.join("export.json");
    std::fs::write(&enc_path, enc).unwrap();
    let preview = ok(inv("import_bitwarden_preview", json!({ "path": enc_path })));
    assert_eq!(preview["needsPassword"], true);
    let err = inv("import_bitwarden", json!({ "path": enc_path, "password": "wrong" })).unwrap_err();
    assert_eq!(err["code"], "import-password");
    let r = ok(inv("import_bitwarden", json!({ "path": enc_path, "password": "export-pw" })));
    assert_eq!(r["imported"], 6);
    assert_eq!(ok(inv("items_list", json!({}))).as_array().unwrap().len(), 6, "re-import updates in place");

    // --- edit / folders / trash ------------------------------------------------------------
    let mut edited = full.clone();
    edited["title"] = json!("GitHub (work)");
    edited["password"] = json!("new-pw");
    let saved = ok(inv("item_save", json!({ "item": edited })));
    assert_eq!(saved["title"], "GitHub (work)");
    assert_eq!(ok(inv("item_get", json!({ "id": gh_id })))["password"], "new-pw");

    let folders = ok(inv("folders_list", json!({})));
    assert_eq!(folders.as_array().unwrap().len(), 3);
    let nf = ok(inv("folder_save", json!({ "folder": { "id": "", "name": "New folder", "parent": null } })));
    assert!(!nf["id"].as_str().unwrap().is_empty());
    assert_eq!(ok(inv("folders_list", json!({}))).as_array().unwrap().len(), 4);
    ok(inv("folder_delete", json!({ "id": nf["id"] })));

    let new_item = ok(inv(
        "item_save",
        json!({ "item": { "id": "", "kind": "login", "title": "Temp", "username": "t", "password": "p", "urls": ["https://temp.example"], "totp": null, "notes": "", "fields": [], "folder": null, "favorite": false, "tags": [], "created": "2026-01-01T00:00:00Z", "modified": "2026-01-01T00:00:00Z", "lastUsed": null, "deleted": false } }),
    ));
    let temp_id = new_item["id"].as_str().unwrap().to_string();
    ok(inv("item_delete", json!({ "id": temp_id })));
    assert_eq!(ok(inv("item_get", json!({ "id": temp_id })))["deleted"], true);
    ok(inv("item_restore", json!({ "id": temp_id })));
    assert_eq!(ok(inv("item_get", json!({ "id": temp_id })))["deleted"], false);
    ok(inv("item_touch", json!({ "id": temp_id })));
    ok(inv("item_purge", json!({ "id": temp_id })));
    assert_eq!(inv("item_get", json!({ "id": temp_id })).unwrap_err()["code"], "not-found");

    let pw = ok(inv("password_generate", json!({ "length": 20, "upper": true, "lower": true, "digits": true, "symbols": false })));
    assert_eq!(pw.as_str().unwrap().len(), 20);

    // --- settings & sync ----------------------------------------------------------------------
    let settings = ok(inv("settings_get", json!({})));
    assert_eq!(settings["vault"]["mode"], "folder");
    assert_eq!(settings["vault"]["path"].as_str().unwrap(), vault_path.to_string_lossy());
    ok(inv("settings_set", json!({ "settings": settings })));
    assert_eq!(ok(inv("vault_status", json!({})))["state"], "unlocked", "unchanged settings keep the vault open");
    let sync = ok(inv("sync_now", json!({})));
    assert_eq!(sync["state"], "idle");
    assert!(sync["lastSync"].is_string());
    ok(inv("cloud_folders_detect", json!({})));
    let apply = ok(inv("browser_integration_apply", json!({})));
    assert_eq!(apply.as_array().unwrap().len(), 5);
    assert!(apply.as_array().unwrap().iter().all(|r| r["ok"] == true));
    let wd = ok(inv("webdav_test", json!({ "url": "ftp://nope", "username": "u", "password": "p" })));
    assert_eq!(wd["ok"], false);

    // --- another device edits the file in the cloud folder ----------------------------------
    {
        let creds = vault_core::Credentials::password("pw");
        let bytes = std::fs::read(&vault_path).unwrap();
        let mut other = vault_core::Vault::open(&bytes, &creds).unwrap();
        other.upsert_item(vault_core::Item::new(vault_core::ItemKind::Login, "From device 2")).unwrap();
        std::thread::sleep(Duration::from_millis(1100)); // distinct mtime second
        let out = other.save(&creds).unwrap();
        vault_core::sync::atomic_write(&vault_path, &out).unwrap();
    }
    let sync = ok(inv("sync_now", json!({})));
    assert_eq!(sync["state"], "idle");
    let items = ok(inv("items_list", json!({})));
    assert!(items.as_array().unwrap().iter().any(|i| i["title"] == "From device 2"));
    // Our own edit (GitHub (work)) was merged back into the file.
    {
        let creds = vault_core::Credentials::password("pw");
        let disk = vault_core::Vault::open(&std::fs::read(&vault_path).unwrap(), &creds).unwrap();
        assert!(disk.items().iter().any(|i| i.title == "GitHub (work)"));
        assert!(disk.items().iter().any(|i| i.title == "From device 2"));
    }

    // --- browser IPC protocol ----------------------------------------------------------------
    let handle = app.handle().clone();
    let webview2 = webview.clone();
    let vault_path_for_ipc = vault_path.clone();
    tauri::async_runtime::block_on(async move {
        let client_sk = SecretKey::generate(&mut OsRng);
        let client_pk = client_sk.public_key();
        let client_id = "11111111-2222-4333-8444-555555555555";
        let mut conn = Stream::connect(socket_name().unwrap()).await.expect("connect to app socket");
        let hello = json!({ "type": "hello", "clientId": client_id, "publicKey": B64.encode(client_pk.as_bytes()), "clientName": "TestBrowser" });
        write_frame(&mut conn, hello.to_string().as_bytes()).await.unwrap();
        let reply: Value = serde_json::from_slice(&read_frame(&mut conn).await.unwrap().unwrap()).unwrap();
        assert_eq!(reply["type"], "hello");
        assert_eq!(reply["paired"], false);
        let app_pk_bytes = B64.decode(reply["publicKey"].as_str().unwrap()).unwrap();
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&app_pk_bytes);
        let sbox = SalsaBox::new(&PublicKey::from(arr), &client_sk);

        async fn call(conn: &mut Stream, sbox: &SalsaBox, client_id: &str, req: Value) -> Value {
            let nonce = SalsaBox::generate_nonce(&mut OsRng);
            let ct = sbox.encrypt(&nonce, req.to_string().as_bytes()).unwrap();
            let env = json!({ "clientId": client_id, "nonce": B64.encode(nonce), "payload": B64.encode(ct) });
            write_frame(conn, env.to_string().as_bytes()).await.unwrap();
            loop {
                let frame = read_frame(conn).await.unwrap().expect("app closed the connection");
                let env: Value = serde_json::from_slice(&frame).unwrap();
                let nonce = B64.decode(env["nonce"].as_str().unwrap()).unwrap();
                let payload = B64.decode(env["payload"].as_str().unwrap()).unwrap();
                let plain = sbox.decrypt(Nonce::from_slice(&nonce), payload.as_slice()).unwrap();
                let msg: Value = serde_json::from_slice(&plain).unwrap();
                if msg.get("action") == Some(&json!("event")) {
                    continue; // pushed events are not the answer we wait for
                }
                return msg;
            }
        }

        // Not paired yet: data requests are refused, status still answers.
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "1", "action": "get-logins", "url": "https://github.com" })).await;
        assert_eq!(r["code"], "not-paired");
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "2", "action": "status" })).await;
        assert_eq!(r["locked"], false);

        // Associate: the app asks the UI; approve it through the pairing_respond command.
        let state = handle.state::<AppState>();
        let approver = {
            let handle = handle.clone();
            let webview = webview2.clone();
            tauri::async_runtime::spawn(async move {
                for _ in 0..100 {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    let id = {
                        let st = handle.state::<AppState>();
                        let g = st.pairing.lock().await;
                        g.keys().next().cloned()
                    };
                    if let Some(id) = id {
                        tokio::task::spawn_blocking(move || {
                            ok(invoke(&webview, "pairing_respond", json!({ "requestId": id, "approve": true })));
                        })
                        .await
                        .unwrap();
                        return;
                    }
                }
                panic!("no pairing request appeared");
            })
        };
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "3", "action": "associate" })).await;
        assert_eq!(r["ok"], true, "{r}");
        approver.await.unwrap();
        assert_eq!(state.paired.lock().await.len(), 1);

        let r = call(&mut conn, &sbox, client_id, json!({ "id": "4", "action": "get-logins", "url": "https://gist.github.com/x" })).await;
        assert_eq!(r["ok"], true);
        let entries = r["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["title"], "GitHub (work)");
        assert_eq!(entries[0]["password"], "new-pw");
        assert_eq!(entries[0]["totp"], true);
        let entry_id = entries[0]["id"].as_str().unwrap().to_string();
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "5", "action": "get-totp", "entryId": entry_id })).await;
        assert_eq!(r["code"].as_str().unwrap().len(), 6);
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "6", "action": "touch", "entryId": entry_id })).await;
        assert_eq!(r["ok"], true);
        // Search by name / username / URL.
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "s1", "action": "search", "query": "octo" })).await;
        let titles: Vec<&str> = r["entries"].as_array().unwrap().iter().map(|e| e["title"].as_str().unwrap()).collect();
        assert_eq!(titles, vec!["GitHub (work)"]);
        assert!(r["entries"][0].get("password").is_none(), "search results carry no passwords");
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "s2", "action": "search", "query": "" })).await;
        assert!(r["entries"].as_array().unwrap().len() >= 3, "empty query lists logins");
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "l1", "action": "list" })).await;
        let all = r["entries"].as_array().unwrap();
        assert!(all.iter().all(|e| e.get("password").is_none()));
        let gh = all.iter().find(|e| e["title"] == "GitHub (work)").unwrap();
        assert_eq!(gh["favorite"], true);
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "g1", "action": "get-entry", "entryId": gh["id"] })).await;
        assert_eq!(r["entry"]["password"], "new-pw");
        assert_eq!(r["entry"]["urls"][1], "gist.github.com");
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "g2", "action": "get-entry", "entryId": "00000000-0000-0000-0000-000000000000" })).await;
        assert_eq!(r["code"], "not-found");

        // Save a brand-new login from a page, then update its password.
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "n1", "action": "save-login", "url": "https://login.newsite.example:8443/signin?next=/", "username": "me@new.example", "password": "first" })).await;
        assert_eq!(r["created"], true, "{r}");
        let new_id = r["entryId"].as_str().unwrap().to_string();
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "n2", "action": "get-logins", "url": "https://login.newsite.example:8443/" })).await;
        let e = &r["entries"][0];
        assert_eq!(e["title"], "login.newsite.example");
        assert_eq!(e["url"], "https://login.newsite.example:8443");
        assert_eq!(e["password"], "first");
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "n3", "action": "save-login", "url": "https://login.newsite.example:8443/", "username": "", "password": "second", "entryId": new_id })).await;
        assert_eq!(r["updated"], true, "{r}");
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "n4", "action": "get-logins", "url": "https://login.newsite.example:8443/" })).await;
        assert_eq!(r["entries"][0]["password"], "second");
        assert_eq!(r["entries"][0]["username"], "me@new.example", "empty username keeps the old one");
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "n5", "action": "save-login", "url": "https://x.example", "username": "u", "password": "p", "entryId": "00000000-0000-0000-0000-000000000000" })).await;
        assert_eq!(r["code"], "not-found");
        // It was persisted to disk.
        {
            let creds = vault_core::Credentials::password("pw");
            let disk = vault_core::Vault::open(&std::fs::read(&vault_path_for_ipc).unwrap(), &creds).unwrap();
            let saved = disk.items().into_iter().find(|i| i.title == "login.newsite.example").unwrap();
            assert_eq!(saved.password, "second");
        }

        // Passkeys: an entry imported by an older Vaultlet (Bitwarden GUID credential ID).
        let pk_key = p256::ecdsa::SigningKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
        {
            use p256::pkcs8::EncodePrivateKey;
            let pem = pk_key.to_pkcs8_pem(p256::pkcs8::LineEnding::LF).unwrap().to_string();
            let state = handle.state::<AppState>();
            let mut guard = state.vault.lock().await;
            let mut item = vault_core::Item::new(vault_core::ItemKind::Login, "AWS");
            item.fields = vec![
                vault_core::Field::new("KPEX_PASSKEY_USERNAME", "alice"),
                vault_core::Field::new("KPEX_PASSKEY_CREDENTIAL_ID", "e8d88789-e916-e196-e3ee-a5ae51df8b8b"),
                vault_core::Field::protected("KPEX_PASSKEY_PRIVATE_KEY_PEM", pem),
                vault_core::Field::new("KPEX_PASSKEY_RELYING_PARTY", "aws.amazon.com"),
            ];
            guard.as_mut().unwrap().vault.upsert_item(item).unwrap();
        }
        let origin = "https://us-east-1.signin.aws.amazon.com";
        let cred_id = "6NiHiekW4Zbj7qWuUd-Liw"; // the GUID's 16 bytes, base64url
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "p1", "action": "passkey-list", "origin": origin, "rpId": "aws.amazon.com" })).await;
        let entries = r["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["username"], "alice");
        assert_eq!(entries[0]["credentialId"], cred_id);
        let entry_id = entries[0]["entryId"].as_str().unwrap().to_string();
        // allowCredentials narrows the list.
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "p2", "action": "passkey-list", "origin": origin, "rpId": "aws.amazon.com", "allowCredentials": ["AQID"] })).await;
        assert!(r["entries"].as_array().unwrap().is_empty());
        // Another site cannot list or use it.
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "p3", "action": "passkey-list", "origin": "https://evil.example", "rpId": "aws.amazon.com" })).await;
        assert_eq!(r["ok"], false);
        let client_data_hash = [42u8; 32];
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "p4", "action": "passkey-sign", "origin": "https://evil.example", "rpId": "aws.amazon.com", "entryId": entry_id, "clientDataHash": B64URL.encode(client_data_hash) })).await;
        assert_eq!(r["ok"], false);
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "p5", "action": "passkey-sign", "origin": "https://evil.example", "rpId": "evil.example", "entryId": entry_id, "clientDataHash": B64URL.encode(client_data_hash) })).await;
        assert_eq!(r["code"], "not-found");
        // The real site gets a signature that verifies against the passkey's public key.
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "p6", "action": "passkey-sign", "origin": origin, "rpId": "aws.amazon.com", "entryId": entry_id, "clientDataHash": B64URL.encode(client_data_hash) })).await;
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(r["credentialId"], cred_id);
        let auth_data = B64URL.decode(r["authenticatorData"].as_str().unwrap()).unwrap();
        let sig = B64URL.decode(r["signature"].as_str().unwrap()).unwrap();
        {
            use p256::ecdsa::signature::Verifier;
            let mut signed = auth_data.clone();
            signed.extend_from_slice(&client_data_hash);
            let sig = p256::ecdsa::Signature::from_der(&sig).unwrap();
            p256::ecdsa::VerifyingKey::from(&pk_key).verify(&signed, &sig).expect("signature verifies");
        }

        let r = call(&mut conn, &sbox, client_id, json!({ "id": "7", "action": "lock" })).await;
        assert_eq!(r["ok"], true);
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "8", "action": "get-logins", "url": "https://github.com" })).await;
        assert_eq!(r["code"], "locked");
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "8b", "action": "search", "query": "git" })).await;
        assert_eq!(r["code"], "locked");
        let r = call(&mut conn, &sbox, client_id, json!({ "id": "9", "action": "unlock-request" })).await;
        assert_eq!(r["ok"], true);
    });

    // Locked by the browser; unlock again from the UI.
    assert_eq!(ok(inv("vault_status", json!({})))["state"], "locked");
    assert_eq!(inv("items_list", json!({})).unwrap_err()["code"], "other");
    assert_eq!(inv("vault_unlock", json!({ "password": "nope" })).unwrap_err()["code"], "invalid-key");
    ok(inv("vault_unlock", json!({ "password": "pw" })));
    assert_eq!(ok(inv("vault_status", json!({})))["state"], "unlocked");
    let paired = ok(inv("paired_browsers_list", json!({})));
    assert_eq!(paired[0]["name"], "TestBrowser");
    ok(inv("paired_browser_remove", json!({ "clientId": paired[0]["clientId"] })));
    assert!(ok(inv("paired_browsers_list", json!({}))).as_array().unwrap().is_empty());

    // A key-mismatch client is refused.
    tauri::async_runtime::block_on(async {
        let state = app.handle().state::<AppState>();
        state.paired.lock().await.push(crate::state::PairedBrowser {
            client_id: "known".into(),
            public_key: B64.encode([7u8; 32]),
            name: "Old".into(),
            paired_at: chrono::Utc::now(),
        });
        let mut conn = Stream::connect(socket_name().unwrap()).await.unwrap();
        let hello = json!({ "type": "hello", "clientId": "known", "publicKey": B64.encode([9u8; 32]), "clientName": "Evil" });
        write_frame(&mut conn, hello.to_string().as_bytes()).await.unwrap();
        let reply: Value = serde_json::from_slice(&read_frame(&mut conn).await.unwrap().unwrap()).unwrap();
        assert_eq!(reply["code"], "key-mismatch");
    });

    // --- change master password ---------------------------------------------------------------
    assert_eq!(inv("vault_change_password", json!({ "current": "bad", "next": "pw2" })).unwrap_err()["code"], "invalid-key");
    ok(inv("vault_change_password", json!({ "current": "pw", "next": "pw2" })));
    ok(inv("vault_lock", json!({})));
    assert_eq!(inv("vault_unlock", json!({ "password": "pw" })).unwrap_err()["code"], "invalid-key");
    ok(inv("vault_unlock", json!({ "password": "pw2" })));

    // Settings file and paired list were persisted.
    assert!(Path::new(&root.join("config").join("settings.json")).exists());
    assert!(Path::new(&root.join("config").join("paired.json")).exists());
}
