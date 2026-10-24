/**
 * Native messaging client for the Vaultlet desktop app (section 6).
 *
 *   connectNative('com.vaultlet.host')
 *     → plaintext hello / hello
 *     → every later message is { clientId, nonce, payload } (nacl.box)
 */
import { ext, detectBrowserName } from '../shared/browser';
import { generateKeyPair, open, seal, uuid } from '../shared/crypto';
import {
  NATIVE_HOST_NAME,
  isEnvelope,
  isHostError,
  isPushEvent,
  type Envelope,
  type EntryDetail,
  type ErrResponse,
  type GetEntryResponse,
  type GetIconResponse,
  type ListResponse,
  type LoginSummary,
  type GetLoginsResponse,
  type GetTotpResponse,
  type HelloRequest,
  type HelloResponse,
  type LoginEntry,
  type GeneratePasswordResponse,
  type GeneratorOptions,
  type ItemSaveInput,
  type ItemSaveResponse,
  type PasskeyCandidate,
  type PasskeyCreateInput,
  type PasskeyCreateResponse,
  type PasskeyListResponse,
  type PasskeySignResponse,
  type ProtocolError,
  type PushEventName,
  type Request,
  type Response,
  type SaveLoginInput,
  type SaveLoginResponse,
  type SaveLoginResult,
  type SearchResponse,
  type StatusResponse,
} from '../shared/protocol';
import { storageGet, storageRemove, storageSet } from '../shared/storage';
import type { ConnectionState } from '../shared/rpc';

const REQUEST_TIMEOUT_MS = 10_000;
/** `associate` waits for a human to click a dialog in the desktop app. */
const ASSOCIATE_TIMEOUT_MS = 120_000;
const HELLO_TIMEOUT_MS = 10_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type RequestBody = DistributiveOmit<Request, 'id'>;

type Pending = {
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class NativeClientError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'NativeClientError';
    this.code = code;
  }
}

export interface NativeClientEvents {
  /** connection/pairing state changed */
  onStateChange(): void;
  /** app pushed an event */
  onEvent(event: PushEventName): void;
}

export class NativeClient {
  private port: chrome.runtime.Port | null = null;
  private pending = new Map<string, Pending>();
  private helloWaiter: { resolve: (r: HelloResponse) => void; reject: (e: Error) => void } | null =
    null;
  private connectPromise: Promise<void> | null = null;
  private backoffMs = BACKOFF_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private identity: { clientId: string; publicKey: string; secretKey: string } | null = null;

  connection: ConnectionState = 'disconnected';
  lastError?: string;
  paired = false;
  appPublicKey?: string;
  appVersion?: string;
  /** undefined until known */
  locked?: boolean;
  vaultName?: string;

  constructor(private events: NativeClientEvents) {}

  // ---- identity -----------------------------------------------------------

  async loadIdentity(): Promise<{ clientId: string; publicKey: string; secretKey: string }> {
    if (this.identity) return this.identity;
    const s = await storageGet(['clientId', 'publicKey', 'secretKey', 'appPublicKey', 'paired', 'appVersion']);
    let { clientId, publicKey, secretKey } = s;
    if (!clientId || !publicKey || !secretKey) {
      clientId = clientId ?? uuid();
      const kp = generateKeyPair();
      publicKey = kp.publicKey;
      secretKey = kp.secretKey;
      await storageSet({ clientId, publicKey, secretKey, paired: false });
    }
    this.identity = { clientId, publicKey, secretKey };
    this.appPublicKey = s.appPublicKey;
    this.paired = !!s.paired;
    this.appVersion = s.appVersion;
    return this.identity;
  }

  /** Forget identity and keys (options → "re-pair"). */
  async resetIdentity(): Promise<void> {
    this.disconnect('reset');
    this.identity = null;
    this.appPublicKey = undefined;
    this.paired = false;
    this.locked = undefined;
    this.vaultName = undefined;
    await storageRemove(['clientId', 'publicKey', 'secretKey', 'appPublicKey', 'paired', 'appVersion']);
    this.events.onStateChange();
  }

  get clientId(): string | undefined {
    return this.identity?.clientId;
  }
  get publicKey(): string | undefined {
    return this.identity?.publicKey;
  }

  // ---- connection ---------------------------------------------------------

  /** Ensure a connected + handshaked port. Resolves when hello completed. */
  ensureConnected(): Promise<void> {
    if (this.port && this.connection === 'connected') return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const id = await this.loadIdentity();
    this.setConnection('connecting');

    let port: chrome.runtime.Port;
    try {
      port = ext.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (e) {
      this.fail('host-missing', (e as Error).message);
      throw new NativeClientError('host-missing', (e as Error).message);
    }
    this.port = port;
    port.onMessage.addListener(this.handleMessage);
    port.onDisconnect.addListener(() => this.handleDisconnect(port));

    const hello: HelloRequest = {
      type: 'hello',
      clientId: id.clientId,
      publicKey: id.publicKey,
      clientName: detectBrowserName(),
    };

    const reply = await new Promise<HelloResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helloWaiter = null;
        reject(new NativeClientError('hello-timeout'));
      }, HELLO_TIMEOUT_MS);
      this.helloWaiter = {
        resolve: (r) => {
          clearTimeout(timer);
          this.helloWaiter = null;
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          this.helloWaiter = null;
          reject(e);
        },
      };
      try {
        port.postMessage(hello);
      } catch (e) {
        this.helloWaiter?.reject(new NativeClientError('post-failed', (e as Error).message));
      }
    }).catch((e: Error) => {
      // Port may already be gone; make sure state reflects failure.
      const code = e instanceof NativeClientError ? e.code : 'hello-failed';
      if (this.port === port) this.fail(code, e.message);
      throw e;
    });

    this.appPublicKey = reply.publicKey;
    this.paired = !!reply.paired;
    this.appVersion = reply.version;
    await storageSet({ appPublicKey: reply.publicKey, paired: this.paired, appVersion: reply.version });
    this.backoffMs = BACKOFF_MIN_MS;
    this.lastError = undefined;
    this.setConnection('connected');
  }

  disconnect(reason = 'closed'): void {
    const port = this.port;
    this.port = null;
    if (port) {
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.rejectAll(new NativeClientError('disconnected', reason));
    this.setConnection('disconnected');
  }

  private fail(code: string, message?: string): void {
    this.lastError = code;
    const port = this.port;
    this.port = null;
    if (port) {
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.rejectAll(new NativeClientError(code, message));
    this.setConnection('disconnected');
  }

  private rejectAll(err: Error): void {
    this.helloWaiter?.reject(err);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private setConnection(state: ConnectionState): void {
    if (this.connection !== state) {
      this.connection = state;
      this.events.onStateChange();
    }
  }

  private handleDisconnect = (port: chrome.runtime.Port): void => {
    if (this.port !== port) return; // stale port
    const msg = ext.runtime.lastError?.message ?? (port as { error?: { message?: string } }).error?.message;
    const code = this.lastError ?? (msg && /not found|host/i.test(msg) ? 'host-missing' : 'disconnected');
    this.lastError = code;
    this.port = null;
    this.rejectAll(new NativeClientError(code, msg));
    this.setConnection('disconnected');
    this.scheduleReconnect();
  };

  /** Reconnect with exponential backoff; only if there is something to do. */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.lastError === 'key-mismatch' || this.lastError === 'reset') return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected().catch(() => {
        /* state already updated; next attempt scheduled by onDisconnect or on demand */
      });
    }, delay);
  }

  // ---- messages -----------------------------------------------------------

  private handleMessage = (raw: unknown): void => {
    if (isHostError(raw)) {
      // native host says the desktop app is not running
      this.fail(raw.error || 'app-not-running');
      this.scheduleReconnect();
      return;
    }
    const msg = raw as HelloResponse | ProtocolError | Envelope;
    if ((msg as HelloResponse).type === 'hello') {
      this.helloWaiter?.resolve(msg as HelloResponse);
      return;
    }
    if ((msg as ProtocolError).type === 'error') {
      const err = msg as ProtocolError;
      if (err.code === 'key-mismatch') {
        // The app knows our clientId with a different key; the user has to
        // re-pair (options page) or remove the browser in the app.
        this.paired = false;
        void storageSet({ paired: false });
      }
      this.fail(err.code, err.message);
      return;
    }
    if (isEnvelope(msg)) {
      let inner: unknown;
      try {
        inner = this.decrypt(msg);
      } catch (e) {
        console.warn('[vaultlet] could not open envelope', e);
        return;
      }
      if (isPushEvent(inner)) {
        this.applyEvent(inner.event);
        this.events.onEvent(inner.event);
        return;
      }
      const res = inner as Response;
      const p = res && typeof res.id === 'string' ? this.pending.get(res.id) : undefined;
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(res.id);
      p.resolve(res);
      return;
    }
    console.warn('[vaultlet] unexpected native message', raw);
  };

  private applyEvent(event: PushEventName): void {
    if (event === 'locked') this.locked = true;
    else if (event === 'unlocked') this.locked = false;
  }

  private decrypt(env: Envelope): unknown {
    if (!this.identity || !this.appPublicKey) throw new Error('no session');
    return open(env, this.appPublicKey, this.identity.secretKey);
  }

  private async send(req: Request, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    await this.ensureConnected();
    const port = this.port;
    if (!port || !this.identity || !this.appPublicKey) {
      throw new NativeClientError('disconnected');
    }
    const env = seal(this.identity.clientId, req, this.appPublicKey, this.identity.secretKey);
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        reject(new NativeClientError('timeout', `${req.action} timed out`));
      }, timeoutMs);
      this.pending.set(req.id, { resolve, reject, timer });
      try {
        port.postMessage(env);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(req.id);
        reject(new NativeClientError('post-failed', (e as Error).message));
      }
    });
  }

  private async call<T extends Response>(req: RequestBody, timeoutMs?: number): Promise<T> {
    const res = await this.send({ id: uuid(), ...req } as Request, timeoutMs);
    if (!res.ok) {
      const err = res as ErrResponse;
      if (err.code === 'locked') this.locked = true;
      if (err.code === 'not-paired' && this.paired) {
        this.paired = false;
        void storageSet({ paired: false });
        this.events.onStateChange();
      }
      throw new NativeClientError(err.code, err.message);
    }
    return res as T;
  }

  // ---- typed API ----------------------------------------------------------

  async status(): Promise<{ locked: boolean; vaultName?: string }> {
    const r = await this.call<StatusResponse>({ action: 'status' });
    const changed = this.locked !== r.locked || this.vaultName !== r.vaultName;
    this.locked = r.locked;
    this.vaultName = r.vaultName;
    if (changed) this.events.onStateChange();
    return { locked: r.locked, vaultName: r.vaultName };
  }

  /** Ask the app to pair; the user approves inside the desktop app. */
  async associate(): Promise<{ ok: boolean; code?: string }> {
    try {
      await this.call({ action: 'associate' }, ASSOCIATE_TIMEOUT_MS);
      this.paired = true;
      await storageSet({ paired: true });
      this.events.onStateChange();
      return { ok: true };
    } catch (e) {
      if (e instanceof NativeClientError && e.code === 'rejected') {
        return { ok: false, code: 'rejected' };
      }
      throw e;
    }
  }

  async getLogins(url: string): Promise<LoginEntry[]> {
    const r = await this.call<GetLoginsResponse>({ action: 'get-logins', url });
    if (this.locked !== false) {
      this.locked = false;
      this.events.onStateChange();
    }
    return r.entries ?? [];
  }

  /** Free-text search over title, username and URLs (app side: ≤ 50, sorted by title). No passwords. */
  async search(query: string): Promise<LoginSummary[]> {
    const r = await this.call<SearchResponse>({ action: 'search', query });
    return (r.entries ?? []).map(toSummary);
  }

  /** Every login, sorted by title. No passwords. */
  async list(): Promise<LoginSummary[]> {
    const r = await this.call<ListResponse>({ action: 'list' });
    return (r.entries ?? []).map(toSummary);
  }

  /** Site icon fetched and cached by the app (first lookup of a host can take a few seconds). */
  async getIcon(host: string): Promise<string | null> {
    const r = await this.call<GetIconResponse>({ action: 'get-icon', host });
    return typeof r.dataUrl === 'string' ? r.dataUrl : null;
  }

  /** One login including its password; fetched only at the moment of fill / copy / reveal. */
  async getEntry(entryId: string): Promise<EntryDetail> {
    const r = await this.call<GetEntryResponse>({ action: 'get-entry', entryId });
    const e = r.entry;
    return {
      id: e.id,
      title: e.title ?? '',
      username: e.username ?? '',
      password: e.password ?? '',
      totp: !!e.totp,
      url: e.url ?? '',
      urls: Array.isArray(e.urls) ? e.urls : e.url ? [e.url] : [],
      notes: e.notes ?? '',
      favorite: !!e.favorite,
    };
  }

  /** Create a login (no entryId) or update an existing one's username/password. */
  async saveLogin(input: SaveLoginInput): Promise<SaveLoginResult> {
    const body: SaveLoginInput = { url: input.url, username: input.username, password: input.password };
    if (input.title) body.title = input.title;
    if (input.entryId) body.entryId = input.entryId;
    const r = await this.call<SaveLoginResponse>({ action: 'save-login', ...body });
    return { entryId: r.entryId, created: r.created === true, updated: r.updated === true };
  }

  async getTotp(entryId: string): Promise<{ code: string; remaining: number; period?: number }> {
    const r = await this.call<GetTotpResponse>({ action: 'get-totp', entryId });
    return { code: r.code, remaining: r.remaining, period: r.period };
  }

  async touch(entryId: string): Promise<void> {
    await this.call({ action: 'touch', entryId });
  }

  async lock(): Promise<void> {
    await this.call({ action: 'lock' });
    this.locked = true;
    this.events.onStateChange();
  }

  async unlockRequest(): Promise<void> {
    await this.call({ action: 'unlock-request' });
  }

  /** Passkeys for `rpId` that `origin` may use (the app re-checks the pair). */
  async passkeyList(origin: string, rpId: string, allowCredentials: string[]): Promise<PasskeyCandidate[]> {
    const r = await this.call<PasskeyListResponse>({ action: 'passkey-list', origin, rpId, allowCredentials });
    return (r.entries ?? []).map((e) => ({
      entryId: e.entryId,
      title: e.title ?? '',
      username: e.username ?? '',
      credentialId: e.credentialId,
    }));
  }

  /** Create a login or change one (see ItemSaveInput); returns its id. */
  async saveItem(entry: ItemSaveInput): Promise<string> {
    const r = await this.call<ItemSaveResponse>({ action: 'item-save', entry });
    return r.entryId;
  }

  /** Move an item to the trash (restorable in the app). */
  async trashItem(entryId: string): Promise<void> {
    await this.call({ action: 'item-trash', entryId });
  }

  async generatePassword(opts: GeneratorOptions): Promise<string> {
    const r = await this.call<GeneratePasswordResponse>({ action: 'generate-password', ...opts });
    return r.password;
  }

  /** Have the app create a passkey and store it in the vault. */
  async passkeyCreate(input: PasskeyCreateInput): Promise<Omit<PasskeyCreateResponse, 'id' | 'ok'>> {
    const r = await this.call<PasskeyCreateResponse>({ action: 'passkey-create', ...input });
    return {
      entryId: r.entryId,
      credentialId: r.credentialId,
      authenticatorData: r.authenticatorData,
      attestationObject: r.attestationObject,
      publicKey: r.publicKey,
      publicKeyAlgorithm: r.publicKeyAlgorithm,
    };
  }

  /** Have the app sign an assertion; `clientDataHash` is SHA-256(clientDataJSON), base64url. */
  async passkeySign(
    origin: string,
    rpId: string,
    entryId: string,
    clientDataHash: string,
  ): Promise<Omit<PasskeySignResponse, 'id' | 'ok'>> {
    const r = await this.call<PasskeySignResponse>({ action: 'passkey-sign', origin, rpId, entryId, clientDataHash });
    return {
      credentialId: r.credentialId,
      authenticatorData: r.authenticatorData,
      signature: r.signature,
      userHandle: r.userHandle ?? null,
    };
  }
}

/** Keep only summary fields (drops a password if an older app still sends one). */
export function toSummary(e: Partial<LoginSummary> & { id: string }): LoginSummary {
  return {
    id: e.id,
    title: e.title ?? '',
    username: e.username ?? '',
    url: e.url ?? '',
    totp: !!e.totp,
    favorite: !!e.favorite,
  };
}
