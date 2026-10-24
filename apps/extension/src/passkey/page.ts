/**
 * Runs in the page's own JavaScript world (manifest `world: "MAIN"`), at
 * document_start in every frame. Wraps `navigator.credentials.get()` and
 * `.create()` so Vaultlet can sign in with, and save, passkeys; everything
 * Vaultlet does not handle goes to the browser's own implementation unchanged.
 *
 * This script has no extension privileges. It only forwards the request to
 * the bridge content script; the origin is established by the extension from
 * the browser's sender information, not from anything said here.
 */
import {
  PAGE_CHANNEL,
  fromB64url,
  isPageMessage,
  toB64url,
  type AssertionJSON,
  type AttestationJSON,
  type PageCreateRequest,
  type PageCreateResult,
  type PageGetRequest,
  type PageGetResult,
  type PageMessage,
} from '../shared/webauthn';

(() => {
  const credentials = navigator.credentials;
  if (!credentials || typeof credentials.get !== 'function' || typeof PublicKeyCredential === 'undefined') return;
  const nativeGet = credentials.get.bind(credentials);
  const nativeCreate = credentials.create.bind(credentials);

  type Result = PageGetResult | PageCreateResult;
  const pending = new Map<string, (r: Result) => void>();
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !isPageMessage(ev.data) || ev.data.dir !== 'response' || !ev.data.result) return;
    const resolve = pending.get(ev.data.id);
    if (!resolve) return;
    pending.delete(ev.data.id);
    resolve(ev.data.result);
  });

  const post = (m: Omit<PageMessage, 'source'>) => window.postMessage({ source: PAGE_CHANNEL, ...m }, window.location.origin);

  function ask(op: 'get' | 'create', request: PageGetRequest | PageCreateRequest, signal?: AbortSignal): Promise<Result> {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      pending.set(id, resolve);
      signal?.addEventListener(
        'abort',
        () => {
          if (!pending.delete(id)) return;
          post({ id, dir: 'cancel' });
          resolve({ kind: 'error', name: 'AbortError' });
        },
        { once: true },
      );
      post({ id, dir: 'request', op, request });
    });
  }

  const b64 = (v: BufferSource) => toB64url(v as ArrayBuffer | ArrayBufferView);
  const buf = (s: string): ArrayBuffer => fromB64url(s).slice().buffer;
  const value = (v: unknown) => ({ value: v, enumerable: true });
  const method = (fn: () => unknown) => ({ value: fn });

  function reject(name: string): never {
    const messages: Record<string, string> = {
      AbortError: 'The operation was aborted.',
      InvalidStateError: 'The user attempted to register an authenticator that contains one of the credentials already registered with the relying party.',
    };
    throw new DOMException(messages[name] ?? 'The operation either timed out or was not allowed.', name);
  }

  /** A real-looking PublicKeyCredential: `instanceof` checks and toJSON() work. */
  function credential(json: AssertionJSON | AttestationJSON, response: object, extensions: object): PublicKeyCredential {
    return Object.create(PublicKeyCredential.prototype, {
      id: value(json.id),
      rawId: value(buf(json.rawId)),
      type: value('public-key'),
      authenticatorAttachment: value(json.authenticatorAttachment),
      response: value(response),
      getClientExtensionResults: method(() => ({ ...extensions })),
      toJSON: method(() => JSON.parse(JSON.stringify(json))),
    }) as PublicKeyCredential;
  }

  function assertionCredential(a: AssertionJSON): PublicKeyCredential {
    const response = Object.create(AuthenticatorAssertionResponse.prototype, {
      clientDataJSON: value(buf(a.response.clientDataJSON)),
      authenticatorData: value(buf(a.response.authenticatorData)),
      signature: value(buf(a.response.signature)),
      userHandle: value(a.response.userHandle ? buf(a.response.userHandle) : null),
    });
    return credential(a, response, a.clientExtensionResults);
  }

  function attestationCredential(a: AttestationJSON): PublicKeyCredential {
    const r = a.response;
    const response = Object.create(AuthenticatorAttestationResponse.prototype, {
      clientDataJSON: value(buf(r.clientDataJSON)),
      attestationObject: value(buf(r.attestationObject)),
      getTransports: method(() => [...r.transports]),
      getAuthenticatorData: method(() => buf(r.authenticatorData)),
      getPublicKey: method(() => buf(r.publicKey)),
      getPublicKeyAlgorithm: method(() => r.publicKeyAlgorithm),
    });
    return credential(a, response, a.clientExtensionResults);
  }

  async function get(options?: CredentialRequestOptions): Promise<Credential | null> {
    const pk = options?.publicKey;
    // Only plain passkey sign-ins. Conditional (autofill) requests, passwords,
    // federated credentials etc. stay with the browser.
    if (!pk || options?.mediation === 'conditional' || window.isSecureContext !== true) return nativeGet(options);
    if (options.signal?.aborted) reject('AbortError');
    let result: Result;
    try {
      result = await ask(
        'get',
        {
          challenge: b64(pk.challenge),
          rpId: pk.rpId,
          allowCredentials: (pk.allowCredentials ?? []).filter((c) => c.type === 'public-key').map((c) => b64(c.id)),
          timeout: pk.timeout,
        },
        options.signal,
      );
    } catch {
      return nativeGet(options);
    }
    if (result.kind === 'assertion') return assertionCredential(result.assertion);
    if (result.kind === 'error') reject(result.name);
    return nativeGet(options);
  }

  async function create(options?: CredentialCreationOptions): Promise<Credential | null> {
    const pk = options?.publicKey;
    if (!pk || (options as { mediation?: string }).mediation === 'conditional' || window.isSecureContext !== true) {
      return nativeCreate(options);
    }
    if (options.signal?.aborted) reject('AbortError');
    let result: Result;
    try {
      result = await ask(
        'create',
        {
          challenge: b64(pk.challenge),
          rp: { id: pk.rp.id, name: String(pk.rp.name ?? '') },
          user: { id: b64(pk.user.id), name: String(pk.user.name ?? ''), displayName: String(pk.user.displayName ?? '') },
          algorithms: (pk.pubKeyCredParams ?? []).filter((p) => p.type === 'public-key').map((p) => p.alg),
          excludeCredentials: (pk.excludeCredentials ?? []).filter((c) => c.type === 'public-key').map((c) => b64(c.id)),
          authenticatorAttachment: pk.authenticatorSelection?.authenticatorAttachment,
          timeout: pk.timeout,
          credProps: !!(pk.extensions as { credProps?: boolean } | undefined)?.credProps,
        },
        options.signal,
      );
    } catch {
      return nativeCreate(options);
    }
    if (result.kind === 'attestation') return attestationCredential(result.attestation);
    if (result.kind === 'error') reject(result.name);
    return nativeCreate(options);
  }

  Object.defineProperty(credentials, 'get', { value: get, configurable: true, writable: true });
  Object.defineProperty(credentials, 'create', { value: create, configurable: true, writable: true });
})();
