//! Vaultlet core library: a KDBX 4 vault behind a small, Bitwarden-shaped model.
//!
//! See `docs/ARCHITECTURE.md` sections 1, 2 and 4 for the contract this crate implements.
//! Nothing from the `keepass` crate leaks through the public API.

pub mod error;
pub mod generator;
pub mod import;
pub mod matching;
pub mod merge;
pub mod model;
pub mod sync;
pub mod totp;
pub mod vault;

pub use error::{Error, Result};
pub use generator::{password_generate, strength};
pub use import::{BitwardenSource, ImportResult};
pub use matching::match_items;
pub use merge::MergeReport;
pub use model::{Field, Folder, Item, ItemKind, ItemSummary};
pub use totp::Code as TotpCode;
pub use vault::{Credentials, Vault};
