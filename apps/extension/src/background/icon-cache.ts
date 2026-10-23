/**
 * Site icon cache in the background: in-memory LRU (≤ 500 hosts, ≤ 2 MB of
 * data: URLs) persisted to chrome.storage.local so a reopened popup renders
 * icons instantly. Concurrent lookups of one host share a request, and at
 * most 4 requests run against the app at once (newest first, so the rows the
 * user is looking at win over rows scrolled past).
 */
import { isAcceptableIcon, normalizeHost } from '../shared/site-icon';

export interface PersistedIcon {
  /** data: URL */
  d: string;
  /** fetched at */
  f: number;
  /** last used */
  t: number;
}

export interface IconPersist {
  load(): Promise<Record<string, PersistedIcon> | undefined>;
  save(data: Record<string, PersistedIcon>): Promise<void>;
}

export interface IconCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  concurrency?: number;
  /** re-fetch icons older than this (the app keeps its own 30-day cache) */
  ttlMs?: number;
  /** remember "no icon" this long (memory only) */
  missTtlMs?: number;
  persistDelayMs?: number;
  now?: () => number;
}

interface Entry {
  dataUrl: string | null;
  fetchedAt: number;
  usedAt: number;
}

export const ICON_STORAGE_KEY = 'iconCache';

export class IconCache {
  private mem = new Map<string, Entry>(); // insertion order = LRU order (oldest first)
  private inflight = new Map<string, Promise<string | null>>();
  private queue: (() => void)[] = [];
  private active = 0;
  private loading: Promise<void> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly o: Required<IconCacheOptions>;

  constructor(
    private readonly fetcher: (host: string) => Promise<string | null>,
    private readonly persist?: IconPersist,
    opts: IconCacheOptions = {},
  ) {
    this.o = {
      maxEntries: opts.maxEntries ?? 500,
      maxBytes: opts.maxBytes ?? 2_000_000,
      concurrency: opts.concurrency ?? 4,
      ttlMs: opts.ttlMs ?? 7 * 24 * 3600_000,
      missTtlMs: opts.missTtlMs ?? 10 * 60_000,
      persistDelayMs: opts.persistDelayMs ?? 1000,
      now: opts.now ?? Date.now,
    };
  }

  /** data: URL for the host, or null (no icon / app unavailable). */
  async get(rawHost: string): Promise<string | null> {
    const host = normalizeHost(rawHost);
    if (!host) return null;
    await this.load();
    const now = this.o.now();
    const hit = this.mem.get(host);
    if (hit) {
      const ttl = hit.dataUrl ? this.o.ttlMs : this.o.missTtlMs;
      if (now - hit.fetchedAt < ttl) {
        this.touch(host, hit, now);
        return hit.dataUrl;
      }
    }
    const pending = this.inflight.get(host);
    if (pending) return pending;
    const p = this.schedule(() => this.fetcher(host))
      .then((d) => {
        const dataUrl = isAcceptableIcon(d) ? d : null;
        this.put(host, { dataUrl, fetchedAt: this.o.now(), usedAt: this.o.now() });
        return dataUrl;
      })
      // app locked / not running / timeout: answer null but do not remember it
      .catch(() => hit?.dataUrl ?? null)
      .finally(() => this.inflight.delete(host));
    this.inflight.set(host, p);
    return p;
  }

  /** Snapshot for tests / diagnostics. */
  stats(): { entries: number; bytes: number; hosts: string[] } {
    return { entries: this.mem.size, bytes: this.bytes(), hosts: [...this.mem.keys()] };
  }

  /** Write pending changes now (tests, service-worker shutdown). */
  async flush(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    await this.save();
  }

  // ---- internals --------------------------------------------------------------

  private load(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        if (!this.persist) return;
        try {
          const data = (await this.persist.load()) ?? {};
          const rows = Object.entries(data)
            .filter(([h, v]) => normalizeHost(h) === h && v && isAcceptableIcon(v.d))
            .sort((a, b) => a[1].t - b[1].t);
          for (const [h, v] of rows) {
            if (!this.mem.has(h)) this.mem.set(h, { dataUrl: v.d, fetchedAt: v.f, usedAt: v.t });
          }
          this.evict();
        } catch {
          /* start empty */
        }
      })();
    }
    return this.loading;
  }

  private touch(host: string, e: Entry, now: number): void {
    e.usedAt = now;
    this.mem.delete(host);
    this.mem.set(host, e);
    if (e.dataUrl) this.schedulePersist();
  }

  private put(host: string, e: Entry): void {
    this.mem.delete(host);
    this.mem.set(host, e);
    this.evict();
    this.schedulePersist();
  }

  private bytes(): number {
    let n = 0;
    for (const e of this.mem.values()) n += e.dataUrl?.length ?? 0;
    return n;
  }

  private evict(): void {
    while (this.mem.size > this.o.maxEntries) this.mem.delete(this.mem.keys().next().value!);
    let bytes = this.bytes();
    for (const [h, e] of this.mem) {
      if (bytes <= this.o.maxBytes) break;
      if (!e.dataUrl) continue;
      bytes -= e.dataUrl.length;
      this.mem.delete(h);
    }
  }

  private schedulePersist(): void {
    if (!this.persist || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.save();
    }, this.o.persistDelayMs);
  }

  private async save(): Promise<void> {
    if (!this.persist) return;
    const out: Record<string, PersistedIcon> = {};
    for (const [h, e] of this.mem) if (e.dataUrl) out[h] = { d: e.dataUrl, f: e.fetchedAt, t: e.usedAt };
    try {
      await this.persist.save(out);
    } catch {
      /* quota etc.: memory cache still works */
    }
  }

  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.queue.pop()?.(); // LIFO: most recently requested first
          });
      };
      if (this.active < this.o.concurrency) run();
      else this.queue.push(run);
    });
  }
}
