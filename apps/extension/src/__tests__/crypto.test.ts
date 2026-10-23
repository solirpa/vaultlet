import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { generateKeyPair, open, seal, uuid } from '../shared/crypto';
import { isEnvelope } from '../shared/protocol';

describe('protocol envelope (nacl.box)', () => {
  it('round-trips between two key pairs', () => {
    const ext = generateKeyPair();
    const app = generateKeyPair();
    const request = { id: uuid(), action: 'get-logins', url: 'https://example.com/login' };

    const env = seal('client-1', request, app.publicKey, ext.secretKey);
    expect(isEnvelope(env)).toBe(true);
    expect(env.clientId).toBe('client-1');
    expect(decodeBase64(env.nonce)).toHaveLength(nacl.box.nonceLength);

    // The app opens with its secret key and our public key
    const opened = open<typeof request>(env, ext.publicKey, app.secretKey);
    expect(opened).toEqual(request);

    // And replies the same way
    const reply = { id: request.id, ok: true, entries: [] };
    const back = seal('client-1', reply, ext.publicKey, app.secretKey);
    expect(open(back, app.publicKey, ext.secretKey)).toEqual(reply);
  });

  it('uses a fresh nonce per message', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const e1 = seal('c', { x: 1 }, b.publicKey, a.secretKey);
    const e2 = seal('c', { x: 1 }, b.publicKey, a.secretKey);
    expect(e1.nonce).not.toBe(e2.nonce);
    expect(e1.payload).not.toBe(e2.payload);
  });

  it('rejects tampered payloads and wrong keys', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const mallory = generateKeyPair();
    const env = seal('c', { secret: 'hunter2' }, b.publicKey, a.secretKey);

    expect(() => open(env, a.publicKey, mallory.secretKey)).toThrow();

    const bytes = decodeBase64(env.payload);
    bytes[bytes.length - 1] ^= 0x01;
    const tampered = { ...env, payload: encodeBase64(bytes) };
    expect(() => open(tampered, a.publicKey, b.secretKey)).toThrow();

    expect(() => open({ ...env, nonce: 'AAAA' }, a.publicKey, b.secretKey)).toThrow(/nonce/);
  });

  it('generates RFC 4122 uuids', () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuid()).not.toBe(uuid());
  });
});
