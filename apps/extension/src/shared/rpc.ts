/**
 * Typed RPC between popup/options/content and the background service worker,
 * carried over chrome.runtime.sendMessage.
 *
 * The background checks the sender: extension pages (popup/options) may call
 * every method in `PageRpcMethods`; content scripts may only call the methods
 * in `ContentRpcMethods`, and those derive the page URL / tab from the message
 * sender rather than from arguments, so a compromised frame cannot ask for
 * another site's logins.
 */
import type { EntryDetail, LoginEntry, LoginSummary, PushEventName, SaveLoginInput, SaveLoginResult } from './protocol';
import type { PageCreateRequest, PageCreateResult, PageGetRequest, PageGetResult } from './webauthn';
import { sendRuntimeMessage } from './browser';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface ExtensionState {
  connection: ConnectionState;
  /** last connection error, e.g. 'app-not-running', 'host-missing', 'key-mismatch' */
  error?: string;
  paired: boolean;
  /** undefined until a status/get-logins call has told us */
  locked?: boolean;
  vaultName?: string;
  appVersion?: string;
  clientId?: string;
  publicKey?: string;
}

export type FillOutcome = 'both' | 'username' | 'password' | 'none';

/** A login as shown in the inline menu: no password. */
export type InlineEntry = Omit<LoginEntry, 'password'>;

export type InlineLogins =
  | { status: 'ok'; entries: InlineEntry[] }
  | { status: 'locked' }
  /** not paired, app not running, host missing, … → the inline UI shows nothing */
  | { status: 'unavailable' };

export interface InlineCredentials {
  username: string;
  password: string;
  /** current TOTP code when the entry has one */
  totp?: string;
}

/** What the user did with a save/update prompt. */
export type PromptAction = 'save' | 'never' | 'dismiss';

/** Methods for extension pages (popup, options). */
export interface PageRpcMethods {
  getState: { args: []; result: ExtensionState };
  /** force a (re)connect + hello, returns the resulting state */
  reconnect: { args: []; result: ExtensionState };
  status: { args: []; result: { locked: boolean; vaultName?: string } };
  associate: { args: []; result: { ok: boolean; code?: string } };
  getLogins: { args: [url: string]; result: LoginEntry[] };
  /** logins matching a URL, without passwords (popup "Autofill suggestions") */
  suggestions: { args: [url: string]; result: LoginSummary[] };
  /** every login, without passwords */
  list: { args: []; result: LoginSummary[] };
  search: { args: [query: string]; result: LoginSummary[] };
  /** one login with password / notes / urls — only at the moment of reveal / copy */
  getEntry: { args: [entryId: string]; result: EntryDetail };
  /** site icon (data: URL) via the app, cached in the background; null = use the monogram */
  icon: { args: [host: string]; result: string | null };
  saveLogin: { args: [input: SaveLoginInput]; result: SaveLoginResult };
  getTotp: { args: [entryId: string]; result: { code: string; remaining: number; period?: number } };
  touch: { args: [entryId: string]; result: void };
  lock: { args: []; result: void };
  unlockRequest: { args: []; result: void };
  /**
   * Fill username/password into a tab (background → content). `notice` is
   * shown as a small toast next to the filled field (e.g. "Verification code copied").
   */
  fill: {
    args: [tabId: number, username: string, password: string, entryId?: string, notice?: string];
    result: { filled: FillOutcome };
  };
  /** fill one entry into a tab; the background fetches the password itself (get-entry) */
  fillEntry: { args: [tabId: number, entryId: string, notice?: string]; result: { filled: FillOutcome } };
  /** forget keys + clientId; next connect generates a fresh identity */
  resetPairing: { args: []; result: ExtensionState };
  /** passkey confirmation window: what is being asked (re-lists passkeys while the vault is locked) */
  passkeyPending: { args: [requestId: string]; result: PasskeyPrompt | null };
  /** passkey confirmation window: the user's choice */
  passkeyAnswer: { args: [requestId: string, answer: PasskeyAnswer]; result: void };
}

/** What the passkey confirmation window shows. */
export type PasskeyPrompt =
  | {
      kind: 'get';
      origin: string;
      rpId: string;
      locked: boolean;
      entries: { entryId: string; title: string; username: string }[];
    }
  | {
      kind: 'create';
      origin: string;
      rpId: string;
      locked: boolean;
      /** site name and account from the page's request (display only) */
      rpName: string;
      userName: string;
      userDisplayName: string;
      /** the vault already holds a passkey the site listed in excludeCredentials */
      excluded: boolean;
      /** logins for this site without a passkey, where the new one can be saved */
      targets: { entryId: string; title: string; username: string }[];
    };

/**
 * Sign in with a passkey (`entryId`), save a new one (`saveTo`: an entry id or "new"),
 * hand over to the browser (device / security key), or refuse.
 */
export type PasskeyAnswer = { entryId: string } | { saveTo: string } | 'fallback' | 'cancel';

/** Methods for content scripts; URL/tab come from the sender. */
export interface ContentRpcMethods {
  /** matching logins (without passwords) for the calling frame's URL */
  inlineLogins: { args: []; result: InlineLogins };
  /** credentials (+ current TOTP) of one entry, only if it matches the calling frame's URL */
  inlineFill: { args: [entryId: string]; result: InlineCredentials };
  unlockRequest: { args: []; result: void };
  /** site icon for a host this tab's inline menu / save card is showing */
  icon: { args: [host: string]; result: string | null };
  /** a login form was submitted in this frame */
  captureLogin: { args: [capture: { username: string; password: string }]; result: void };
  /** user answered (or the card timed out on) a save/update prompt */
  promptAction: { args: [promptId: string, action: PromptAction]; result: { ok: boolean; error?: string } };
  /** the page called navigator.credentials.get(); resolves once the user decided */
  passkeyGet: { args: [pageRequestId: string, request: PageGetRequest]; result: PageGetResult };
  /** the page called navigator.credentials.create() */
  passkeyCreate: { args: [pageRequestId: string, request: PageCreateRequest]; result: PageCreateResult };
  /** the page aborted that call */
  passkeyCancel: { args: [pageRequestId: string]; result: void };
}

export type RpcMethods = PageRpcMethods & ContentRpcMethods;
export type RpcName = keyof RpcMethods;
export type ContentRpcName = keyof ContentRpcMethods;

export const CONTENT_RPC_METHODS: readonly ContentRpcName[] = [
  'inlineLogins',
  'inlineFill',
  'unlockRequest',
  'icon',
  'captureLogin',
  'promptAction',
  'passkeyGet',
  'passkeyCreate',
  'passkeyCancel',
];

export interface RpcRequest<K extends RpcName = RpcName> {
  type: 'vaultlet-rpc';
  method: K;
  args: RpcMethods[K]['args'];
}

export type RpcResponse<K extends RpcName = RpcName> =
  | { ok: true; result: RpcMethods[K]['result'] }
  | { ok: false; error: string; code?: string };

/** Background → popup/options broadcast. */
export interface StateBroadcast {
  type: 'vaultlet-state';
  state: ExtensionState;
  event?: PushEventName;
}

export class RpcError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export async function rpc<K extends RpcName>(
  method: K,
  ...args: RpcMethods[K]['args']
): Promise<RpcMethods[K]['result']> {
  const req: RpcRequest<K> = { type: 'vaultlet-rpc', method, args };
  const res = await sendRuntimeMessage<RpcResponse<K> | undefined>(req);
  if (!res) throw new RpcError('no response from background');
  if (!res.ok) throw new RpcError(res.error, res.code);
  return res.result;
}

export function isRpcRequest(m: unknown): m is RpcRequest {
  return typeof m === 'object' && m !== null && (m as RpcRequest).type === 'vaultlet-rpc';
}

export function isStateBroadcast(m: unknown): m is StateBroadcast {
  return typeof m === 'object' && m !== null && (m as StateBroadcast).type === 'vaultlet-state';
}

/** A save/update offer as the content script renders it (never contains the password). */
export interface SavePrompt {
  id: string;
  kind: 'save' | 'update';
  /** host of the captured login, e.g. "github.com" */
  host: string;
  username: string;
}

/** Messages background → content script. */
export type ContentMessage =
  | { type: 'vaultlet-fill'; username: string; password: string; notice?: string; totp?: string }
  | { type: 'vaultlet-ping' }
  /** app push event or pairing change → drop the inline-menu cache */
  | { type: 'vaultlet-event'; event: PushEventName | 'pairing' }
  /** show the save/update card (top frame only) */
  | { type: 'vaultlet-prompt'; prompt: SavePrompt }
  /** keyboard shortcut with several matches: open the inline menu on the focused field */
  | { type: 'vaultlet-open-menu' };

export interface FillResult {
  filled: FillOutcome;
}
