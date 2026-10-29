//! Browser password exports (CSV).
//!
//! - Chrome, Edge, Brave, Opera, Vivaldi and Google Password Manager:
//!   `name,url,username,password[,note]`. Android app logins have `android://<hash>@<package>/`
//!   URLs, which become `androidapp://<package>` (as Bitwarden and the Android app store them).
//! - Firefox: `url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,
//!   timePasswordChanged` (times in milliseconds). Firefox's own `chrome://` entries are skipped.
//! - Safari and the Passwords app: `Title,URL,Username,Password,Notes,OTPAuth`; the OTPAuth
//!   column carries TOTP secrets.

use chrono::{DateTime, TimeZone, Utc};

use super::{Format, ImportResult};
use crate::error::{Error, Result};
use crate::model::{Item, ItemKind};

pub(super) fn parse(format: Format, text: &str) -> Result<ImportResult> {
    let mut rdr = csv::ReaderBuilder::new().flexible(true).from_reader(text.as_bytes());
    let headers: Vec<String> = rdr
        .headers()
        .map_err(|e| Error::Import(e.to_string()))?
        .iter()
        .map(|h| h.trim().to_ascii_lowercase())
        .collect();
    let col = |name: &str| headers.iter().position(|h| h == name);
    let (c_url, c_user, c_pass) = (col("url"), col("username"), col("password"));
    if c_url.is_none() || c_user.is_none() || c_pass.is_none() {
        return Err(Error::Import("not a browser password export (missing url/username/password columns)".into()));
    }
    let c_title = col("name").or_else(|| col("title"));
    let c_notes = col("note").or_else(|| col("notes"));
    let c_otp = col("otpauth");
    let c_realm = col("httprealm");
    let (c_created, c_used, c_changed) = (col("timecreated"), col("timelastused"), col("timepasswordchanged"));

    let mut result = ImportResult::default();
    // Rows without timestamps all get the same one, so the first copy of a repeated login wins.
    let now = Utc::now();
    let mut firefox_internal = 0;
    let mut empty = 0;
    for (line, rec) in rdr.records().enumerate() {
        let rec = rec.map_err(|e| Error::Import(format!("line {}: {e}", line + 2)))?;
        let get = |c: Option<usize>| c.and_then(|i| rec.get(i)).unwrap_or("").trim().to_string();
        let raw_url = get(c_url);
        if format == Format::FirefoxCsv && raw_url.starts_with("chrome://") {
            firefox_internal += 1;
            continue;
        }
        let username = get(c_user);
        let password = get(c_pass);
        if username.is_empty() && password.is_empty() {
            empty += 1;
            continue;
        }
        let url = normalize_url(&raw_url);
        let title = Some(get(c_title)).filter(|t| !t.is_empty()).unwrap_or_else(|| title_for(&url));

        let mut item = Item::new(ItemKind::Login, title);
        item.created = now;
        item.modified = now;
        item.username = username;
        item.password = password;
        if !url.is_empty() {
            item.urls.push(url);
        }
        item.notes = get(c_notes).replace("\r\n", "\n");
        let realm = get(c_realm);
        if !realm.is_empty() {
            let line = format!("HTTP authentication realm: {realm}");
            item.notes = if item.notes.is_empty() { line } else { format!("{}\n{line}", item.notes) };
        }
        let otp = get(c_otp);
        if !otp.is_empty() {
            match crate::totp::normalize_to_uri(&otp, &item.title) {
                Ok(uri) => item.totp = Some(uri),
                Err(_) => result.skipped.push(format!("{}: TOTP secret could not be parsed", item.title)),
            }
        }
        if let Some(t) = millis(&get(c_created)) {
            item.created = t;
        }
        if let Some(t) = millis(&get(c_changed)) {
            item.modified = t;
        }
        item.last_used = millis(&get(c_used));
        if item.created > item.modified {
            item.created = item.modified;
        }
        result.items.push(item);
    }
    if firefox_internal > 0 {
        result.skipped.push(format!("{firefox_internal} Firefox system entries (chrome://) skipped"));
    }
    if empty > 0 {
        result.skipped.push(format!("{empty} entries without a username or password skipped"));
    }
    Ok(result)
}

/// `android://<hash>@<package>/` → `androidapp://<package>`; anything else is kept as is.
fn normalize_url(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix("android://") {
        let pkg = rest.rsplit_once('@').map_or(rest, |(_, p)| p).trim_end_matches('/');
        if !pkg.is_empty() {
            return format!("androidapp://{pkg}");
        }
    }
    raw.to_string()
}

/// A title for an export line without one: the host (without `www.`) or the app package.
fn title_for(url: &str) -> String {
    if let Some(pkg) = url.strip_prefix("androidapp://") {
        return pkg.to_string();
    }
    let with_scheme = if url.contains("://") { url.to_string() } else { format!("https://{url}") };
    url::Url::parse(&with_scheme)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.strip_prefix("www.").unwrap_or(h).to_string()))
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| if url.is_empty() { "Untitled".into() } else { url.to_string() })
}

fn millis(s: &str) -> Option<DateTime<Utc>> {
    let ms: i64 = s.parse().ok().filter(|ms| *ms > 0)?;
    Utc.timestamp_millis_opt(ms).single()
}

#[cfg(test)]
mod tests {
    use super::super::parse as parse_format;
    use super::*;

    const CHROME: &str = include_str!("../../tests/fixtures/chrome.csv");
    const FIREFOX: &str = include_str!("../../tests/fixtures/firefox.csv");
    const SAFARI: &str = include_str!("../../tests/fixtures/safari.csv");

    fn find<'a>(r: &'a ImportResult, title: &str) -> &'a Item {
        r.items.iter().find(|i| i.title == title).unwrap_or_else(|| panic!("no item {title}"))
    }

    #[test]
    fn chrome() {
        let r = parse_format(Format::ChromeCsv, CHROME, None).unwrap();
        let gh = find(&r, "github.com");
        assert_eq!(gh.username, "alex@example.com");
        assert_eq!(gh.password, "Gh-demo-T9!pw");
        assert_eq!(gh.urls, vec!["https://github.com/login"]);
        assert_eq!(gh.notes, "Recovery codes are in the safe.\nSecond line, with a comma.");
        assert_eq!(gh.kind, ItemKind::Login);
        // Android app logins.
        let bank = find(&r, "Example Bank");
        assert_eq!(bank.urls, vec!["androidapp://com.example.bank"]);
        // No name: the host, without www.
        assert!(r.items.iter().any(|i| i.title == "shop.example.com" && i.username.is_empty()));
        assert!(r.skipped.iter().any(|s| s.contains("without a username or password")));
    }

    #[test]
    fn crlf_and_bom_read_the_same() {
        // Chrome on Windows writes a BOM and CRLF; the fixture is stored with LF in git.
        let windows = format!("\u{feff}{}", CHROME.replace("\r\n", "\n").replace('\n', "\r\n"));
        let a = parse_format(Format::ChromeCsv, CHROME, None).unwrap();
        let b = parse_format(Format::ChromeCsv, &windows, None).unwrap();
        let fields = |r: &ImportResult| {
            r.items.iter().map(|i| (i.title.clone(), i.username.clone(), i.urls.clone(), i.notes.clone())).collect::<Vec<_>>()
        };
        assert_eq!(fields(&a), fields(&b));
        assert_eq!(find(&b, "github.com").notes, "Recovery codes are in the safe.\nSecond line, with a comma.");
    }

    #[test]
    fn firefox() {
        let r = parse_format(Format::FirefoxCsv, FIREFOX, None).unwrap();
        assert!(r.items.iter().all(|i| !i.urls.iter().any(|u| u.starts_with("chrome://"))));
        assert!(r.skipped.iter().any(|s| s.contains("Firefox system entries")));
        let shop = find(&r, "shop.example.com");
        assert_eq!(shop.created.to_rfc3339(), "2024-01-02T03:04:05+00:00");
        assert_eq!(shop.modified.to_rfc3339(), "2024-03-04T05:06:07+00:00");
        assert!(shop.last_used.is_some());
        let router = find(&r, "192.168.1.1");
        assert!(router.notes.contains("HTTP authentication realm: Router admin"));
    }

    #[test]
    fn safari() {
        let r = parse_format(Format::SafariCsv, SAFARI, None).unwrap();
        let gh = find(&r, "github.com (alex@example.com)");
        assert!(gh.totp.as_deref().unwrap().contains("secret=JBSWY3DPEHPK3PXP"));
        let plain = find(&r, "dash.cloudflare.com (alex@example.com)");
        assert!(plain.totp.is_none());
        assert_eq!(plain.notes, "Team account");
    }

    #[test]
    fn urls_and_titles() {
        assert_eq!(normalize_url("android://AbC123==@com.example.app/"), "androidapp://com.example.app");
        assert_eq!(normalize_url("https://example.com/a"), "https://example.com/a");
        assert_eq!(title_for("https://www.example.com/login"), "example.com");
        assert_eq!(title_for("androidapp://com.example.app"), "com.example.app");
        assert_eq!(title_for(""), "Untitled");
    }

    #[test]
    fn rejects_unrelated_csv() {
        assert!(parse(Format::ChromeCsv, "a,b\n1,2\n").is_err());
    }
}
