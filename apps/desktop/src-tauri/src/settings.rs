//! Application settings (`<app_config_dir>/settings.json`), architecture doc section 3.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SyncMode {
    #[default]
    Folder,
    Webdav,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSettings {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default = "default_remote_path")]
    pub remote_path: String,
}

fn default_remote_path() -> String {
    "Vaultlet/Vaultlet.kdbx".into()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultSettings {
    #[serde(default)]
    pub mode: SyncMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webdav: Option<WebDavSettings>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecuritySettings {
    #[serde(default = "d_auto_lock")]
    pub auto_lock_minutes: u32,
    #[serde(default = "d_clipboard")]
    pub clear_clipboard_seconds: u32,
    #[serde(default = "d_true")]
    pub lock_on_sleep: bool,
}

fn d_auto_lock() -> u32 {
    15
}
fn d_clipboard() -> u32 {
    30
}
fn d_true() -> bool {
    true
}

impl Default for SecuritySettings {
    fn default() -> Self {
        SecuritySettings { auto_lock_minutes: 15, clear_clipboard_seconds: 30, lock_on_sleep: true }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrowserIntegration {
    #[serde(default)]
    pub chrome: bool,
    #[serde(default)]
    pub edge: bool,
    #[serde(default)]
    pub brave: bool,
    #[serde(default)]
    pub firefox: bool,
    #[serde(default)]
    pub chromium: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiSettings {
    #[serde(default = "d_theme")]
    pub theme: String,
    #[serde(default = "d_language")]
    pub language: String,
    /// Show website icons, fetched from each site itself and cached locally.
    #[serde(default = "d_true")]
    pub site_icons: bool,
}

fn d_theme() -> String {
    "system".into()
}

fn d_language() -> String {
    let lang = std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LC_MESSAGES"))
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_default();
    if lang.to_lowercase().starts_with("zh") {
        "zh-CN".into()
    } else {
        "en".into()
    }
}

impl Default for UiSettings {
    fn default() -> Self {
        UiSettings { theme: d_theme(), language: d_language(), site_icons: true }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub vault: VaultSettings,
    #[serde(default)]
    pub security: SecuritySettings,
    #[serde(default)]
    pub browser_integration: BrowserIntegration,
    #[serde(default)]
    pub ui: UiSettings,
}

impl Settings {
    pub fn load(dir: &Path) -> Settings {
        let p = dir.join("settings.json");
        match std::fs::read_to_string(&p) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
                tracing::warn!("settings.json unreadable ({e}); using defaults");
                Settings::default()
            }),
            Err(_) => Settings::default(),
        }
    }

    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let json = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        vault_core::sync::atomic_write(&dir.join("settings.json"), json.as_bytes())
    }

    /// Where the vault file lives on disk for the current mode.
    pub fn vault_file(&self, data_dir: &Path) -> Option<PathBuf> {
        match self.vault.mode {
            SyncMode::Folder => self.vault.path.as_ref().filter(|p| !p.is_empty()).map(PathBuf::from),
            SyncMode::Webdav => Some(data_dir.join("vault.kdbx")),
        }
    }
}
