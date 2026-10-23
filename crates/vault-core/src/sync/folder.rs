//! Helpers for the "folder" sync mode: atomic writes, change detection and cloud conflict copies.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// `(mtime, len)` of a file, used to detect external changes before saving.
pub type Fingerprint = (SystemTime, u64);

/// Write `bytes` to a temp file in the same directory, flush, then rename over `path`.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    let nonce = getrandom::u64().map_err(|e| io::Error::other(format!("rng: {e}")))?;
    let tmp = dir.join(format!(".{name}.{nonce:016x}.tmp"));
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// `(mtime, len)` of `path`.
pub fn file_fingerprint(path: &Path) -> io::Result<Fingerprint> {
    let md = fs::metadata(path)?;
    Ok((md.modified()?, md.len()))
}

const CONFLICT_MARKERS: &[&str] = &["(冲突", "冲突副本", "冲突", "conflicted copy", "conflict", " - Copy", "副本"];

fn is_conflict_name(stem: &str, ext: Option<&str>, candidate: &str) -> bool {
    let Some(rest) = candidate.strip_prefix(stem) else {
        return false;
    };
    let rest = match ext {
        Some(ext) => match rest.strip_suffix(ext).and_then(|r| r.strip_suffix('.')) {
            Some(r) => r,
            None => return false,
        },
        None => rest,
    };
    if rest.is_empty() {
        return false;
    }
    if CONFLICT_MARKERS.iter().any(|m| rest.contains(m)) {
        return true;
    }
    // "Vaultlet (1).kdbx", "Vaultlet(2).kdbx"
    let t = rest.trim();
    t.strip_prefix('(')
        .and_then(|t| t.strip_suffix(')'))
        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

/// Sibling files that look like cloud-provider conflict copies of `path`
/// (`Vaultlet (冲突).kdbx`, `Vaultlet (xxx's conflicted copy 2024-01-01).kdbx`, `Vaultlet (1).kdbx`,
/// `Vaultlet - Copy.kdbx`, `Vaultlet 冲突副本.kdbx`...). Sorted by name.
pub fn conflict_copies(path: &Path) -> Vec<PathBuf> {
    let (Some(stem), Some(dir)) = (path.file_stem().and_then(|s| s.to_str()), path.parent()) else {
        return Vec::new();
    };
    let ext = path.extension().and_then(|e| e.to_str());
    let dir = if dir.as_os_str().is_empty() { Path::new(".") } else { dir };
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let own = path.file_name();
    let mut out: Vec<PathBuf> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter(|e| Some(e.file_name().as_os_str()) != own)
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| is_conflict_name(stem, ext, n))
        })
        .map(|e| e.path())
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflict_names() {
        let k = Some("kdbx");
        assert!(is_conflict_name("Vaultlet", k, "Vaultlet (冲突).kdbx"));
        assert!(is_conflict_name("Vaultlet", k, "Vaultlet (张三's conflicted copy 2024-01-01).kdbx"));
        assert!(is_conflict_name("Vaultlet", k, "Vaultlet (1).kdbx"));
        assert!(is_conflict_name("Vaultlet", k, "Vaultlet - Copy.kdbx"));
        assert!(is_conflict_name("Vaultlet", k, "Vaultlet 冲突副本.kdbx"));
        assert!(!is_conflict_name("Vaultlet", k, "Vaultlet.kdbx"));
        assert!(!is_conflict_name("Vaultlet", k, "Vaultlet.kdbx.bak"));
        assert!(!is_conflict_name("Vaultlet", k, "Vaultlet2.kdbx"));
        assert!(!is_conflict_name("Vaultlet", k, "Other (1).kdbx"));
    }

    #[test]
    fn atomic_write_and_fingerprint_and_copies() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("Vaultlet.kdbx");
        atomic_write(&p, b"hello").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"hello");
        atomic_write(&p, b"hello world").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"hello world");
        let fp = file_fingerprint(&p).unwrap();
        assert_eq!(fp.1, 11);
        // no temp files left behind
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);

        fs::write(dir.path().join("Vaultlet (冲突).kdbx"), b"x").unwrap();
        fs::write(dir.path().join("Vaultlet (1).kdbx"), b"x").unwrap();
        fs::write(dir.path().join("Vaultlet.kdbx.bak"), b"x").unwrap();
        let copies = conflict_copies(&p);
        let names: Vec<String> = copies
            .iter()
            .map(|c| c.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["Vaultlet (1).kdbx", "Vaultlet (冲突).kdbx"]);
    }
}
