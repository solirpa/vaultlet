//! Detect local sync folders of iCloud Drive / Dropbox / OneDrive (architecture doc section 3).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[serde(rename = "icloud")]
    ICloud,
    Dropbox,
    OneDrive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudFolder {
    pub provider: Provider,
    pub path: PathBuf,
}

/// Paths listed in Dropbox's `info.json` (`personal.path`, `business.path`).
pub fn parse_dropbox_info(json: &str) -> Vec<PathBuf> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(obj) = v.as_object() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for key in ["personal", "business"] {
        if let Some(p) = obj.get(key).and_then(|a| a.get("path")).and_then(|p| p.as_str()) {
            out.push(PathBuf::from(p));
        }
    }
    // Any other account types
    for (k, v) in obj {
        if k != "personal" && k != "business" {
            if let Some(p) = v.get("path").and_then(|p| p.as_str()) {
                out.push(PathBuf::from(p));
            }
        }
    }
    out
}

fn home() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|b| b.home_dir().to_path_buf())
}

fn push_if_dir(out: &mut Vec<CloudFolder>, provider: Provider, path: PathBuf) {
    if path.is_dir() && !out.iter().any(|c| c.path == path) {
        out.push(CloudFolder { provider, path });
    }
}

fn dropbox_candidates(home: &Path) -> Vec<PathBuf> {
    let mut v = vec![home.join("Dropbox")];
    #[cfg(target_os = "windows")]
    let info = std::env::var_os("LOCALAPPDATA").map(|l| PathBuf::from(l).join("Dropbox").join("info.json"));
    #[cfg(not(target_os = "windows"))]
    let info = Some(home.join(".dropbox").join("info.json"));
    if let Some(info) = info {
        if let Ok(s) = std::fs::read_to_string(info) {
            v.extend(parse_dropbox_info(&s));
        }
    }
    v
}

/// Existing cloud sync directories on this machine, in a stable order.
pub fn detect() -> Vec<CloudFolder> {
    let mut out = Vec::new();
    let Some(home) = home() else {
        return out;
    };

    #[cfg(target_os = "macos")]
    {
        push_if_dir(
            &mut out,
            Provider::ICloud,
            home.join("Library/Mobile Documents/com~apple~CloudDocs"),
        );
        for p in dropbox_candidates(&home) {
            push_if_dir(&mut out, Provider::Dropbox, p);
        }
        push_if_dir(&mut out, Provider::OneDrive, home.join("OneDrive"));
        if let Ok(rd) = std::fs::read_dir(home.join("Library/CloudStorage")) {
            let mut dirs: Vec<PathBuf> = rd
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("OneDrive")))
                .collect();
            dirs.sort();
            for p in dirs {
                push_if_dir(&mut out, Provider::OneDrive, p);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        push_if_dir(&mut out, Provider::ICloud, home.join("iCloudDrive"));
        for p in dropbox_candidates(&home) {
            push_if_dir(&mut out, Provider::Dropbox, p);
        }
        if let Some(od) = std::env::var_os("OneDrive") {
            push_if_dir(&mut out, Provider::OneDrive, PathBuf::from(od));
        }
        push_if_dir(&mut out, Provider::OneDrive, home.join("OneDrive"));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for p in dropbox_candidates(&home) {
            push_if_dir(&mut out, Provider::Dropbox, p);
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropbox_info() {
        let j = r#"{"personal": {"path": "/Users/me/Dropbox", "host": 1}, "business": {"path": "/Users/me/Dropbox (Acme)"}}"#;
        assert_eq!(
            parse_dropbox_info(j),
            vec![PathBuf::from("/Users/me/Dropbox"), PathBuf::from("/Users/me/Dropbox (Acme)")]
        );
        assert!(parse_dropbox_info("not json").is_empty());
    }

    #[test]
    fn provider_json_names() {
        assert_eq!(serde_json::to_string(&Provider::ICloud).unwrap(), "\"icloud\"");
        assert_eq!(serde_json::to_string(&Provider::OneDrive).unwrap(), "\"onedrive\"");
        assert_eq!(serde_json::to_string(&Provider::Dropbox).unwrap(), "\"dropbox\"");
    }

    #[test]
    fn detect_returns_only_dirs() {
        for c in detect() {
            assert!(c.path.is_dir());
        }
    }
}
