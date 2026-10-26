//! Vaultlet core for the mobile apps (UniFFI): open a vault, browse and edit it, TOTP,
//! autofill matching and WebDAV sync. Everything is synchronous; callers run it off the UI
//! thread. Secrets stay inside the `Vault` object except where a caller asks for one item.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use uuid::Uuid;
use vault_core::sync::{GetResult, WebDavClient};
use vault_core::{Credentials, Item, ItemKind};

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum VaultError {
    /// `code` is vault-core's stable error code (`invalid-key`, `not-found`, `http`, ...).
    /// (Not `message`: that name clashes with Kotlin's `Exception.message`.)
    #[error("{detail}")]
    Failed { code: String, detail: String },
}

impl From<vault_core::Error> for VaultError {
    fn from(e: vault_core::Error) -> Self {
        VaultError::Failed { code: e.code().to_string(), detail: e.to_string() }
    }
}

fn failed(code: &str, message: impl Into<String>) -> VaultError {
    VaultError::Failed { code: code.to_string(), detail: message.into() }
}

type Result<T> = std::result::Result<T, VaultError>;

/// For WebDAV requests: vault-core reports a 401/403 as `InvalidKey`, the same as a wrong master
/// password; tell the two apart for the user.
fn net<T>(r: vault_core::Result<T>) -> Result<T> {
    r.map_err(|e| match e {
        vault_core::Error::InvalidKey => failed("webdav-auth", "the WebDAV server rejected the username or app password"),
        e => e.into(),
    })
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ItemSummary {
    pub id: String,
    /// `login`, `note`, `card` or `identity`
    pub kind: String,
    pub title: String,
    pub username: String,
    pub url: String,
    pub favorite: bool,
    pub has_totp: bool,
    pub has_passkey: bool,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FieldRecord {
    pub name: String,
    pub value: String,
    pub protected: bool,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ItemDetail {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub username: String,
    pub password: String,
    pub urls: Vec<String>,
    pub notes: String,
    pub favorite: bool,
    pub has_totp: bool,
    pub has_passkey: bool,
    /// Custom fields, without the passkey's own fields.
    pub fields: Vec<FieldRecord>,
}

/// Create (no `id`) or change a login. `totp`: `None` keeps the secret, `""` removes it.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ItemInput {
    pub id: Option<String>,
    pub title: String,
    pub username: String,
    pub password: String,
    pub urls: Vec<String>,
    pub notes: String,
    pub favorite: bool,
    pub totp: Option<String>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TotpCode {
    pub code: String,
    pub remaining: u32,
    pub period: u32,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct WebDavConfig {
    pub url: String,
    pub username: String,
    pub password: String,
    pub remote_path: String,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct Download {
    pub bytes: Vec<u8>,
    pub etag: Option<String>,
}

/// Outcome of [`Vault::sync_webdav`]. `vault_bytes` is the encrypted vault to keep as the
/// local cache; `pending_upload` stays true when local changes could not be uploaded yet.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SyncResult {
    pub vault_bytes: Vec<u8>,
    pub etag: Option<String>,
    pub changed_locally: bool,
    pub uploaded: bool,
    pub pending_upload: bool,
}

fn kind_name(k: ItemKind) -> &'static str {
    match k {
        ItemKind::Login => "login",
        ItemKind::Note => "note",
        ItemKind::Card => "card",
        ItemKind::Identity => "identity",
    }
}

fn has_passkey(i: &Item) -> bool {
    i.fields.iter().any(|f| f.name.starts_with("KPEX_PASSKEY_"))
}

fn summary(i: &Item) -> ItemSummary {
    ItemSummary {
        id: i.id.to_string(),
        kind: kind_name(i.kind).into(),
        title: i.title.clone(),
        username: i.username.clone(),
        url: i.urls.first().cloned().unwrap_or_default(),
        favorite: i.favorite,
        has_totp: i.has_totp(),
        has_passkey: has_passkey(i),
    }
}

fn sorted(mut items: Vec<ItemSummary>) -> Vec<ItemSummary> {
    items.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    items
}

fn parse_id(id: &str) -> Result<Uuid> {
    Uuid::parse_str(id).map_err(|_| failed("invalid-argument", format!("bad id {id}")))
}

fn runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| failed("io", e.to_string()))
}

fn client(cfg: &WebDavConfig) -> Result<WebDavClient> {
    Ok(WebDavClient::new(&cfg.url, &cfg.username, &cfg.password)?)
}

struct Inner {
    vault: vault_core::Vault,
    creds: Credentials,
    /// ETag of the remote copy last seen.
    etag: Option<String>,
    /// Local changes not on the server yet (persisted by the caller across restarts).
    pending_upload: bool,
}

#[derive(uniffi::Object)]
pub struct Vault {
    inner: Mutex<Inner>,
}

/// Decrypt a vault (KDBX bytes) with the master password.
#[uniffi::export]
pub fn open_vault(bytes: Vec<u8>, password: String) -> Result<Arc<Vault>> {
    let creds = Credentials::password(password);
    let vault = vault_core::Vault::open(&bytes, &creds)?;
    Ok(Arc::new(Vault { inner: Mutex::new(Inner { vault, creds, etag: None, pending_upload: false }) }))
}

#[uniffi::export]
pub fn generate_password(length: u32, upper: bool, lower: bool, digits: bool, symbols: bool) -> Result<String> {
    Ok(vault_core::password_generate((length as usize).clamp(4, 128), upper, lower, digits, symbols)?)
}

/// Check that the server accepts the credentials.
#[uniffi::export]
pub fn webdav_test(config: WebDavConfig) -> Result<()> {
    let c = client(&config)?;
    net(runtime()?.block_on(c.test_connection()))?;
    Ok(())
}

/// Download the vault file (first setup, or before unlocking).
#[uniffi::export]
pub fn webdav_fetch(config: WebDavConfig) -> Result<Download> {
    let c = client(&config)?;
    match net(runtime()?.block_on(c.get(&config.remote_path, None)))? {
        GetResult::Modified { bytes, etag } => Ok(Download { bytes, etag }),
        GetResult::NotFound => Err(failed("not-found", format!("{} not found on the server", config.remote_path))),
        GetResult::NotModified => Err(failed("http", "unexpected 304")),
    }
}

impl Vault {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic while holding the lock cannot leave the vault half-written in a way that
        // matters here; keep going with the data.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }
}

#[uniffi::export]
impl Vault {
    pub fn name(&self) -> String {
        self.lock().vault.name()
    }

    /// Every item not in the trash, sorted by title.
    pub fn items(&self) -> Vec<ItemSummary> {
        sorted(self.lock().vault.items().iter().filter(|i| !i.deleted).map(summary).collect())
    }

    /// Title, username or any URL contains `query` (case-insensitive).
    pub fn search(&self, query: String) -> Vec<ItemSummary> {
        let q = query.trim().to_lowercase();
        sorted(
            self.lock()
                .vault
                .items()
                .iter()
                .filter(|i| !i.deleted)
                .filter(|i| {
                    q.is_empty()
                        || i.title.to_lowercase().contains(&q)
                        || i.username.to_lowercase().contains(&q)
                        || i.urls.iter().any(|u| u.to_lowercase().contains(&q))
                })
                .map(summary)
                .collect(),
        )
    }

    pub fn item(&self, id: String) -> Option<ItemDetail> {
        let uuid = Uuid::parse_str(&id).ok()?;
        let i = self.lock().vault.item(uuid).filter(|i| !i.deleted)?;
        Some(ItemDetail {
            id: i.id.to_string(),
            kind: kind_name(i.kind).into(),
            title: i.title.clone(),
            username: i.username.clone(),
            password: i.password.clone(),
            urls: i.urls.clone(),
            notes: i.notes.clone(),
            favorite: i.favorite,
            has_totp: i.has_totp(),
            has_passkey: has_passkey(&i),
            fields: i
                .fields
                .iter()
                .filter(|f| !f.name.starts_with("KPEX_PASSKEY_"))
                .map(|f| FieldRecord { name: f.name.clone(), value: f.value.clone(), protected: f.protected })
                .collect(),
        })
    }

    /// Logins for a web page, best match first (same rules as the desktop extension).
    pub fn matches(&self, url: String) -> Vec<ItemSummary> {
        let items = self.lock().vault.items();
        vault_core::match_items(&items, &url)
            .into_iter()
            .filter(|i| i.kind == ItemKind::Login && !i.deleted)
            .map(summary)
            .collect()
    }

    /// Logins saved for an Android app (`androidapp://<package>`, as Bitwarden stores them).
    pub fn matches_app(&self, package: String) -> Vec<ItemSummary> {
        let want = format!("androidapp://{}", package.trim().to_lowercase());
        sorted(
            self.lock()
                .vault
                .items()
                .iter()
                .filter(|i| i.kind == ItemKind::Login && !i.deleted)
                .filter(|i| i.urls.iter().any(|u| u.trim().trim_end_matches('/').to_lowercase() == want))
                .map(summary)
                .collect(),
        )
    }

    pub fn totp(&self, id: String) -> Result<Option<TotpCode>> {
        let item = self.lock().vault.item(parse_id(&id)?);
        let Some(secret) = item.and_then(|i| i.totp) else {
            return Ok(None);
        };
        let c = vault_core::totp::generate(&secret, SystemTime::now())?;
        Ok(Some(TotpCode { code: c.code, remaining: c.remaining, period: c.period }))
    }

    /// Create or change a login. Fields not in [`ItemInput`] (custom fields, passkeys,
    /// folder, tags) are kept; the previous version goes to the item history.
    pub fn save_item(&self, input: ItemInput) -> Result<String> {
        let title = input.title.trim().to_string();
        if title.is_empty() {
            return Err(failed("invalid-argument", "title is empty"));
        }
        let mut g = self.lock();
        let mut item = match &input.id {
            Some(id) => g
                .vault
                .item(parse_id(id)?)
                .filter(|i| !i.deleted && i.kind == ItemKind::Login)
                .ok_or_else(|| failed("not-found", "no such login"))?,
            None => Item::new(ItemKind::Login, title.clone()),
        };
        item.title = title;
        item.username = input.username;
        item.password = input.password;
        item.urls = input.urls.iter().map(|u| u.trim()).filter(|u| !u.is_empty()).map(String::from).collect();
        item.notes = input.notes;
        item.favorite = input.favorite;
        match input.totp.as_deref().map(str::trim) {
            None => {}
            Some("") => item.totp = None,
            Some(s) => {
                item.totp = Some(
                    vault_core::totp::normalize_to_uri(s, &item.title)
                        .map_err(|_| failed("invalid-totp", "not a TOTP secret or otpauth:// URI"))?,
                )
            }
        }
        let saved = g.vault.upsert_item(item)?;
        g.pending_upload = true;
        Ok(saved.id.to_string())
    }

    /// Move to the trash (restorable in the desktop app).
    pub fn trash_item(&self, id: String) -> Result<()> {
        let uuid = parse_id(&id)?;
        let mut g = self.lock();
        if !g.vault.item(uuid).is_some_and(|i| !i.deleted) {
            return Err(failed("not-found", "no such item"));
        }
        g.vault.delete_item(uuid)?;
        g.pending_upload = true;
        Ok(())
    }

    /// Record that an item was used (sorting of autofill suggestions).
    pub fn touch(&self, id: String) {
        if let Ok(uuid) = Uuid::parse_str(&id) {
            self.lock().vault.touch_used(uuid);
        }
    }

    /// The vault encrypted for the local cache. Keeps `pending_upload` as it is.
    pub fn serialize(&self) -> Result<Vec<u8>> {
        let mut g = self.lock();
        let creds = g.creds.clone();
        Ok(g.vault.save(&creds)?)
    }

    pub fn pending_upload(&self) -> bool {
        self.lock().pending_upload
    }

    /// Restore sync state saved by the caller (ETag of the cached copy, unsent changes).
    pub fn set_sync_state(&self, etag: Option<String>, pending_upload: bool) {
        let mut g = self.lock();
        g.etag = etag;
        g.pending_upload |= pending_upload;
    }

    /// Pull from and push to the WebDAV server. The vault stays usable meanwhile: the lock is
    /// only held to snapshot and merge, never during network requests.
    pub fn sync_webdav(&self, config: WebDavConfig) -> Result<SyncResult> {
        let c = client(&config)?;
        let rt = runtime()?;
        let remote = config.remote_path.clone();
        let mut changed_locally = false;
        let mut uploaded = false;
        for attempt in 0.. {
            let (etag, creds) = {
                let g = self.lock();
                (g.etag.clone(), g.creds.clone())
            };
            let pulled = net(rt.block_on(c.get(&remote, etag.as_deref())))?;
            let remote_vault = match &pulled {
                GetResult::Modified { bytes, .. } => Some(vault_core::Vault::open(bytes, &creds)?),
                _ => None,
            };
            let upload = {
                let mut g = self.lock();
                match pulled {
                    GetResult::NotModified => {}
                    GetResult::NotFound => {
                        g.etag = None;
                        g.pending_upload = true;
                    }
                    GetResult::Modified { etag, .. } => {
                        let mut remote_vault = remote_vault.expect("decrypted above");
                        changed_locally |= !g.vault.merge_from(&remote_vault).is_empty();
                        g.pending_upload |= !remote_vault.merge_from(&g.vault).is_empty();
                        g.etag = etag;
                    }
                }
                if !g.pending_upload {
                    break;
                }
                let creds = g.creds.clone();
                let bytes = g.vault.save(&creds)?;
                // Edits made while the upload is in flight set this again.
                g.pending_upload = false;
                (bytes, g.etag.clone())
            };
            let (bytes, base_etag) = upload;
            let pushed = rt.block_on(async {
                c.ensure_parents(&remote).await?;
                c.put(&remote, bytes, base_etag.as_deref()).await
            });
            let mut g = self.lock();
            match pushed {
                Ok(new_etag) => {
                    g.etag = new_etag;
                    uploaded = true;
                    break;
                }
                Err(vault_core::Error::PreconditionFailed) if attempt < 3 => {
                    g.pending_upload = true;
                    g.etag = None; // someone else wrote first: full GET and merge again
                }
                Err(e) => {
                    g.pending_upload = true;
                    return net(Err(e));
                }
            }
        }
        let mut g = self.lock();
        let creds = g.creds.clone();
        let vault_bytes = g.vault.save(&creds)?;
        Ok(SyncResult { vault_bytes, etag: g.etag.clone(), changed_locally, uploaded, pending_upload: g.pending_upload })
    }
}
