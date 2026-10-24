/**
 * Runs in the page's own JavaScript world (manifest `world: "MAIN"`), at
 * document_start in every frame. Wraps `navigator.credentials.get()` so a
 * passkey stored in Vaultlet can answer it; everything Vaultlet does not
 * handle goes to the browser's own implementation unchanged.
 *
 * This script has no extension privileges. It only forwards the request to
 * the bridge content script; the origin is established by the extension from
 * the browser's sender information, not from anything said here.
 */
import { PAGE_CHANNEL, fromB64url, isPageMessage, toB64url, type AssertionJSON, type PageGetResult, type PageMessage } from '../shared/webauthn';

(() => {
  const credentials = navigator.credentials;
  if (!credentials || typeof credentials.get !== 'function' || typeof PublicKeyCredential === 'undefined') return;
  const nativeGet = credentials.get.bind(credentials);

  const pending = new Map<string, (r: PageGetResult) => void>();
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !isPageMessage(ev.data) || ev.data.dir !== 'response' || !ev.data.result) return;
    const resolve = pending.get(ev.data.id);
    if (!resolve) return;
    pending.delete(ev.data.id);
    resolve(ev.data.result);
  });

  const post = (m: Omit<PageMessage, 'source'>) => window.postMessage({ source: PAGE_CHANNEL, ...m }, window.location.origin);

  function ask(options: PublicKeyCredentialRequestOptions, signal?: AbortSignal): Promise<PageGetResult> {
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
      post({
        id,
        dir: 'request',
        request: {
          challenge: toB64url(options.challenge as ArrayBuffer | ArrayBufferView),
          rpId: options.rpId,
          allowCredentials: (options.allowCredentials ?? [])
            .filter((c) => c.type === 'public-key')
            .map((c) => toB64url(c.id as ArrayBuffer | ArrayBufferView)),
          timeout: options.timeout,
        },
      });
    });
  }

  const buf = (s: string): ArrayBuffer => fromB64url(s).slice().buffer;

  /** A real-looking PublicKeyCredential: `instanceof` checks and toJSON() work. */
  function toCredential(a: AssertionJSON): PublicKeyCredential {
    const value = (v: unknown) => ({ value: v, enumerable: true });
    const response = Object.create(AuthenticatorAssertionResponse.prototype, {
      clientDataJSON: value(buf(a.response.clientDataJSON)),
      authenticatorData: value(buf(a.response.authenticatorData)),
      signature: value(buf(a.response.signature)),
      userHandle: value(a.response.userHandle ? buf(a.response.userHandle) : null),
    });
    return Object.create(PublicKeyCredential.prototype, {
      id: value(a.id),
      rawId: value(buf(a.rawId)),
      type: value('public-key'),
      authenticatorAttachment: value(a.authenticatorAttachment),
      response: value(response),
      getClientExtensionResults: { value: () => ({}) },
      toJSON: { value: () => JSON.parse(JSON.stringify(a)) },
    }) as PublicKeyCredential;
  }

  async function get(options?: CredentialRequestOptions): Promise<Credential | null> {
    const pk = options?.publicKey;
    // Only plain passkey sign-ins. Conditional (autofill) requests, passwords,
    // federated credentials etc. stay with the browser.
    if (!pk || options?.mediation === 'conditional' || window.isSecureContext !== true) return nativeGet(options);
    if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

    let result: PageGetResult;
    try {
      result = await ask(pk, options.signal);
    } catch {
      return nativeGet(options);
    }
    switch (result.kind) {
      case 'assertion':
        return toCredential(result.assertion);
      case 'error':
        throw new DOMException(
          result.name === 'AbortError' ? 'The operation was aborted.' : 'The operation either timed out or was not allowed.',
          result.name,
        );
      default:
        return nativeGet(options);
    }
  }

  Object.defineProperty(credentials, 'get', { value: get, configurable: true, writable: true });
})();
