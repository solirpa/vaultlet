//! Password generation (CSPRNG via the OS) and a simple strength estimate.

use crate::error::{Error, Result};

const UPPER: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
const DIGITS: &[u8] = b"0123456789";
const SYMBOLS: &[u8] = b"!@#$%^&*()-_=+[]{};:,.<>?/";

fn random_u32() -> Result<u32> {
    getrandom::u32().map_err(|e| Error::Crypto(format!("os rng unavailable: {e}")))
}

/// Uniform index in `0..n` by rejection sampling (no modulo bias).
fn random_index(n: usize) -> Result<usize> {
    debug_assert!(n > 0 && n <= u32::MAX as usize);
    let n32 = n as u32;
    let limit = u32::MAX - (u32::MAX % n32);
    loop {
        let r = random_u32()?;
        if r < limit {
            return Ok((r % n32) as usize);
        }
    }
}

/// Generate a password of `length` characters using the enabled classes. At least one character
/// of every enabled class is guaranteed.
pub fn password_generate(
    length: usize,
    upper: bool,
    lower: bool,
    digits: bool,
    symbols: bool,
) -> Result<String> {
    let classes: Vec<&[u8]> = [(upper, UPPER), (lower, LOWER), (digits, DIGITS), (symbols, SYMBOLS)]
        .into_iter()
        .filter(|(on, _)| *on)
        .map(|(_, c)| c)
        .collect();
    if classes.is_empty() {
        return Err(Error::InvalidArgument("enable at least one character class".into()));
    }
    if length < classes.len() {
        return Err(Error::InvalidArgument(format!(
            "length {length} is too short for {} character classes",
            classes.len()
        )));
    }
    if length > 1024 {
        return Err(Error::InvalidArgument("length is too large".into()));
    }
    let alphabet: Vec<u8> = classes.iter().flat_map(|c| c.iter().copied()).collect();
    let mut out: Vec<u8> = Vec::with_capacity(length);
    for class in &classes {
        out.push(class[random_index(class.len())?]);
    }
    while out.len() < length {
        out.push(alphabet[random_index(alphabet.len())?]);
    }
    // Fisher–Yates so the guaranteed characters are not always at the front.
    for i in (1..out.len()).rev() {
        let j = random_index(i + 1)?;
        out.swap(i, j);
    }
    Ok(String::from_utf8(out).expect("ascii alphabet"))
}

/// Rough strength score 0..=4 from an entropy estimate (charset size ^ effective length).
pub fn strength(password: &str) -> u8 {
    if password.is_empty() {
        return 0;
    }
    let (mut up, mut lo, mut di, mut sy, mut other) = (false, false, false, false, false);
    for c in password.chars() {
        if c.is_ascii_uppercase() {
            up = true;
        } else if c.is_ascii_lowercase() {
            lo = true;
        } else if c.is_ascii_digit() {
            di = true;
        } else if c.is_ascii() {
            sy = true;
        } else {
            other = true;
        }
    }
    let mut pool = 0f64;
    if up {
        pool += 26.0;
    }
    if lo {
        pool += 26.0;
    }
    if di {
        pool += 10.0;
    }
    if sy {
        pool += 33.0;
    }
    if other {
        pool += 100.0;
    }
    // Repeated characters add less than fresh ones.
    let mut seen = std::collections::HashSet::new();
    let mut effective = 0f64;
    for c in password.chars() {
        effective += if seen.insert(c) { 1.0 } else { 0.5 };
    }
    let bits = effective * pool.log2();
    match bits {
        b if b < 28.0 => 0,
        b if b < 40.0 => 1,
        b if b < 60.0 => 2,
        b if b < 80.0 => 3,
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes_are_guaranteed() {
        for _ in 0..200 {
            let p = password_generate(4, true, true, true, true).unwrap();
            assert_eq!(p.len(), 4);
            assert!(p.bytes().any(|b| UPPER.contains(&b)));
            assert!(p.bytes().any(|b| LOWER.contains(&b)));
            assert!(p.bytes().any(|b| DIGITS.contains(&b)));
            assert!(p.bytes().any(|b| SYMBOLS.contains(&b)));
        }
        let p = password_generate(32, false, false, true, false).unwrap();
        assert!(p.bytes().all(|b| b.is_ascii_digit()));
        assert_eq!(p.len(), 32);
        assert!(password_generate(8, false, false, false, false).is_err());
        assert!(password_generate(2, true, true, true, false).is_err());
        assert_ne!(
            password_generate(20, true, true, true, true).unwrap(),
            password_generate(20, true, true, true, true).unwrap()
        );
    }

    #[test]
    fn strength_scale() {
        assert_eq!(strength(""), 0);
        assert_eq!(strength("abc"), 0);
        assert_eq!(strength("password"), 1);
        assert_eq!(strength("Tr0ub4dor&3"), 3);
        assert_eq!(strength("correct horse battery staple"), 4);
        assert_eq!(strength("aaaaaaaaaaaaaaaaaaaa"), 2);
        assert_eq!(strength(&password_generate(24, true, true, true, true).unwrap()), 4);
    }
}
