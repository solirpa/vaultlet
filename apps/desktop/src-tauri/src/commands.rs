//! Tauri commands (architecture doc section 5). Every command returns `vault_core::Error` on
//! failure, which serializes to `{ code, message }`.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use uuid::Uuid;
use vault_core::import::{self, BitwardenSource};
use vault_core::sync::detect_cloud_folders;
use vault_core::{Credentials, Error, Folder, Item, ItemSummary, Result, Vault};

use crate::autolock;
use crate::settings::{Settings, SyncMode};
use crate::state::{AppState, PairedBrowserInfo, PushEvent, SyncStatus, Unlocked};
use crate::store;

type Res<T> = Result<T>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub mode: SyncMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

fn locked() -> Error {
    Error::Other("vault is locked".into())
}

async fn with_vault<T>(state: &AppState, f: impl FnOnce(&mut Unlocked) -> Res<T>) -> Res<T> {
    state.touch_activity().await;
    let mut guard = state.vault.lock().await;
    let u = guard.as_mut().ok_or_else(locked)?;
    f(u)
}

/// Mutate the vault, persist it, and notify listeners.
async fn mutate<R: Runtime, T>(app: &AppHandle<R>, state: &AppState, f: impl FnOnce(&mut Vault) -> Res<T>) -> Res<T> {
    state.touch_activity().await;
    let out = {
        let mut guard = state.vault.lock().await;
        let u = guard.as_mut().ok_or_else(locked)?;
        let out = f(&mut u.vault)?;
        store::write_vault(u).await?;
        out
    };
    state.push(PushEvent::ItemsChanged);
    if state.settings.lock().await.vault.mode == SyncMode::Webdav {
        store::sync_in_background(app);
    }
    Ok(out)
}

fn parse_id(id: &str) -> Res<Uuid> {
    Uuid::parse_str(id).map_err(|_| Error::InvalidArgument(format!("bad id {id}")))
}

// ---- state ----------------------------------------------------------------------------------

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> Res<VaultStatus> {
    let settings = state.settings.lock().await.clone();
    let mode = settings.vault.mode;
    let file = settings.vault_file(&state.paths.data_dir);
    let guard = state.vault.lock().await;
    if let Some(u) = guard.as_ref() {
        return Ok(VaultStatus {
            state: "unlocked",
            path: Some(display_path(&settings, &u.file)),
            mode,
            name: Some(u.vault.name()),
        });
    }
    let configured = match mode {
        SyncMode::Folder => file.as_ref().is_some_and(|p| p.exists()),
        SyncMode::Webdav => settings.vault.webdav.as_ref().is_some_and(|w| !w.url.is_empty()),
    };
    Ok(VaultStatus {
        state: if configured { "locked" } else { "no-vault" },
        path: file.map(|p| display_path(&settings, &p)),
        mode,
        name: None,
    })
}

fn display_path(settings: &Settings, local: &std::path::Path) -> String {
    match (&settings.vault.mode, &settings.vault.webdav) {
        (SyncMode::Webdav, Some(w)) => format!("{}/{}", w.url.trim_end_matches('/'), w.remote_path.trim_start_matches('/')),
        _ => local.to_string_lossy().into_owned(),
    }
}

async fn unlock_with<R: Runtime>(app: &AppHandle<R>, state: &AppState, file: PathBuf, vault: Vault, creds: Credentials) -> Res<()> {
    let mode = state.settings.lock().await.vault.mode;
    let fingerprint = vault_core::sync::file_fingerprint(&file).ok();
    let etag = if mode == SyncMode::Webdav { store::load_etag(&state.paths.data_dir) } else { None };
    *state.vault.lock().await = Some(Unlocked { vault, creds, file: file.clone(), fingerprint, etag, needs_upload: false });
    state.touch_activity().await;
    *state.watcher.lock().await = if mode == SyncMode::Folder { store::start_watcher(app.clone(), file) } else { None };
    state.push(PushEvent::Unlocked);
    store::sync_in_background(app);
    Ok(())
}

#[tauri::command]
pub async fn vault_create<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, path: String, password: String, name: String) -> Res<()> {
    if password.is_empty() {
        return Err(Error::InvalidArgument("password is empty".into()));
    }
    let mode = state.settings.lock().await.vault.mode;
    let file = match mode {
        SyncMode::Folder => {
            let p = PathBuf::from(path.trim());
            if p.as_os_str().is_empty() {
                return Err(Error::InvalidArgument("path is empty".into()));
            }
            if p.exists() {
                return Err(Error::AlreadyExists(p.to_string_lossy().into_owned()));
            }
            p
        }
        SyncMode::Webdav => {
            // Never overwrite a vault that already lives on the server: the user should unlock it.
            let settings = state.settings.lock().await.clone();
            let (client, remote) = store::webdav_client(&settings, &state)?;
            if client.exists(&remote).await? {
                return Err(Error::AlreadyExists(format!("remote vault {remote}")));
            }
            state.paths.data_dir.join("vault.kdbx")
        }
    };
    let creds = Credentials::password(password);
    let name = if name.trim().is_empty() { "Vaultlet".to_string() } else { name.trim().to_string() };
    let mut vault = Vault::create(&name);
    let bytes = store::serialize(&vault, &creds).await?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    vault_core::sync::atomic_write(&file, &bytes)?;
    vault.mark_saved();
    {
        let mut s = state.settings.lock().await;
        if mode == SyncMode::Folder {
            s.vault.path = Some(file.to_string_lossy().into_owned());
        }
        s.save(&state.paths.config_dir)?;
    }
    autolock::lock(&app).await;
    unlock_with(&app, &state, file, vault, creds).await?;
    // Brand-new WebDAV vault: push it right away.
    if mode == SyncMode::Webdav {
        if let Some(u) = state.vault.lock().await.as_mut() {
            u.needs_upload = true;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn vault_unlock<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, password: Option<String>, keyfile: Option<String>) -> Res<()> {
    let settings = state.settings.lock().await.clone();
    let file = settings
        .vault_file(&state.paths.data_dir)
        .ok_or_else(|| Error::InvalidArgument("no vault configured".into()))?;
    if settings.vault.mode == SyncMode::Webdav {
        match store::webdav_fetch_to_cache(&app).await {
            Ok(true) => {}
            Ok(false) => return Err(Error::NotFound("remote vault".into())),
            Err(e) if file.exists() => tracing::warn!("WebDAV fetch failed, using cache: {e}"),
            Err(e) => return Err(e),
        }
    }
    if !file.exists() {
        return Err(Error::NotFound(file.to_string_lossy().into_owned()));
    }
    let creds = Credentials {
        password: password.filter(|p| !p.is_empty()),
        keyfile: match keyfile.filter(|k| !k.is_empty()) {
            Some(k) => Some(std::fs::read(k)?),
            None => None,
        },
    };
    let vault = store::open_file(&file, &creds).await?;
    unlock_with(&app, &state, file, vault, creds).await
}

#[tauri::command]
pub async fn vault_lock<R: Runtime>(app: AppHandle<R>) -> Res<()> {
    autolock::lock(&app).await;
    Ok(())
}

#[tauri::command]
pub async fn vault_change_password<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, current: String, next: String) -> Res<()> {
    if next.is_empty() {
        return Err(Error::InvalidArgument("new password is empty".into()));
    }
    state.touch_activity().await;
    {
        let mut guard = state.vault.lock().await;
        let u = guard.as_mut().ok_or_else(locked)?;
        if u.creds.password.as_deref() != Some(current.as_str()) {
            return Err(Error::InvalidKey);
        }
        // Pick up any external changes under the old key before switching.
        store::merge_external_if_changed(u).await?;
        u.creds = Credentials { password: Some(next), keyfile: u.creds.keyfile.clone() };
        u.vault.change_key(vault_core::vault::KdfParams::default());
        store::write_vault(u).await?;
    }
    if state.settings.lock().await.vault.mode == SyncMode::Webdav {
        store::sync_in_background(&app);
    }
    Ok(())
}

// ---- items ------------------------------------------------------------------------------------

#[tauri::command]
pub async fn items_list(state: State<'_, AppState>) -> Res<Vec<ItemSummary>> {
    with_vault(&state, |u| Ok(u.vault.items().iter().map(ItemSummary::from).collect())).await
}

#[tauri::command]
pub async fn item_get(state: State<'_, AppState>, id: String) -> Res<Item> {
    let id = parse_id(&id)?;
    with_vault(&state, |u| u.vault.item(id).ok_or_else(|| Error::NotFound("item".into()))).await
}

#[tauri::command]
pub async fn item_save<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, item: Item) -> Res<Item> {
    mutate(&app, &state, |v| v.upsert_item(item)).await
}

#[tauri::command]
pub async fn item_delete<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, id: String) -> Res<()> {
    let id = parse_id(&id)?;
    mutate(&app, &state, |v| v.delete_item(id)).await
}

#[tauri::command]
pub async fn item_restore<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, id: String) -> Res<()> {
    let id = parse_id(&id)?;
    mutate(&app, &state, |v| v.restore_item(id)).await
}

#[tauri::command]
pub async fn item_purge<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, id: String) -> Res<()> {
    let id = parse_id(&id)?;
    mutate(&app, &state, |v| v.purge_item(id)).await
}

#[tauri::command]
pub async fn item_touch(state: State<'_, AppState>, id: String) -> Res<()> {
    let id = parse_id(&id)?;
    // Usage bookkeeping is kept in memory and written with the next real change or on lock.
    with_vault(&state, |u| {
        u.vault.touch_used(id);
        Ok(())
    })
    .await
}

#[derive(Serialize)]
pub struct TotpCode {
    pub code: String,
    pub period: u32,
    pub remaining: u32,
}

#[tauri::command]
pub async fn totp_now(state: State<'_, AppState>, id: String) -> Res<TotpCode> {
    let id = parse_id(&id)?;
    with_vault(&state, |u| {
        let item = u.vault.item(id).ok_or_else(|| Error::NotFound("item".into()))?;
        let secret = item.totp.as_deref().ok_or_else(|| Error::Totp("item has no TOTP".into()))?;
        let c = vault_core::totp::generate(secret, std::time::SystemTime::now())?;
        Ok(TotpCode { code: c.code, period: c.period, remaining: c.remaining })
    })
    .await
}

#[tauri::command]
pub async fn password_generate(length: usize, upper: bool, lower: bool, digits: bool, symbols: bool) -> Res<String> {
    vault_core::password_generate(length.clamp(4, 128), upper, lower, digits, symbols)
}

// ---- folders ----------------------------------------------------------------------------------

#[tauri::command]
pub async fn folders_list(state: State<'_, AppState>) -> Res<Vec<Folder>> {
    with_vault(&state, |u| Ok(u.vault.folders())).await
}

#[tauri::command]
pub async fn folder_save<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, folder: Folder) -> Res<Folder> {
    mutate(&app, &state, |v| v.upsert_folder(folder)).await
}

#[tauri::command]
pub async fn folder_delete<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, id: String) -> Res<()> {
    let id = parse_id(&id)?;
    mutate(&app, &state, |v| v.delete_folder(id)).await
}

// ---- import -----------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub items: usize,
    pub folders: usize,
    pub skipped: Vec<String>,
    pub needs_password: bool,
}

#[derive(Serialize)]
pub struct ImportOutcome {
    pub imported: usize,
}

fn read_export(path: &str, password: Option<String>) -> Res<std::result::Result<import::ImportResult, ()>> {
    let text = std::fs::read_to_string(path)?;
    let is_csv = path.to_lowercase().ends_with(".csv") || text.trim_start().starts_with("folder,");
    let src = if is_csv {
        BitwardenSource::Csv(text)
    } else if import::is_encrypted_json(&text) {
        match password.filter(|p| !p.is_empty()) {
            Some(p) => BitwardenSource::EncryptedJson { json: text, password: p },
            None => return Ok(Err(())),
        }
    } else {
        BitwardenSource::Json(text)
    };
    Ok(Ok(import::bitwarden(src)?))
}

#[tauri::command]
pub async fn import_bitwarden_preview(path: String, password: Option<String>) -> Res<ImportPreview> {
    match read_export(&path, password)? {
        Err(()) => Ok(ImportPreview { items: 0, folders: 0, skipped: vec![], needs_password: true }),
        Ok(r) => Ok(ImportPreview { items: r.items.len(), folders: r.folders.len(), skipped: r.skipped, needs_password: false }),
    }
}

#[tauri::command]
pub async fn import_bitwarden<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, path: String, password: Option<String>) -> Res<ImportOutcome> {
    let r = match read_export(&path, password)? {
        Err(()) => return Err(Error::ImportPassword("password required".into())),
        Ok(r) => r,
    };
    let imported = mutate(&app, &state, |v| import::apply(v, &r)).await?;
    let _ = app.emit("items:changed", ());
    Ok(ImportOutcome { imported })
}

// ---- settings & sync --------------------------------------------------------------------------

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> Res<Settings> {
    Ok(state.settings.lock().await.clone())
}

#[tauri::command]
pub async fn settings_set<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, settings: Settings) -> Res<()> {
    let (old_file, new_file, mode_changed) = {
        let mut s = state.settings.lock().await;
        let old_file = s.vault_file(&state.paths.data_dir);
        let mode_changed = s.vault.mode != settings.vault.mode;
        *s = settings;
        s.save(&state.paths.config_dir)?;
        (old_file, s.vault_file(&state.paths.data_dir), mode_changed)
    };
    // Switching vault file or mode: lock so the next unlock opens the right file.
    if old_file != new_file || mode_changed {
        autolock::lock(&app).await;
        let mode = state.settings.lock().await.vault.mode;
        *state.sync.lock().await = SyncStatus::idle(mode);
    }
    Ok(())
}

#[derive(Serialize)]
pub struct CloudFolderOut {
    pub provider: String,
    pub path: String,
}

#[tauri::command]
pub async fn cloud_folders_detect() -> Res<Vec<CloudFolderOut>> {
    Ok(detect_cloud_folders()
        .into_iter()
        .map(|f| CloudFolderOut {
            provider: serde_json::to_value(f.provider).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default(),
            path: f.path.to_string_lossy().into_owned(),
        })
        .collect())
}

#[tauri::command]
pub async fn webdav_set_password(state: State<'_, AppState>, password: String) -> Res<()> {
    if password.is_empty() {
        state.secrets.delete(store::WEBDAV_PASSWORD_KEY);
    } else {
        state.secrets.set(store::WEBDAV_PASSWORD_KEY, &password)?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct WebDavTestResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn webdav_test(url: String, username: String, password: String) -> Res<WebDavTestResult> {
    let r = async {
        let c = vault_core::sync::WebDavClient::new(&url, &username, &password)?;
        c.test_connection().await
    }
    .await;
    Ok(match r {
        Ok(()) => WebDavTestResult { ok: true, message: "connected".into() },
        Err(Error::InvalidKey) => WebDavTestResult { ok: false, message: "server rejected the username or password".into() },
        Err(e) => WebDavTestResult { ok: false, message: e.to_string() },
    })
}

#[tauri::command]
pub async fn sync_now<R: Runtime>(app: AppHandle<R>) -> Res<SyncStatus> {
    Ok(store::sync_now(&app).await)
}

#[tauri::command]
pub async fn sync_status(state: State<'_, AppState>) -> Res<SyncStatus> {
    let mut s = state.sync.lock().await.clone();
    s.mode = state.settings.lock().await.vault.mode;
    Ok(s)
}

// ---- browser integration ----------------------------------------------------------------------

#[tauri::command]
pub async fn browser_integration_apply(state: State<'_, AppState>) -> Res<Vec<crate::browser::manifests::ApplyResult>> {
    let cfg = state.settings.lock().await.browser_integration;
    Ok(crate::browser::manifests::apply(&cfg))
}

#[tauri::command]
pub async fn paired_browsers_list(state: State<'_, AppState>) -> Res<Vec<PairedBrowserInfo>> {
    Ok(state
        .paired
        .lock()
        .await
        .iter()
        .map(|p| PairedBrowserInfo { client_id: p.client_id.clone(), name: p.name.clone(), paired_at: p.paired_at })
        .collect())
}

#[tauri::command]
pub async fn paired_browser_remove(state: State<'_, AppState>, client_id: String) -> Res<()> {
    state.paired.lock().await.retain(|p| p.client_id != client_id);
    state.save_paired().await?;
    Ok(())
}

#[tauri::command]
pub async fn pairing_respond(state: State<'_, AppState>, request_id: String, approve: bool) -> Res<()> {
    if let Some(tx) = state.pairing.lock().await.remove(&request_id) {
        let _ = tx.send(approve);
    }
    Ok(())
}

/// Website icon for a host as a `data:` URL (fetched from the site itself, cached on disk).
#[tauri::command]
pub async fn icon_get(state: State<'_, AppState>, host: String) -> Res<Option<String>> {
    if !state.settings.lock().await.ui.site_icons {
        return Ok(None);
    }
    Ok(state.icons.get(&host).await)
}

/// Bring the main window to the front (pairing requests, unlock requests from the browser).
pub fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
