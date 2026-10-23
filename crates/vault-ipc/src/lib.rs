//! Shared plumbing between the desktop app and the browser native messaging host.
//!
//! Both sides speak the same frame format as Chrome native messaging:
//! a 4-byte little-endian length prefix followed by a UTF-8 JSON document.

#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ToFsName};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
use interprocess::local_socket::Name;
use std::io;
#[cfg(unix)]
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Maximum accepted frame size (native messaging caps host→browser at 1 MiB).
pub const MAX_FRAME: u32 = 1024 * 1024;

/// Name of the native messaging host as registered with browsers.
pub const HOST_NAME: &str = "com.vaultlet.host";

/// Bundle identifier of the desktop app; also the config directory name.
pub const APP_ID: &str = "com.vaultlet.app";

/// Filesystem path of the local socket on Unix platforms.
#[cfg(unix)]
pub fn socket_path() -> PathBuf {
    if let Some(p) = std::env::var_os("VAULTLET_SOCKET") {
        return PathBuf::from(p);
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home)
                .join("Library/Application Support")
                .join(APP_ID)
                .join("vaultlet.sock");
        }
    }
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir).join("vaultlet.sock");
    }
    let uid = unsafe { libc_getuid() };
    PathBuf::from(format!("/tmp/vaultlet-{uid}.sock"))
}

#[cfg(unix)]
unsafe fn libc_getuid() -> u32 {
    extern "C" {
        fn getuid() -> u32;
    }
    getuid()
}

/// Named pipe name on Windows (`\\.\pipe\<name>`). Pipe names are machine-wide, so include
/// the user to keep sessions of different users apart.
#[cfg(windows)]
pub fn pipe_name() -> String {
    if let Some(p) = std::env::var_os("VAULTLET_SOCKET") {
        return p.to_string_lossy().into_owned();
    }
    let user = std::env::var("USERNAME").unwrap_or_default();
    let domain = std::env::var("USERDOMAIN").unwrap_or_default();
    let tag: String = format!("{domain}.{user}")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect();
    format!("vaultlet-{tag}")
}

/// Local socket name usable with `interprocess` on every platform.
pub fn socket_name() -> io::Result<Name<'static>> {
    #[cfg(windows)]
    {
        pipe_name().to_ns_name::<GenericNamespaced>()
    }
    #[cfg(unix)]
    {
        let path = socket_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        path.to_fs_name::<GenericFilePath>()
    }
}

/// Read one length-prefixed JSON frame. Returns `Ok(None)` on clean EOF.
pub async fn read_frame<R: AsyncReadExt + Unpin>(r: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len);
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

/// Write one length-prefixed frame.
pub async fn write_frame<W: AsyncWriteExt + Unpin>(w: &mut W, payload: &[u8]) -> io::Result<()> {
    if payload.len() as u64 > MAX_FRAME as u64 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    w.write_all(&(payload.len() as u32).to_le_bytes()).await?;
    w.write_all(payload).await?;
    w.flush().await
}

/// Convenience: write a serde_json value as a frame.
pub async fn write_json<W: AsyncWriteExt + Unpin>(w: &mut W, v: &serde_json::Value) -> io::Result<()> {
    write_frame(w, v.to_string().as_bytes()).await
}
