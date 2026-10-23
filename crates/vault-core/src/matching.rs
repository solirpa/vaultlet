//! URL → item matching for the browser extension (architecture doc section 2).

use std::cmp::Ordering;

use url::Url;

use crate::model::Item;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Target {
    host: String,
    port: Option<u16>,
    /// `host` with the public suffix list applied (eTLD+1), when known.
    site: Option<String>,
}

/// Parse a URL or a bare host ("example.com", "example.com:8443", "localhost").
fn parse_target(raw: &str) -> Option<Target> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let url = Url::parse(&with_scheme).ok()?;
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    let port = url.port_or_known_default();
    let site = if url.domain().is_some() {
        psl::domain_str(&host).map(|d| d.to_ascii_lowercase())
    } else {
        None
    };
    Some(Target { host, port, site })
}

fn score(page: &Target, candidate: &Target) -> u32 {
    let base = if page.host == candidate.host {
        100
    } else if page.site.is_some() && page.site == candidate.site {
        50
    } else {
        return 0;
    };
    let port_bonus = u32::from(page.port.is_some() && page.port == candidate.port);
    base + port_bonus
}

/// Items matching `page_url`, best first.
///
/// Ranking: exact host (+1 if the port also matches) > same eTLD+1 via the public suffix list >
/// nothing. Scheme is ignored; entries whose URL is a bare domain are understood. Deleted items
/// are skipped. Ties break on `last_used` (most recent first), then title.
pub fn match_items<'a>(items: &'a [Item], page_url: &str) -> Vec<&'a Item> {
    let Some(page) = parse_target(page_url) else {
        return Vec::new();
    };
    let mut scored: Vec<(u32, &Item)> = items
        .iter()
        .filter(|it| !it.deleted)
        .filter_map(|it| {
            let best = it
                .urls
                .iter()
                .filter_map(|u| parse_target(u))
                .map(|t| score(&page, &t))
                .max()
                .unwrap_or(0);
            (best > 0).then_some((best, it))
        })
        .collect();
    scored.sort_by(|(sa, a), (sb, b)| {
        sb.cmp(sa)
            .then_with(|| match (b.last_used, a.last_used) {
                (Some(x), Some(y)) => x.cmp(&y),
                (Some(_), None) => Ordering::Greater,
                (None, Some(_)) => Ordering::Less,
                (None, None) => Ordering::Equal,
            })
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });
    scored.into_iter().map(|(_, it)| it).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ItemKind;
    use chrono::{TimeZone, Utc};

    fn login(title: &str, urls: &[&str]) -> Item {
        let mut it = Item::new(ItemKind::Login, title);
        it.urls = urls.iter().map(|s| s.to_string()).collect();
        it
    }

    #[test]
    fn ranking_exact_then_etld() {
        let items = vec![
            login("accounts", &["https://accounts.google.com"]),
            login("mail", &["mail.google.com"]),
            login("other", &["https://example.com"]),
            login("exact", &["http://mail.google.com/login"]),
        ];
        let m = match_items(&items, "https://mail.google.com/u/0/");
        let titles: Vec<&str> = m.iter().map(|i| i.title.as_str()).collect();
        // both exact-host entries first (scheme is ignored, so they tie and sort by title), then
        // the eTLD+1 sibling; example.com is excluded
        assert_eq!(titles, vec!["exact", "mail", "accounts"]);
    }

    #[test]
    fn port_preference_and_ip() {
        let items = vec![
            login("8443", &["https://host.example.org:8443"]),
            login("443", &["https://host.example.org"]),
            login("ip", &["http://10.0.0.5"]),
        ];
        let m = match_items(&items, "https://host.example.org:8443/x");
        assert_eq!(m[0].title, "8443");
        assert_eq!(m[1].title, "443");
        assert_eq!(m.len(), 2);
        let m = match_items(&items, "10.0.0.5");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].title, "ip");
        assert!(match_items(&items, "10.0.0.6").is_empty());
    }

    #[test]
    fn public_suffix_rules() {
        let items = vec![login("a", &["a.github.io"]), login("b", &["https://b.github.io"])];
        // github.io is a public suffix: a.github.io and b.github.io are different sites
        let m = match_items(&items, "https://a.github.io/page");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].title, "a");
        let items = vec![login("shop", &["shop.example.co.uk"])];
        assert_eq!(match_items(&items, "https://www.example.co.uk").len(), 1);
    }

    #[test]
    fn deleted_skipped_and_last_used_order() {
        let mut a = login("a", &["example.com"]);
        let mut b = login("b", &["example.com"]);
        let mut d = login("d", &["example.com"]);
        a.last_used = Some(Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap());
        b.last_used = Some(Utc.with_ymd_and_hms(2024, 6, 1, 0, 0, 0).unwrap());
        d.deleted = true;
        let items = vec![a, b, d, login("c", &["example.com"])];
        let m = match_items(&items, "example.com");
        let titles: Vec<&str> = m.iter().map(|i| i.title.as_str()).collect();
        assert_eq!(titles, vec!["b", "a", "c"]);
        assert!(match_items(&items, "").is_empty());
        assert!(match_items(&items, "not a url at all ::").is_empty());
    }
}
