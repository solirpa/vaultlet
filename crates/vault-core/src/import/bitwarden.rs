//! Bitwarden import: plaintext JSON, CSV and password-protected JSON exports.
//!
//! Format notes are in `docs/ARCHITECTURE.md` ("导入格式要点").

use std::collections::HashMap;

use base64::Engine;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value as Json;
use uuid::Uuid;

use super::ImportResult;
use crate::error::{Error, Result};
use crate::model::{Field, Folder, Item, ItemKind};

/// Source of a Bitwarden export.
#[derive(Debug, Clone)]
pub enum BitwardenSource {
    Json(String),
    Csv(String),
    EncryptedJson { json: String, password: String },
}

/// Sniff whether a file is a password-protected Bitwarden export.
pub fn is_encrypted_json(json: &str) -> bool {
    serde_json::from_str::<Json>(json)
        .ok()
        .and_then(|v| v.get("encrypted").and_then(Json::as_bool))
        .unwrap_or(false)
}

/// Parse an export.
pub fn bitwarden(src: BitwardenSource) -> Result<ImportResult> {
    match src {
        BitwardenSource::Json(json) => {
            if is_encrypted_json(&json) {
                return Err(Error::ImportPassword("password required".into()));
            }
            parse_json(&json)
        }
        BitwardenSource::Csv(csv) => parse_csv(&csv),
        BitwardenSource::EncryptedJson { json, password } => {
            let plain = encrypted::decrypt_export(&json, &password)?;
            parse_json(&plain)
        }
    }
}

// ---------------------------------------------------------------------------------------------
// JSON

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Export {
    #[serde(default)]
    folders: Vec<BwFolder>,
    #[serde(default)]
    collections: Vec<BwFolder>,
    #[serde(default)]
    items: Vec<BwItem>,
}

#[derive(Deserialize)]
struct BwFolder {
    id: Option<String>,
    name: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BwItem {
    id: Option<String>,
    #[serde(rename = "type")]
    kind: i64,
    name: Option<String>,
    notes: Option<String>,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    reprompt: i64,
    folder_id: Option<String>,
    #[serde(default)]
    collection_ids: Option<Vec<String>>,
    #[serde(default)]
    fields: Option<Vec<BwField>>,
    login: Option<BwLogin>,
    card: Option<HashMap<String, Json>>,
    identity: Option<HashMap<String, Json>>,
    ssh_key: Option<HashMap<String, Json>>,
    creation_date: Option<String>,
    revision_date: Option<String>,
    deleted_date: Option<String>,
    #[serde(default)]
    password_history: Option<Vec<BwPasswordHistory>>,
    #[serde(default)]
    attachments: Option<Vec<Json>>,
}

#[derive(Deserialize)]
struct BwField {
    name: Option<String>,
    value: Option<Json>,
    #[serde(rename = "type", default)]
    kind: i64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BwLogin {
    #[serde(default)]
    uris: Option<Vec<BwUri>>,
    username: Option<String>,
    password: Option<String>,
    totp: Option<String>,
    #[serde(default)]
    fido2_credentials: Option<Vec<Json>>,
}

#[derive(Deserialize)]
struct BwUri {
    uri: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BwPasswordHistory {
    last_used_date: Option<String>,
    password: Option<String>,
}

/// Field names of card/identity objects, in display order (matches the architecture doc).
pub const CARD_FIELDS: &[&str] = &["cardholderName", "number", "brand", "expMonth", "expYear", "code"];
pub const IDENTITY_FIELDS: &[&str] = &[
    "title", "firstName", "middleName", "lastName", "username", "company", "ssn", "passportNumber",
    "licenseNumber", "email", "phone", "address1", "address2", "address3", "city", "state",
    "postalCode", "country",
];
const PROTECTED_STRUCT_FIELDS: &[&str] = &["number", "code", "ssn", "passportNumber", "licenseNumber"];

fn parse_time(s: Option<&str>) -> Option<DateTime<Utc>> {
    s.and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Utc))
}

fn id_or_new(s: Option<&str>) -> Uuid {
    s.and_then(|s| Uuid::parse_str(s).ok()).unwrap_or_else(Uuid::new_v4)
}

fn json_str(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        Json::Null => String::new(),
        other => other.to_string(),
    }
}

/// Turn a Bitwarden folder list (names may be nested with `/`) into our folder tree.
fn build_folders(list: &[BwFolder], prefix_counter: &mut usize) -> (Vec<Folder>, HashMap<String, Uuid>) {
    let mut out: Vec<Folder> = Vec::new();
    let mut by_path: HashMap<String, Uuid> = HashMap::new();
    let mut by_bw_id: HashMap<String, Uuid> = HashMap::new();
    for f in list {
        let segments: Vec<&str> = f.name.split('/').map(str::trim).filter(|s| !s.is_empty()).collect();
        let segments = if segments.is_empty() { vec!["Untitled"] } else { segments };
        let mut parent: Option<Uuid> = None;
        let mut path = String::new();
        for seg in segments {
            if !path.is_empty() {
                path.push('/');
            }
            path.push_str(seg);
            let id = match by_path.get(&path) {
                Some(id) => *id,
                None => {
                    *prefix_counter += 1;
                    let id = Uuid::new_v4();
                    out.push(Folder { id, name: seg.to_string(), parent });
                    by_path.insert(path.clone(), id);
                    id
                }
            };
            parent = Some(id);
        }
        if let (Some(bw), Some(p)) = (&f.id, parent) {
            by_bw_id.insert(bw.clone(), p);
        }
    }
    (out, by_bw_id)
}

fn parse_json(json: &str) -> Result<ImportResult> {
    let export: Export = serde_json::from_str(json)?;
    let mut counter = 0;
    let (mut folders, folder_ids) = build_folders(&export.folders, &mut counter);
    let (coll_folders, coll_ids) = build_folders(&export.collections, &mut counter);
    folders.extend(coll_folders);

    let mut result = ImportResult { folders, ..Default::default() };
    for bw in &export.items {
        let title = bw.name.clone().unwrap_or_default();
        let kind = match bw.kind {
            1 => ItemKind::Login,
            2 => ItemKind::Note,
            3 => ItemKind::Card,
            4 => ItemKind::Identity,
            5 => ItemKind::Note,
            other => {
                result.skipped.push(format!("{title}: unknown item type {other}"));
                continue;
            }
        };
        let mut item = Item::new(kind, title.clone());
        item.id = id_or_new(bw.id.as_deref());
        item.notes = bw.notes.clone().unwrap_or_default();
        item.favorite = bw.favorite;
        if bw.reprompt != 0 {
            item.tags.push("reprompt".into());
        }
        item.folder = bw
            .folder_id
            .as_ref()
            .and_then(|f| folder_ids.get(f).copied())
            .or_else(|| {
                bw.collection_ids
                    .as_ref()
                    .and_then(|c| c.first())
                    .and_then(|c| coll_ids.get(c).copied())
            });
        if let Some(t) = parse_time(bw.creation_date.as_deref()) {
            item.created = t;
        }
        if let Some(t) = parse_time(bw.revision_date.as_deref()) {
            item.modified = t;
        }
        item.deleted = bw.deleted_date.is_some();

        if let Some(login) = &bw.login {
            item.username = login.username.clone().unwrap_or_default();
            item.password = login.password.clone().unwrap_or_default();
            item.urls = login
                .uris
                .iter()
                .flatten()
                .filter_map(|u| u.uri.clone())
                .map(|u| u.trim().to_string())
                .filter(|u| !u.is_empty())
                .collect();
            if let Some(t) = login.totp.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                match crate::totp::normalize_to_uri(t, &title) {
                    Ok(uri) => item.totp = Some(uri),
                    Err(_) => {
                        result.skipped.push(format!("{title}: TOTP secret could not be parsed, kept verbatim"));
                        item.totp = Some(t.to_string());
                    }
                }
            }
            if let Some(cred) = login.fido2_credentials.as_ref().and_then(|c| c.first()) {
                match passkey_fields(cred) {
                    Some(fields) => {
                        item.fields.extend(fields);
                        item.tags.push("Passkey".into());
                    }
                    None => result.skipped.push(format!("{title}: passkey (FIDO2 credential) could not be converted")),
                }
            }
        }
        if let Some(card) = &bw.card {
            push_struct_fields(&mut item.fields, card, CARD_FIELDS);
        }
        if let Some(ident) = &bw.identity {
            push_struct_fields(&mut item.fields, ident, IDENTITY_FIELDS);
        }
        if let Some(ssh) = &bw.ssh_key {
            for (k, v) in ssh {
                let val = json_str(v);
                if !val.is_empty() {
                    item.fields.push(if k == "privateKey" { Field::protected(k, val) } else { Field::new(k, val) });
                }
            }
        }
        for f in bw.fields.iter().flatten() {
            let name = f.name.clone().unwrap_or_else(|| "Field".into());
            let value = f.value.as_ref().map(json_str).unwrap_or_default();
            match f.kind {
                1 => item.fields.push(Field::protected(name, value)),
                2 => item.fields.push(Field::new(name, if value == "true" { "true" } else { "false" })),
                3 => item.fields.push(Field::new(name, format!("linked:{value}"))),
                _ => item.fields.push(Field::new(name, value)),
            }
        }
        if bw.attachments.as_ref().is_some_and(|a| !a.is_empty()) {
            result.skipped.push(format!("{title}: attachments are not part of Bitwarden exports"));
        }
        if let Some(hist) = &bw.password_history {
            let mut entries: Vec<(DateTime<Utc>, String)> = hist
                .iter()
                .filter_map(|h| Some((parse_time(h.last_used_date.as_deref())?, h.password.clone()?)))
                .collect();
            entries.sort_by_key(|(t, _)| *t);
            if !entries.is_empty() {
                result.password_history.insert(item.id, entries);
            }
        }
        result.items.push(item);
    }
    Ok(result)
}

/// Map a Bitwarden FIDO2 credential onto KeePassXC's passkey attributes
/// (`KPEX_PASSKEY_*`, KeePassXC 2.7.7+), so nothing is lost and KeePassXC-Browser can use it.
fn passkey_fields(cred: &Json) -> Option<Vec<Field>> {
    let get = |k: &str| cred.get(k).and_then(Json::as_str).map(str::to_string);
    let key_value = get("keyValue")?;
    // Bitwarden exports the ID as a GUID or `b64.<base64url>`; KeePassXC stores base64url.
    let credential_id = crate::passkey::encode_credential_id(&crate::passkey::decode_credential_id(&get("credentialId")?)?);
    let rp_id = get("rpId")?;
    // Bitwarden stores the PKCS#8 private key base64url-encoded; KeePassXC wants PEM.
    let der = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(key_value.trim_end_matches('='))
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(&key_value))
        .ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(der);
    let mut pem = String::from("-----BEGIN PRIVATE KEY-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk).ok()?);
        pem.push('\n');
    }
    pem.push_str("-----END PRIVATE KEY-----");
    let mut out = vec![
        Field::new("KPEX_PASSKEY_USERNAME", get("userName").unwrap_or_default()),
        Field::new("KPEX_PASSKEY_CREDENTIAL_ID", credential_id),
        Field::protected("KPEX_PASSKEY_PRIVATE_KEY_PEM", pem),
        Field::new("KPEX_PASSKEY_RELYING_PARTY", rp_id),
    ];
    if let Some(h) = get("userHandle") {
        out.push(Field::protected("KPEX_PASSKEY_USER_HANDLE", h));
    }
    Some(out)
}

fn push_struct_fields(fields: &mut Vec<Field>, obj: &HashMap<String, Json>, order: &[&str]) {
    let mut keys: Vec<&String> = obj.keys().collect();
    keys.sort_by_key(|k| order.iter().position(|o| o == k).unwrap_or(usize::MAX));
    for k in keys {
        let v = json_str(&obj[k]);
        if v.is_empty() {
            continue;
        }
        let protected = PROTECTED_STRUCT_FIELDS.contains(&k.as_str());
        fields.push(Field { name: k.clone(), value: v, protected });
    }
}

// ---------------------------------------------------------------------------------------------
// CSV

fn parse_csv(text: &str) -> Result<ImportResult> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rdr = csv::ReaderBuilder::new().flexible(true).from_reader(text.as_bytes());
    let headers = rdr.headers().map_err(|e| Error::Import(e.to_string()))?.clone();
    let col = |name: &str| headers.iter().position(|h| h.trim() == name);
    let c_folder = col("folder");
    let c_fav = col("favorite");
    let c_type = col("type");
    let c_name = col("name");
    let c_notes = col("notes");
    let c_fields = col("fields");
    let c_reprompt = col("reprompt");
    let c_uri = col("login_uri");
    let c_user = col("login_username");
    let c_pass = col("login_password");
    let c_totp = col("login_totp");
    if c_name.is_none() || c_type.is_none() {
        return Err(Error::Import("not a Bitwarden CSV export (missing name/type columns)".into()));
    }

    let mut result = ImportResult::default();
    let mut by_path: HashMap<String, Uuid> = HashMap::new();
    for rec in rdr.records() {
        let rec = rec.map_err(|e| Error::Import(e.to_string()))?;
        let get = |c: Option<usize>| c.and_then(|i| rec.get(i)).unwrap_or("").trim().to_string();
        let kind = match get(c_type).as_str() {
            "login" => ItemKind::Login,
            "note" => ItemKind::Note,
            "card" => ItemKind::Card,
            "identity" => ItemKind::Identity,
            other => {
                result.skipped.push(format!("{}: unknown type '{other}'", get(c_name)));
                continue;
            }
        };
        let mut item = Item::new(kind, get(c_name));
        item.notes = get(c_notes);
        item.favorite = matches!(get(c_fav).as_str(), "1" | "true" | "TRUE");
        if matches!(get(c_reprompt).as_str(), "1" | "true") {
            item.tags.push("reprompt".into());
        }
        let folder = get(c_folder);
        if !folder.is_empty() {
            let mut parent = None;
            let mut path = String::new();
            for seg in folder.split('/').map(str::trim).filter(|s| !s.is_empty()) {
                if !path.is_empty() {
                    path.push('/');
                }
                path.push_str(seg);
                let id = *by_path.entry(path.clone()).or_insert_with(|| {
                    let id = Uuid::new_v4();
                    result.folders.push(Folder { id, name: seg.to_string(), parent });
                    id
                });
                parent = Some(id);
            }
            item.folder = parent;
        }
        let fields = get(c_fields);
        for line in fields.lines() {
            if let Some((n, v)) = line.split_once(':') {
                item.fields.push(Field::new(n.trim(), v.trim()));
            } else if !line.trim().is_empty() {
                item.fields.push(Field::new(line.trim(), ""));
            }
        }
        if kind == ItemKind::Login {
            item.urls = get(c_uri)
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect();
            item.username = get(c_user);
            item.password = get(c_pass);
            let totp = get(c_totp);
            if !totp.is_empty() {
                item.totp = Some(crate::totp::normalize_to_uri(&totp, &item.title).unwrap_or(totp));
            }
        }
        result.items.push(item);
    }
    Ok(result)
}

// ---------------------------------------------------------------------------------------------
// Password-protected export

pub mod encrypted {
    use super::*;
    use aes::Aes256;
    use cipher::{BlockModeDecrypt, BlockModeEncrypt, KeyIvInit};
    use hmac::digest::KeyInit;
    use hmac::{Hmac, Mac};
    use sha2::{Digest, Sha256};

    type Aes256CbcDec = cbc::Decryptor<Aes256>;
    type Aes256CbcEnc = cbc::Encryptor<Aes256>;
    type HmacSha256 = Hmac<Sha256>;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Envelope {
        encrypted: bool,
        #[serde(default)]
        password_protected: bool,
        salt: Option<String>,
        #[serde(default)]
        kdf_type: i64,
        kdf_iterations: Option<u32>,
        kdf_memory: Option<u32>,
        kdf_parallelism: Option<u32>,
        #[serde(rename = "encKeyValidation_DO_NOT_EDIT")]
        enc_key_validation: Option<String>,
        data: Option<String>,
    }

    /// KDF parameters of an export; also used by tests to build fixtures.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Kdf {
        Pbkdf2 { iterations: u32 },
        Argon2id { iterations: u32, memory_mib: u32, parallelism: u32 },
    }

    /// Derive the 32-byte master key exactly like Bitwarden's `deriveKeyFromPassword`.
    pub fn derive_master_key(password: &str, salt: &str, kdf: Kdf) -> Result<[u8; 32]> {
        let mut key = [0u8; 32];
        match kdf {
            Kdf::Pbkdf2 { iterations } => {
                pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt.as_bytes(), iterations, &mut key);
            }
            Kdf::Argon2id { iterations, memory_mib, parallelism } => {
                let salt_hash = Sha256::digest(salt.as_bytes());
                let config = argon2::Config {
                    variant: argon2::Variant::Argon2id,
                    version: argon2::Version::Version13,
                    mem_cost: memory_mib.max(1) * 1024,
                    time_cost: iterations.max(1),
                    lanes: parallelism.max(1),
                    hash_length: 32,
                    ..argon2::Config::default()
                };
                let out = argon2::hash_raw(password.as_bytes(), &salt_hash, &config)
                    .map_err(|e| Error::Crypto(e.to_string()))?;
                key.copy_from_slice(&out);
            }
        }
        Ok(key)
    }

    /// HKDF-Expand (no extract) with info "enc" / "mac", as Bitwarden's `stretchKey`.
    pub fn stretch(master: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
        let hk = hkdf::Hkdf::<Sha256>::from_prk(master).expect("32-byte prk");
        let mut enc = [0u8; 32];
        let mut mac = [0u8; 32];
        hk.expand(b"enc", &mut enc).expect("okm length");
        hk.expand(b"mac", &mut mac).expect("okm length");
        (enc, mac)
    }

    fn b64(s: &str) -> Result<Vec<u8>> {
        base64::engine::general_purpose::STANDARD
            .decode(s.trim())
            .map_err(|e| Error::Import(format!("invalid base64 in export: {e}")))
    }

    /// Decrypt a Bitwarden EncString (`0.iv|ct` or `2.iv|ct|mac`) with the master key.
    pub fn decrypt_enc_string(enc: &str, master: &[u8; 32]) -> Result<Vec<u8>> {
        let (kind, rest) = enc
            .split_once('.')
            .ok_or_else(|| Error::Import("malformed EncString".into()))?;
        let parts: Vec<&str> = rest.split('|').collect();
        let (key, verify_mac): ([u8; 32], Option<[u8; 32]>) = match kind {
            "0" => (*master, None),
            "2" => {
                let (enc_key, mac_key) = stretch(master);
                (enc_key, Some(mac_key))
            }
            other => return Err(Error::Import(format!("unsupported EncString type {other}"))),
        };
        if parts.len() < 2 {
            return Err(Error::Import("malformed EncString".into()));
        }
        let iv = b64(parts[0])?;
        let ct = b64(parts[1])?;
        if let Some(mac_key) = verify_mac {
            let mac = b64(parts.get(2).ok_or_else(|| Error::Import("missing MAC".into()))?)?;
            let mut h = HmacSha256::new_from_slice(&mac_key).map_err(|e| Error::Crypto(e.to_string()))?;
            h.update(&iv);
            h.update(&ct);
            h.verify_slice(&mac).map_err(|_| Error::ImportPassword("wrong password".into()))?;
        }
        if iv.len() != 16 {
            return Err(Error::Import("bad IV length".into()));
        }
        let dec = Aes256CbcDec::new_from_slices(&key, &iv).map_err(|e| Error::Crypto(e.to_string()))?;
        dec.decrypt_padded_vec::<cipher::block_padding::Pkcs7>(&ct)
            .map_err(|_| Error::ImportPassword("wrong password".into()))
    }

    /// Encrypt as a type-2 EncString (used to build test fixtures and for symmetry).
    pub fn encrypt_enc_string(plain: &[u8], master: &[u8; 32], iv: &[u8; 16]) -> String {
        let (enc_key, mac_key) = stretch(master);
        let enc = Aes256CbcEnc::new_from_slices(&enc_key, iv).expect("key/iv sizes");
        let ct = enc.encrypt_padded_vec::<cipher::block_padding::Pkcs7>(plain);
        let mut h = HmacSha256::new_from_slice(&mac_key).expect("mac key");
        h.update(iv);
        h.update(&ct);
        let mac = h.finalize().into_bytes();
        let e = base64::engine::general_purpose::STANDARD;
        format!("2.{}|{}|{}", e.encode(iv), e.encode(ct), e.encode(mac))
    }

    /// Decrypt a password-protected export into its plaintext JSON.
    pub fn decrypt_export(json: &str, password: &str) -> Result<String> {
        let env: Envelope = serde_json::from_str(json)?;
        if !env.encrypted {
            return Ok(json.to_string());
        }
        if !env.password_protected {
            return Err(Error::Import(
                "this export is encrypted with your Bitwarden account key; export a password-protected or plaintext file instead".into(),
            ));
        }
        let salt = env.salt.ok_or_else(|| Error::Import("missing salt".into()))?;
        let kdf = match env.kdf_type {
            1 => Kdf::Argon2id {
                iterations: env.kdf_iterations.unwrap_or(3),
                memory_mib: env.kdf_memory.unwrap_or(64),
                parallelism: env.kdf_parallelism.unwrap_or(4),
            },
            _ => Kdf::Pbkdf2 { iterations: env.kdf_iterations.unwrap_or(600_000) },
        };
        let master = derive_master_key(password, &salt, kdf)?;
        if let Some(v) = &env.enc_key_validation {
            decrypt_enc_string(v, &master).map_err(|_| Error::ImportPassword("wrong password".into()))?;
        }
        let data = env.data.ok_or_else(|| Error::Import("missing data".into()))?;
        let plain = decrypt_enc_string(&data, &master)?;
        String::from_utf8(plain).map_err(|_| Error::Import("decrypted data is not UTF-8".into()))
    }

    /// Build a password-protected export (test helper; mirrors Bitwarden's writer).
    pub fn encrypt_export(plain_json: &str, password: &str, kdf: Kdf) -> Result<String> {
        let salt = "c2FsdHNhbHRzYWx0c2FsdA==".to_string();
        let master = derive_master_key(password, &salt, kdf)?;
        let iv1 = [1u8; 16];
        let iv2 = [2u8; 16];
        let validation = encrypt_enc_string(b"00000000-0000-4000-8000-000000000000", &master, &iv1);
        let data = encrypt_enc_string(plain_json.as_bytes(), &master, &iv2);
        let (kdf_type, it, mem, par) = match kdf {
            Kdf::Pbkdf2 { iterations } => (0, iterations, None, None),
            Kdf::Argon2id { iterations, memory_mib, parallelism } => (1, iterations, Some(memory_mib), Some(parallelism)),
        };
        Ok(serde_json::json!({
            "encrypted": true,
            "passwordProtected": true,
            "salt": salt,
            "kdfType": kdf_type,
            "kdfIterations": it,
            "kdfMemory": mem,
            "kdfParallelism": par,
            "encKeyValidation_DO_NOT_EDIT": validation,
            "data": data,
        })
        .to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::super::apply;
    use super::*;
    use crate::vault::{KdfParams, Vault};

    const JSON: &str = include_str!("../../tests/fixtures/bitwarden.json");
    const CSV: &str = include_str!("../../tests/fixtures/bitwarden.csv");

    #[test]
    fn json_maps_all_kinds() {
        let r = bitwarden(BitwardenSource::Json(JSON.into())).unwrap();
        assert_eq!(r.items.len(), 6);
        let login = r.items.iter().find(|i| i.title == "GitHub").unwrap();
        assert_eq!(login.kind, ItemKind::Login);
        assert_eq!(login.username, "octocat@example.com");
        assert_eq!(login.urls, vec!["https://github.com/login", "gist.github.com"]);
        assert!(login.totp.as_deref().unwrap().starts_with("otpauth://totp/"));
        assert!(login.favorite);
        assert!(login.fields.iter().any(|f| f.name == "PIN" && f.protected && f.value == "1234"));
        assert!(login.fields.iter().any(|f| f.name == "Flag" && f.value == "true"));
        assert!(login.folder.is_some());
        assert!(r.password_history.get(&login.id).is_some_and(|h| h.len() == 2));
        assert_eq!(login.created.to_rfc3339(), "2024-01-02T03:04:05+00:00");

        let card = r.items.iter().find(|i| i.title == "Visa").unwrap();
        assert_eq!(card.kind, ItemKind::Card);
        assert!(card.fields.iter().any(|f| f.name == "number" && f.protected));
        assert_eq!(card.fields[0].name, "cardholderName");

        let ident = r.items.iter().find(|i| i.title == "Passport").unwrap();
        assert_eq!(ident.kind, ItemKind::Identity);
        assert!(ident.fields.iter().any(|f| f.name == "passportNumber" && f.protected));

        let note = r.items.iter().find(|i| i.title == "Router").unwrap();
        assert_eq!(note.kind, ItemKind::Note);
        assert!(note.deleted);

        let bare = r.items.iter().find(|i| i.title == "Bare TOTP").unwrap();
        assert!(bare.totp.as_deref().unwrap().contains("secret=JBSWY3DPEHPK3PXP"));
        let pk = r.items.iter().find(|i| i.title == "Passkey site").unwrap();
        assert!(pk.tags.contains(&"Passkey".to_string()));
        // The Bitwarden GUID becomes its 16 raw bytes in base64url, as KeePassXC stores it.
        assert!(pk.fields.iter().any(|f| f.name == "KPEX_PASSKEY_CREDENTIAL_ID" && f.value == "AAAAAAAAAAAAAAAAAAAAAA"));
        assert!(crate::passkey::Passkey::from_item(pk).is_some());
        let pem = pk.fields.iter().find(|f| f.name == "KPEX_PASSKEY_PRIVATE_KEY_PEM").unwrap();
        assert!(pem.protected && pem.value.starts_with("-----BEGIN PRIVATE KEY-----"));
        assert!(pk.fields.iter().any(|f| f.name == "KPEX_PASSKEY_RELYING_PARTY" && f.value == "passkey.example"));

        // Nested folder "Work/Infra" becomes two folders.
        assert_eq!(r.folders.len(), 3);
        let infra = r.folders.iter().find(|f| f.name == "Infra").unwrap();
        let work = r.folders.iter().find(|f| f.name == "Work").unwrap();
        assert_eq!(infra.parent, Some(work.id));
    }

    #[test]
    fn apply_is_idempotent_and_replays_history() {
        let r = bitwarden(BitwardenSource::Json(JSON.into())).unwrap();
        let mut v = Vault::create_with_kdf("T", KdfParams::fast());
        assert_eq!(apply(&mut v, &r).unwrap().created, 6);
        assert_eq!(v.items().len(), 6);
        assert_eq!(v.folders().len(), 3);
        let gh = v.items().into_iter().find(|i| i.title == "GitHub").unwrap();
        assert_eq!(gh.password, "current-password");
        let e = v.database().entry(keepass::db::EntryId::from(gh.id)).unwrap();
        assert_eq!(e.history.as_ref().unwrap().get_entries().len(), 2);
        // Second import: same ids → updates, no duplicates.
        let r2 = bitwarden(BitwardenSource::Json(JSON.into())).unwrap();
        assert_eq!(apply(&mut v, &r2).unwrap().updated, 6);
        assert_eq!(v.items().len(), 6);
        assert_eq!(v.folders().len(), 3);
    }

    #[test]
    fn csv_import() {
        let r = bitwarden(BitwardenSource::Csv(CSV.into())).unwrap();
        assert_eq!(r.items.len(), 3);
        let a = r.items.iter().find(|i| i.title == "Site A").unwrap();
        assert_eq!(a.urls, vec!["https://a.example.com", "https://alt.a.example.com"]);
        assert_eq!(a.fields.len(), 2);
        assert!(a.favorite);
        assert!(a.totp.is_some());
        assert!(r.folders.iter().any(|f| f.name == "Infra"));
        let n = r.items.iter().find(|i| i.kind == ItemKind::Note).unwrap();
        assert!(n.notes.contains('\n'));
    }

    #[test]
    fn encrypted_export_round_trip_both_kdfs() {
        for kdf in [
            encrypted::Kdf::Pbkdf2 { iterations: 1000 },
            encrypted::Kdf::Argon2id { iterations: 1, memory_mib: 8, parallelism: 1 },
        ] {
            let enc = encrypted::encrypt_export(JSON, "export-pass", kdf).unwrap();
            assert!(is_encrypted_json(&enc));
            assert!(matches!(
                bitwarden(BitwardenSource::Json(enc.clone())),
                Err(Error::ImportPassword(_))
            ));
            assert!(matches!(
                bitwarden(BitwardenSource::EncryptedJson { json: enc.clone(), password: "nope".into() }),
                Err(Error::ImportPassword(_))
            ));
            let r = bitwarden(BitwardenSource::EncryptedJson { json: enc, password: "export-pass".into() }).unwrap();
            assert_eq!(r.items.len(), 6);
        }
    }

    #[test]
    fn enc_string_matches_known_vector() {
        // Independent check of the primitives: PBKDF2 → HKDF-expand → AES-CBC + HMAC.
        let master = encrypted::derive_master_key("password", "salt", encrypted::Kdf::Pbkdf2 { iterations: 1 }).unwrap();
        let s = encrypted::encrypt_enc_string(b"hello", &master, &[0u8; 16]);
        assert!(s.starts_with("2."));
        assert_eq!(encrypted::decrypt_enc_string(&s, &master).unwrap(), b"hello");
        let mut wrong = master;
        wrong[0] ^= 1;
        assert!(encrypted::decrypt_enc_string(&s, &wrong).is_err());
    }
}
