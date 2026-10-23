//! TOTP generation for `otpauth://totp/...` URIs and bare base32 secrets.

use std::time::{SystemTime, UNIX_EPOCH};

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use totp_rs::{Algorithm, Builder, Secret, Totp};

use crate::error::{Error, Result};

/// A generated one-time code plus the timing information the UI needs for a countdown ring.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Code {
    pub code: String,
    /// Step length in seconds.
    pub period: u32,
    /// Seconds until the code rolls over.
    pub remaining: u32,
}

fn is_uri(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    lower.starts_with("otpauth://")
}

/// Clean a bare secret: drop whitespace/dashes/padding, uppercase.
fn clean_secret(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '=')
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

fn decode_secret(s: &str) -> Result<Vec<u8>> {
    let cleaned = clean_secret(s);
    if cleaned.is_empty() {
        return Err(Error::Totp("empty TOTP secret".into()));
    }
    base32::decode(base32::Alphabet::Rfc4648 { padding: false }, &cleaned)
        .ok_or_else(|| Error::Totp("TOTP secret is not valid base32".into()))
}

/// Parse either form into a configured generator.
fn parse(secret_or_uri: &str) -> Result<Totp> {
    let s = secret_or_uri.trim();
    if s.is_empty() {
        return Err(Error::Totp("empty TOTP secret".into()));
    }
    if is_uri(s) {
        let lower = s.to_ascii_lowercase();
        if !lower.starts_with("otpauth://totp/") && !lower.starts_with("otpauth://totp?") {
            return Err(Error::Totp("only otpauth://totp URIs are supported".into()));
        }
        return Totp::from_url_unchecked(s).map_err(|e| Error::Totp(format!("invalid otpauth URI: {e}")));
    }
    let bytes = decode_secret(s)?;
    Ok(Builder::new()
        .with_algorithm(Algorithm::SHA1)
        .with_digits(6)
        .with_step_duration(30)
        .with_secret(Secret::from(bytes.as_slice()))
        .build_noncompliant())
}

/// Generate the code valid at `now`.
pub fn generate(secret_or_uri: &str, now: SystemTime) -> Result<Code> {
    let totp = parse(secret_or_uri)?;
    let ts = now
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::Totp("clock is before the unix epoch".into()))?
        .as_secs();
    let step = totp.step().max(1);
    let code = totp.generate(ts).to_string();
    Ok(Code {
        code,
        period: step as u32,
        remaining: (step - ts % step) as u32,
    })
}

/// Normalize the stored form: URIs pass through untouched (after a syntax check), bare secrets are
/// wrapped into an `otpauth://totp/<label>?secret=...` URI with the RFC defaults.
pub fn normalize_to_uri(secret_or_uri: &str, label: &str) -> Result<String> {
    let s = secret_or_uri.trim();
    if is_uri(s) {
        parse(s)?;
        return Ok(s.to_string());
    }
    let bytes = decode_secret(s)?;
    let secret = base32::encode(base32::Alphabet::Rfc4648 { padding: false }, &bytes);
    let label = if label.trim().is_empty() { "Vaultlet" } else { label.trim() };
    let label = utf8_percent_encode(label, NON_ALPHANUMERIC).to_string();
    Ok(format!(
        "otpauth://totp/{label}?secret={secret}&algorithm=SHA1&digits=6&period=30"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    fn uri(secret_ascii: &str, algo: &str) -> String {
        let b32 = base32::encode(base32::Alphabet::Rfc4648 { padding: false }, secret_ascii.as_bytes());
        format!("otpauth://totp/RFC6238:test?secret={b32}&algorithm={algo}&digits=8&period=30&issuer=RFC6238")
    }

    #[test]
    fn rfc6238_vectors() {
        // (time, sha1, sha256, sha512) from RFC 6238 appendix B
        let vectors = [
            (59u64, "94287082", "46119246", "90693936"),
            (1111111109, "07081804", "68084774", "25091201"),
            (1111111111, "14050471", "67062674", "99943326"),
            (1234567890, "89005924", "91819424", "93441116"),
            (2000000000, "69279037", "90698825", "38618901"),
            (20000000000, "65353130", "77737706", "47863826"),
        ];
        let sha1 = uri("12345678901234567890", "SHA1");
        let sha256 = uri("12345678901234567890123456789012", "SHA256");
        let sha512 = uri(
            "1234567890123456789012345678901234567890123456789012345678901234",
            "SHA512",
        );
        for (t, c1, c256, c512) in vectors {
            assert_eq!(generate(&sha1, at(t)).unwrap().code, c1, "sha1 @ {t}");
            assert_eq!(generate(&sha256, at(t)).unwrap().code, c256, "sha256 @ {t}");
            assert_eq!(generate(&sha512, at(t)).unwrap().code, c512, "sha512 @ {t}");
        }
    }

    #[test]
    fn bare_secret_defaults_and_period() {
        // JBSWY3DPEHPK3PXP = "Hello!\xde\xad\xbe\xef", a very common test secret.
        let c = generate("jbsw y3dp ehpk 3pxp====", at(59)).unwrap();
        assert_eq!(c.period, 30);
        assert_eq!(c.remaining, 1);
        assert_eq!(c.code.len(), 6);
        let c2 = generate("JBSWY3DPEHPK3PXP", at(59)).unwrap();
        assert_eq!(c.code, c2.code);
        let via_uri = generate(
            "otpauth://totp/Example:alice@google.com?secret=JBSWY3DPEHPK3PXP&issuer=Example",
            at(59),
        )
        .unwrap();
        assert_eq!(via_uri.code, c.code);
    }

    #[test]
    fn custom_digits_and_period() {
        let u = "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=7&period=60";
        let c = generate(u, at(130)).unwrap();
        assert_eq!(c.code.len(), 7);
        assert_eq!(c.period, 60);
        assert_eq!(c.remaining, 50);
    }

    #[test]
    fn normalize() {
        let n = normalize_to_uri("jbsw y3dp ehpk 3pxp", "GitHub:octocat").unwrap();
        assert_eq!(
            n,
            "otpauth://totp/GitHub%3Aoctocat?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30"
        );
        assert_eq!(generate(&n, at(59)).unwrap().code, generate("JBSWY3DPEHPK3PXP", at(59)).unwrap().code);
        let u = "otpauth://totp/a?secret=JBSWY3DPEHPK3PXP";
        assert_eq!(normalize_to_uri(u, "ignored").unwrap(), u);
        assert!(normalize_to_uri("not base32 !!!", "x").is_err());
        assert!(normalize_to_uri("", "x").is_err());
        assert!(generate("otpauth://hotp/a?secret=JBSWY3DPEHPK3PXP&counter=1", at(0)).is_err());
    }
}
