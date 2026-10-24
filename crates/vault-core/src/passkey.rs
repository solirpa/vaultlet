//! Passkeys (WebAuthn credentials) stored in KeePassXC's format (`KPEX_PASSKEY_*` fields,
//! KeePassXC 2.7.7+), and producing WebAuthn assertions with them.
//!
//! Signing happens here, inside the desktop process: the browser extension only ever receives
//! the authenticator data and the signature, never the private key.

use base64::Engine;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::pkcs8::DecodePrivateKey;
use sha2::{Digest, Sha256};

use crate::model::Item;
use crate::{Error, Result};

pub const FIELD_USERNAME: &str = "KPEX_PASSKEY_USERNAME";
pub const FIELD_CREDENTIAL_ID: &str = "KPEX_PASSKEY_CREDENTIAL_ID";
pub const FIELD_PRIVATE_KEY: &str = "KPEX_PASSKEY_PRIVATE_KEY_PEM";
pub const FIELD_RELYING_PARTY: &str = "KPEX_PASSKEY_RELYING_PARTY";
pub const FIELD_USER_HANDLE: &str = "KPEX_PASSKEY_USER_HANDLE";

const B64URL: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// Authenticator data flags: user present, user verified (the vault was unlocked with the
/// master password), backup eligible and backed up (the vault is a synced file).
const FLAGS: u8 = 0x01 | 0x04 | 0x08 | 0x10;

/// The passkey stored on an item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Passkey {
    pub rp_id: String,
    pub credential_id: Vec<u8>,
    pub username: String,
    pub user_handle: Option<Vec<u8>>,
    private_key_pem: String,
}

/// A WebAuthn assertion (`navigator.credentials.get` result), minus the client data, which the
/// caller built and hashed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assertion {
    pub credential_id: Vec<u8>,
    pub authenticator_data: Vec<u8>,
    /// ASN.1 DER encoded ECDSA signature, as WebAuthn expects for ES256.
    pub signature: Vec<u8>,
    pub user_handle: Option<Vec<u8>>,
}

impl Passkey {
    /// The passkey of an item, if it has a usable one.
    pub fn from_item(item: &Item) -> Option<Passkey> {
        let field = |name: &str| item.fields.iter().find(|f| f.name == name).map(|f| f.value.trim().to_string());
        let rp_id = field(FIELD_RELYING_PARTY).filter(|s| !s.is_empty())?.to_ascii_lowercase();
        let credential_id = decode_credential_id(&field(FIELD_CREDENTIAL_ID)?)?;
        let private_key_pem = field(FIELD_PRIVATE_KEY).filter(|s| !s.is_empty())?;
        let username = field(FIELD_USERNAME).filter(|s| !s.is_empty()).unwrap_or_else(|| item.username.clone());
        let user_handle = field(FIELD_USER_HANDLE).and_then(|h| decode_b64(&h));
        Some(Passkey { rp_id, credential_id, username, user_handle, private_key_pem })
    }

    /// Sign an assertion for `client_data_hash` (SHA-256 of the clientDataJSON).
    pub fn assert(&self, client_data_hash: &[u8]) -> Result<Assertion> {
        if client_data_hash.len() != 32 {
            return Err(Error::InvalidArgument("client data hash must be 32 bytes".into()));
        }
        let key = SigningKey::from_pkcs8_pem(&self.private_key_pem)
            .map_err(|_| Error::Crypto("unsupported passkey key (only ES256 / P-256 is supported)".into()))?;
        let mut authenticator_data = Sha256::digest(self.rp_id.as_bytes()).to_vec();
        authenticator_data.push(FLAGS);
        // Synced passkeys cannot keep a monotonic counter; 0 tells the site not to check it.
        authenticator_data.extend_from_slice(&0u32.to_be_bytes());
        let mut signed = authenticator_data.clone();
        signed.extend_from_slice(client_data_hash);
        let signature: Signature = key.sign(&signed);
        Ok(Assertion {
            credential_id: self.credential_id.clone(),
            authenticator_data,
            signature: signature.to_der().as_bytes().to_vec(),
            user_handle: self.user_handle.clone(),
        })
    }
}

/// Credential IDs are base64url in KeePassXC's format. Bitwarden exports them as a GUID
/// (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, the 16 raw bytes in order) or as `b64.<base64url>`;
/// older Vaultlet imports copied those verbatim, so accept all three.
pub fn decode_credential_id(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if let Some(bytes) = parse_guid(s) {
        return Some(bytes);
    }
    let s = s.strip_prefix("b64.").unwrap_or(s);
    decode_b64(s).filter(|b| !b.is_empty())
}

/// Credential ID in the format KeePassXC stores (base64url, no padding).
pub fn encode_credential_id(bytes: &[u8]) -> String {
    B64URL.encode(bytes)
}

fn parse_guid(s: &str) -> Option<Vec<u8>> {
    let parts: Vec<&str> = s.split('-').collect();
    let lens: Vec<usize> = parts.iter().map(|p| p.len()).collect();
    if lens != [8, 4, 4, 4, 12] {
        return None;
    }
    let hex: String = parts.concat();
    (0..16).map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()).collect()
}

fn decode_b64(s: &str) -> Option<Vec<u8>> {
    let s = s.trim().trim_end_matches('=');
    B64URL
        .decode(s)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(s))
        .ok()
}

/// WebAuthn's rule for which relying party an origin may act for: the origin must be secure
/// (https, or http on localhost), and the RP ID must be the origin's host or a registrable
/// suffix of it — never a public suffix such as `com` or `github.io`.
pub fn rp_id_allowed(rp_id: &str, origin: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    let Some(host) = url.host_str().map(|h| h.trim_end_matches('.').to_ascii_lowercase()) else {
        return false;
    };
    let rp_id = rp_id.trim_end_matches('.').to_ascii_lowercase();
    let localhost = host == "localhost" || host.ends_with(".localhost");
    match url.scheme() {
        "https" => {}
        "http" if localhost => {}
        _ => return false,
    }
    if rp_id.is_empty() {
        return false;
    }
    if matches!(url.host(), Some(url::Host::Ipv4(_)) | Some(url::Host::Ipv6(_))) {
        return rp_id == host;
    }
    if host != rp_id && !host.ends_with(&format!(".{rp_id}")) {
        return false;
    }
    if rp_id == "localhost" {
        return true;
    }
    // Reject public suffixes (`com`, `co.uk`, `github.io`, ...).
    psl::suffix_str(&rp_id).map(|s| s != rp_id).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Field, ItemKind};
    use p256::ecdsa::signature::Verifier;
    use p256::ecdsa::VerifyingKey;
    use p256::pkcs8::{EncodePrivateKey, LineEnding};

    fn item_with_key(key: &SigningKey, credential_id: &str) -> Item {
        let pem = key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
        let mut item = Item::new(ItemKind::Login, "AWS");
        item.username = "alice".into();
        item.fields = vec![
            Field::new(FIELD_USERNAME, "alice"),
            Field::new(FIELD_CREDENTIAL_ID, credential_id),
            Field::protected(FIELD_PRIVATE_KEY, pem),
            Field::new(FIELD_RELYING_PARTY, "aws.amazon.com"),
            Field::protected(FIELD_USER_HANDLE, "dXNlci1oYW5kbGU"),
        ];
        item
    }

    #[test]
    fn signs_a_verifiable_assertion() {
        let key = SigningKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
        let pk = Passkey::from_item(&item_with_key(&key, "AQIDBA")).unwrap();
        assert_eq!(pk.rp_id, "aws.amazon.com");
        assert_eq!(pk.credential_id, vec![1, 2, 3, 4]);
        assert_eq!(pk.user_handle.as_deref(), Some(&b"user-handle"[..]));

        let client_data_hash = Sha256::digest(br#"{"type":"webauthn.get"}"#);
        let a = pk.assert(&client_data_hash).unwrap();
        assert_eq!(&a.authenticator_data[..32], Sha256::digest(b"aws.amazon.com").as_slice());
        assert_eq!(a.authenticator_data[32], 0x1d);
        assert_eq!(a.authenticator_data.len(), 37);

        let mut signed = a.authenticator_data.clone();
        signed.extend_from_slice(&client_data_hash);
        let sig = Signature::from_der(&a.signature).unwrap();
        VerifyingKey::from(&key).verify(&signed, &sig).unwrap();
    }

    #[test]
    fn credential_id_formats() {
        // Bitwarden GUID: the raw bytes in order.
        assert_eq!(
            decode_credential_id("e8d88789-e916-e196-e3ee-a5ae51df8b8b").unwrap(),
            vec![0xe8, 0xd8, 0x87, 0x89, 0xe9, 0x16, 0xe1, 0x96, 0xe3, 0xee, 0xa5, 0xae, 0x51, 0xdf, 0x8b, 0x8b]
        );
        assert_eq!(decode_credential_id("b64.AQIDBA").unwrap(), vec![1, 2, 3, 4]);
        assert_eq!(decode_credential_id("AQIDBA").unwrap(), vec![1, 2, 3, 4]);
        assert_eq!(decode_credential_id("AQIDBA==").unwrap(), vec![1, 2, 3, 4]);
        assert!(decode_credential_id("").is_none());
        assert_eq!(encode_credential_id(&[1, 2, 3, 4]), "AQIDBA");
    }

    #[test]
    fn items_without_a_full_passkey_are_ignored() {
        let mut item = Item::new(ItemKind::Login, "x");
        assert!(Passkey::from_item(&item).is_none());
        item.fields.push(Field::new(FIELD_RELYING_PARTY, "example.com"));
        item.fields.push(Field::new(FIELD_CREDENTIAL_ID, "AQID"));
        assert!(Passkey::from_item(&item).is_none()); // no key
    }

    #[test]
    fn rejects_other_key_types() {
        let mut item = item_with_key(&SigningKey::random(&mut p256::elliptic_curve::rand_core::OsRng), "AQID");
        item.fields[2].value = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----".into();
        let pk = Passkey::from_item(&item).unwrap();
        assert!(matches!(pk.assert(&[0u8; 32]), Err(Error::Crypto(_))));
        assert!(matches!(pk.assert(&[0u8; 5]), Err(Error::InvalidArgument(_))));
    }

    #[test]
    fn rp_id_rules() {
        assert!(rp_id_allowed("aws.amazon.com", "https://us-east-1.signin.aws.amazon.com"));
        assert!(rp_id_allowed("amazon.com", "https://signin.aws.amazon.com"));
        assert!(rp_id_allowed("github.com", "https://github.com:443"));
        assert!(rp_id_allowed("localhost", "http://localhost:8080"));
        // Different site, parent public suffix, insecure origin, look-alike suffix.
        assert!(!rp_id_allowed("aws.amazon.com", "https://evil.example"));
        assert!(!rp_id_allowed("com", "https://amazon.com"));
        assert!(!rp_id_allowed("github.io", "https://someone.github.io"));
        assert!(!rp_id_allowed("amazon.com", "http://amazon.com"));
        assert!(!rp_id_allowed("amazon.com", "https://notamazon.com"));
        assert!(!rp_id_allowed("signin.aws.amazon.com", "https://aws.amazon.com"));
        assert!(!rp_id_allowed("", "https://amazon.com"));
        assert!(!rp_id_allowed("amazon.com", "not a url"));
    }
}
