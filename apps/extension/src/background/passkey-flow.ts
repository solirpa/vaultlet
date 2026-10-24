/**
 * Background side of passkey sign-in (see shared/webauthn.ts for the whole flow).
 *
 * Security properties:
 *   - The origin comes from the requesting frame's sender URL (set by the browser),
 *     never from the page. The clientDataJSON is built here from that origin.
 *   - Nothing is signed without a click in the confirmation window, an extension
 *     page the website cannot script or overlay.
 *   - The desktop app re-checks that the origin may act for the RP ID before it
 *     lists or signs anything.
 */
import type { PasskeyCandidate, PasskeySignResponse } from '../shared/protocol';
import type { PasskeyAnswer, PasskeyPrompt } from '../shared/rpc';
import {
  clientDataJSON,
  isSecureOrigin,
  rpIdMatchesHost,
  sha256B64url,
  toB64url,
  type PageGetRequest,
  type PageGetResult,
} from '../shared/webauthn';

export interface PasskeyClient {
  /** throws with code 'locked' when the vault is locked */
  passkeyList(origin: string, rpId: string, allowCredentials: string[]): Promise<PasskeyCandidate[]>;
  passkeySign(origin: string, rpId: string, entryId: string, clientDataHash: string): Promise<Omit<PasskeySignResponse, 'id' | 'ok'>>;
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

interface Pending {
  requestId: string;
  tabId: number;
  pageRequestId: string;
  origin: string;
  rpId: string;
  request: PageGetRequest;
  windowId?: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (r: PageGetResult) => void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

const FALLBACK: PageGetResult = { kind: 'fallback' };
const NOT_ALLOWED: PageGetResult = { kind: 'error', name: 'NotAllowedError' };

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

export class PasskeyFlow {
  private pending = new Map<string, Pending>();

  constructor(
    private client: PasskeyClient,
    private windows: PasskeyWindows,
    private newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** `navigator.credentials.get()` from a page; settles when the user decided (or it timed out). */
  async get(caller: PasskeyCaller, pageRequestId: string, request: PageGetRequest): Promise<PageGetResult> {
    const origin = originOf(caller.url);
    if (!origin || !isSecureOrigin(caller.url) || typeof request?.challenge !== 'string') return FALLBACK;
    // Cross-origin iframes need the browser's own permission-policy handling.
    if (caller.frameId !== 0 && originOf(caller.tabUrl) !== origin) return FALLBACK;
    const host = new URL(origin).hostname;
    const rpId = (request.rpId || host).toLowerCase();
    if (!rpIdMatchesHost(rpId, host)) return { kind: 'error', name: 'SecurityError' };
    const allow = Array.isArray(request.allowCredentials) ? request.allowCredentials.filter((c) => typeof c === 'string') : [];

    if (!(await this.client.isPaired().catch(() => false))) return FALLBACK;
    try {
      const entries = await this.client.passkeyList(origin, rpId, allow);
      if (entries.length === 0) return FALLBACK; // nothing in Vaultlet for this site
    } catch (e) {
      // Locked: we cannot know yet, so ask (the window offers to unlock or use another device).
      if (errorCode(e) !== 'locked') return FALLBACK;
    }

    // One prompt per tab: a new request replaces an older one.
    for (const p of this.pending.values()) if (p.tabId === caller.tabId) this.finish(p, NOT_ALLOWED);

    const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Number(request.timeout) || DEFAULT_TIMEOUT_MS));
    const requestId = this.newId();
    return new Promise<PageGetResult>((resolve) => {
      const p: Pending = {
        requestId,
        tabId: caller.tabId,
        pageRequestId,
        origin,
        rpId,
        request: { ...request, allowCredentials: allow },
        timer: setTimeout(() => this.finish(p, NOT_ALLOWED), timeout),
        resolve,
      };
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

  /** What the confirmation window shows; null when the request is gone. */
  async prompt(requestId: string): Promise<PasskeyPrompt | null> {
    const p = this.pending.get(requestId);
    if (!p) return null;
    try {
      const entries = await this.client.passkeyList(p.origin, p.rpId, p.request.allowCredentials);
      return {
        origin: p.origin,
        rpId: p.rpId,
        locked: false,
        entries: entries.map(({ entryId, title, username }) => ({ entryId, title, username })),
      };
    } catch (e) {
      if (errorCode(e) === 'locked') return { origin: p.origin, rpId: p.rpId, locked: true, entries: [] };
      throw e;
    }
  }

  /** The user's choice in the confirmation window. Signing errors are thrown back to the window. */
  async answer(requestId: string, answer: PasskeyAnswer): Promise<void> {
    const p = this.pending.get(requestId);
    if (!p) return;
    if (answer === 'cancel') return this.finish(p, NOT_ALLOWED);
    if (answer === 'fallback') return this.finish(p, FALLBACK);
    if (typeof answer?.entryId !== 'string') throw new Error('bad answer');

    const json = clientDataJSON(p.request.challenge, p.origin);
    const signed = await this.client.passkeySign(p.origin, p.rpId, answer.entryId, await sha256B64url(json));
    if (!this.pending.has(requestId)) return; // timed out / cancelled meanwhile
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

  /** The page aborted its call. */
  cancelFromPage(tabId: number, pageRequestId: string): void {
    for (const p of this.pending.values()) {
      if (p.tabId === tabId && p.pageRequestId === pageRequestId) this.finish(p, { kind: 'error', name: 'AbortError' });
    }
  }

  /** A window was closed (by the user or by us). */
  windowClosed(windowId: number): void {
    for (const p of this.pending.values()) if (p.windowId === windowId) this.finish(p, NOT_ALLOWED);
  }

  /** The tab went away or navigated. */
  tabGone(tabId: number): void {
    for (const p of this.pending.values()) if (p.tabId === tabId) this.finish(p, NOT_ALLOWED);
  }

  private finish(p: Pending, result: PageGetResult): void {
    if (!this.pending.delete(p.requestId)) return;
    clearTimeout(p.timer);
    if (p.windowId !== undefined) this.windows.close(p.windowId);
    p.resolve(result);
  }
}
