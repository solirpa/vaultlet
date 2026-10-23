//! Crate-wide error type. Serializes to `{ code, message }` so the Tauri layer can pass it through.

use serde::ser::SerializeStruct;
use serde::Serialize;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0} not found")]
    NotFound(String),
    #[error("{0} already exists")]
    AlreadyExists(String),
    #[error("invalid password or key file")]
    InvalidKey,
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("vault format error: {0}")]
    Format(String),
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("cryptography error: {0}")]
    Crypto(String),
    #[error("TOTP error: {0}")]
    Totp(String),
    #[error("import error: {0}")]
    Import(String),
    /// The export is password protected and no (or a wrong) password was given.
    #[error("the Bitwarden export is password protected: {0}")]
    ImportPassword(String),
    #[error("network error: {0}")]
    Network(String),
    #[error("remote file was modified by someone else (precondition failed)")]
    PreconditionFailed,
    #[error("HTTP {status}: {message}")]
    Http { status: u16, message: String },
    #[error("{0}")]
    Other(String),
}

impl Error {
    /// Stable machine-readable code (kebab-case) used by the desktop app and the extension.
    pub fn code(&self) -> &'static str {
        match self {
            Error::NotFound(_) => "not-found",
            Error::AlreadyExists(_) => "already-exists",
            Error::InvalidKey => "invalid-key",
            Error::InvalidArgument(_) => "invalid-argument",
            Error::Format(_) => "format",
            Error::Io(_) => "io",
            Error::Crypto(_) => "crypto",
            Error::Totp(_) => "totp",
            Error::Import(_) => "import",
            Error::ImportPassword(_) => "import-password",
            Error::Network(_) => "network",
            Error::PreconditionFailed => "precondition-failed",
            Error::Http { .. } => "http",
            Error::Other(_) => "other",
        }
    }
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("Error", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

impl From<keepass::db::DatabaseOpenError> for Error {
    fn from(e: keepass::db::DatabaseOpenError) -> Self {
        use keepass::db::DatabaseOpenError as E;
        match e {
            E::Key(_) => Error::InvalidKey,
            E::Io(io) => Error::Io(io),
            other => Error::Format(other.to_string()),
        }
    }
}

impl From<keepass::db::DatabaseSaveError> for Error {
    fn from(e: keepass::db::DatabaseSaveError) -> Self {
        use keepass::db::DatabaseSaveError as E;
        match e {
            E::Io(io) => Error::Io(io),
            E::Key(_) => Error::InvalidKey,
            other => Error::Format(other.to_string()),
        }
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Import(e.to_string())
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Error::Network(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_code_message() {
        let v = serde_json::to_value(Error::NotFound("item".into())).unwrap();
        assert_eq!(v, serde_json::json!({"code": "not-found", "message": "item not found"}));
        let v = serde_json::to_value(Error::PreconditionFailed).unwrap();
        assert_eq!(v["code"], "precondition-failed");
    }
}
