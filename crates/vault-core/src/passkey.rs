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

/// The account a new passkey is created for (`PublicKeyCredentialUserEntity`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewPasskeyUser {
    /// user handle chosen by the site
    pub id: Vec<u8>,
    pub name: String,
}

/// A freshly created passkey plus what the site gets back from `navigator.credentials.create()`.
#[derive(Debug, Clone)]
pub struct Registration {
    /// `KPEX_PASSKEY_*` fields to store on the item
    pub fields: Vec<crate::model::Field>,
    pub credential_id: Vec<u8>,
    /// authenticator data with the attested credential (flags include AT)
    pub authenticator_data: Vec<u8>,
    /// CBOR `{ fmt: "none", attStmt: {}, authData }`
    pub attestation_object: Vec<u8>,
    /// SubjectPublicKeyInfo DER, for `getPublicKey()`
    pub public_key_spki: Vec<u8>,
}

/// COSE algorithm identifier of ES256, the only algorithm Vaultlet creates.
pub const COSE_ES256: i64 = -7;

/// Create a passkey for `rp_id`: a new P-256 key pair whose private half stays in the vault.
/// The attestation is "none" with an all-zero AAGUID, like most software passkey providers.
pub fn register(rp_id: &str, user: &NewPasskeyUser) -> Result<Registration> {
    use p256::elliptic_curve::rand_core::OsRng;
    use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};

    let rp_id = rp_id.to_ascii_lowercase();
    let key = SigningKey::random(&mut OsRng);
    let mut credential_id = vec![0u8; 16];
    getrandom::fill(&mut credential_id).map_err(|e| Error::Crypto(format!("os rng unavailable: {e}")))?;

    let point = key.verifying_key().to_encoded_point(false);
    let (x, y) = (point.x().ok_or_else(|| Error::Crypto("bad key".into()))?, point.y().ok_or_else(|| Error::Crypto("bad key".into()))?);
    // COSE_Key: { 1 (kty): 2 (EC2), 3 (alg): -7 (ES256), -1 (crv): 1 (P-256), -2 (x), -3 (y) }
    let mut cose = Vec::new();
    cbor::map_header(&mut cose, 5);
    for (k, v) in [(1, 2), (3, COSE_ES256), (-1, 1)] {
        cbor::int(&mut cose, k);
        cbor::int(&mut cose, v);
    }
    cbor::int(&mut cose, -2);
    cbor::bytes(&mut cose, x);
    cbor::int(&mut cose, -3);
    cbor::bytes(&mut cose, y);

    let mut authenticator_data = Sha256::digest(rp_id.as_bytes()).to_vec();
    authenticator_data.push(FLAGS | 0x40); // + attested credential data
    authenticator_data.extend_from_slice(&0u32.to_be_bytes());
    authenticator_data.extend_from_slice(&[0u8; 16]); // AAGUID
    authenticator_data.extend_from_slice(&(credential_id.len() as u16).to_be_bytes());
    authenticator_data.extend_from_slice(&credential_id);
    authenticator_data.extend_from_slice(&cose);

    let mut attestation_object = Vec::new();
    cbor::map_header(&mut attestation_object, 3);
    cbor::text(&mut attestation_object, "fmt");
    cbor::text(&mut attestation_object, "none");
    cbor::text(&mut attestation_object, "attStmt");
    cbor::map_header(&mut attestation_object, 0);
    cbor::text(&mut attestation_object, "authData");
    cbor::bytes(&mut attestation_object, &authenticator_data);

    let pem = key.to_pkcs8_pem(LineEnding::LF).map_err(|e| Error::Crypto(e.to_string()))?.to_string();
    let public_key_spki = key.verifying_key().to_public_key_der().map_err(|e| Error::Crypto(e.to_string()))?.into_vec();
    let fields = vec![
        crate::model::Field::new(FIELD_USERNAME, user.name.clone()),
        crate::model::Field::new(FIELD_CREDENTIAL_ID, encode_credential_id(&credential_id)),
        crate::model::Field::protected(FIELD_PRIVATE_KEY, pem),
        crate::model::Field::new(FIELD_RELYING_PARTY, rp_id),
        crate::model::Field::protected(FIELD_USER_HANDLE, B64URL.encode(&user.id)),
    ];
    Ok(Registration { fields, credential_id, authenticator_data, attestation_object, public_key_spki })
}

/// Just enough CBOR (RFC 8949) for COSE keys and attestation objects.
mod cbor {
    fn head(out: &mut Vec<u8>, major: u8, n: u64) {
        let m = major << 5;
        match n {
            0..=23 => out.push(m | n as u8),
            24..=0xff => out.extend_from_slice(&[m | 24, n as u8]),
            0x100..=0xffff => {
                out.push(m | 25);
                out.extend_from_slice(&(n as u16).to_be_bytes());
            }
            _ => {
                out.push(m | 26);
                out.extend_from_slice(&(n as u32).to_be_bytes());
            }
        }
    }
    pub fn int(out: &mut Vec<u8>, v: i64) {
        if v >= 0 {
            head(out, 0, v as u64)
        } else {
            head(out, 1, (-1 - v) as u64)
        }
    }
    pub fn bytes(out: &mut Vec<u8>, b: &[u8]) {
        head(out, 2, b.len() as u64);
        out.extend_from_slice(b);
    }
    pub fn text(out: &mut Vec<u8>, s: &str) {
        head(out, 3, s.len() as u64);
        out.extend_from_slice(s.as_bytes());
    }
    pub fn map_header(out: &mut Vec<u8>, len: u64) {
        head(out, 5, len);
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
    fn registration_round_trip() {
        use ciborium::value::Value;
        let user = NewPasskeyUser { id: b"user-42".to_vec(), name: "alice@example.com".into() };
        let reg = register("Example.COM", &user).unwrap();

        // The stored fields make a usable passkey for the same credential.
        let mut item = Item::new(ItemKind::Login, "example.com");
        item.fields = reg.fields.clone();
        let pk = Passkey::from_item(&item).unwrap();
        assert_eq!(pk.rp_id, "example.com");
        assert_eq!(pk.credential_id, reg.credential_id);
        assert_eq!(pk.username, "alice@example.com");
        assert_eq!(pk.user_handle.as_deref(), Some(&b"user-42"[..]));
        assert_eq!(reg.credential_id.len(), 16);

        // Attestation object, decoded by an independent CBOR implementation.
        let att: Value = ciborium::from_reader(reg.attestation_object.as_slice()).unwrap();
        let map = att.as_map().unwrap();
        let get = |k: &str| map.iter().find(|(key, _)| key.as_text() == Some(k)).map(|(_, v)| v.clone()).unwrap();
        assert_eq!(get("fmt").as_text(), Some("none"));
        assert!(get("attStmt").as_map().unwrap().is_empty());
        let auth = get("authData").as_bytes().unwrap().clone();
        assert_eq!(auth, reg.authenticator_data);

        // authData: rpIdHash, flags (UP UV BE BS AT), counter, AAGUID, credential id, COSE key.
        assert_eq!(&auth[..32], Sha256::digest(b"example.com").as_slice());
        assert_eq!(auth[32], 0x5d);
        assert_eq!(&auth[33..37], &[0, 0, 0, 0]);
        assert_eq!(&auth[37..53], &[0u8; 16]);
        let id_len = u16::from_be_bytes([auth[53], auth[54]]) as usize;
        assert_eq!(&auth[55..55 + id_len], reg.credential_id.as_slice());
        let cose: Value = ciborium::from_reader(&auth[55 + id_len..]).unwrap();
        let cose = cose.as_map().unwrap();
        let int = |k: i64| cose.iter().find(|(key, _)| key.as_integer() == Some(k.into())).map(|(_, v)| v.clone()).unwrap();
        assert_eq!(int(1).as_integer(), Some(2.into()));
        assert_eq!(int(3).as_integer(), Some(COSE_ES256.into()));
        assert_eq!(int(-1).as_integer(), Some(1.into()));
        let (x, y) = (int(-2).as_bytes().unwrap().clone(), int(-3).as_bytes().unwrap().clone());

        // The COSE key and the SPKI are the same public key, and it verifies an assertion.
        let mut sec1 = vec![4u8];
        sec1.extend_from_slice(&x);
        sec1.extend_from_slice(&y);
        let vk = VerifyingKey::from_sec1_bytes(&sec1).unwrap();
        use p256::pkcs8::DecodePublicKey;
        assert_eq!(VerifyingKey::from_public_key_der(&reg.public_key_spki).unwrap(), vk);
        let hash = Sha256::digest(b"client data");
        let a = pk.assert(&hash).unwrap();
        let mut signed = a.authenticator_data.clone();
        signed.extend_from_slice(&hash);
        vk.verify(&signed, &Signature::from_der(&a.signature).unwrap()).unwrap();

        // Two registrations never share a credential.
        assert_ne!(register("example.com", &user).unwrap().credential_id, reg.credential_id);
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
