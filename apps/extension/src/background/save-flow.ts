/**
 * Save / update prompt flow (background side).
 *
 *  content script ──captureLogin──▶ SaveFlow.capture()   (kept per tab, 60 s)
 *  next page load in that tab, or 2 s without navigation ──▶ offer()
 *    get-logins(origin) + decideSaveOffer() ──▶ prompt to the tab's top frame
 *  user clicks Save / Update / Not now / Never ──▶ action()
 *
 * Captured passwords exist only in the in-memory map here, mirrored to
 * chrome.storage.session (memory-only, cleared on browser restart, not readable
 * by content scripts) so a suspended MV3 service worker does not lose them.
 * They are removed after use, after "none" decisions and on expiry. Never logged.
 */
import { uuid } from '../shared/crypto';
import type { LoginEntry, SaveLoginInput, SaveLoginResult } from '../shared/protocol';
import type { PromptAction, SavePrompt } from '../shared/rpc';
import { decideSaveOffer, type SaveDecision } from '../shared/save-decision';

export const CAPTURE_TTL_MS = 60_000;
export const NO_NAVIGATION_MS = 2_000;
/** a shown card lives 30 s; keep the capture a little longer so its buttons still work */
const PROMPT_GRACE_MS = 35_000;
const SESSION_KEY = 'vaultletPendingCaptures';

export interface PendingCapture {
  tabId: number;
  /** URL of the frame the login was submitted in (from the message sender, not the page) */
  url: string;
  origin: string;
  host: string;
  username: string;
  password: string;
  createdAt: number;
  expiresAt: number;
  /** a navigation started after the capture; offer on load complete */
  navigating?: boolean;
  promptId?: string;
  decision?: SaveDecision;
  offeredAt?: number;
}

/** Minimal storage.session-like area (injectable for tests). */
export interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface SaveFlowDeps {
  session?: SessionArea;
  getLogins(url: string): Promise<LoginEntry[]>;
  saveLogin(input: SaveLoginInput): Promise<SaveLoginResult>;
  sendPrompt(tabId: number, prompt: SavePrompt): Promise<void>;
  tabStatus(tabId: number): Promise<'loading' | 'complete' | 'gone' | undefined>;
  isNever(origin: string): Promise<boolean>;
  addNever(origin: string): Promise<void>;
  /** e.g. the badge count changed after a save */
  onSaved?(result: SaveLoginResult): void;
  now?(): number;
}

export class SaveFlow {
  private mem = new Map<number, PendingCapture>();
  private expiry = new Map<number, ReturnType<typeof setTimeout>>();
  private ready: Promise<void>;

  constructor(private readonly deps: SaveFlowDeps) {
    this.ready = this.load();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // ---- store ------------------------------------------------------------------

  private async load(): Promise<void> {
    const area = this.deps.session;
    if (!area) return;
    try {
      const raw = (await area.get(SESSION_KEY))?.[SESSION_KEY] as Record<string, PendingCapture> | undefined;
      const now = this.now();
      for (const c of Object.values(raw ?? {})) {
        if (c && typeof c.tabId === 'number' && c.expiresAt > now && !this.mem.has(c.tabId)) {
          this.mem.set(c.tabId, c);
          this.scheduleExpiry(c);
        }
      }
      await this.persist();
    } catch {
      /* session storage unavailable: memory only */
    }
  }

  private async persist(): Promise<void> {
    const area = this.deps.session;
    if (!area) return;
    try {
      if (this.mem.size === 0) await area.remove(SESSION_KEY);
      else await area.set({ [SESSION_KEY]: Object.fromEntries([...this.mem].map(([k, v]) => [String(k), v])) });
    } catch {
      /* ignore */
    }
  }

  private scheduleExpiry(c: PendingCapture): void {
    const old = this.expiry.get(c.tabId);
    if (old) clearTimeout(old);
    const t = setTimeout(
      () => {
        const cur = this.mem.get(c.tabId);
        if (cur && cur.expiresAt <= this.now()) void this.drop(c.tabId);
      },
      Math.max(0, c.expiresAt - this.now()) + 10,
    );
    this.expiry.set(c.tabId, t);
  }

  private async put(c: PendingCapture): Promise<void> {
    this.mem.set(c.tabId, c);
    this.scheduleExpiry(c);
    await this.persist();
  }

  async drop(tabId: number): Promise<void> {
    await this.ready;
    const t = this.expiry.get(tabId);
    if (t) clearTimeout(t);
    this.expiry.delete(tabId);
    if (this.mem.delete(tabId)) await this.persist();
  }

  async get(tabId: number): Promise<PendingCapture | undefined> {
    await this.ready;
    const c = this.mem.get(tabId);
    if (c && c.expiresAt <= this.now()) {
      await this.drop(tabId);
      return undefined;
    }
    return c;
  }

  // ---- flow -------------------------------------------------------------------

  /** A login was submitted in `frameUrl` of `tabId`. */
  async capture(tabId: number, frameUrl: string, username: string, password: string): Promise<void> {
    await this.ready;
    if (!password || typeof password !== 'string') return;
    let u: URL;
    try {
      u = new URL(frameUrl);
    } catch {
      return;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
    if (await this.deps.isNever(u.origin)) return;
    const now = this.now();
    const c: PendingCapture = {
      tabId,
      url: `${u.origin}${u.pathname}`,
      origin: u.origin,
      host: u.host,
      username: String(username ?? '').trim(),
      password,
      createdAt: now,
      expiresAt: now + CAPTURE_TTL_MS,
    };
    await this.put(c);
    setTimeout(() => void this.noNavigationCheck(tabId, now), NO_NAVIGATION_MS);
  }

  /** 2 s after the capture: offer now unless a navigation is under way. */
  async noNavigationCheck(tabId: number, createdAt: number): Promise<void> {
    const c = await this.get(tabId);
    if (!c || c.createdAt !== createdAt || c.navigating || c.offeredAt) return;
    const status = await this.deps.tabStatus(tabId).catch(() => undefined);
    if (status === 'gone') {
      await this.drop(tabId);
      return;
    }
    if (status === 'loading') {
      await this.put({ ...c, navigating: true });
      return;
    }
    await this.offer(tabId);
  }

  async onTabLoading(tabId: number): Promise<void> {
    const c = await this.get(tabId);
    if (c && !c.navigating) await this.put({ ...c, navigating: true });
  }

  async onTabComplete(tabId: number): Promise<void> {
    const c = await this.get(tabId);
    if (c) await this.offer(tabId);
  }

  /** After unlock: offer whatever is still pending. */
  async offerAll(): Promise<void> {
    await this.ready;
    for (const tabId of [...this.mem.keys()]) await this.offer(tabId);
  }

  /** Decide and, if there is something to offer, send the card to the tab's top frame. */
  async offer(tabId: number): Promise<void> {
    const c = await this.get(tabId);
    if (!c) return;
    if (await this.deps.isNever(c.origin)) {
      await this.drop(tabId);
      return;
    }
    let entries: LoginEntry[];
    try {
      entries = await this.deps.getLogins(c.url);
    } catch {
      return; // locked / not paired / app not running: keep it for after unlock (within the 60 s window)
    }
    const fresh = await this.get(tabId);
    if (!fresh || fresh.createdAt !== c.createdAt) return; // replaced or expired meanwhile
    const decision = decideSaveOffer(c, entries);
    if (decision.kind === 'none') {
      await this.drop(tabId);
      return;
    }
    const now = this.now();
    const offeredAt = fresh.offeredAt ?? now;
    const next: PendingCapture = {
      ...fresh,
      decision,
      promptId: fresh.promptId ?? uuid(),
      offeredAt,
      expiresAt: Math.max(fresh.expiresAt, offeredAt + PROMPT_GRACE_MS),
    };
    await this.put(next);
    const prompt: SavePrompt = {
      id: next.promptId!,
      kind: decision.kind,
      host: c.host,
      username: decision.kind === 'update' ? decision.username : c.username,
    };
    await this.deps.sendPrompt(tabId, prompt).catch(() => {});
  }

  /** The user answered the card shown in `tabId`. */
  async action(tabId: number, promptId: string, action: PromptAction): Promise<{ ok: boolean; error?: string }> {
    const c = await this.get(tabId);
    if (!c || c.promptId !== promptId || !c.decision || c.decision.kind === 'none') {
      return { ok: false, error: 'expired' };
    }
    if (action === 'dismiss') {
      await this.drop(tabId);
      return { ok: true };
    }
    if (action === 'never') {
      await this.deps.addNever(c.origin);
      await this.drop(tabId);
      return { ok: true };
    }
    const d = c.decision;
    const input: SaveLoginInput =
      d.kind === 'update'
        ? { url: c.origin, username: d.username, password: c.password, entryId: d.entryId }
        : { url: c.origin, username: c.username, password: c.password };
    try {
      const result = await this.deps.saveLogin(input);
      await this.drop(tabId);
      this.deps.onSaved?.(result);
      return { ok: true };
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'error';
      if (code === 'not-found') await this.drop(tabId);
      return { ok: false, error: code };
    }
  }
}
