import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IconCache, type IconPersist, type PersistedIcon } from '../background/icon-cache';
import { iconHost, monogram, normalizeHost } from '../shared/site-icon';

const png = (tag: string, pad = 0) => `data:image/png;base64,${tag}${'A'.repeat(pad)}`;

function memoryStore(initial: Record<string, PersistedIcon> = {}) {
  let data: Record<string, PersistedIcon> | undefined = structuredClone(initial);
  const store: IconPersist & { data: () => Record<string, PersistedIcon> | undefined; saves: number } = {
    saves: 0,
    load: async () => structuredClone(data),
    save: async (d) => {
      store.saves++;
      data = structuredClone(d);
    },
    data: () => data,
  };
  return store;
}

/** A fetcher whose requests resolve only when the test says so. */
function controlledFetcher() {
  const pending = new Map<string, (v: string | null) => void>();
  const calls: string[] = [];
  const fetcher = vi.fn((host: string) => {
    calls.push(host);
    return new Promise<string | null>((res) => pending.set(host, res));
  });
  return { fetcher, calls, resolve: (host: string, v: string | null) => pending.get(host)?.(v), pending };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('IconCache', () => {
  it('fetches once, then serves from memory', async () => {
    const fetcher = vi.fn(async (h: string) => png(h));
    const c = new IconCache(fetcher);
    expect(await c.get('GitHub.com')).toBe(png('github.com'));
    expect(await c.get('github.com')).toBe(png('github.com'));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent lookups of one host', async () => {
    const f = controlledFetcher();
    const c = new IconCache(f.fetcher);
    const a = c.get('a.test');
    const b = c.get('a.test');
    await vi.advanceTimersByTimeAsync(0);
    f.resolve('a.test', png('a'));
    expect(await a).toBe(png('a'));
    expect(await b).toBe(png('a'));
    expect(f.calls).toEqual(['a.test']);
  });

  it('runs at most 4 requests at once, newest queued first', async () => {
    const f = controlledFetcher();
    const c = new IconCache(f.fetcher);
    const hosts = ['h1.test', 'h2.test', 'h3.test', 'h4.test', 'h5.test', 'h6.test', 'h7.test'];
    const results = hosts.map((h) => c.get(h));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toEqual(['h1.test', 'h2.test', 'h3.test', 'h4.test']);
    f.resolve('h1.test', png('1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.at(-1)).toBe('h7.test'); // LIFO: the row requested last is likely the one on screen
    for (const h of hosts) f.resolve(h, png(h));
    await vi.advanceTimersByTimeAsync(0);
    for (const h of hosts.slice(4)) f.resolve(h, png(h));
    await Promise.all(results);
    expect(f.calls).toHaveLength(7);
  });

  it('evicts the least recently used host beyond maxEntries', async () => {
    const c = new IconCache(async (h) => png(h), undefined, { maxEntries: 3 });
    for (const h of ['a.test', 'b.test', 'c.test']) await c.get(h);
    await c.get('a.test'); // a is now most recent
    await c.get('d.test');
    expect(c.stats().hosts).toEqual(['c.test', 'a.test', 'd.test']);
  });

  it('keeps the total size under maxBytes, evicting oldest first', async () => {
    const c = new IconCache(async (h) => png(h, 400), undefined, { maxBytes: 1000 });
    for (const h of ['a.test', 'b.test', 'c.test', 'd.test']) await c.get(h);
    const { hosts, bytes } = c.stats();
    expect(bytes).toBeLessThanOrEqual(1000);
    expect(hosts).toEqual(['c.test', 'd.test']);
  });

  it('persists data URLs (not misses) and restores them in LRU order', async () => {
    const store = memoryStore();
    const fetcher = vi.fn(async (h: string) => (h === 'none.test' ? null : png(h)));
    const c = new IconCache(fetcher, store, { persistDelayMs: 500 });
    await c.get('a.test');
    await c.get('none.test');
    await c.get('b.test');
    expect(store.saves).toBe(0); // debounced
    await vi.advanceTimersByTimeAsync(600);
    expect(Object.keys(store.data()!)).toEqual(['a.test', 'b.test']);

    // a fresh instance (popup reopened / worker restarted) answers without asking the app
    const fetcher2 = vi.fn(async () => png('x'));
    const c2 = new IconCache(fetcher2, store);
    expect(await c2.get('b.test')).toBe(png('b.test'));
    expect(await c2.get('a.test')).toBe(png('a.test'));
    expect(fetcher2).not.toHaveBeenCalled();
    expect(c2.stats().hosts).toEqual(['b.test', 'a.test']);
  });

  it('drops invalid persisted rows and non-image responses', async () => {
    const store = memoryStore({
      'ok.test': { d: png('ok'), f: Date.now(), t: 1 },
      'bad.test': { d: 'javascript:alert(1)', f: Date.now(), t: 2 },
      'Not A Host': { d: png('x'), f: Date.now(), t: 3 },
    });
    const c = new IconCache(async () => 'data:text/html,<script>', store);
    await c.get('ok.test');
    expect(c.stats().hosts).toEqual(['ok.test']);
    expect(await c.get('other.test')).toBeNull();
  });

  it('does not remember failures (app locked / not running) but does remember misses', async () => {
    let fail = true;
    const fetcher = vi.fn(async () => {
      if (fail) throw new Error('locked');
      return null;
    });
    const c = new IconCache(fetcher, undefined, { missTtlMs: 60_000 });
    expect(await c.get('a.test')).toBeNull();
    fail = false;
    expect(await c.get('a.test')).toBeNull();
    expect(await c.get('a.test')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2); // retried after the failure, then the miss is cached
    await vi.advanceTimersByTimeAsync(61_000);
    await c.get('a.test');
    expect(fetcher).toHaveBeenCalledTimes(3); // miss expired
  });

  it('re-fetches icons older than the TTL', async () => {
    const fetcher = vi.fn(async (h: string) => png(h));
    const c = new IconCache(fetcher, undefined, { ttlMs: 1000 });
    await c.get('a.test');
    await vi.advanceTimersByTimeAsync(1500);
    await c.get('a.test');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ignores things that are not hosts', async () => {
    const fetcher = vi.fn(async () => png('x'));
    const c = new IconCache(fetcher);
    expect(await c.get('')).toBeNull();
    expect(await c.get('a b')).toBeNull();
    expect(await c.get('https://x.test')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('site icon helpers', () => {
  it('iconHost only for http(s) URLs', () => {
    expect(iconHost('https://www.GitHub.com/login')).toBe('www.github.com');
    expect(iconHost('http://localhost:8080/')).toBe('localhost:8080');
    expect(iconHost('github.com')).toBe('github.com');
    expect(iconHost('androidapp://com.example')).toBeNull();
    expect(iconHost('ssh://host')).toBeNull();
    expect(iconHost('')).toBeNull();
    expect(normalizeHost('Example.COM.')).toBe('example.com');
  });

  it('monogram: first letter, CJK character or digit', () => {
    expect(monogram('github')).toBe('G');
    expect(monogram('微信')).toBe('微');
    expect(monogram('1Password')).toBe('1');
    expect(monogram('  (work) Slack')).toBe('W');
    expect(monogram('')).toBe('?');
  });
});
