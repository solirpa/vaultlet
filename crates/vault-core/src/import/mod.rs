//! Importing from other password managers and from browsers.
//!
//! Every source is parsed into an [`ImportResult`]; [`plan`] previews what writing it would do
//! and [`apply`] writes it. Bitwarden exports carry stable ids, so re-importing one updates the
//! same items. Browser CSV exports do not, so their logins are matched against existing ones by
//! site and username: importing the same file twice adds nothing the second time, and a changed
//! password updates the login (the previous version goes to its history).
//!
//! Format notes are in `docs/ARCHITECTURE.md` ("导入格式要点").

mod bitwarden;
mod browser;

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub use bitwarden::{bitwarden, encrypted, is_encrypted_json, BitwardenSource, CARD_FIELDS, IDENTITY_FIELDS};

use crate::error::{Error, Result};
use crate::model::{Folder, Item, ItemKind};
use crate::vault::Vault;

/// The file formats Vaultlet can import.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Format {
    BitwardenJson,
    BitwardenEncryptedJson,
    BitwardenCsv,
    /// Chrome and Chromium-based browsers (Edge, Brave, Opera, Vivaldi), and Google Password
    /// Manager: `name,url,username,password[,note]`.
    ChromeCsv,
    /// `url,username,password,httpRealm,formActionOrigin,guid,timeCreated,...`
    FirefoxCsv,
    /// Safari and the Passwords app: `Title,URL,Username,Password,Notes,OTPAuth`.
    SafariCsv,
}

impl Format {
    pub const ALL: [Format; 6] = [
        Format::BitwardenJson,
        Format::BitwardenEncryptedJson,
        Format::BitwardenCsv,
        Format::ChromeCsv,
        Format::FirefoxCsv,
        Format::SafariCsv,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Format::BitwardenJson => "bitwarden-json",
            Format::BitwardenEncryptedJson => "bitwarden-encrypted-json",
            Format::BitwardenCsv => "bitwarden-csv",
            Format::ChromeCsv => "chrome-csv",
            Format::FirefoxCsv => "firefox-csv",
            Format::SafariCsv => "safari-csv",
        }
    }

    pub fn parse(s: &str) -> Option<Format> {
        Format::ALL.into_iter().find(|f| f.as_str() == s)
    }

    /// True for exports without stable item ids, whose logins are matched by site and username.
    pub fn matches_by_login(self) -> bool {
        matches!(self, Format::ChromeCsv | Format::FirefoxCsv | Format::SafariCsv)
    }
}

/// A parsed export, not yet written to a vault.
#[derive(Debug, Clone, Default)]
pub struct ImportResult {
    pub format: Option<Format>,
    pub items: Vec<Item>,
    /// Folders in parents-first order; `parent` references other folders in this list.
    pub folders: Vec<Folder>,
    /// Human-readable notes about data that could not be mapped.
    pub skipped: Vec<String>,
    /// Historical passwords per item id (oldest first), applied as KDBX history by [`apply`].
    pub password_history: HashMap<Uuid, Vec<(DateTime<Utc>, String)>>,
}

/// What importing a result does (or did) to a vault.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// New items.
    pub created: usize,
    /// Existing items changed (for logins matched by site and username: a new password, or a
    /// TOTP secret or note they did not have yet).
    pub updated: usize,
    /// Logins already in the vault with the same password; left alone.
    pub unchanged: usize,
    /// Repeats of the same login within the file; the most recently changed one is used.
    pub duplicates: usize,
}

/// Work out the format of an export from its contents (`None` if it is not one we know).
pub fn detect(text: &str) -> Option<Format> {
    let text = strip_bom(text).trim_start();
    if text.starts_with('{') {
        return Some(if is_encrypted_json(text) { Format::BitwardenEncryptedJson } else { Format::BitwardenJson });
    }
    let mut rdr = csv::ReaderBuilder::new().flexible(true).from_reader(text.as_bytes());
    let headers: Vec<String> = rdr.headers().ok()?.iter().map(|h| h.trim().to_ascii_lowercase()).collect();
    let has = |name: &str| headers.iter().any(|h| h == name);
    if has("login_uri") || (has("folder") && has("type") && has("name")) {
        Some(Format::BitwardenCsv)
    } else if has("url") && has("username") && has("password") && (has("httprealm") || has("formactionorigin")) {
        Some(Format::FirefoxCsv)
    } else if has("url") && has("username") && has("password") && (has("otpauth") || has("title")) {
        Some(Format::SafariCsv)
    } else if has("url") && has("username") && has("password") && has("name") {
        Some(Format::ChromeCsv)
    } else {
        None
    }
}

/// Parse an export in `format`. `password` is only used for password-protected Bitwarden
/// exports; without it they fail with [`Error::ImportPassword`].
pub fn parse(format: Format, text: &str, password: Option<&str>) -> Result<ImportResult> {
    let text = strip_bom(text).to_string();
    let mut r = match format {
        Format::BitwardenJson => bitwarden(BitwardenSource::Json(text))?,
        Format::BitwardenEncryptedJson => match password.filter(|p| !p.is_empty()) {
            Some(p) => bitwarden(BitwardenSource::EncryptedJson { json: text, password: p.to_string() })?,
            None => return Err(Error::ImportPassword("password required".into())),
        },
        Format::BitwardenCsv => bitwarden(BitwardenSource::Csv(text))?,
        Format::ChromeCsv | Format::FirefoxCsv | Format::SafariCsv => browser::parse(format, &text)?,
    };
    r.format = Some(format);
    Ok(r)
}

fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

// ---------------------------------------------------------------------------------------------
// Matching and writing

enum Action {
    /// A new item (index into `ImportResult::items`).
    Create(usize),
    /// Bitwarden item with an id already in the vault (index into `ImportResult::items`).
    Replace(usize),
    /// An existing login with merged-in changes.
    Merge(Item),
    Unchanged,
    Duplicate,
}

/// The site part of a login key: the host without `www.` (plus a non-default port), or the
/// whole `androidapp://<package>` for apps.
fn site_key(raw: &str) -> String {
    let raw = raw.trim();
    if let Some(pkg) = raw.strip_prefix("androidapp://") {
        return format!("androidapp://{}", pkg.trim_end_matches('/').to_ascii_lowercase());
    }
    let with_scheme = if raw.contains("://") { raw.to_string() } else { format!("https://{raw}") };
    match url::Url::parse(&with_scheme) {
        Ok(u) => {
            let host = u.host_str().unwrap_or("").trim_end_matches('.').to_ascii_lowercase();
            let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
            match u.port() {
                Some(p) => format!("{host}:{p}"),
                None => host,
            }
        }
        Err(_) => raw.to_ascii_lowercase(),
    }
}

/// Keys a login is known by: one per URL (site + username), or the title when it has no URL.
fn login_keys(item: &Item) -> Vec<String> {
    let user = item.username.trim().to_lowercase();
    let mut keys: Vec<String> = item.urls.iter().map(|u| format!("{}\u{0}{user}", site_key(u))).collect();
    if keys.is_empty() {
        keys.push(format!("title:{}\u{0}{user}", item.title.trim().to_lowercase()));
    }
    keys.dedup();
    keys
}

/// `existing` with what `incoming` adds: its password, a TOTP secret or note it lacks, and
/// URLs for sites it does not list yet.
fn merge_login(existing: &Item, incoming: &Item) -> Item {
    let mut out = existing.clone();
    if !incoming.password.is_empty() {
        out.password = incoming.password.clone();
    }
    if !existing.has_totp() && incoming.has_totp() {
        out.totp = incoming.totp.clone();
    }
    if existing.notes.trim().is_empty() && !incoming.notes.trim().is_empty() {
        out.notes = incoming.notes.clone();
    }
    let sites: Vec<String> = existing.urls.iter().map(|u| site_key(u)).collect();
    for u in &incoming.urls {
        if !sites.contains(&site_key(u)) {
            out.urls.push(u.clone());
        }
    }
    out
}

fn resolve(vault: &Vault, r: &ImportResult) -> Vec<Action> {
    let by_login = r.format.is_some_and(Format::matches_by_login);
    if !by_login {
        return (0..r.items.len())
            .map(|i| if vault.item(r.items[i].id).is_some() { Action::Replace(i) } else { Action::Create(i) })
            .collect();
    }

    // Within the file, keep the most recently changed copy of each login.
    let mut best: HashMap<String, usize> = HashMap::new();
    for (i, item) in r.items.iter().enumerate() {
        for key in login_keys(item) {
            match best.get(&key) {
                Some(&j) if r.items[j].modified >= item.modified => {}
                _ => {
                    best.insert(key, i);
                }
            }
        }
    }

    let existing: Vec<Item> = vault
        .items()
        .into_iter()
        .filter(|i| !i.deleted && i.kind == ItemKind::Login)
        .collect();
    let mut index: HashMap<String, usize> = HashMap::new();
    for (i, item) in existing.iter().enumerate() {
        for key in login_keys(item) {
            index.entry(key).or_insert(i);
        }
    }

    let mut merged: HashMap<usize, Item> = HashMap::new();
    let mut actions = Vec::with_capacity(r.items.len());
    for (i, item) in r.items.iter().enumerate() {
        let keys = login_keys(item);
        if !keys.iter().any(|k| best.get(k) == Some(&i)) {
            actions.push(Action::Duplicate);
            continue;
        }
        match keys.iter().find_map(|k| index.get(k).copied()) {
            None => actions.push(Action::Create(i)),
            Some(e) => {
                // Two lines of the file can land on the same existing login (different URLs).
                let base = merged.get(&e).cloned().unwrap_or_else(|| existing[e].clone());
                let next = merge_login(&base, item);
                if next == base {
                    actions.push(Action::Unchanged);
                } else {
                    merged.insert(e, next.clone());
                    actions.push(Action::Merge(next));
                }
            }
        }
    }
    actions
}

fn summarize(actions: &[Action]) -> ImportSummary {
    let mut s = ImportSummary::default();
    for a in actions {
        match a {
            Action::Create(_) => s.created += 1,
            Action::Replace(_) | Action::Merge(_) => s.updated += 1,
            Action::Unchanged => s.unchanged += 1,
            Action::Duplicate => s.duplicates += 1,
        }
    }
    s
}

/// What [`apply`] would do, without changing the vault.
pub fn plan(vault: &Vault, r: &ImportResult) -> ImportSummary {
    summarize(&resolve(vault, r))
}

/// Write an [`ImportResult`] into the vault. Folders are matched by name and parent, so
/// importing twice does not duplicate them.
pub fn apply(vault: &mut Vault, r: &ImportResult) -> Result<ImportSummary> {
    let actions = resolve(vault, r);
    let mut folder_map: HashMap<Uuid, Uuid> = HashMap::new();
    let existing = vault.folders();
    for f in &r.folders {
        let parent = f.parent.and_then(|p| folder_map.get(&p).copied());
        let found = existing
            .iter()
            .chain(vault.folders().iter())
            .find(|e| e.name == f.name && e.parent == parent)
            .map(|e| e.id);
        let id = match found {
            Some(id) => id,
            None => {
                vault
                    .upsert_folder(Folder {
                        id: Uuid::nil(),
                        name: f.name.clone(),
                        parent,
                    })?
                    .id
            }
        };
        folder_map.insert(f.id, id);
    }
    for action in &actions {
        match action {
            Action::Create(i) | Action::Replace(i) => {
                let item = &r.items[*i];
                let mut it = item.clone();
                it.folder = it.folder.and_then(|f| folder_map.get(&f).copied());
                // Replay password history (oldest first) so KDBX history matches the source's.
                if let Some(hist) = r.password_history.get(&item.id) {
                    let mut prev = it.clone();
                    for (when, pw) in hist {
                        prev.password = pw.clone();
                        prev.deleted = false;
                        vault.upsert_item_at(prev.clone(), Some(*when))?;
                    }
                }
                vault.upsert_item_at(it, Some(item.modified))?;
            }
            // An update of an existing login: the previous version goes to its history.
            Action::Merge(item) => {
                vault.upsert_item(item.clone())?;
            }
            Action::Unchanged | Action::Duplicate => {}
        }
    }
    Ok(summarize(&actions))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::KdfParams;

    const CHROME: &str = include_str!("../../tests/fixtures/chrome.csv");
    const FIREFOX: &str = include_str!("../../tests/fixtures/firefox.csv");
    const SAFARI: &str = include_str!("../../tests/fixtures/safari.csv");
    const BW_JSON: &str = include_str!("../../tests/fixtures/bitwarden.json");
    const BW_CSV: &str = include_str!("../../tests/fixtures/bitwarden.csv");

    #[test]
    fn detects_every_format() {
        assert_eq!(detect(CHROME), Some(Format::ChromeCsv));
        assert_eq!(detect(FIREFOX), Some(Format::FirefoxCsv));
        assert_eq!(detect(SAFARI), Some(Format::SafariCsv));
        assert_eq!(detect(BW_JSON), Some(Format::BitwardenJson));
        assert_eq!(detect(BW_CSV), Some(Format::BitwardenCsv));
        let enc = encrypted::encrypt_export(BW_JSON, "pw", encrypted::Kdf::Pbkdf2 { iterations: 1000 }).unwrap();
        assert_eq!(detect(&enc), Some(Format::BitwardenEncryptedJson));
        assert_eq!(detect("\u{feff}name,url,username,password\r\n"), Some(Format::ChromeCsv));
        assert_eq!(detect("a,b,c\n1,2,3\n"), None);
        assert_eq!(detect(""), None);
        for f in Format::ALL {
            assert_eq!(Format::parse(f.as_str()), Some(f));
        }
    }

    #[test]
    fn encrypted_bitwarden_needs_the_file_password() {
        let enc = encrypted::encrypt_export(BW_JSON, "pw", encrypted::Kdf::Pbkdf2 { iterations: 1000 }).unwrap();
        assert!(matches!(parse(Format::BitwardenEncryptedJson, &enc, None), Err(Error::ImportPassword(_))));
        assert_eq!(parse(Format::BitwardenEncryptedJson, &enc, Some("pw")).unwrap().items.len(), 6);
    }

    #[test]
    fn importing_the_same_browser_export_twice_adds_nothing() {
        let mut v = Vault::create_with_kdf("T", KdfParams::fast());
        let r = parse(Format::ChromeCsv, CHROME, None).unwrap();
        let first = plan(&v, &r);
        assert_eq!(apply(&mut v, &r).unwrap(), first);
        assert_eq!(first.duplicates, 1, "the fixture repeats one login");
        let count = v.items().len();
        assert_eq!(count, first.created);

        // Without timestamps, the first copy of a repeated login is the one kept.
        let gh = v.items().into_iter().find(|i| i.title == "github.com").unwrap();
        assert_eq!(gh.urls, vec!["https://github.com/login"]);

        let again = apply(&mut v, &parse(Format::ChromeCsv, CHROME, None).unwrap()).unwrap();
        assert_eq!(again, ImportSummary { created: 0, updated: 0, unchanged: first.created, duplicates: 1 });
        assert_eq!(v.items().len(), count);
    }

    #[test]
    fn a_changed_password_updates_the_login_and_keeps_the_old_one_in_history() {
        let mut v = Vault::create_with_kdf("T", KdfParams::fast());
        let mut gh = Item::new(ItemKind::Login, "GitHub (mine)");
        gh.username = "Alex@Example.com".into();
        gh.password = "old-password".into();
        gh.urls = vec!["https://www.github.com/".into()];
        gh.notes = "kept".into();
        let gh = v.upsert_item(gh).unwrap();

        let csv = "name,url,username,password,note\ngithub.com,https://github.com/login,alex@example.com,new-password,from chrome\n";
        let r = parse(Format::ChromeCsv, csv, None).unwrap();
        assert_eq!(plan(&v, &r), ImportSummary { updated: 1, ..Default::default() });
        apply(&mut v, &r).unwrap();

        assert_eq!(v.items().len(), 1);
        let now = v.item(gh.id).unwrap();
        assert_eq!(now.password, "new-password");
        assert_eq!(now.title, "GitHub (mine)", "the existing login keeps its title");
        assert_eq!(now.notes, "kept", "an existing note is not replaced");
        let e = v.database().entry(keepass::db::EntryId::from(gh.id)).unwrap();
        let history = e.history.as_ref().unwrap().get_entries();
        assert!(history.iter().any(|h| h.get_password() == Some("old-password")));
    }

    #[test]
    fn a_login_in_the_trash_does_not_absorb_the_import() {
        let mut v = Vault::create_with_kdf("T", KdfParams::fast());
        let mut old = Item::new(ItemKind::Login, "Shop");
        old.username = "alex@example.com".into();
        old.password = "pw".into();
        old.urls = vec!["https://shop.example.com".into()];
        old.deleted = true;
        v.upsert_item(old).unwrap();
        let csv = "name,url,username,password\nShop,https://shop.example.com/login,alex@example.com,pw\n";
        let s = apply(&mut v, &parse(Format::ChromeCsv, csv, None).unwrap()).unwrap();
        assert_eq!(s.created, 1);
    }

    #[test]
    fn safari_adds_a_totp_secret_to_a_login_chrome_brought_in() {
        let mut v = Vault::create_with_kdf("T", KdfParams::fast());
        let csv = "name,url,username,password\nShop,https://shop.example.com,alex@example.com,Sh0p-pw\n";
        apply(&mut v, &parse(Format::ChromeCsv, csv, None).unwrap()).unwrap();
        let safari = "Title,URL,Username,Password,Notes,OTPAuth\n\
                      shop.example.com (alex@example.com),https://shop.example.com/,alex@example.com,Sh0p-pw,,otpauth://totp/Shop:alex?secret=JBSWY3DPEHPK3PXP&issuer=Shop\n";
        let s = apply(&mut v, &parse(Format::SafariCsv, safari, None).unwrap()).unwrap();
        assert_eq!(s.updated, 1);
        let items = v.items();
        assert_eq!(items.len(), 1);
        assert!(items[0].has_totp());
    }

    #[test]
    fn site_keys() {
        assert_eq!(site_key("https://www.GitHub.com/login?x=1"), "github.com");
        assert_eq!(site_key("github.com"), "github.com");
        assert_eq!(site_key("http://localhost:8080/admin"), "localhost:8080");
        assert_eq!(site_key("androidapp://com.Example.Bank/"), "androidapp://com.example.bank");
        assert_ne!(site_key("https://mail.example.com"), site_key("https://example.com"));
    }
}
