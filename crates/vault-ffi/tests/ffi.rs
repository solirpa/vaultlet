//! The mobile API end to end: open, browse, edit, TOTP, autofill matching, and WebDAV sync
//! between two "phones" against an in-process server with ETags and If-Match.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use vault_core::vault::KdfParams;
use vault_ffi::*;

const PW: &str = "master";

fn new_vault_bytes() -> Vec<u8> {
    let mut v = vault_core::Vault::create_with_kdf("Phone test", KdfParams::fast());
    let mut gh = vault_core::Item::new(vault_core::ItemKind::Login, "GitHub");
    gh.username = "octocat".into();
    gh.password = "gh-pw".into();
    gh.urls = vec!["https://github.com/login".into()];
    gh.totp = Some("JBSWY3DPEHPK3PXP".into());
    v.upsert_item(gh).unwrap();
    let mut app = vault_core::Item::new(vault_core::ItemKind::Login, "Bank app");
    app.username = "me".into();
    app.urls = vec!["androidapp://com.example.bank".into()];
    app.fields = vec![vault_core::Field::new("KPEX_PASSKEY_RELYING_PARTY", "bank.example"), vault_core::Field::new("PIN", "1234")];
    v.upsert_item(app).unwrap();
    v.save(&vault_core::Credentials::password(PW)).unwrap()
}

fn input(title: &str) -> ItemInput {
    ItemInput {
        id: None,
        title: title.into(),
        username: "u".into(),
        password: "p".into(),
        urls: vec!["https://new.example".into(), " ".into()],
        notes: String::new(),
        favorite: false,
        totp: None,
    }
}

#[test]
fn open_browse_edit() {
    let bytes = new_vault_bytes();
    assert!(matches!(open_vault(bytes.clone(), "wrong".into()), Err(VaultError::Failed { code, .. }) if code == "invalid-key"));
    let v = open_vault(bytes, PW.into()).unwrap();
    assert_eq!(v.name(), "Phone test");
    let items = v.items();
    assert_eq!(items.iter().map(|i| i.title.as_str()).collect::<Vec<_>>(), ["Bank app", "GitHub"]);
    assert!(items[0].has_passkey && !items[1].has_passkey && items[1].has_totp);

    // Search, web and app matching.
    assert_eq!(v.search("octo".into())[0].title, "GitHub");
    assert_eq!(v.matches("https://github.com/settings".into())[0].title, "GitHub");
    assert!(v.matches("https://evil.example".into()).is_empty());
    assert_eq!(v.matches_app("com.example.bank".into())[0].title, "Bank app");
    assert!(v.matches_app("com.example".into()).is_empty());

    // Details hide the passkey's own fields but keep custom ones.
    let bank = v.item(items[0].id.clone()).unwrap();
    assert_eq!(bank.fields, vec![FieldRecord { name: "PIN".into(), value: "1234".into(), protected: false }]);
    let code = v.totp(items[1].id.clone()).unwrap().unwrap();
    assert_eq!(code.code.len(), 6);
    assert!(v.totp(items[0].id.clone()).unwrap().is_none());

    // Create, edit (passkey and custom fields survive), TOTP rules, trash.
    assert!(!v.pending_upload());
    let id = v.save_item(input("New")).unwrap();
    assert!(v.pending_upload());
    assert_eq!(v.item(id.clone()).unwrap().urls, ["https://new.example"]);
    let mut edit = input("Bank renamed");
    edit.id = Some(bank.id.clone());
    edit.totp = Some("JBSWY3DPEHPK3PXP".into());
    v.save_item(edit.clone()).unwrap();
    let bank2 = v.item(bank.id.clone()).unwrap();
    assert!(bank2.has_passkey && bank2.has_totp && bank2.fields.len() == 1);
    edit.totp = Some("nope !!".into());
    assert!(matches!(v.save_item(edit.clone()), Err(VaultError::Failed { code, .. }) if code == "invalid-totp"));
    edit.totp = Some(String::new());
    v.save_item(edit).unwrap();
    assert!(!v.item(bank.id.clone()).unwrap().has_totp);
    assert!(matches!(v.save_item(input("  ")), Err(VaultError::Failed { code, .. }) if code == "invalid-argument"));
    v.trash_item(id.clone()).unwrap();
    assert!(v.item(id.clone()).is_none());
    assert!(v.trash_item(id).is_err());

    // The cache round-trips.
    let again = open_vault(v.serialize().unwrap(), PW.into()).unwrap();
    assert_eq!(again.items().len(), 2);
    assert_eq!(generate_password(24, true, true, true, false).unwrap().len(), 24);
}

/// In-memory WebDAV server: ETags, If-Match, and 409 for a missing parent like 坚果云.
fn fake_dav() -> String {
    #[derive(Default)]
    struct Fs {
        dirs: Vec<String>,
        files: HashMap<String, (Vec<u8>, u32)>,
        next: u32,
    }
    let fs = Arc::new(Mutex::new(Fs { dirs: vec![String::new()], ..Default::default() }));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for sock in listener.incoming() {
            let mut sock = sock.unwrap();
            let fs = fs.clone();
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                let (head_len, body_len) = loop {
                    let n = sock.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
                        let len = head.lines().find_map(|l| l.strip_prefix("content-length:")).map(|v| v.trim().parse().unwrap()).unwrap_or(0);
                        break (i + 4, len);
                    }
                };
                while buf.len() < head_len + body_len {
                    let n = sock.read(&mut chunk).unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                }
                let head = String::from_utf8_lossy(&buf[..head_len]).to_string();
                let lower = head.to_lowercase();
                let mut first = head.lines().next().unwrap().split(' ');
                let method = first.next().unwrap().to_string();
                let path = first.next().unwrap().trim_start_matches("/dav").trim_end_matches('/').to_string();
                let header = |name: &str| lower.lines().find_map(|l| l.strip_prefix(name)).map(|v| v.trim().trim_matches('"').to_string());
                let parent = path.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default();
                let body = buf[head_len..head_len + body_len].to_vec();
                let mut fs = fs.lock().unwrap();
                let (status, etag, payload): (&str, Option<u32>, Vec<u8>) = if !fs.dirs.contains(&parent) {
                    ("409 Conflict", None, b"AncestorsNotFound".to_vec())
                } else {
                    match method.as_str() {
                        "GET" => match fs.files.get(&path) {
                            Some((_, tag)) if header("if-none-match:").as_deref() == Some(&tag.to_string()) => ("304 Not Modified", Some(*tag), vec![]),
                            Some((data, tag)) => ("200 OK", Some(*tag), data.clone()),
                            None => ("404 Not Found", None, vec![]),
                        },
                        "HEAD" => match fs.files.get(&path) {
                            Some((_, tag)) => ("200 OK", Some(*tag), vec![]),
                            None => ("404 Not Found", None, vec![]),
                        },
                        "PROPFIND" if fs.dirs.contains(&path) || fs.files.contains_key(&path) => ("207 Multi-Status", None, vec![]),
                        "PROPFIND" => ("404 Not Found", None, vec![]),
                        "MKCOL" => {
                            fs.dirs.push(path);
                            ("201 Created", None, vec![])
                        }
                        "PUT" => {
                            let current = fs.files.get(&path).map(|(_, t)| t.to_string());
                            match header("if-match:") {
                                Some(want) if Some(&want) != current.as_ref() => ("412 Precondition Failed", None, vec![]),
                                _ => {
                                    fs.next += 1;
                                    let tag = fs.next;
                                    fs.files.insert(path, (body, tag));
                                    ("201 Created", Some(tag), vec![])
                                }
                            }
                        }
                        _ => ("405 Method Not Allowed", None, vec![]),
                    }
                };
                drop(fs);
                let etag = etag.map(|t| format!("ETag: \"{t}\"\r\n")).unwrap_or_default();
                let head = format!("HTTP/1.1 {status}\r\n{etag}Content-Length: {}\r\nConnection: close\r\n\r\n", payload.len());
                let _ = sock.write_all(head.as_bytes());
                let _ = sock.write_all(&payload);
            });
        }
    });
    format!("http://{addr}/dav/")
}

#[test]
fn two_phones_sync_through_webdav() {
    let cfg = WebDavConfig { url: fake_dav(), username: "u".into(), password: "p".into(), remote_path: "/我的坚果云/Vaultlet/Vaultlet.kdbx".into() };
    assert!(matches!(webdav_fetch(cfg.clone()), Err(VaultError::Failed { code, .. }) if code == "not-found"));

    // Phone A uploads its vault (the folders do not exist yet: 409 from the server).
    let a = open_vault(new_vault_bytes(), PW.into()).unwrap();
    a.set_sync_state(None, true);
    let r = a.sync_webdav(cfg.clone()).unwrap();
    assert!(r.uploaded && !r.pending_upload && r.etag.is_some());

    // Phone B downloads it.
    let dl = webdav_fetch(cfg.clone()).unwrap();
    let b = open_vault(dl.bytes, PW.into()).unwrap();
    b.set_sync_state(dl.etag, false);
    assert_eq!(b.items().len(), 2);
    let r = b.sync_webdav(cfg.clone()).unwrap();
    assert!(!r.uploaded && !r.changed_locally, "nothing to do: {r:?}");

    // Both edit at the same time; A syncs first, then B (If-Match fails, merge, retry).
    a.save_item(input("From A")).unwrap();
    b.save_item(input("From B")).unwrap();
    assert!(a.sync_webdav(cfg.clone()).unwrap().uploaded);
    let rb = b.sync_webdav(cfg.clone()).unwrap();
    assert!(rb.uploaded && rb.changed_locally && !rb.pending_upload);
    let ra = a.sync_webdav(cfg.clone()).unwrap();
    assert!(ra.changed_locally && !ra.uploaded);
    let titles = |v: &Vault| v.items().into_iter().map(|i| i.title).collect::<Vec<_>>();
    assert_eq!(titles(&a), titles(&b));
    assert!(titles(&a).contains(&"From A".to_string()) && titles(&a).contains(&"From B".to_string()));

    // The cache bytes a sync returns open to the same vault.
    assert_eq!(titles(&open_vault(ra.vault_bytes, PW.into()).unwrap()), titles(&a));

    // A server that refuses the upload keeps the change pending.
    b.save_item(input("Offline edit")).unwrap();
    let bad = WebDavConfig { url: "http://127.0.0.1:9/dav/".into(), ..cfg.clone() };
    assert!(b.sync_webdav(bad).is_err());
    assert!(b.pending_upload());
    assert!(b.sync_webdav(cfg).unwrap().uploaded);
}
