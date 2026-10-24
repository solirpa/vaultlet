/**
 * Background side of passkeys (see shared/webauthn.ts for the whole flow):
 * signing in with a passkey from the vault (`get`) and saving new ones (`create`).
 *
 * Security properties:
 *   - The origin comes from the requesting frame's sender URL (set by the browser),
 *     never from the page. The clientDataJSON is built here from that origin.
 *   - Nothing is signed or created without a click in the confirmation window, an
 *     extension page the website cannot script or overlay.
 *   - The desktop app re-checks that the origin may act for the RP ID, and never
 *     replaces an existing passkey.
 */
import type { LoginEntry, PasskeyCandidate, PasskeyCreateInput, PasskeyCreateResponse, PasskeySignResponse } from '../shared/protocol';
import type { PasskeyAnswer, PasskeyPrompt } from '../shared/rpc';
import {
  clientDataJSON,
  isSecureOrigin,
  rpIdMatchesHost,
  sha256B64url,
  toB64url,
  type PageCreateRequest,
  type PageCreateResult,
  type PageErrorName,
  type PageGetRequest,
  type PageGetResult,
} from '../shared/webauthn';

export interface PasskeyClient {
  /** throws with code 'locked' when the vault is locked */
  passkeyList(origin: string, rpId: string, allowCredentials: string[]): Promise<PasskeyCandidate[]>;
  passkeySign(origin: string, rpId: string, entryId: string, clientDataHash: string): Promise<Omit<PasskeySignResponse, 'id' | 'ok'>>;
  passkeyCreate(input: PasskeyCreateInput): Promise<Omit<PasskeyCreateResponse, 'id' | 'ok'>>;
  /** logins matching a page URL (throws 'locked' when locked) */
  logins(url: string): Promise<LoginEntry[]>;
  isPaired(): Promise<boolean>;
}

export interface PasskeyWindows {
  /** open the confirmation window for `requestId`; resolves to its window id */
  open(requestId: string): Promise<number | undefined>;
  close(windowId: number): void;
}

export interface PasskeyCaller {
  tabId: number;
  frameId: number;
  /** URL of the calling frame (from the sender) */
  url: string;
  /** URL of the tab's top frame (from the sender) */
  tabUrl: string;
}

type Op = { op: 'get'; request: PageGetRequest } | { op: 'create'; request: PageCreateRequest };
type Result = PageGetResult | PageCreateResult;

type Pending = Op & {
  requestId: string;
  tabId: number;
  pageUrl: string;
  pageRequestId: string;
  origin: string;
  rpId: string;
  windowId?: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (r: Result) => void;
};

/** COSE ES256, the only algorithm Vaultlet creates passkeys with. */
const ES256 = -7;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

const FALLBACK = { kind: 'fallback' } as const;
const error = (name: PageErrorName) => ({ kind: 'error', name }) as const;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function errorCode(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : []);

export class PasskeyFlow {
  private pending = new Map<string, Pending>();

  constructor(
    private client: PasskeyClient,
    private windows: PasskeyWindows,
    private newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** `navigator.credentials.get()` from a page; settles when the user decided (or it timed out). */
  async get(caller: PasskeyCaller, pageRequestId: string, request: PageGetRequest): Promise<PageGetResult> {
    const where = this.locate(caller, request?.rpId);
    if ('kind' in where) return where;
    if (typeof request?.challenge !== 'string') return FALLBACK;
    const allow = strings(request.allowCredentials);
    if (!(await this.client.isPaired().catch(() => false))) return FALLBACK;
    try {
      const entries = await this.client.passkeyList(where.origin, where.rpId, allow);
      if (entries.length === 0) return FALLBACK; // nothing in Vaultlet for this site
    } catch (e) {
      // Locked: we cannot know yet, so ask (the window offers to unlock or use another device).
      if (errorCode(e) !== 'locked') return FALLBACK;
    }
    return this.ask(caller, pageRequestId, where, { op: 'get', request: { ...request, allowCredentials: allow } }) as Promise<PageGetResult>;
  }

  /** `navigator.credentials.create()` from a page. */
  async create(caller: PasskeyCaller, pageRequestId: string, request: PageCreateRequest): Promise<PageCreateResult> {
    const where = this.locate(caller, request?.rp?.id);
    if ('kind' in where) return where;
    if (typeof request?.challenge !== 'string' || typeof request.user?.id !== 'string') return FALLBACK;
    // Sites that insist on a security key, or cannot take ES256, keep the browser's flow.
    if (request.authenticatorAttachment === 'cross-platform') return FALLBACK;
    if (!Array.isArray(request.algorithms) || !request.algorithms.includes(ES256)) return FALLBACK;
    if (!(await this.client.isPaired().catch(() => false))) return FALLBACK;
    const clean: PageCreateRequest = { ...request, excludeCredentials: strings(request.excludeCredentials) };
    return this.ask(caller, pageRequestId, where, { op: 'create', request: clean }) as Promise<PageCreateResult>;
  }

  /** What the confirmation window shows; null when the request is gone. */
  async prompt(requestId: string): Promise<PasskeyPrompt | null> {
    const p = this.pending.get(requestId);
    if (!p) return null;
    const base = { origin: p.origin, rpId: p.rpId };
    try {
      if (p.op === 'get') {
        const entries = await this.client.passkeyList(p.origin, p.rpId, p.request.allowCredentials);
        return { kind: 'get', ...base, locked: false, entries: entries.map(({ entryId, title, username }) => ({ entryId, title, username })) };
      }
      const excluded =
        p.request.excludeCredentials.length > 0 &&
        (await this.client.passkeyList(p.origin, p.rpId, p.request.excludeCredentials)).length > 0;
      const targets = (await this.client.logins(p.pageUrl))
        .filter((e) => !e.passkey)
        .map(({ id, title, username }) => ({ entryId: id, title, username }));
      return { ...this.createInfo(p), locked: false, excluded, targets };
    } catch (e) {
      if (errorCode(e) !== 'locked') throw e;
      return p.op === 'get'
        ? { kind: 'get', ...base, locked: true, entries: [] }
        : { ...this.createInfo(p), locked: true, excluded: false, targets: [] };
    }
  }

  /** The user's choice in the confirmation window. Signing / saving errors are thrown back to the window. */
  async answer(requestId: string, answer: PasskeyAnswer): Promise<void> {
    const p = this.pending.get(requestId);
    if (!p) return;
    if (answer === 'fallback') return this.finish(p, FALLBACK);
    if (answer === 'cancel') {
      // Declining after being told the account already has a passkey here is the spec's InvalidStateError.
      let name: PageErrorName = 'NotAllowedError';
      if (p.op === 'create') {
        const info = await this.prompt(requestId).catch(() => null);
        if (info?.kind === 'create' && info.excluded) name = 'InvalidStateError';
      }
      return this.finish(p, error(name));
    }
    if (p.op === 'get') {
      if (typeof (answer as { entryId?: unknown }).entryId !== 'string') throw new Error('bad answer');
      return this.signIn(p, (answer as { entryId: string }).entryId);
    }
    if (typeof (answer as { saveTo?: unknown }).saveTo !== 'string') throw new Error('bad answer');
    return this.save(p, (answer as { saveTo: string }).saveTo);
  }

  /** The page aborted its call. */
  cancelFromPage(tabId: number, pageRequestId: string): void {
    for (const p of this.pending.values()) {
      if (p.tabId === tabId && p.pageRequestId === pageRequestId) this.finish(p, error('AbortError'));
    }
  }

  /** A window was closed (by the user or by us). */
  windowClosed(windowId: number): void {
    for (const p of this.pending.values()) if (p.windowId === windowId) this.finish(p, error('NotAllowedError'));
  }

  /** The tab went away or navigated. */
  tabGone(tabId: number): void {
    for (const p of this.pending.values()) if (p.tabId === tabId) this.finish(p, error('NotAllowedError'));
  }

  // ---- internals -------------------------------------------------------------

  /** Origin and RP ID for a request, or the answer to give right away. */
  private locate(caller: PasskeyCaller, requestedRpId: unknown): { origin: string; rpId: string } | typeof FALLBACK | ReturnType<typeof error> {
    const origin = originOf(caller.url);
    if (!origin || !isSecureOrigin(caller.url)) return FALLBACK;
    // Cross-origin iframes need the browser's own permission-policy handling.
    if (caller.frameId !== 0 && originOf(caller.tabUrl) !== origin) return FALLBACK;
    const host = new URL(origin).hostname;
    const rpId = (typeof requestedRpId === 'string' && requestedRpId ? requestedRpId : host).toLowerCase();
    if (!rpIdMatchesHost(rpId, host)) return error('SecurityError');
    return { origin, rpId };
  }

  private ask(caller: PasskeyCaller, pageRequestId: string, where: { origin: string; rpId: string }, op: Op): Promise<Result> {
    // One prompt per tab: a new request replaces an older one.
    for (const p of this.pending.values()) if (p.tabId === caller.tabId) this.finish(p, error('NotAllowedError'));
    const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Number(op.request.timeout) || DEFAULT_TIMEOUT_MS));
    const requestId = this.newId();
    return new Promise<Result>((resolve) => {
      const p = {
        ...op,
        requestId,
        tabId: caller.tabId,
        pageUrl: caller.url,
        pageRequestId,
        ...where,
        resolve,
      } as Pending;
      p.timer = setTimeout(() => this.finish(p, error('NotAllowedError')), timeout);
      this.pending.set(requestId, p);
      this.windows
        .open(requestId)
        .then((windowId) => {
          if (windowId === undefined) return this.finish(p, FALLBACK);
          if (this.pending.has(requestId)) p.windowId = windowId;
          else this.windows.close(windowId);
        })
        .catch(() => this.finish(p, FALLBACK));
    });
  }

  private createInfo(p: Pending & { op: 'create' }) {
    return {
      kind: 'create' as const,
      origin: p.origin,
      rpId: p.rpId,
      rpName: String(p.request.rp?.name ?? ''),
      userName: String(p.request.user.name ?? ''),
      userDisplayName: String(p.request.user.displayName ?? ''),
    };
  }

  private async signIn(p: Pending & { op: 'get' }, entryId: string): Promise<void> {
    const json = clientDataJSON(p.request.challenge, p.origin, 'webauthn.get');
    const signed = await this.client.passkeySign(p.origin, p.rpId, entryId, await sha256B64url(json));
    if (!this.pending.has(p.requestId)) return; // timed out / cancelled meanwhile
    this.finish(p, {
      kind: 'assertion',
      assertion: {
        id: signed.credentialId,
        rawId: signed.credentialId,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: toB64url(new TextEncoder().encode(json)),
          authenticatorData: signed.authenticatorData,
          signature: signed.signature,
          userHandle: signed.userHandle,
        },
        clientExtensionResults: {},
      },
    });
  }

  private async save(p: Pending & { op: 'create' }, saveTo: string): Promise<void> {
    const r = p.request;
    let created: Omit<PasskeyCreateResponse, 'id' | 'ok'>;
    try {
      created = await this.client.passkeyCreate({
        origin: p.origin,
        rpId: p.rpId,
        rpName: r.rp?.name || undefined,
        userId: r.user.id,
        userName: r.user.name || r.user.displayName,
        entryId: saveTo === 'new' ? undefined : saveTo,
        excludeCredentials: r.excludeCredentials,
      });
    } catch (e) {
      if (errorCode(e) === 'excluded') return this.finish(p, error('InvalidStateError'));
      throw e;
    }
    if (!this.pending.has(p.requestId)) return;
    const json = clientDataJSON(r.challenge, p.origin, 'webauthn.create');
    this.finish(p, {
      kind: 'attestation',
      attestation: {
        id: created.credentialId,
        rawId: created.credentialId,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: toB64url(new TextEncoder().encode(json)),
          attestationObject: created.attestationObject,
          authenticatorData: created.authenticatorData,
          publicKey: created.publicKey,
          publicKeyAlgorithm: created.publicKeyAlgorithm,
          transports: ['hybrid', 'internal'],
        },
        clientExtensionResults: r.credProps ? { credProps: { rk: true } } : {},
      },
    });
  }

  private finish(p: Pending, result: Result): void {
    if (!this.pending.delete(p.requestId)) return;
    clearTimeout(p.timer);
    if (p.windowId !== undefined) this.windows.close(p.windowId);
    p.resolve(result);
  }
}
