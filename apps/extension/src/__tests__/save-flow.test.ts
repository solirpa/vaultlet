import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveFlow, type SaveFlowDeps, type SessionArea } from '../background/save-flow';
import type { LoginEntry } from '../shared/protocol';
import type { SavePrompt } from '../shared/rpc';

const login = (id: string, username: string, password: string): LoginEntry => ({
  id,
  title: 't',
  username,
  password,
  totp: false,
  url: 'https://example.com',
});

function setup(over: Partial<SaveFlowDeps> = {}) {
  const session: Record<string, unknown> = {};
  const area: SessionArea = {
    get: async (k) => (k in session ? { [k]: session[k] } : {}),
    set: async (items) => void Object.assign(session, structuredClone(items)),
    remove: async (k) => void delete session[k],
  };
  const prompts: { tabId: number; prompt: SavePrompt }[] = [];
  const never = new Set<string>();
  const deps: SaveFlowDeps = {
    session: area,
    getLogins: vi.fn(async () => [] as LoginEntry[]),
    saveLogin: vi.fn(async () => ({ entryId: 'new', created: true, updated: false })),
    sendPrompt: async (tabId, prompt) => void prompts.push({ tabId, prompt }),
    tabStatus: vi.fn(async () => 'complete' as const),
    isNever: async (o) => never.has(o),
    addNever: async (o) => void never.add(o),
    ...over,
  };
  return { flow: new SaveFlow(deps), deps, session, prompts, never };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('SaveFlow', () => {
  it('offers "save" 2 s after a capture when no navigation happens, then saves', async () => {
    const { flow, deps, session, prompts } = setup();
    await flow.capture(7, 'https://example.com/login?next=/x', 'alice', 'pw');
    expect(JSON.stringify(session)).toContain('alice'); // mirrored to storage.session only
    await vi.advanceTimersByTimeAsync(1900);
    expect(prompts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(prompts).toEqual([{ tabId: 7, prompt: { id: expect.any(String), kind: 'save', host: 'example.com', username: 'alice' } }]);
    expect(deps.getLogins).toHaveBeenCalledWith('https://example.com/login');

    expect(await flow.action(7, prompts[0].prompt.id, 'save')).toEqual({ ok: true });
    expect(deps.saveLogin).toHaveBeenCalledWith({ url: 'https://example.com', username: 'alice', password: 'pw' });
    expect(await flow.get(7)).toBeUndefined();
    expect(session).toEqual({}); // cleared after use
  });

  it('waits for the next page load when the tab navigates', async () => {
    const { flow, prompts } = setup();
    await flow.capture(1, 'https://example.com/login', 'alice', 'pw');
    await flow.onTabLoading(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(prompts).toHaveLength(0);
    await flow.onTabComplete(1);
    expect(prompts).toHaveLength(1);
  });

  it('treats a still-loading tab at 2 s as a navigation', async () => {
    const { flow, prompts } = setup({ tabStatus: async () => 'loading' });
    await flow.capture(1, 'https://example.com/login', 'alice', 'pw');
    await vi.advanceTimersByTimeAsync(2100);
    expect(prompts).toHaveLength(0);
    await flow.onTabComplete(1);
    expect(prompts).toHaveLength(1);
  });

  it('offers "update" with the stored username and entry id', async () => {
    const { flow, deps, prompts } = setup({ getLogins: vi.fn(async () => [login('e1', 'Alice', 'old')]) });
    await flow.capture(1, 'https://example.com/', 'alice', 'new');
    await vi.advanceTimersByTimeAsync(2100);
    expect(prompts[0].prompt).toMatchObject({ kind: 'update', username: 'Alice' });
    await flow.action(1, prompts[0].prompt.id, 'save');
    expect(deps.saveLogin).toHaveBeenCalledWith({ url: 'https://example.com', username: 'Alice', password: 'new', entryId: 'e1' });
  });

  it('drops identical logins without prompting', async () => {
    const { flow, prompts } = setup({ getLogins: vi.fn(async () => [login('e1', 'alice', 'pw')]) });
    await flow.capture(1, 'https://example.com/', 'alice', 'pw');
    await vi.advanceTimersByTimeAsync(2100);
    expect(prompts).toHaveLength(0);
    expect(await flow.get(1)).toBeUndefined();
  });

  it('keeps the capture while locked and offers it right after unlock', async () => {
    let locked = true;
    const getLogins = vi.fn(async () => {
      if (locked) throw Object.assign(new Error('locked'), { code: 'locked' });
      return [];
    });
    const { flow, prompts } = setup({ getLogins });
    await flow.capture(3, 'https://example.com/', 'alice', 'pw');
    await vi.advanceTimersByTimeAsync(2100);
    expect(prompts).toHaveLength(0);
    expect(await flow.get(3)).toBeDefined();
    locked = false;
    await flow.offerAll();
    expect(prompts).toHaveLength(1);
  });

  it('expires captures after 60 s', async () => {
    const { flow, session, prompts } = setup({ getLogins: vi.fn(async () => Promise.reject(new Error('locked'))) });
    await flow.capture(3, 'https://example.com/', 'alice', 'pw');
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await flow.get(3)).toBeUndefined();
    expect(session).toEqual({});
    await flow.offerAll();
    expect(prompts).toHaveLength(0);
  });

  it('"Never for this site" stores the origin and suppresses future captures', async () => {
    const { flow, never, prompts } = setup();
    await flow.capture(1, 'https://example.com/a', 'alice', 'pw');
    await vi.advanceTimersByTimeAsync(2100);
    expect(await flow.action(1, prompts[0].prompt.id, 'never')).toEqual({ ok: true });
    expect([...never]).toEqual(['https://example.com']);
    await flow.capture(1, 'https://example.com/b', 'alice', 'pw');
    expect(await flow.get(1)).toBeUndefined();
  });

  it('rejects actions for unknown / stale prompts and ignores non-web URLs and empty passwords', async () => {
    const { flow } = setup();
    expect(await flow.action(1, 'nope', 'save')).toEqual({ ok: false, error: 'expired' });
    await flow.capture(1, 'chrome://settings', 'a', 'b');
    await flow.capture(2, 'https://example.com', 'a', '');
    expect(await flow.get(1)).toBeUndefined();
    expect(await flow.get(2)).toBeUndefined();
  });

  it('survives a service-worker restart via storage.session', async () => {
    const first = setup();
    await first.flow.capture(5, 'https://example.com/', 'alice', 'pw');
    const restarted = new SaveFlow({ ...first.deps, session: {
      get: async (k) => (k in first.session ? { [k]: first.session[k] } : {}),
      set: async (items) => void Object.assign(first.session, items),
      remove: async (k) => void delete first.session[k],
    } });
    expect(await restarted.get(5)).toMatchObject({ username: 'alice', origin: 'https://example.com' });
  });
});
