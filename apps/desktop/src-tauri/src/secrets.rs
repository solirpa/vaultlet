//! Small secrets (WebDAV password, the app's X25519 secret key) in the OS keychain, with a
//! permission-restricted file fallback for systems without a usable keyring.

use std::path::{Path, PathBuf};

const SERVICE: &str = "com.vaultlet.app";

pub struct Secrets {
    fallback_dir: PathBuf,
}

impl Secrets {
    pub fn new(config_dir: &Path) -> Secrets {
        Secrets { fallback_dir: config_dir.join("secrets") }
    }

    fn file(&self, key: &str) -> PathBuf {
        self.fallback_dir.join(format!("{key}.secret"))
    }

    pub fn get(&self, key: &str) -> Option<String> {
        if let Ok(entry) = keyring::Entry::new(SERVICE, key) {
            if let Ok(v) = entry.get_password() {
                return Some(v);
            }
        }
        std::fs::read_to_string(self.file(key)).ok().map(|s| s.trim_end().to_string())
    }

    pub fn set(&self, key: &str, value: &str) -> std::io::Result<()> {
        if let Ok(entry) = keyring::Entry::new(SERVICE, key) {
            if entry.set_password(value).is_ok() {
                let _ = std::fs::remove_file(self.file(key));
                return Ok(());
            }
        }
        std::fs::create_dir_all(&self.fallback_dir)?;
        let path = self.file(key);
        std::fs::write(&path, value)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    /// File-only storage (0600) for secrets that must never trigger a keychain prompt at
    /// startup, such as the app's own X25519 key. The vault itself stays encrypted regardless.
    pub fn get_file(&self, key: &str) -> Option<String> {
        std::fs::read_to_string(self.file(key)).ok().map(|s| s.trim_end().to_string())
    }

    pub fn set_file(&self, key: &str, value: &str) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.fallback_dir)?;
        let path = self.file(key);
        std::fs::write(&path, value)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    pub fn delete(&self, key: &str) {
        if let Ok(entry) = keyring::Entry::new(SERVICE, key) {
            let _ = entry.delete_credential();
        }
        let _ = std::fs::remove_file(self.file(key));
    }
}
