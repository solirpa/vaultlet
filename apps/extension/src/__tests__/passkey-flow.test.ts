/**
 * Passkey sign-in in the background: origin from the sender, client data built
 * by the extension, nothing signed without an answer from the confirmation
 * window, and fallbacks to the browser's own WebAuthn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PasskeyFlow, type PasskeyCaller, type PasskeyClient } from '../background/passkey-flow';
import type { LoginEntry, PasskeyCandidate, PasskeyCreateInput } from '../shared/protocol';
import { clientDataJSON, fromB64url, isSecureOrigin, rpIdMatchesHost, sha256B64url, toB64url } from '../shared/webauthn';

const AWS: PasskeyCaller = {
  tabId: 7,
  frameId: 0,
  url: 'https://us-east-1.signin.aws.amazon.com/oauth?x=1',
  tabUrl: 'https://us-east-1.signin.aws.amazon.com/oauth?x=1',
};
const ENTRY: PasskeyCandidate = { entryId: 'e1', title: 'AWS-123456789012', username: 'alice', credentialId: 'AQID' };

const LOGINS: LoginEntry[] = [
  { id: 'l1', title: 'Example', username: 'alice', password: 'pw', totp: false, url: 'https://example.com', passkey: false },
  { id: 'l2', title: 'Example 2', username: 'bob', password: 'pw', totp: false, url: 'https://example.com', passkey: true },
];

function setup(opts: { entries?: PasskeyCandidate[]; locked?: boolean; paired?: boolean; createError?: string } = {}) {
  let locked = opts.locked ?? false;
  const signed: { origin: string; rpId: string; entryId: string; hash: string }[] = [];
  const listed: { origin: string; rpId: string; allow: string[] }[] = [];
  const created: PasskeyCreateInput[] = [];
  const client: PasskeyClient = {
    async passkeyCreate(input) {
      created.push(input);
      if (opts.createError) throw Object.assign(new Error(opts.createError), { code: opts.createError });
      return {
        entryId: 'new-entry',
        credentialId: 'Q1JFRA',
        authenticatorData: 'YXV0aA',
        attestationObject: 'YXR0',
        publicKey: 'c3BraQ',
        publicKeyAlgorithm: -7,
      };
    },
    async logins() {
      if (locked) throw Object.assign(new Error('locked'), { code: 'locked' });
      return LOGINS;
    },
    async passkeyList(origin, rpId, allow) {
      listed.push({ origin, rpId, allow });
      if (locked) throw Object.assign(new Error('locked'), { code: 'locked' });
      return opts.entries ?? [ENTRY];
    },
    async passkeySign(origin, rpId, entryId, hash) {
      signed.push({ origin, rpId, entryId, hash });
      return { credentialId: 'AQID', authenticatorData: 'YXV0aA', signature: 'c2ln', userHandle: 'dXNlcg' };
    },
    isPaired: async () => opts.paired ?? true,
  };
  const opened: string[] = [];
  const closed: number[] = [];
  const windows = {
    async open(requestId: string) {
      opened.push(requestId);
      return 100 + opened.length;
    },
    close: (id: number) => closed.push(id),
  };
  let n = 0;
  const flow = new PasskeyFlow(client, windows, () => `req-${++n}`);
  return { flow, signed, listed, created, opened, closed, unlock: () => (locked = false) };
}

const REQUEST = { challenge: 'Y2hhbGxlbmdl', rpId: 'aws.amazon.com', allowCredentials: [] as string[] };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('webauthn helpers', () => {
  it('base64url round-trips', () => {
    const bytes = new Uint8Array([0, 251, 255, 1, 2]);
    expect(toB64url(bytes)).toBe('APv_AQI');
    expect(Array.from(fromB64url('APv_AQI'))).toEqual(Array.from(bytes));
  });

  it('secure origins and RP ID suffixes', () => {
    expect(isSecureOrigin('https://a.example/x')).toBe(true);
    expect(isSecureOrigin('http://localhost:3000/')).toBe(true);
    expect(isSecureOrigin('http://example.com/')).toBe(false);
    expect(rpIdMatchesHost('aws.amazon.com', 'us-east-1.signin.aws.amazon.com')).toBe(true);
    expect(rpIdMatchesHost('amazon.com', 'notamazon.com')).toBe(false);
    expect(rpIdMatchesHost('', 'a.com')).toBe(false);
  });
});

describe('PasskeyFlow', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it('signs only after the user picks a passkey, with client data built from the sender origin', async () => {
    const { flow, signed, opened, closed } = setup();
    const result = flow.get(AWS, 'page-1', REQUEST);
    await tick();
    expect(opened).toEqual(['req-1']);
    expect(signed).toEqual([]); // nothing signed before the click

    const prompt = await flow.prompt('req-1');
    expect(prompt).toEqual({
      kind: 'get',
      origin: 'https://us-east-1.signin.aws.amazon.com',
      rpId: 'aws.amazon.com',
      locked: false,
      entries: [{ entryId: 'e1', title: 'AWS-123456789012', username: 'alice' }],
    });

    await flow.answer('req-1', { entryId: 'e1' });
    const r = await result;
    expect(r.kind).toBe('assertion');
    if (r.kind !== 'assertion') return;
    const json = clientDataJSON('Y2hhbGxlbmdl', 'https://us-east-1.signin.aws.amazon.com');
    expect(new TextDecoder().decode(fromB64url(r.assertion.response.clientDataJSON))).toBe(json);
    expect(JSON.parse(json)).toEqual({
      type: 'webauthn.get',
      challenge: 'Y2hhbGxlbmdl',
      origin: 'https://us-east-1.signin.aws.amazon.com',
      crossOrigin: false,
    });
    expect(signed).toEqual([
      { origin: 'https://us-east-1.signin.aws.amazon.com', rpId: 'aws.amazon.com', entryId: 'e1', hash: await sha256B64url(json) },
    ]);
    expect(r.assertion).toMatchObject({ id: 'AQID', rawId: 'AQID', type: 'public-key' });
    expect(r.assertion.response).toMatchObject({ authenticatorData: 'YXV0aA', signature: 'c2ln', userHandle: 'dXNlcg' });
    expect(closed).toEqual([101]);
  });

  it('falls back to the browser when Vaultlet has nothing for the site', async () => {
    const { flow, opened } = setup({ entries: [] });
    expect(await flow.get(AWS, 'p', REQUEST)).toEqual({ kind: 'fallback' });
    expect(opened).toEqual([]);
  });

  it('falls back when not paired, on insecure pages and in cross-origin frames', async () => {
    expect(await setup({ paired: false }).flow.get(AWS, 'p', REQUEST)).toEqual({ kind: 'fallback' });
    const { flow, listed } = setup();
    expect(await flow.get({ ...AWS, url: 'http://aws.amazon.com/', tabUrl: 'http://aws.amazon.com/' }, 'p', REQUEST)).toEqual({ kind: 'fallback' });
    expect(await flow.get({ ...AWS, frameId: 3, tabUrl: 'https://evil.example/' }, 'p', REQUEST)).toEqual({ kind: 'fallback' });
    expect(listed).toEqual([]);
  });

  it('refuses an RP ID that is not the page host or a parent of it', async () => {
    const { flow, listed } = setup();
    const r = await flow.get({ ...AWS, url: 'https://evil.example/', tabUrl: 'https://evil.example/' }, 'p', REQUEST);
    expect(r).toEqual({ kind: 'error', name: 'SecurityError' });
    expect(listed).toEqual([]);
  });

  it('defaults the RP ID to the page host and passes allowCredentials through', async () => {
    const { flow, listed } = setup({ entries: [] });
    await flow.get(AWS, 'p', { challenge: 'x', allowCredentials: ['AQID'] });
    expect(listed).toEqual([{ origin: 'https://us-east-1.signin.aws.amazon.com', rpId: 'us-east-1.signin.aws.amazon.com', allow: ['AQID'] }]);
  });

  it('cancel, fallback and closing the window', async () => {
    const a = setup();
    const r1 = a.flow.get(AWS, 'p1', REQUEST);
    await tick();
    await a.flow.answer('req-1', 'cancel');
    expect(await r1).toEqual({ kind: 'error', name: 'NotAllowedError' });

    const r2 = a.flow.get(AWS, 'p2', REQUEST);
    await tick();
    await a.flow.answer('req-2', 'fallback');
    expect(await r2).toEqual({ kind: 'fallback' });

    const r3 = a.flow.get(AWS, 'p3', REQUEST);
    await tick();
    a.flow.windowClosed(103);
    expect(await r3).toEqual({ kind: 'error', name: 'NotAllowedError' });
    expect(a.signed).toEqual([]);
    expect(await a.flow.prompt('req-3')).toBeNull();
  });

  it('the page can abort, and a new request replaces the old one in the same tab', async () => {
    const { flow, closed } = setup();
    const r1 = flow.get(AWS, 'p1', REQUEST);
    await tick();
    const r2 = flow.get(AWS, 'p2', REQUEST);
    expect(await r1).toEqual({ kind: 'error', name: 'NotAllowedError' });
    await tick();
    flow.cancelFromPage(AWS.tabId, 'p2');
    expect(await r2).toEqual({ kind: 'error', name: 'AbortError' });
    expect(closed).toEqual([101, 102]);
  });

  it('a locked vault shows the unlock state, then the passkeys once unlocked', async () => {
    const { flow, unlock } = setup({ locked: true });
    const r = flow.get(AWS, 'p', REQUEST);
    await tick();
    expect(await flow.prompt('req-1')).toMatchObject({ locked: true, entries: [] });
    unlock();
    const p = await flow.prompt('req-1');
    expect(p?.kind === 'get' && p.entries).toHaveLength(1);
    await flow.answer('req-1', { entryId: 'e1' });
    expect((await r).kind).toBe('assertion');
  });

  it('times out', async () => {
    vi.useFakeTimers();
    const { flow } = setup();
    const r = flow.get(AWS, 'p', { ...REQUEST, timeout: 60_000 });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await r).toEqual({ kind: 'error', name: 'NotAllowedError' });
  });

  // ---- create ----------------------------------------------------------------

  const CREATE = {
    challenge: 'Y2hhbGxlbmdl',
    rp: { id: 'aws.amazon.com', name: 'AWS' },
    user: { id: 'dXNlcg', name: 'alice', displayName: 'Alice' },
    algorithms: [-8, -7, -257],
    excludeCredentials: [] as string[],
    credProps: true,
  };

  it('saves a passkey only after the user chose where, and returns a none attestation', async () => {
    const { flow, created, opened } = setup({ entries: [] });
    const result = flow.create(AWS, 'page-1', CREATE);
    await tick();
    expect(opened).toEqual(['req-1']);
    expect(created).toEqual([]);

    const prompt = await flow.prompt('req-1');
    expect(prompt).toEqual({
      kind: 'create',
      origin: 'https://us-east-1.signin.aws.amazon.com',
      rpId: 'aws.amazon.com',
      rpName: 'AWS',
      userName: 'alice',
      userDisplayName: 'Alice',
      locked: false,
      excluded: false,
      // logins that already hold a passkey are not offered
      targets: [{ entryId: 'l1', title: 'Example', username: 'alice' }],
    });

    await flow.answer('req-1', { saveTo: 'l1' });
    const r = await result;
    expect(created).toEqual([
      {
        origin: 'https://us-east-1.signin.aws.amazon.com',
        rpId: 'aws.amazon.com',
        rpName: 'AWS',
        userId: 'dXNlcg',
        userName: 'alice',
        entryId: 'l1',
        excludeCredentials: [],
      },
    ]);
    expect(r.kind).toBe('attestation');
    if (r.kind !== 'attestation') return;
    const cd = JSON.parse(new TextDecoder().decode(fromB64url(r.attestation.response.clientDataJSON)));
    expect(cd).toEqual({
      type: 'webauthn.create',
      challenge: 'Y2hhbGxlbmdl',
      origin: 'https://us-east-1.signin.aws.amazon.com',
      crossOrigin: false,
    });
    expect(r.attestation).toMatchObject({ id: 'Q1JFRA', rawId: 'Q1JFRA', clientExtensionResults: { credProps: { rk: true } } });
    expect(r.attestation.response).toMatchObject({ attestationObject: 'YXR0', publicKey: 'c3BraQ', publicKeyAlgorithm: -7 });
  });

  it('"new" saves to a new item', async () => {
    const { flow, created } = setup();
    const result = flow.create(AWS, 'p', CREATE);
    await tick();
    await flow.answer('req-1', { saveTo: 'new' });
    expect((await result).kind).toBe('attestation');
    expect(created[0].entryId).toBeUndefined();
  });

  it('leaves security-key-only and non-ES256 registrations to the browser', async () => {
    const { flow, opened } = setup();
    expect(await flow.create(AWS, 'p', { ...CREATE, authenticatorAttachment: 'cross-platform' })).toEqual({ kind: 'fallback' });
    expect(await flow.create(AWS, 'p', { ...CREATE, algorithms: [-257] })).toEqual({ kind: 'fallback' });
    expect(await setup({ paired: false }).flow.create(AWS, 'p', CREATE)).toEqual({ kind: 'fallback' });
    expect(await flow.create({ ...AWS, url: 'https://evil.example/', tabUrl: 'https://evil.example/' }, 'p', CREATE)).toEqual({
      kind: 'error',
      name: 'SecurityError',
    });
    expect(opened).toEqual([]);
  });

  it('an account already in the vault: told so, OK gives InvalidStateError, nothing created', async () => {
    const { flow, created, listed } = setup(); // passkeyList finds ENTRY
    const result = flow.create(AWS, 'p', { ...CREATE, excludeCredentials: ['AQID'] });
    await tick();
    expect(await flow.prompt('req-1')).toMatchObject({ kind: 'create', excluded: true });
    expect(listed.at(-1)).toEqual({ origin: 'https://us-east-1.signin.aws.amazon.com', rpId: 'aws.amazon.com', allow: ['AQID'] });
    await flow.answer('req-1', 'cancel');
    expect(await result).toEqual({ kind: 'error', name: 'InvalidStateError' });
    expect(created).toEqual([]);
  });

  it('the app refusing an excluded credential at save time also gives InvalidStateError', async () => {
    const { flow } = setup({ entries: [], createError: 'excluded' });
    const result = flow.create(AWS, 'p', CREATE);
    await tick();
    await flow.answer('req-1', { saveTo: 'new' });
    expect(await result).toEqual({ kind: 'error', name: 'InvalidStateError' });
  });

  it('other save errors go back to the window and the request stays open', async () => {
    const { flow } = setup({ entries: [], createError: 'already-exists' });
    const result = flow.create(AWS, 'p', CREATE);
    await tick();
    await expect(flow.answer('req-1', { saveTo: 'l1' })).rejects.toThrow('already-exists');
    expect(await flow.prompt('req-1')).not.toBeNull();
    await flow.answer('req-1', 'cancel');
    expect(await result).toEqual({ kind: 'error', name: 'NotAllowedError' });
  });

  it('locked: the window waits for unlock before offering targets', async () => {
    const { flow, unlock } = setup({ locked: true });
    const result = flow.create(AWS, 'p', CREATE);
    await tick();
    expect(await flow.prompt('req-1')).toMatchObject({ kind: 'create', locked: true, targets: [] });
    unlock();
    expect(await flow.prompt('req-1')).toMatchObject({ locked: false, targets: [{ entryId: 'l1' }] });
    await flow.answer('req-1', { saveTo: 'new' });
    expect((await result).kind).toBe('attestation');
  });
});
