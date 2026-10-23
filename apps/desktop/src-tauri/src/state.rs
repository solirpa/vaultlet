//! Shared application state.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, oneshot, Mutex};
use vault_core::sync::Fingerprint;
use vault_core::{Credentials, Vault};

use crate::secrets::Secrets;
use crate::settings::{Settings, SyncMode};

pub struct Paths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
}

/// An unlocked vault plus everything needed to persist it.
pub struct Unlocked {
    pub vault: Vault,
    pub creds: Credentials,
    /// Local file (the configured path in folder mode, the cache file in WebDAV mode).
    pub file: PathBuf,
    pub fingerprint: Option<Fingerprint>,
    /// ETag of the remote copy we last saw (WebDAV mode).
    pub etag: Option<String>,
    /// Local changes not yet uploaded (WebDAV mode).
    pub needs_upload: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncState {
    Idle,
    Syncing,
    Error,
    Conflict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub mode: SyncMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync: Option<DateTime<Utc>>,
    pub state: SyncState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub conflict_files: Vec<String>,
}

impl SyncStatus {
    pub fn idle(mode: SyncMode) -> SyncStatus {
        SyncStatus { mode, last_sync: None, state: SyncState::Idle, message: None, conflict_files: Vec::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedBrowser {
    pub client_id: String,
    pub public_key: String,
    pub name: String,
    pub paired_at: DateTime<Utc>,
}

/// Public view of a paired browser (no key material).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedBrowserInfo {
    pub client_id: String,
    pub name: String,
    pub paired_at: DateTime<Utc>,
}

/// Event pushed to connected browser extensions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushEvent {
    Locked,
    Unlocked,
    ItemsChanged,
}

impl PushEvent {
    pub fn wire_name(self) -> &'static str {
        match self {
            PushEvent::Locked => "locked",
            PushEvent::Unlocked => "unlocked",
            PushEvent::ItemsChanged => "items-changed",
        }
    }
}

pub struct AppState {
    pub paths: Paths,
    pub settings: Mutex<Settings>,
    pub vault: Mutex<Option<Unlocked>>,
    pub sync: Mutex<SyncStatus>,
    pub paired: Mutex<Vec<PairedBrowser>>,
    pub pairing: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    pub app_secret: crypto_box::SecretKey,
    pub last_activity: Mutex<Instant>,
    pub push: broadcast::Sender<PushEvent>,
    pub secrets: Secrets,
    pub watcher: Mutex<Option<crate::store::WatchHandle>>,
    pub icons: crate::icons::IconService,
}

impl AppState {
    pub async fn touch_activity(&self) {
        *self.last_activity.lock().await = Instant::now();
    }

    pub fn push(&self, ev: PushEvent) {
        let _ = self.push.send(ev);
    }

    pub fn paired_file(&self) -> PathBuf {
        self.paths.config_dir.join("paired.json")
    }

    pub async fn save_paired(&self) -> std::io::Result<()> {
        let list = self.paired.lock().await.clone();
        let json = serde_json::to_string_pretty(&list).map_err(std::io::Error::other)?;
        std::fs::create_dir_all(&self.paths.config_dir)?;
        vault_core::sync::atomic_write(&self.paired_file(), json.as_bytes())
    }

    pub fn load_paired(path: &std::path::Path) -> Vec<PairedBrowser> {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }
}
