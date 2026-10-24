//! Local socket server for the browser native messaging host (architecture doc section 6).
//!
//! Frames are `[u32 LE length][JSON]`. The first frame is a plaintext `hello`; everything after
//! that is an envelope `{ clientId, nonce, payload }` sealed with NaCl box (X25519 +
//! XSalsa20-Poly1305) between the extension's key pair and the app's key pair.

use std::time::Duration;

use base64::Engine;
use chrono::Utc;
use crypto_box::aead::{Aead, AeadCore, OsRng};
use crypto_box::{Nonce, PublicKey, SalsaBox, SecretKey};
use interprocess::local_socket::tokio::{prelude::*, Listener, Stream};
use interprocess::local_socket::ListenerOptions;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;
use vault_core::matching::match_items;
use vault_core::passkey;
use vault_ipc::{read_frame, socket_name, write_frame};

use crate::autolock;
use crate::commands::focus_main_window;
use crate::state::{AppState, PairedBrowser, PushEvent};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const B64URL: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;
const PAIRING_TIMEOUT: Duration = Duration::from_secs(120);

/// Load or create the app's X25519 secret key. Kept in a 0600 file rather than the keychain:
/// on macOS every rebuilt (re-signed) binary would otherwise pop a keychain prompt that blocks
/// the event loop during setup, leaving a white window.
pub fn load_or_create_secret(secrets: &crate::secrets::Secrets) -> SecretKey {
    const KEY: &str = "app-secret-key";
    if let Some(b64) = secrets.get_file(KEY) {
        if let Ok(bytes) = B64.decode(b64.trim()) {
            if bytes.len() == 32 {
                let mut arr = [0u8; 32];
                arr.copy_from_slice(&bytes);
                return SecretKey::from(arr);
            }
        }
    }
    let sk = SecretKey::generate(&mut OsRng);
    let _ = secrets.set_file(KEY, &B64.encode(sk.to_bytes()));
    sk
}

pub fn spawn<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let name = match socket_name() {
            Ok(n) => n,
            Err(e) => {
                tracing::error!("cannot build socket name: {e}");
                return;
            }
        };
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(vault_ipc::socket_path());
        }
        let listener = match ListenerOptions::new().name(name).create_tokio() {
            Ok(l) => l,
            Err(e) => {
                tracing::error!("cannot listen on local socket: {e}");
                return;
            }
        };
        tracing::info!("browser IPC listening");
        serve(app, listener).await;
    });
}

async fn serve<R: Runtime>(app: AppHandle<R>, listener: Listener) {
    loop {
        match listener.accept().await {
            Ok(conn) => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = handle_connection(app, conn).await {
                        tracing::debug!("browser connection ended: {e}");
                    }
                });
            }
            Err(e) => {
                tracing::warn!("accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

struct Session {
    client_id: String,
    client_name: String,
    client_pk: PublicKey,
    paired: bool,
}

async fn handle_connection<R: Runtime>(app: AppHandle<R>, conn: Stream) -> std::io::Result<()> {
    let state = app.state::<AppState>();
    let (mut rx, tx) = conn.split();

    // Writer task: everything that goes to the browser passes through this channel.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let writer = tauri::async_runtime::spawn(async move {
        let mut tx = tx;
        while let Some(frame) = out_rx.recv().await {
            if write_frame(&mut tx, &frame).await.is_err() {
                break;
            }
        }
        let _ = tx.shutdown().await;
    });

    // Handshake.
    let Some(first) = read_frame(&mut rx).await? else {
        return Ok(());
    };
    let hello: Value = serde_json::from_slice(&first).map_err(std::io::Error::other)?;
    if hello.get("type").and_then(Value::as_str) != Some("hello") {
        let _ = out_tx.send(json!({ "type": "error", "code": "expected-hello" }).to_string().into_bytes());
        return Ok(());
    }
    let client_id = hello.get("clientId").and_then(Value::as_str).unwrap_or("").to_string();
    let client_name = hello.get("clientName").and_then(Value::as_str).unwrap_or("Browser").to_string();
    let pk_b64 = hello.get("publicKey").and_then(Value::as_str).unwrap_or("").to_string();
    let pk_bytes = B64.decode(&pk_b64).ok().filter(|b| b.len() == 32);
    let (Some(pk_bytes), false) = (pk_bytes, client_id.is_empty()) else {
        let _ = out_tx.send(json!({ "type": "error", "code": "bad-hello" }).to_string().into_bytes());
        return Ok(());
    };
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&pk_bytes);
    let client_pk = PublicKey::from(arr);

    let paired = {
        let list = state.paired.lock().await;
        match list.iter().find(|p| p.client_id == client_id) {
            Some(p) if p.public_key == pk_b64 => true,
            Some(_) => {
                let _ = out_tx.send(json!({ "type": "error", "code": "key-mismatch" }).to_string().into_bytes());
                drop(out_tx);
                let _ = writer.await;
                return Ok(());
            }
            None => false,
        }
    };
    let app_pk = state.app_secret.public_key();
    let _ = out_tx.send(
        json!({ "type": "hello", "publicKey": B64.encode(app_pk.as_bytes()), "paired": paired, "version": env!("CARGO_PKG_VERSION") })
            .to_string()
            .into_bytes(),
    );

    let mut session = Session { client_id, client_name, client_pk, paired };
    let sbox = SalsaBox::new(&session.client_pk, &state.app_secret);
    let mut events = state.push.subscribe();

    loop {
        tokio::select! {
            frame = read_frame(&mut rx) => {
                let Some(frame) = frame? else { break };
                let Ok(env) = serde_json::from_slice::<Value>(&frame) else { continue };
                let Some(plain) = open_envelope(&sbox, &env) else {
                    let _ = out_tx.send(json!({ "type": "error", "code": "bad-envelope" }).to_string().into_bytes());
                    continue;
                };
                let Ok(req) = serde_json::from_slice::<Value>(&plain) else { continue };
                let resp = handle_request(&app, &mut session, &req).await;
                if let Some(frame) = seal_envelope(&sbox, &session.client_id, &resp) {
                    let _ = out_tx.send(frame);
                }
            }
            ev = events.recv() => {
                match ev {
                    Ok(ev) => {
                        if session.paired {
                            let msg = json!({ "action": "event", "event": push_name(ev) });
                            if let Some(frame) = seal_envelope(&sbox, &session.client_id, &msg) {
                                let _ = out_tx.send(frame);
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }
    drop(out_tx);
    let _ = writer.await;
    Ok(())
}

/// Listing view sent to the popup: no password.
fn login_summary(i: &vault_core::Item) -> Value {
    json!({
        "id": i.id.to_string(),
        "title": i.title,
        "username": i.username,
        "totp": i.has_totp(),
        "url": i.urls.first().cloned().unwrap_or_default(),
        "favorite": i.favorite,
    })
}

fn login_entry(i: &vault_core::Item) -> Value {
    json!({
        "id": i.id.to_string(),
        "title": i.title,
        "username": i.username,
        "password": i.password,
        "totp": i.has_totp(),
        "url": i.urls.first().cloned().unwrap_or_default(),
        "passkey": i.fields.iter().any(|f| f.name.starts_with("KPEX_PASSKEY_")),
    })
}

/// `https://accounts.example.com:8443/login?x` → (`https://accounts.example.com:8443`, `accounts.example.com`).
fn origin_and_host(page: &str) -> (String, String) {
    match url::Url::parse(page) {
        Ok(u) if u.host_str().is_some() => {
            let host = u.host_str().unwrap_or_default().to_string();
            let origin = u.origin().ascii_serialization();
            (origin, host)
        }
        _ => (String::new(), page.to_string()),
    }
}

fn push_name(ev: PushEvent) -> &'static str {
    ev.wire_name()
}

fn open_envelope(sbox: &SalsaBox, env: &Value) -> Option<Vec<u8>> {
    let nonce = B64.decode(env.get("nonce")?.as_str()?).ok()?;
    let payload = B64.decode(env.get("payload")?.as_str()?).ok()?;
    if nonce.len() != 24 {
        return None;
    }
    sbox.decrypt(Nonce::from_slice(&nonce), payload.as_slice()).ok()
}

fn seal_envelope(sbox: &SalsaBox, client_id: &str, msg: &Value) -> Option<Vec<u8>> {
    let nonce = SalsaBox::generate_nonce(&mut OsRng);
    let ct = sbox.encrypt(&nonce, msg.to_string().as_bytes()).ok()?;
    Some(json!({ "clientId": client_id, "nonce": B64.encode(nonce), "payload": B64.encode(ct) }).to_string().into_bytes())
}

fn err(id: &Value, code: &str, message: &str) -> Value {
    json!({ "id": id, "ok": false, "code": code, "message": message })
}

async fn handle_request<R: Runtime>(app: &AppHandle<R>, session: &mut Session, req: &Value) -> Value {
    let state = app.state::<AppState>();
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let action = req.get("action").and_then(Value::as_str).unwrap_or("");

    if action == "associate" {
        if session.paired {
            return json!({ "id": id, "ok": true });
        }
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<bool>();
        state.pairing.lock().await.insert(request_id.clone(), tx);
        let _ = app.emit("pairing:request", json!({ "requestId": request_id, "clientName": session.client_name }));
        focus_main_window(app);
        let approved = matches!(tokio::time::timeout(PAIRING_TIMEOUT, rx).await, Ok(Ok(true)));
        state.pairing.lock().await.remove(&request_id);
        if !approved {
            return err(&id, "rejected", "pairing was not approved");
        }
        {
            let mut list = state.paired.lock().await;
            list.retain(|p| p.client_id != session.client_id);
            list.push(PairedBrowser {
                client_id: session.client_id.clone(),
                public_key: B64.encode(session.client_pk.as_bytes()),
                name: session.client_name.clone(),
                paired_at: Utc::now(),
            });
        }
        let _ = state.save_paired().await;
        session.paired = true;
        return json!({ "id": id, "ok": true });
    }

    if action == "status" {
        let guard = state.vault.lock().await;
        return match guard.as_ref() {
            Some(u) => json!({ "id": id, "ok": true, "locked": false, "vaultName": u.vault.name(), "paired": session.paired }),
            None => json!({ "id": id, "ok": true, "locked": true, "paired": session.paired }),
        };
    }

    if !session.paired {
        return err(&id, "not-paired", "this browser is not paired with Vaultlet");
    }

    match action {
        "get-logins" => {
            let url = req.get("url").and_then(Value::as_str).unwrap_or("");
            state.touch_activity().await;
            let guard = state.vault.lock().await;
            let Some(u) = guard.as_ref() else {
                return err(&id, "locked", "vault is locked");
            };
            let items = u.vault.items();
            let entries: Vec<Value> = match_items(&items, url)
                .into_iter()
                .filter(|i| i.kind == vault_core::ItemKind::Login)
                .map(login_entry)
                .collect();
            json!({ "id": id, "ok": true, "entries": entries })
        }
        "search" => {
            let query = req.get("query").and_then(Value::as_str).unwrap_or("").trim().to_lowercase();
            state.touch_activity().await;
            let guard = state.vault.lock().await;
            let Some(u) = guard.as_ref() else {
                return err(&id, "locked", "vault is locked");
            };
            let mut hits: Vec<vault_core::Item> = u
                .vault
                .items()
                .into_iter()
                .filter(|i| i.kind == vault_core::ItemKind::Login && !i.deleted)
                .filter(|i| {
                    query.is_empty()
                        || i.title.to_lowercase().contains(&query)
                        || i.username.to_lowercase().contains(&query)
                        || i.urls.iter().any(|u| u.to_lowercase().contains(&query))
                })
                .collect();
            hits.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
            let entries: Vec<Value> = hits.iter().take(50).map(login_summary).collect();
            json!({ "id": id, "ok": true, "entries": entries })
        }
        "list" => {
            state.touch_activity().await;
            let guard = state.vault.lock().await;
            let Some(u) = guard.as_ref() else {
                return err(&id, "locked", "vault is locked");
            };
            let mut all: Vec<vault_core::Item> = u
                .vault
                .items()
                .into_iter()
                .filter(|i| i.kind == vault_core::ItemKind::Login && !i.deleted)
                .collect();
            all.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
            let entries: Vec<Value> = all.iter().map(login_summary).collect();
            json!({ "id": id, "ok": true, "entries": entries })
        }
        "get-entry" => {
            let entry_id = req.get("entryId").and_then(Value::as_str).unwrap_or("");
            let Ok(uuid) = Uuid::parse_str(entry_id) else {
                return err(&id, "not-found", "bad entry id");
            };
            state.touch_activity().await;
            let guard = state.vault.lock().await;
            let Some(u) = guard.as_ref() else {
                return err(&id, "locked", "vault is locked");
            };
            match u.vault.item(uuid).filter(|i| i.kind == vault_core::ItemKind::Login && !i.deleted) {
                Some(i) => {
                    let mut e = login_entry(&i);
                    e["urls"] = json!(i.urls);
                    e["notes"] = json!(i.notes);
                    e["favorite"] = json!(i.favorite);
                    json!({ "id": id, "ok": true, "entry": e })
                }
                None => err(&id, "not-found", "no such entry"),
            }
        }
        "save-login" => {
            let page = req.get("url").and_then(Value::as_str).unwrap_or("");
            let username = req.get("username").and_then(Value::as_str).unwrap_or("").to_string();
            let password = req.get("password").and_then(Value::as_str).unwrap_or("").to_string();
            let title = req.get("title").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()).map(String::from);
            let entry_id = req.get("entryId").and_then(Value::as_str).filter(|s| !s.is_empty());
            if password.is_empty() {
                return err(&id, "invalid-argument", "password is empty");
            }
            state.touch_activity().await;
            let result = {
                let mut guard = state.vault.lock().await;
                let Some(u) = guard.as_mut() else {
                    return err(&id, "locked", "vault is locked");
                };
                let outcome = match entry_id {
                    Some(eid) => {
                        let Ok(uuid) = Uuid::parse_str(eid) else {
                            return err(&id, "not-found", "bad entry id");
                        };
                        let Some(mut item) = u.vault.item(uuid) else {
                            return err(&id, "not-found", "no such entry");
                        };
                        if !username.is_empty() {
                            item.username = username;
                        }
                        item.password = password;
                        u.vault.upsert_item(item).map(|i| (i.id, false))
                    }
                    None => {
                        let (origin, host) = origin_and_host(page);
                        let mut item = vault_core::Item::new(vault_core::ItemKind::Login, title.unwrap_or_else(|| host.clone()));
                        item.username = username;
                        item.password = password;
                        if !origin.is_empty() {
                            item.urls = vec![origin];
                        }
                        u.vault.upsert_item(item).map(|i| (i.id, true))
                    }
                };
                match outcome {
                    Ok(r) => match crate::store::write_vault(u).await {
                        Ok(()) => Ok(r),
                        Err(e) => Err(e),
                    },
                    Err(e) => Err(e),
                }
            };
            match result {
                Ok((entry, created)) => {
                    let _ = app.emit("items:changed", ());
                    state.push(PushEvent::ItemsChanged);
                    if state.settings.lock().await.vault.mode == crate::settings::SyncMode::Webdav {
                        crate::store::sync_in_background(app);
                    }
                    if created {
                        json!({ "id": id, "ok": true, "entryId": entry.to_string(), "created": true })
                    } else {
                        json!({ "id": id, "ok": true, "entryId": entry.to_string(), "updated": true })
                    }
                }
                Err(e) => err(&id, e.code(), &e.to_string()),
            }
        }
        "get-icon" => {
            let host = req.get("host").and_then(Value::as_str).unwrap_or("").to_string();
            if !state.settings.lock().await.ui.site_icons {
                return json!({ "id": id, "ok": true, "dataUrl": null });
            }
            let icon = state.icons.get(&host).await;
            json!({ "id": id, "ok": true, "dataUrl": icon })
        }
        "get-totp" => {
            let entry_id = req.get("entryId").and_then(Value::as_str).unwrap_or("");
            let Ok(uuid) = Uuid::parse_str(entry_id) else {
                return err(&id, "not-found", "bad entry id");
            };
            let guard = state.vault.lock().await;
            let Some(u) = guard.as_ref() else {
                return err(&id, "locked", "vault is locked");
            };
            let Some(item) = u.vault.item(uuid) else {
                return err(&id, "not-found", "no such entry");
            };
            let Some(secret) = item.totp.as_deref() else {
                return err(&id, "no-totp", "entry has no TOTP");
            };
            match vault_core::totp::generate(secret, std::time::SystemTime::now()) {
                Ok(c) => json!({ "id": id, "ok": true, "code": c.code, "remaining": c.remaining, "period": c.period }),
                Err(e) => err(&id, "totp", &e.to_string()),
            }
        }
        // Passkeys: the extension sends the page origin (taken from the browser, not the page)
        // and the RP ID the page asked for. Both actions re-check that the origin may act for
        // that RP, so a paired extension cannot get assertions for other sites.
        "passkey-list" => {
            let origin = req.get("origin").and_then(Value::as_str).unwrap_or("");
            let rp_id = req.get("rpId").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
            if !passkey::rp_id_allowed(&rp_id, origin) {
                return err(&id, "invalid-argument", "RP ID is not valid for this origin");
            }
            let allowed: Vec<Vec<u8>> = req
                .get("allowCredentials")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).filter_map(passkey::decode_credential_id).collect())
                .unwrap_or_default();
            state.touch_activity().await;
            let guard = state.vault.lock().await;
            let Some(u) = guard.as_ref() else {
                return err(&id, "locked", "vault is locked");
            };
            let entries: Vec<Value> = u
                .vault
                .items()
                .into_iter()
                .filter(|i| !i.deleted)
                .filter_map(|i| Some((passkey::Passkey::from_item(&i)?, i)))
                .filter(|(pk, _)| pk.rp_id == rp_id)
                .filter(|(pk, _)| allowed.is_empty() || allowed.contains(&pk.credential_id))
                .map(|(pk, i)| {
                    json!({
                        "entryId": i.id.to_string(),
                        "title": i.title,
                        "username": pk.username,
                        "credentialId": passkey::encode_credential_id(&pk.credential_id),
                    })
                })
                .collect();
            json!({ "id": id, "ok": true, "entries": entries })
        }
        "passkey-sign" => {
            let origin = req.get("origin").and_then(Value::as_str).unwrap_or("");
            let rp_id = req.get("rpId").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
            let entry_id = req.get("entryId").and_then(Value::as_str).unwrap_or("");
            let hash = req.get("clientDataHash").and_then(Value::as_str).and_then(|h| B64URL.decode(h.trim_end_matches('=')).ok());
            if !passkey::rp_id_allowed(&rp_id, origin) {
                return err(&id, "invalid-argument", "RP ID is not valid for this origin");
            }
            let (Ok(uuid), Some(hash)) = (Uuid::parse_str(entry_id), hash) else {
                return err(&id, "invalid-argument", "bad entry id or client data hash");
            };
            state.touch_activity().await;
            let mut guard = state.vault.lock().await;
            let Some(u) = guard.as_mut() else {
                return err(&id, "locked", "vault is locked");
            };
            let Some(pk) = u.vault.item(uuid).filter(|i| !i.deleted).and_then(|i| passkey::Passkey::from_item(&i)) else {
                return err(&id, "not-found", "no passkey on this entry");
            };
            if pk.rp_id != rp_id {
                return err(&id, "not-found", "no passkey for this site on this entry");
            }
            match pk.assert(&hash) {
                Ok(a) => {
                    u.vault.touch_used(uuid);
                    json!({
                        "id": id,
                        "ok": true,
                        "credentialId": B64URL.encode(&a.credential_id),
                        "authenticatorData": B64URL.encode(&a.authenticator_data),
                        "signature": B64URL.encode(&a.signature),
                        "userHandle": a.user_handle.map(|h| B64URL.encode(h)),
                    })
                }
                Err(e) => err(&id, e.code(), &e.to_string()),
            }
        }
        "passkey-create" => {
            let origin = req.get("origin").and_then(Value::as_str).unwrap_or("");
            let rp_id = req.get("rpId").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
            let rp_name = req.get("rpName").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
            let user_name = req.get("userName").and_then(Value::as_str).unwrap_or("").trim().to_string();
            let user_id = req.get("userId").and_then(Value::as_str).and_then(|u| B64URL.decode(u.trim_end_matches('=')).ok());
            let entry_id = req.get("entryId").and_then(Value::as_str).filter(|s| !s.is_empty());
            let excluded: Vec<Vec<u8>> = req
                .get("excludeCredentials")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).filter_map(passkey::decode_credential_id).collect())
                .unwrap_or_default();
            if !passkey::rp_id_allowed(&rp_id, origin) {
                return err(&id, "invalid-argument", "RP ID is not valid for this origin");
            }
            let Some(user_id) = user_id.filter(|u| !u.is_empty() && u.len() <= 64) else {
                return err(&id, "invalid-argument", "bad user id");
            };
            state.touch_activity().await;
            let result = {
                let mut guard = state.vault.lock().await;
                let Some(u) = guard.as_mut() else {
                    return err(&id, "locked", "vault is locked");
                };
                let items = u.vault.items();
                let already = items
                    .iter()
                    .filter(|i| !i.deleted)
                    .filter_map(passkey::Passkey::from_item)
                    .any(|pk| pk.rp_id == rp_id && excluded.contains(&pk.credential_id));
                if already {
                    return err(&id, "excluded", "a passkey for this account is already in the vault");
                }
                let mut item = match entry_id {
                    Some(eid) => {
                        let Some(item) = Uuid::parse_str(eid).ok().and_then(|uuid| u.vault.item(uuid)).filter(|i| !i.deleted) else {
                            return err(&id, "not-found", "no such entry");
                        };
                        // Never overwrite a passkey: it may be the only way into that account.
                        if item.fields.iter().any(|f| f.name.starts_with("KPEX_PASSKEY_")) {
                            return err(&id, "already-exists", "this entry already has a passkey");
                        }
                        item
                    }
                    None => {
                        let mut item = vault_core::Item::new(vault_core::ItemKind::Login, rp_name.unwrap_or(&rp_id).to_string());
                        item.urls = vec![origin.to_string()];
                        item
                    }
                };
                let reg = match passkey::register(&rp_id, &passkey::NewPasskeyUser { id: user_id, name: user_name.clone() }) {
                    Ok(r) => r,
                    Err(e) => return err(&id, e.code(), &e.to_string()),
                };
                if item.username.is_empty() {
                    item.username = user_name;
                }
                item.fields.extend(reg.fields.clone());
                if !item.tags.iter().any(|t| t == "Passkey") {
                    item.tags.push("Passkey".into());
                }
                match u.vault.upsert_item(item) {
                    Ok(saved) => match crate::store::write_vault(u).await {
                        Ok(()) => Ok((saved.id, reg)),
                        Err(e) => Err(e),
                    },
                    Err(e) => Err(e),
                }
            };
            match result {
                Ok((entry, reg)) => {
                    let _ = app.emit("items:changed", ());
                    state.push(PushEvent::ItemsChanged);
                    if state.settings.lock().await.vault.mode == crate::settings::SyncMode::Webdav {
                        crate::store::sync_in_background(app);
                    }
                    json!({
                        "id": id,
                        "ok": true,
                        "entryId": entry.to_string(),
                        "credentialId": B64URL.encode(&reg.credential_id),
                        "authenticatorData": B64URL.encode(&reg.authenticator_data),
                        "attestationObject": B64URL.encode(&reg.attestation_object),
                        "publicKey": B64URL.encode(&reg.public_key_spki),
                        "publicKeyAlgorithm": passkey::COSE_ES256,
                    })
                }
                Err(e) => err(&id, e.code(), &e.to_string()),
            }
        }
        "touch" => {
            let entry_id = req.get("entryId").and_then(Value::as_str).unwrap_or("");
            if let Ok(uuid) = Uuid::parse_str(entry_id) {
                if let Some(u) = state.vault.lock().await.as_mut() {
                    u.vault.touch_used(uuid);
                }
            }
            json!({ "id": id, "ok": true })
        }
        "lock" => {
            autolock::lock(app).await;
            json!({ "id": id, "ok": true })
        }
        "unlock-request" => {
            focus_main_window(app);
            json!({ "id": id, "ok": true })
        }
        other => err(&id, "unknown-action", &format!("unknown action {other}")),
    }
}
