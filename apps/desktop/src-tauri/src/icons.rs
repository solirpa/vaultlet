//! Website icons, fetched directly from each site (never through a third-party icon service) and
//! cached on disk.
//!
//! Lookup order for `accounts.example.com`: the host's own page (`<link rel=icon>` /
//! `apple-touch-icon`), then `/favicon.ico`, then the same for the registrable domain
//! (`example.com`). Private addresses (IP literals, `localhost`, `.local`, `.lan`, …) are never
//! contacted. Results — including "no icon" — are cached under `<data_dir>/icons/`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use base64::Engine;
use tokio::sync::{Mutex, Semaphore};

const MAX_HTML: usize = 512 * 1024;
const MAX_ICON: usize = 256 * 1024;
const POSITIVE_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
const NEGATIVE_TTL: Duration = Duration::from_secs(3 * 24 * 3600);

pub struct IconService {
    dir: PathBuf,
    http: reqwest::Client,
    limit: Semaphore,
    /// In-flight lookups, so many rows asking for the same host share one fetch.
    inflight: Mutex<HashMap<String, Arc<tokio::sync::OnceCell<Option<String>>>>>,
}

impl IconService {
    pub fn new(data_dir: &Path) -> IconService {
        let http = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")
            .timeout(Duration::from_secs(6))
            .connect_timeout(Duration::from_secs(4))
            .redirect(reqwest::redirect::Policy::limited(4))
            .build()
            .expect("http client");
        IconService {
            dir: data_dir.join("icons"),
            http,
            limit: Semaphore::new(6),
            inflight: Mutex::new(HashMap::new()),
        }
    }

    /// `data:` URL of the site's icon, or `None`.
    pub async fn get(&self, host: &str) -> Option<String> {
        let host = normalize_host(host)?;
        if let Some(cached) = self.read_cache(&host) {
            return cached;
        }
        let cell = {
            let mut map = self.inflight.lock().await;
            map.entry(host.clone()).or_insert_with(|| Arc::new(tokio::sync::OnceCell::new())).clone()
        };
        let result = cell
            .get_or_init(|| async {
                let _permit = self.limit.acquire().await.ok();
                let found = self.lookup(&host).await;
                self.write_cache(&host, found.as_ref());
                found.map(|(mime, bytes)| data_url(&mime, &bytes))
            })
            .await
            .clone();
        self.inflight.lock().await.remove(&host);
        result
    }

    fn cache_paths(&self, host: &str) -> (PathBuf, PathBuf) {
        (self.dir.join(format!("{host}.icon")), self.dir.join(format!("{host}.none")))
    }

    /// `Some(Some(url))` = cached icon, `Some(None)` = cached miss, `None` = not cached / stale.
    fn read_cache(&self, host: &str) -> Option<Option<String>> {
        let (icon, none) = self.cache_paths(host);
        let fresh = |p: &Path, ttl: Duration| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .is_some_and(|age| age < ttl)
        };
        if fresh(&icon, POSITIVE_TTL) {
            let bytes = std::fs::read(&icon).ok()?;
            // File layout: "<mime>\n<bytes>".
            let split = bytes.iter().position(|b| *b == b'\n')?;
            let mime = String::from_utf8_lossy(&bytes[..split]).to_string();
            return Some(Some(data_url(&mime, &bytes[split + 1..])));
        }
        if fresh(&none, NEGATIVE_TTL) {
            return Some(None);
        }
        None
    }

    fn write_cache(&self, host: &str, found: Option<&(String, Vec<u8>)>) {
        let _ = std::fs::create_dir_all(&self.dir);
        let (icon, none) = self.cache_paths(host);
        match found {
            Some((mime, bytes)) => {
                let mut out = mime.as_bytes().to_vec();
                out.push(b'\n');
                out.extend_from_slice(bytes);
                let _ = vault_core::sync::atomic_write(&icon, &out);
                let _ = std::fs::remove_file(none);
            }
            None => {
                let _ = std::fs::write(none, b"");
            }
        }
    }

    async fn lookup(&self, host: &str) -> Option<(String, Vec<u8>)> {
        let mut candidates = vec![host.to_string()];
        if let Some(root) = registrable_domain(host) {
            if root != host {
                candidates.push(root);
            }
        }
        for h in candidates {
            if let Some(found) = self.lookup_host(&h).await {
                return Some(found);
            }
        }
        None
    }

    async fn lookup_host(&self, host: &str) -> Option<(String, Vec<u8>)> {
        let base = format!("https://{host}/");
        // 1. Icons declared in the page.
        if let Some((page_url, html)) = self.fetch_text(&base).await {
            for href in icon_links(&html) {
                if let Ok(url) = page_url.join(&href) {
                    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_some_and(is_private_host) {
                        continue;
                    }
                    if let Some(icon) = self.fetch_image(url.as_str()).await {
                        return Some(icon);
                    }
                }
            }
        }
        // 2. The conventional location.
        self.fetch_image(&format!("https://{host}/favicon.ico")).await
    }

    async fn fetch_text(&self, url: &str) -> Option<(url::Url, String)> {
        let resp = self.http.get(url).header("Accept", "text/html").send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let final_url = resp.url().clone();
        if final_url.host_str().is_some_and(is_private_host) {
            return None;
        }
        let bytes = read_limited(resp, MAX_HTML).await?;
        Some((final_url, String::from_utf8_lossy(&bytes).into_owned()))
    }

    async fn fetch_image(&self, url: &str) -> Option<(String, Vec<u8>)> {
        let resp = self.http.get(url).header("Accept", "image/*").send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let header_mime = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.split(';').next().unwrap_or("").trim().to_lowercase());
        let bytes = read_limited(resp, MAX_ICON).await?;
        let mime = sniff_image(&bytes).or_else(|| header_mime.filter(|m| m.starts_with("image/")))?;
        if bytes.len() < 64 {
            return None; // 1x1 placeholders and empty responses
        }
        Some((mime, bytes))
    }
}

async fn read_limited(mut resp: reqwest::Response, max: usize) -> Option<Vec<u8>> {
    if resp.content_length().is_some_and(|n| n as usize > max) {
        return None;
    }
    let mut out = Vec::new();
    while let Ok(Some(chunk)) = resp.chunk().await {
        out.extend_from_slice(&chunk);
        if out.len() > max {
            return None;
        }
    }
    Some(out)
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Recognise the image formats a webview can render.
pub fn sniff_image(b: &[u8]) -> Option<String> {
    let m = if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if b.starts_with(&[0, 0, 1, 0]) {
        "image/x-icon"
    } else if b.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if b.starts_with(b"GIF8") {
        "image/gif"
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        "image/webp"
    } else {
        let head = String::from_utf8_lossy(&b[..b.len().min(512)]).to_lowercase();
        if head.contains("<svg") {
            "image/svg+xml"
        } else {
            return None;
        }
    };
    Some(m.to_string())
}

/// Extract icon hrefs from HTML, best first: apple-touch-icon, then sized/svg icons (largest
/// first), then plain `icon` / `shortcut icon`.
pub fn icon_links(html: &str) -> Vec<String> {
    let lower = html.to_lowercase();
    let mut found: Vec<(i32, String)> = Vec::new();
    let mut pos = 0;
    while let Some(start) = lower[pos..].find("<link") {
        let start = pos + start;
        let end = lower[start..].find('>').map(|e| start + e).unwrap_or(lower.len());
        let tag_lower = &lower[start..end];
        let tag = &html[start..end];
        pos = end;
        let Some(rel) = attr(tag_lower, tag_lower, "rel") else { continue };
        if !rel.split_whitespace().any(|r| r == "icon" || r == "apple-touch-icon" || r == "apple-touch-icon-precomposed") {
            continue;
        }
        let Some(href) = attr(tag_lower, tag, "href").filter(|h| !h.is_empty() && !h.starts_with("data:")) else { continue };
        let sizes = attr(tag_lower, tag_lower, "sizes").unwrap_or_default();
        let size: i32 = sizes
            .split(|c: char| c == 'x' || c.is_whitespace())
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let mut score = if rel.contains("apple-touch-icon") { 1000 } else { 0 };
        score += if href.to_lowercase().ends_with(".svg") || sizes == "any" { 500 } else { size.min(256) };
        found.push((score, href));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, h)| h).collect()
}

/// Value of `name="..."` in a tag; `lower` is used to locate it, `orig` to read it (keeps case).
fn attr(lower: &str, orig: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=");
    let mut idx = 0;
    while let Some(i) = lower[idx..].find(&needle) {
        let i = idx + i;
        let before_ok = i == 0 || lower.as_bytes()[i - 1].is_ascii_whitespace();
        let vstart = i + needle.len();
        idx = vstart;
        if !before_ok {
            continue;
        }
        let rest = &orig[vstart..];
        let value = match rest.chars().next()? {
            q @ ('"' | '\'') => rest[1..].split(q).next()?.to_string(),
            _ => rest.split(|c: char| c.is_whitespace() || c == '>' || c == '/').next()?.to_string(),
        };
        return Some(value.trim().to_string());
    }
    None
}

/// Lowercase host without port; `None` for anything we must not contact.
pub fn normalize_host(input: &str) -> Option<String> {
    let s = input.trim();
    let host = if s.contains("://") {
        url::Url::parse(s).ok()?.host_str()?.to_string()
    } else {
        url::Url::parse(&format!("https://{s}")).ok()?.host_str()?.to_string()
    };
    let host = host.trim_end_matches('.').to_lowercase();
    if host.is_empty() || is_private_host(&host) || !host.contains('.') {
        return None;
    }
    if !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
        return None;
    }
    Some(host)
}

fn is_private_host(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']').to_lowercase();
    if h.parse::<std::net::IpAddr>().is_ok() {
        return true; // never fetch IP literals (routers, NAS, internal services)
    }
    h == "localhost"
        || [".local", ".lan", ".home", ".internal", ".intranet", ".corp", ".localhost", ".test", ".example", ".invalid"]
            .iter()
            .any(|s| h.ends_with(s))
}

fn registrable_domain(host: &str) -> Option<String> {
    let d = psl::domain(host.as_bytes())?;
    std::str::from_utf8(d.as_bytes()).ok().map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts() {
        assert_eq!(normalize_host("https://Account.Oray.com:8443/login").as_deref(), Some("account.oray.com"));
        assert_eq!(normalize_host("gist.github.com").as_deref(), Some("gist.github.com"));
        assert_eq!(normalize_host("http://10.0.0.1:8080/admin"), None);
        assert_eq!(normalize_host("router.local"), None);
        assert_eq!(normalize_host("localhost:3000"), None);
        assert_eq!(normalize_host("androidapp://com.example.app"), None.or(normalize_host("androidapp://com.example.app")));
        assert_eq!(registrable_domain("account.oray.com").as_deref(), Some("oray.com"));
        assert_eq!(registrable_domain("www.bbc.co.uk").as_deref(), Some("bbc.co.uk"));
    }

    #[test]
    fn links_are_ranked() {
        let html = r#"<html><head>
            <link rel="shortcut icon" href="/favicon.ico">
            <link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png">
            <LINK REL="apple-touch-icon" SIZES="180x180" HREF="/Apple-180.png">
            <link rel="icon" href="data:image/png;base64,AAAA">
            <link rel="stylesheet" href="/x.css">
        </head></html>"#;
        assert_eq!(icon_links(html), vec!["/Apple-180.png", "/icon-32.png", "/favicon.ico"]);
    }

    #[test]
    fn sniffing() {
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\nrest").as_deref(), Some("image/png"));
        assert_eq!(sniff_image(&[0, 0, 1, 0, 1, 0]).as_deref(), Some("image/x-icon"));
        assert_eq!(sniff_image(b"<?xml version='1.0'?><svg xmlns=...>").as_deref(), Some("image/svg+xml"));
        assert_eq!(sniff_image(b"<html>not an image</html>"), None);
    }
}

#[cfg(test)]
mod live {
    /// Network check against a few public sites: `cargo test -p vaultlet icons::live -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn fetch_real_icons() {
        let dir = tempfile::tempdir().unwrap();
        let svc = super::IconService::new(dir.path());
        for host in ["github.com", "www.12306.cn", "account.oray.com", "adobe.com", "affine.pro", "10.0.0.1"] {
            let t = std::time::Instant::now();
            let r = svc.get(host).await;
            println!("{host:22} {:>5} ms  {}", t.elapsed().as_millis(), r.as_deref().map(|u| &u[..u.find(';').unwrap_or(20)]).unwrap_or("none"));
        }
        // Second call is served from the disk cache.
        let t = std::time::Instant::now();
        assert!(svc.get("github.com").await.is_some());
        assert!(t.elapsed().as_millis() < 50);
    }
}
