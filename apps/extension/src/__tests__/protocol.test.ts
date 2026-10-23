/**
 * Wire format of the new `search` and `save-login` actions: what the
 * NativeClient puts inside the encrypted envelope and how it reads replies,
 * against a fake desktop app on the other end of a fake native port.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, open, seal } from '../shared/crypto';
import type { Envelope, HelloRequest, Request } from '../shared/protocol';

type Listener = (m: unknown) => void;

const app = generateKeyPair();
const received: Request[] = [];
let extPublicKey = '';
let reply: (req: Request) => Record<string, unknown> = (req) => ({ id: req.id, ok: true });

function makePort() {
  const msgListeners: Listener[] = [];
  const port = {
    onMessage: { addListener: (l: Listener) => msgListeners.push(l) },
    onDisconnect: { addListener: () => {} },
    disconnect: () => {},
    postMessage(m: unknown) {
      const deliver = (x: unknown) => queueMicrotask(() => msgListeners.forEach((l) => l(x)));
      const hello = m as HelloRequest;
      if (hello.type === 'hello') {
        extPublicKey = hello.publicKey;
        deliver({ type: 'hello', publicKey: app.publicKey, paired: true, version: '0.2.0' });
        return;
      }
      const req = open<Request>(m as Envelope, extPublicKey, app.secretKey);
      received.push(req);
      deliver(seal('app', reply(req), extPublicKey, app.secretKey));
    },
  };
  return port;
}

const store: Record<string, unknown> = {};
const fakeChrome = {
  runtime: {
    id: 'test',
    lastError: undefined,
    connectNative: () => makePort(),
  },
  storage: {
    local: {
      get: (keys: string[] | null, cb: (r: Record<string, unknown>) => void) =>
        cb(Object.fromEntries((keys ?? Object.keys(store)).filter((k) => k in store).map((k) => [k, store[k]]))),
      set: (items: Record<string, unknown>, cb: () => void) => {
        Object.assign(store, items);
        cb();
      },
      remove: (keys: string[], cb: () => void) => {
        keys.forEach((k) => delete store[k]);
        cb();
      },
    },
  },
};

let NativeClient: typeof import('../background/native-client').NativeClient;
let client: InstanceType<typeof NativeClient>;

beforeAll(async () => {
  vi.stubGlobal('chrome', fakeChrome);
  ({ NativeClient } = await import('../background/native-client'));
  client = new NativeClient({ onStateChange() {}, onEvent() {} });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const entry = { id: 'e1', title: 'GitHub', username: 'alice', password: 'pw', totp: false, url: 'https://github.com' };

describe('protocol envelope: search / save-login', () => {
  it('seals and opens the new request shapes', () => {
    const ext = generateKeyPair();
    const reqs: Request[] = [
      { id: '1', action: 'search', query: 'git' },
      { id: '2', action: 'save-login', url: 'https://example.com', username: 'a', password: 'p' },
      { id: '3', action: 'save-login', url: 'https://example.com', username: 'a', password: 'p', entryId: 'e1', title: 'T' },
    ];
    for (const r of reqs) expect(open(seal('c', r, app.publicKey, ext.secretKey), ext.publicKey, app.secretKey)).toEqual(r);
  });

  it('search sends { id, action: "search", query } and returns summaries (never a password)', async () => {
    // an older app may still include the password; the client drops it
    reply = (req) => ({ id: req.id, ok: true, entries: [{ ...entry, favorite: true }] });
    const out = await client.search('Git');
    const req = received.at(-1)!;
    expect(req).toEqual({ id: expect.any(String), action: 'search', query: 'Git' });
    expect(out).toEqual([{ id: 'e1', title: 'GitHub', username: 'alice', url: 'https://github.com', totp: false, favorite: true }]);
    expect(out[0]).not.toHaveProperty('password');
  });

  it('list sends { id, action: "list" } and returns summaries', async () => {
    reply = (req) => ({
      id: req.id,
      ok: true,
      entries: [{ id: 'a', title: 'A', username: 'u', url: '', totp: true, favorite: false }],
    });
    const out = await client.list();
    expect(received.at(-1)).toEqual({ id: expect.any(String), action: 'list' });
    expect(out).toEqual([{ id: 'a', title: 'A', username: 'u', url: '', totp: true, favorite: false }]);
  });

  it('get-entry sends { id, action: "get-entry", entryId } and returns the full entry', async () => {
    const full = { ...entry, urls: ['https://github.com', 'https://gist.github.com'], notes: 'n', favorite: true };
    reply = (req) => ({ id: req.id, ok: true, entry: full });
    expect(await client.getEntry('e1')).toEqual(full);
    expect(received.at(-1)).toEqual({ id: expect.any(String), action: 'get-entry', entryId: 'e1' });
    reply = (req) => ({ id: req.id, ok: false, code: 'not-found' });
    await expect(client.getEntry('zz')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('save-login without entryId creates (no entryId / title keys on the wire)', async () => {
    reply = (req) => ({ id: req.id, ok: true, entryId: 'new-1', created: true });
    const out = await client.saveLogin({ url: 'https://example.com', username: 'bob', password: 'pw2' });
    const req = received.at(-1)!;
    expect(req).toEqual({ id: expect.any(String), action: 'save-login', url: 'https://example.com', username: 'bob', password: 'pw2' });
    expect(Object.keys(req)).not.toContain('entryId');
    expect(Object.keys(req)).not.toContain('title');
    expect(out).toEqual({ entryId: 'new-1', created: true, updated: false });
  });

  it('save-login with entryId updates', async () => {
    reply = (req) => ({ id: req.id, ok: true, entryId: 'e1', updated: true });
    const out = await client.saveLogin({ url: 'https://github.com', username: 'alice', password: 'new', entryId: 'e1', title: 'GitHub' });
    expect(received.at(-1)).toMatchObject({ action: 'save-login', entryId: 'e1', title: 'GitHub', password: 'new' });
    expect(out).toEqual({ entryId: 'e1', created: false, updated: true });
  });

  it('maps error codes (not-found, locked) to NativeClientError', async () => {
    reply = (req) => ({ id: req.id, ok: false, code: 'not-found' });
    await expect(client.saveLogin({ url: 'https://x.test', username: 'a', password: 'b', entryId: 'nope' })).rejects.toMatchObject({
      code: 'not-found',
    });
    reply = (req) => ({ id: req.id, ok: false, code: 'locked' });
    await expect(client.search('x')).rejects.toMatchObject({ code: 'locked' });
    expect(client.locked).toBe(true);
  });

  it('uses a fresh request id per call', async () => {
    reply = (req) => ({ id: req.id, ok: true, entries: [] });
    await client.search('a');
    await client.search('b');
    const [a, b] = received.slice(-2);
    expect(a.id).not.toBe(b.id);
  });
});
