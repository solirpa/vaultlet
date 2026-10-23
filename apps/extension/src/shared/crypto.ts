import nacl from 'tweetnacl';
import { decodeBase64, decodeUTF8, encodeBase64, encodeUTF8 } from 'tweetnacl-util';
import type { Envelope } from './protocol';

export interface KeyPairB64 {
  publicKey: string;
  secretKey: string;
}

export function generateKeyPair(): KeyPairB64 {
  const kp = nacl.box.keyPair();
  return { publicKey: encodeBase64(kp.publicKey), secretKey: encodeBase64(kp.secretKey) };
}

export function randomNonce(): Uint8Array {
  return nacl.randomBytes(nacl.box.nonceLength);
}

/**
 * Seal a JSON-serialisable value into a protocol envelope:
 * payload = base64(nacl.box(utf8(json), nonce, theirPublic, ourSecret)).
 */
export function seal(
  clientId: string,
  message: unknown,
  theirPublicKeyB64: string,
  ourSecretKeyB64: string,
): Envelope {
  const nonce = randomNonce();
  const boxed = nacl.box(
    decodeUTF8(JSON.stringify(message)),
    nonce,
    decodeBase64(theirPublicKeyB64),
    decodeBase64(ourSecretKeyB64),
  );
  return { clientId, nonce: encodeBase64(nonce), payload: encodeBase64(boxed) };
}

/**
 * Open a protocol envelope. Returns the parsed JSON or throws if the box does
 * not authenticate.
 */
export function open<T = unknown>(
  envelope: Envelope,
  theirPublicKeyB64: string,
  ourSecretKeyB64: string,
): T {
  const nonce = decodeBase64(envelope.nonce);
  if (nonce.length !== nacl.box.nonceLength) {
    throw new Error('bad nonce length');
  }
  const opened = nacl.box.open(
    decodeBase64(envelope.payload),
    nonce,
    decodeBase64(theirPublicKeyB64),
    decodeBase64(ourSecretKeyB64),
  );
  if (!opened) {
    throw new Error('box authentication failed');
  }
  return JSON.parse(encodeUTF8(opened)) as T;
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 fallback
  const b = nacl.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
