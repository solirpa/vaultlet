//! Synchronisation helpers (architecture doc sections 3 and 4): WebDAV client, cloud folder
//! detection and atomic file helpers for the folder mode.

pub mod cloud_folders;
pub mod folder;
pub mod webdav;

pub use cloud_folders::{detect as detect_cloud_folders, CloudFolder, Provider};
pub use folder::{atomic_write, conflict_copies, file_fingerprint, Fingerprint};
pub use webdav::{Client as WebDavClient, GetResult};
