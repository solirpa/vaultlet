//! Vault persistence and synchronisation (architecture doc section 4).
//!
//! * folder mode: the vault file lives in a cloud-synced directory; we watch it, merge external
//!   changes, and merge-before-write so two devices never clobber each other.
//! * WebDAV mode: a local cache file plus ETag-guarded GET/PUT against the server.

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::Utc;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use vault_core::sync::{atomic_write, conflict_copies, file_fingerprint, GetResult, WebDavClient};
use vault_core::{Credentials, Error, Result, Vault};

use crate::settings::{Settings, SyncMode};
use crate::state::{AppState, PushEvent, SyncState, SyncStatus, Unlocked};

pub const WEBDAV_PASSWORD_KEY: &str = "webdav-password";

/// Open a KDBX file off the async runtime.
pub async fn open_file(path: &Path, creds: &Credentials) -> Result<Vault> {
    let bytes = std::fs::read(path)?;
    open_bytes(bytes, creds).await
}

pub async fn open_bytes(bytes: Vec<u8>, creds: &Credentials) -> Result<Vault> {
    let creds = creds.clone();
    tokio::task::spawn_blocking(move || Vault::open(&bytes, &creds))
        .await
        .map_err(|e| Error::Other(e.to_string()))?
}

/// Serialize a vault off the async runtime.
pub async fn serialize(vault: &Vault, creds: &Credentials) -> Result<Vec<u8>> {
    let mut v = vault.clone();
    let creds = creds.clone();
    tokio::task::spawn_blocking(move || v.save(&creds))
        .await
        .map_err(|e| Error::Other(e.to_string()))?
}

/// Persist the unlocked vault to its local file. If the file changed underneath us (cloud sync
/// delivered another device's version) it is merged first.
pub async fn write_vault(u: &mut Unlocked) -> Result<()> {
    merge_external_if_changed(u).await?;
    let bytes = serialize(&u.vault, &u.creds).await?;
    if let Some(parent) = u.file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    atomic_write(&u.file, &bytes)?;
    u.vault.mark_saved();
    u.fingerprint = file_fingerprint(&u.file).ok();
    u.needs_upload = true;
    Ok(())
}

/// If the on-disk file differs from what we last read/wrote, merge it into memory.
/// Returns true when the in-memory vault changed as a result.
pub async fn merge_external_if_changed(u: &mut Unlocked) -> Result<bool> {
    let fp = match file_fingerprint(&u.file) {
        Ok(fp) => fp,
        Err(_) => return Ok(false), // file missing: nothing to merge, we'll recreate it on write
    };
    if u.fingerprint.as_ref() == Some(&fp) {
        return Ok(false);
    }
    let disk = match open_file(&u.file, &u.creds).await {
        Ok(v) => v,
        Err(Error::InvalidKey) => {
            // Somebody changed the master password elsewhere; keep our copy and report.
            return Err(Error::Other("the vault file on disk uses a different master password".into()));
        }
        Err(e) => return Err(e),
    };
    let report = u.vault.merge_from(&disk);
    u.fingerprint = Some(fp);
    // Does the disk copy lack anything we have? Then the merged result must be written back.
    let mut probe = disk;
    let missing = probe.merge_from(&u.vault);
    if !missing.is_empty() {
        let bytes = serialize(&u.vault, &u.creds).await?;
        atomic_write(&u.file, &bytes)?;
        u.vault.mark_saved();
        u.fingerprint = file_fingerprint(&u.file).ok();
        u.needs_upload = true;
    }
    Ok(!report.is_empty())
}

fn emit_sync<R: Runtime>(app: &AppHandle<R>, status: &SyncStatus) {
    let _ = app.emit("sync:status", status);
}

async fn set_sync<R: Runtime>(app: &AppHandle<R>, f: impl FnOnce(&mut SyncStatus)) -> SyncStatus {
    let state = app.state::<AppState>();
    let mut s = state.sync.lock().await;
    f(&mut s);
    let out = s.clone();
    drop(s);
    emit_sync(app, &out);
    out
}

/// Reload external changes (folder mode) and refresh the conflict-copy list.
async fn sync_folder<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    let state = app.state::<AppState>();
    let mut guard = state.vault.lock().await;
    let Some(u) = guard.as_mut() else {
        return Ok(());
    };
    let changed = merge_external_if_changed(u).await?;
    let conflicts: Vec<String> = conflict_copies(&u.file)
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    drop(guard);
    if changed {
        let _ = app.emit("items:changed", ());
        state.push(PushEvent::ItemsChanged);
    }
    set_sync(app, |s| {
        s.conflict_files = conflicts.clone();
        s.state = if conflicts.is_empty() { SyncState::Idle } else { SyncState::Conflict };
        s.message = if conflicts.is_empty() { None } else { Some("conflict copies found".into()) };
        s.last_sync = Some(Utc::now());
    })
    .await;
    Ok(())
}

pub fn webdav_client(settings: &Settings, state: &AppState) -> Result<(WebDavClient, String)> {
    let cfg = settings
        .vault
        .webdav
        .as_ref()
        .filter(|w| !w.url.is_empty())
        .ok_or_else(|| Error::InvalidArgument("WebDAV is not configured".into()))?;
    let password = state
        .secrets
        .get(WEBDAV_PASSWORD_KEY)
        .ok_or_else(|| Error::InvalidArgument("WebDAV password is not set".into()))?;
    let client = WebDavClient::new(&cfg.url, &cfg.username, &password)?;
    Ok((client, cfg.remote_path.clone()))
}

fn etag_file(data_dir: &Path) -> PathBuf {
    data_dir.join("vault.etag")
}

pub fn load_etag(data_dir: &Path) -> Option<String> {
    std::fs::read_to_string(etag_file(data_dir)).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn store_etag(data_dir: &Path, etag: Option<&str>) {
    let p = etag_file(data_dir);
    match etag {
        Some(e) => {
            let _ = std::fs::write(p, e);
        }
        None => {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Download the remote vault into the cache (used before the first unlock in WebDAV mode).
pub async fn webdav_fetch_to_cache<R: Runtime>(app: &AppHandle<R>) -> Result<bool> {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().await.clone();
    let (client, remote) = webdav_client(&settings, &state)?;
    let cache = state.paths.data_dir.join("vault.kdbx");
    let etag = load_etag(&state.paths.data_dir).filter(|_| cache.exists());
    match client.get(&remote, etag.as_deref()).await? {
        GetResult::NotModified => Ok(true),
        GetResult::NotFound => Ok(cache.exists()),
        GetResult::Modified { bytes, etag } => {
            std::fs::create_dir_all(&state.paths.data_dir)?;
            atomic_write(&cache, &bytes)?;
            store_etag(&state.paths.data_dir, etag.as_deref());
            Ok(true)
        }
    }
}

/// Pull from / push to the WebDAV server.
///
/// The vault lock is only held to snapshot and to merge, never across network requests:
/// everything else (the UI, the browser extension) waits on that lock, and a slow server
/// would otherwise stall them until the request times out.
async fn sync_webdav<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    let state = app.state::<AppState>();
    // One WebDAV sync at a time; the vault lock no longer serialises them.
    let _running = state.webdav_sync.lock().await;
    let settings = state.settings.lock().await.clone();
    let (client, remote) = webdav_client(&settings, &state)?;
    let mut attempts = 0;
    let mut changed_locally = false;
    loop {
        // Pull (without the lock).
        let Some((etag, creds)) = state.vault.lock().await.as_ref().map(|u| (u.etag.clone(), u.creds.clone())) else {
            return Ok(());
        };
        let pulled = client.get(&remote, etag.as_deref()).await?;
        let remote_vault = match &pulled {
            GetResult::Modified { bytes, .. } => Some(open_bytes(bytes.clone(), &creds).await?),
            _ => None,
        };

        // Merge, and prepare the upload, under the lock.
        let upload = {
            let mut guard = state.vault.lock().await;
            let Some(u) = guard.as_mut() else {
                return Ok(()); // locked meanwhile
            };
            match pulled {
                GetResult::NotModified => {}
                GetResult::NotFound => {
                    u.etag = None;
                    u.needs_upload = true;
                }
                GetResult::Modified { bytes, etag } => {
                    let remote_vault = remote_vault.expect("decrypted above");
                    let report = u.vault.merge_from(&remote_vault);
                    changed_locally |= !report.is_empty();
                    let mut probe = remote_vault;
                    u.needs_upload |= !probe.merge_from(&u.vault).is_empty() || u.vault.has_unsaved_changes();
                    u.etag = etag;
                    if u.needs_upload {
                        let merged = serialize(&u.vault, &u.creds).await?;
                        atomic_write(&u.file, &merged)?;
                    } else {
                        atomic_write(&u.file, &bytes)?;
                    }
                    u.vault.mark_saved();
                    u.fingerprint = file_fingerprint(&u.file).ok();
                }
            }
            if !(u.needs_upload || u.vault.has_unsaved_changes()) {
                break;
            }
            let bytes = serialize(&u.vault, &u.creds).await?;
            atomic_write(&u.file, &bytes)?;
            u.vault.mark_saved();
            u.fingerprint = file_fingerprint(&u.file).ok();
            // Edits made while the upload is in flight set this again.
            u.needs_upload = false;
            (bytes, u.etag.clone())
        };

        // Push (without the lock).
        let (bytes, base_etag) = upload;
        let pushed = match client.ensure_parents(&remote).await {
            Ok(()) => client.put(&remote, bytes, base_etag.as_deref()).await,
            Err(e) => Err(e),
        };
        let mut guard = state.vault.lock().await;
        let Some(u) = guard.as_mut() else {
            return Ok(());
        };
        match pushed {
            Ok(new_etag) => {
                u.etag = new_etag;
                break;
            }
            Err(Error::PreconditionFailed) if attempts < 3 => {
                attempts += 1;
                u.needs_upload = true;
                u.etag = None; // force a full GET next round
            }
            Err(e) => {
                u.needs_upload = true;
                return Err(e);
            }
        }
    }
    let etag = state.vault.lock().await.as_ref().and_then(|u| u.etag.clone());
    store_etag(&state.paths.data_dir, etag.as_deref());
    if changed_locally {
        let _ = app.emit("items:changed", ());
        state.push(PushEvent::ItemsChanged);
    }
    set_sync(app, |s| {
        s.state = SyncState::Idle;
        s.message = None;
        s.last_sync = Some(Utc::now());
        s.conflict_files.clear();
    })
    .await;
    Ok(())
}

/// Run a synchronisation for the current mode and return the resulting status.
pub async fn sync_now<R: Runtime>(app: &AppHandle<R>) -> SyncStatus {
    let state = app.state::<AppState>();
    let mode = state.settings.lock().await.vault.mode;
    set_sync(app, |s| {
        s.mode = mode;
        s.state = SyncState::Syncing;
        s.message = None;
    })
    .await;
    let result = match mode {
        SyncMode::Folder => sync_folder(app).await,
        SyncMode::Webdav => sync_webdav(app).await,
    };
    match result {
        Ok(()) => state.sync.lock().await.clone(),
        Err(e) => {
            set_sync(app, |s| {
                s.state = SyncState::Error;
                s.message = Some(e.to_string());
            })
            .await
        }
    }
}

/// Fire-and-forget sync (after saves).
pub fn sync_in_background<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        sync_now(&app).await;
    });
}

// ---------------------------------------------------------------------------------------------
// File watcher (folder mode)

pub struct WatchHandle {
    _watcher: notify::RecommendedWatcher,
}

pub fn start_watcher<R: Runtime>(app: AppHandle<R>, file: PathBuf) -> Option<WatchHandle> {
    use notify::{RecursiveMode, Watcher};
    let dir = file.parent()?.to_path_buf();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let target = file.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.paths.iter().any(|p| p == &target || p.file_name() == target.file_name()) {
                let _ = tx.send(());
            }
        }
    })
    .ok()?;
    watcher.watch(&dir, RecursiveMode::NonRecursive).ok()?;
    tauri::async_runtime::spawn(async move {
        while rx.recv().await.is_some() {
            // Debounce bursts of events from the cloud client.
            tokio::time::sleep(Duration::from_millis(800)).await;
            while rx.try_recv().is_ok() {}
            let state = app.state::<AppState>();
            if state.vault.lock().await.is_none() {
                break;
            }
            sync_now(&app).await;
        }
    });
    Some(WatchHandle { _watcher: watcher })
}

/// Periodic fallback: folder mode every minute (cloud clients do not always emit events),
/// WebDAV every five minutes.
pub fn spawn_periodic<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut tick: u64 = 0;
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            tick += 1;
            let state = app.state::<AppState>();
            if state.vault.lock().await.is_none() {
                continue;
            }
            let mode = state.settings.lock().await.vault.mode;
            match mode {
                SyncMode::Folder => {
                    sync_now(&app).await;
                }
                SyncMode::Webdav if tick % 5 == 0 => {
                    sync_now(&app).await;
                }
                _ => {}
            }
        }
    });
}
