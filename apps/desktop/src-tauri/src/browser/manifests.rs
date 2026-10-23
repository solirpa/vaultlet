//! Native messaging host manifests (architecture doc section 6).

use std::path::PathBuf;

use serde::Serialize;

use crate::settings::BrowserIntegration;

/// Chrome extension id, fixed by the `key` in the extension manifest.
pub const EXTENSION_ID: &str = include_str!("../../../../extension/EXTENSION_ID");
pub const FIREFOX_ID: &str = "vaultlet@vaultlet.app";

#[derive(Debug, Clone, Serialize)]
pub struct ApplyResult {
    pub browser: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Copy)]
enum Family {
    Chromium,
    Firefox,
}

#[allow(dead_code)] // platform-specific fields
struct Browser {
    key: &'static str,
    family: Family,
    /// Relative to `~/Library/Application Support` on macOS.
    mac: &'static str,
    /// Relative to `~` on Linux.
    linux: &'static str,
    /// Registry subkey under HKCU\Software on Windows.
    win: &'static str,
}

const BROWSERS: &[Browser] = &[
    Browser { key: "chrome", family: Family::Chromium, mac: "Google/Chrome/NativeMessagingHosts", linux: ".config/google-chrome/NativeMessagingHosts", win: r"Google\Chrome\NativeMessagingHosts" },
    Browser { key: "edge", family: Family::Chromium, mac: "Microsoft Edge/NativeMessagingHosts", linux: ".config/microsoft-edge/NativeMessagingHosts", win: r"Microsoft\Edge\NativeMessagingHosts" },
    Browser { key: "brave", family: Family::Chromium, mac: "BraveSoftware/Brave-Browser/NativeMessagingHosts", linux: ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts", win: r"BraveSoftware\Brave-Browser\NativeMessagingHosts" },
    Browser { key: "chromium", family: Family::Chromium, mac: "Chromium/NativeMessagingHosts", linux: ".config/chromium/NativeMessagingHosts", win: r"Chromium\NativeMessagingHosts" },
    Browser { key: "firefox", family: Family::Firefox, mac: "Mozilla/NativeMessagingHosts", linux: ".mozilla/native-messaging-hosts", win: r"Mozilla\NativeMessagingHosts" },
];

fn enabled(cfg: &BrowserIntegration, key: &str) -> bool {
    match key {
        "chrome" => cfg.chrome,
        "edge" => cfg.edge,
        "brave" => cfg.brave,
        "chromium" => cfg.chromium,
        "firefox" => cfg.firefox,
        _ => false,
    }
}

/// Location of the `vaultlet-host` binary: next to the app executable (sidecar in bundles,
/// `target/debug` in development), or `VAULTLET_HOST_PATH`.
pub fn host_binary() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("VAULTLET_HOST_PATH") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) { "vaultlet-host.exe" } else { "vaultlet-host" };
    let candidates = [dir.join(name), dir.join(format!("{name}-{}", std::env::consts::ARCH))];
    candidates.into_iter().find(|p| p.exists())
}

fn manifest_json(family: Family, host: &std::path::Path) -> String {
    let mut m = serde_json::json!({
        "name": vault_ipc::HOST_NAME,
        "description": "Vaultlet browser integration",
        "path": host.to_string_lossy(),
        "type": "stdio",
    });
    match family {
        Family::Chromium => {
            m["allowed_origins"] = serde_json::json!([format!("chrome-extension://{}/", EXTENSION_ID.trim())]);
        }
        Family::Firefox => {
            m["allowed_extensions"] = serde_json::json!([FIREFOX_ID]);
        }
    }
    serde_json::to_string_pretty(&m).unwrap_or_default()
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

/// Where the manifest file goes for this browser on this OS.
fn manifest_path(b: &Browser) -> Option<PathBuf> {
    let file = format!("{}.json", vault_ipc::HOST_NAME);
    #[cfg(target_os = "macos")]
    {
        return Some(home()?.join("Library/Application Support").join(b.mac).join(file));
    }
    #[cfg(target_os = "linux")]
    {
        return Some(home()?.join(b.linux).join(file));
    }
    #[cfg(windows)]
    {
        let appdata = std::env::var_os("APPDATA").map(PathBuf::from).or_else(home)?;
        return Some(appdata.join("Vaultlet").join(b.key).join(file));
    }
    #[allow(unreachable_code)]
    None
}

#[cfg(windows)]
fn registry_set(b: &Browser, manifest: Option<&std::path::Path>) -> std::io::Result<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = format!(r"Software\{}\{}", b.win, vault_ipc::HOST_NAME);
    match manifest {
        Some(m) => {
            let (key, _) = hkcu.create_subkey(&path)?;
            key.set_value("", &m.to_string_lossy().into_owned())?;
        }
        None => {
            let _ = hkcu.delete_subkey_all(&path);
        }
    }
    Ok(())
}

fn install(b: &Browser, host: &std::path::Path) -> std::io::Result<()> {
    let path = manifest_path(b).ok_or_else(|| std::io::Error::other("unsupported platform"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, manifest_json(b.family, host))?;
    #[cfg(windows)]
    registry_set(b, Some(&path))?;
    Ok(())
}

fn uninstall(b: &Browser) -> std::io::Result<()> {
    if let Some(path) = manifest_path(b) {
        if path.exists() {
            let ours = std::fs::read_to_string(&path).map(|s| s.contains(vault_ipc::HOST_NAME)).unwrap_or(false);
            if ours {
                std::fs::remove_file(&path)?;
            }
        }
    }
    #[cfg(windows)]
    registry_set(b, None)?;
    Ok(())
}

/// Write manifests for enabled browsers and remove them for disabled ones.
pub fn apply(cfg: &BrowserIntegration) -> Vec<ApplyResult> {
    let host = host_binary();
    BROWSERS
        .iter()
        .map(|b| {
            let want = enabled(cfg, b.key);
            let r = if want {
                match &host {
                    Some(h) => install(b, h),
                    None => Err(std::io::Error::other("vaultlet-host binary not found next to the app")),
                }
            } else {
                uninstall(b)
            };
            match r {
                Ok(()) => ApplyResult {
                    browser: b.key.into(),
                    ok: true,
                    message: Some(if want { "enabled".into() } else { "disabled".into() }),
                },
                Err(e) => ApplyResult { browser: b.key.into(), ok: false, message: Some(e.to_string()) },
            }
        })
        .collect()
}
