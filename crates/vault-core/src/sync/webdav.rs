//! Minimal async WebDAV client (architecture doc section 4): GET with ETag caching, PUT with
//! `If-Match`, existence check and MKCOL. Works with 坚果云 (`https://dav.jianguoyun.com/dav/`),
//! Nextcloud and plain Apache/nginx DAV.

use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::header::{HeaderValue, ETAG, IF_MATCH, IF_NONE_MATCH};
use reqwest::{Method, StatusCode};

use crate::error::{Error, Result};

/// Characters to escape inside a path segment.
const SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b']')
    .add(b'\\')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

#[derive(Debug, Clone)]
pub enum GetResult {
    NotModified,
    Modified { bytes: Vec<u8>, etag: Option<String> },
    NotFound,
}

#[derive(Clone)]
pub struct Client {
    base: String,
    username: String,
    password: String,
    http: reqwest::Client,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebDavClient").field("base", &self.base).field("username", &self.username).finish()
    }
}

/// Join a base URL and a remote path, percent-encoding each path segment.
pub fn join_url(base: &str, path: &str) -> String {
    let mut out = base.trim_end_matches('/').to_string();
    for seg in path.split('/').filter(|s| !s.is_empty()) {
        out.push('/');
        out.push_str(&utf8_percent_encode(seg, SEGMENT).to_string());
    }
    out
}

/// "Not there" answers. Besides 404, 坚果云 replies 409 `AncestorsNotFound` when a parent
/// directory of the requested path is missing too, e.g. before the first upload.
fn is_missing(status: StatusCode) -> bool {
    status == StatusCode::NOT_FOUND || status == StatusCode::CONFLICT
}

impl Client {
    pub fn new(base_url: &str, username: &str, password: &str) -> Result<Client> {
        let base = base_url.trim().to_string();
        if !(base.starts_with("https://") || base.starts_with("http://")) {
            return Err(Error::InvalidArgument("WebDAV URL must start with http:// or https://".into()));
        }
        let http = reqwest::Client::builder()
            .user_agent("Vaultlet/0.1")
            .timeout(std::time::Duration::from_secs(60))
            .build()?;
        Ok(Client { base, username: username.to_string(), password: password.to_string(), http })
    }

    fn url(&self, path: &str) -> String {
        join_url(&self.base, path)
    }

    fn req(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, self.url(path))
            .basic_auth(&self.username, Some(&self.password))
    }

    fn http_error(status: StatusCode, body: String) -> Error {
        match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Error::InvalidKey,
            StatusCode::PRECONDITION_FAILED => Error::PreconditionFailed,
            s => Error::Http { status: s.as_u16(), message: body.chars().take(200).collect() },
        }
    }

    /// Download `path`. With `if_none_match`, an unchanged file yields [`GetResult::NotModified`].
    pub async fn get(&self, path: &str, if_none_match: Option<&str>) -> Result<GetResult> {
        let mut r = self.req(Method::GET, path);
        if let Some(e) = if_none_match {
            r = r.header(IF_NONE_MATCH, HeaderValue::from_str(e).map_err(|e| Error::InvalidArgument(e.to_string()))?);
        }
        let resp = r.send().await?;
        match resp.status() {
            StatusCode::NOT_MODIFIED => Ok(GetResult::NotModified),
            s if is_missing(s) => Ok(GetResult::NotFound),
            s if s.is_success() => {
                let etag = resp.headers().get(ETAG).and_then(|v| v.to_str().ok()).map(String::from);
                let bytes = resp.bytes().await?.to_vec();
                // Some servers ignore If-None-Match; honour the ETag ourselves.
                if let (Some(want), Some(got)) = (if_none_match, etag.as_deref()) {
                    if want == got {
                        return Ok(GetResult::NotModified);
                    }
                }
                Ok(GetResult::Modified { bytes, etag })
            }
            s => Err(Self::http_error(s, resp.text().await.unwrap_or_default())),
        }
    }

    /// Upload `bytes` to `path`. With `if_match`, the server rejects the write when someone else
    /// changed the file first ([`Error::PreconditionFailed`]). Returns the new ETag if known.
    pub async fn put(&self, path: &str, bytes: Vec<u8>, if_match: Option<&str>) -> Result<Option<String>> {
        let mut r = self
            .req(Method::PUT, path)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(bytes);
        if let Some(e) = if_match {
            r = r.header(IF_MATCH, HeaderValue::from_str(e).map_err(|e| Error::InvalidArgument(e.to_string()))?);
        }
        let resp = r.send().await?;
        let status = resp.status();
        if status.is_success() {
            let etag = resp.headers().get(ETAG).and_then(|v| v.to_str().ok()).map(String::from);
            if etag.is_some() {
                return Ok(etag);
            }
            // 坚果云 and some others do not return an ETag on PUT: ask for it.
            return Ok(self.etag(path).await.unwrap_or(None));
        }
        Err(Self::http_error(status, resp.text().await.unwrap_or_default()))
    }

    /// Current ETag of a file (HEAD), `None` if the server does not provide one.
    pub async fn etag(&self, path: &str) -> Result<Option<String>> {
        let resp = self.req(Method::HEAD, path).send().await?;
        let status = resp.status();
        if is_missing(status) {
            return Err(Error::NotFound(path.to_string()));
        }
        if !status.is_success() {
            return Err(Self::http_error(status, String::new()));
        }
        Ok(resp.headers().get(ETAG).and_then(|v| v.to_str().ok()).map(String::from))
    }

    pub async fn exists(&self, path: &str) -> Result<bool> {
        let resp = self
            .req(Method::from_bytes(b"PROPFIND").expect("method"), path)
            .header("Depth", "0")
            .send()
            .await?;
        match resp.status() {
            s if is_missing(s) => Ok(false),
            s if s.is_success() => Ok(true),
            StatusCode::METHOD_NOT_ALLOWED => {
                // Fall back to HEAD for servers without PROPFIND.
                let resp = self.req(Method::HEAD, path).send().await?;
                Ok(resp.status().is_success())
            }
            s => Err(Self::http_error(s, resp.text().await.unwrap_or_default())),
        }
    }

    /// Create a collection (directory); succeeds if it already exists.
    pub async fn mkcol(&self, path: &str) -> Result<()> {
        let resp = self.req(Method::from_bytes(b"MKCOL").expect("method"), path).send().await?;
        match resp.status() {
            s if s.is_success() || s == StatusCode::METHOD_NOT_ALLOWED => Ok(()),
            s => Err(Self::http_error(s, resp.text().await.unwrap_or_default())),
        }
    }

    /// Make sure every parent directory of `path` exists.
    pub async fn ensure_parents(&self, path: &str) -> Result<()> {
        let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        let mut cur = String::new();
        for seg in segs.iter().take(segs.len().saturating_sub(1)) {
            cur.push('/');
            cur.push_str(seg);
            if !self.exists(&cur).await? {
                self.mkcol(&cur).await?;
            }
        }
        Ok(())
    }

    /// Quick connectivity/authentication check against the base URL.
    pub async fn test_connection(&self) -> Result<()> {
        let resp = self
            .req(Method::from_bytes(b"PROPFIND").expect("method"), "")
            .header("Depth", "0")
            .send()
            .await?;
        let status = resp.status();
        if status.is_success() || status == StatusCode::METHOD_NOT_ALLOWED {
            Ok(())
        } else {
            Err(Self::http_error(status, resp.text().await.unwrap_or_default()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_and_encodes_paths() {
        assert_eq!(join_url("https://dav.jianguoyun.com/dav/", "Vaultlet/my vault.kdbx"), "https://dav.jianguoyun.com/dav/Vaultlet/my%20vault.kdbx");
        assert_eq!(join_url("https://x.example/dav", "/a//b/密码.kdbx"), "https://x.example/dav/a/b/%E5%AF%86%E7%A0%81.kdbx");
        assert_eq!(join_url("https://x.example/dav", ""), "https://x.example/dav");
    }

    #[test]
    fn rejects_non_http_urls() {
        assert!(Client::new("ftp://x", "u", "p").is_err());
        assert!(Client::new("https://dav.jianguoyun.com/dav/", "u", "p").is_ok());
    }

    /// A tiny WebDAV server that answers like 坚果云: 409 when a parent directory is missing,
    /// 404 when only the target is.
    async fn fake_jianguoyun() -> String {
        use std::collections::{HashMap, HashSet};
        use std::sync::{Arc, Mutex};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        #[derive(Default)]
        struct Fs {
            dirs: HashSet<String>,
            files: HashMap<String, Vec<u8>>,
        }
        let fs = Arc::new(Mutex::new(Fs::default()));
        fs.lock().unwrap().dirs.insert(String::new());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = listener.accept().await.unwrap();
                let fs = fs.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let (head_len, body_len) = loop {
                        let n = sock.read(&mut chunk).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
                            let len = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length:"))
                                .map(|v| v.trim().parse::<usize>().unwrap())
                                .unwrap_or(0);
                            break (i + 4, len);
                        }
                    };
                    while buf.len() < head_len + body_len {
                        let n = sock.read(&mut chunk).await.unwrap();
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let head = String::from_utf8_lossy(&buf[..head_len]).to_string();
                    let mut first = head.lines().next().unwrap().split(' ');
                    let method = first.next().unwrap().to_string();
                    let raw = first.next().unwrap().trim_start_matches("/dav").trim_end_matches('/').to_string();
                    let path = percent_encoding::percent_decode_str(&raw).decode_utf8_lossy().into_owned();
                    let parent = path.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default();
                    let body = buf[head_len..head_len + body_len].to_vec();

                    let (status, payload) = {
                        let mut fs = fs.lock().unwrap();
                        if !fs.dirs.contains(&parent) {
                            ("409 Conflict", b"<s:exception>AncestorsNotFound</s:exception>".to_vec())
                        } else {
                            match method.as_str() {
                                "PROPFIND" | "HEAD" if fs.dirs.contains(&path) || fs.files.contains_key(&path) => {
                                    ("207 Multi-Status", Vec::new())
                                }
                                "GET" if fs.files.contains_key(&path) => ("200 OK", fs.files[&path].clone()),
                                "MKCOL" => {
                                    fs.dirs.insert(path);
                                    ("201 Created", Vec::new())
                                }
                                "PUT" => {
                                    fs.files.insert(path, body);
                                    ("201 Created", Vec::new())
                                }
                                _ => ("404 Not Found", Vec::new()),
                            }
                        }
                    };
                    let resp = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", payload.len());
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.write_all(&payload).await;
                });
            }
        });
        format!("http://{addr}/dav/")
    }

    #[tokio::test]
    async fn first_upload_into_missing_folder() {
        let client = Client::new(&fake_jianguoyun().await, "u", "p").unwrap();
        let remote = "/我的坚果云/Vaultlet/Vaultlet.kdbx";

        // Parent folders missing: the server says 409, which still means "not there".
        assert!(!client.exists(remote).await.unwrap());
        assert!(matches!(client.get(remote, None).await.unwrap(), GetResult::NotFound));

        client.ensure_parents(remote).await.unwrap();
        assert!(!client.exists(remote).await.unwrap()); // now a plain 404
        client.put(remote, b"kdbx".to_vec(), None).await.unwrap();

        assert!(client.exists(remote).await.unwrap());
        match client.get(remote, None).await.unwrap() {
            GetResult::Modified { bytes, .. } => assert_eq!(bytes, b"kdbx"),
            _ => panic!("expected the uploaded file"),
        }
    }
}
