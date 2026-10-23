// Minimal RFC 6238 TOTP for the browser mock (SHA1/256/512, 6-8 digits).

function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/[=\s-]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(new Uint8Array(out).buffer as ArrayBuffer);
}

interface Parsed {
  secret: string;
  digits: number;
  period: number;
  algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
}

function parse(secretOrUri: string): Parsed {
  const p: Parsed = { secret: secretOrUri, digits: 6, period: 30, algorithm: 'SHA-1' };
  if (secretOrUri.startsWith('otpauth://')) {
    const u = new URL(secretOrUri);
    p.secret = u.searchParams.get('secret') ?? '';
    p.digits = Number(u.searchParams.get('digits') ?? 6);
    p.period = Number(u.searchParams.get('period') ?? 30);
    const alg = (u.searchParams.get('algorithm') ?? 'SHA1').toUpperCase();
    p.algorithm = alg === 'SHA256' ? 'SHA-256' : alg === 'SHA512' ? 'SHA-512' : 'SHA-1';
  }
  return p;
}

export async function totp(
  secretOrUri: string,
  now: number = Date.now(),
): Promise<{ code: string; period: number; remaining: number }> {
  const { secret, digits, period, algorithm } = parse(secretOrUri);
  const key = base32Decode(secret);
  const counter = Math.floor(now / 1000 / period);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(4, counter >>> 0);
  new DataView(msg.buffer).setUint32(0, Math.floor(counter / 2 ** 32));
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key.length ? key : new Uint8Array(new ArrayBuffer(1)),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, msg));
  const offset = sig[sig.length - 1] & 0x0f;
  const bin =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff);
  const code = String(bin % 10 ** digits).padStart(digits, '0');
  const remaining = period - (Math.floor(now / 1000) % period);
  return { code, period, remaining };
}
