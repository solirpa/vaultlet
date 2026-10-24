/**
 * Passkey (WebAuthn) plumbing shared by the page script, the bridge content
 * script, the background and the confirmation window.
 *
 * Flow for `navigator.credentials.get()`:
 *   page script (MAIN world) → window.postMessage → bridge (content script)
 *   → runtime RPC `passkeyGet` → background: origin from the sender, opens the
 *   confirmation window → desktop app signs (`passkey-sign`) → back the same way.
 * The private key never leaves the desktop app; the extension only sees the
 * authenticator data and the signature.
 */

/** window.postMessage tag between the page script and the bridge. */
export const PAGE_CHANNEL = 'vaultlet-passkey';

/** What the page script hands to the bridge (binary values base64url-encoded). */
export interface PageGetRequest {
  /** challenge from the page, base64url */
  challenge: string;
  /** RP ID the page asked for; undefined = the origin's host */
  rpId?: string;
  /** allowCredentials ids, base64url; empty = any discoverable passkey */
  allowCredentials: string[];
  /** milliseconds, from the page's options */
  timeout?: number;
}

/** Bridge → page answer. */
export type PageGetResult =
  /** let the browser's own WebAuthn handle it (no matching passkey, user chose the device/security key, …) */
  | { kind: 'fallback' }
  /** reject the page's promise with a DOMException of this name */
  | { kind: 'error'; name: 'NotAllowedError' | 'SecurityError' | 'AbortError' }
  | { kind: 'assertion'; assertion: AssertionJSON };

/** A `PublicKeyCredential` (assertion) in its JSON form, as `toJSON()` produces. */
export interface AssertionJSON {
  id: string;
  rawId: string;
  type: 'public-key';
  authenticatorAttachment: 'platform';
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle: string | null;
  };
  clientExtensionResults: Record<string, never>;
}

export interface PageMessage {
  source: typeof PAGE_CHANNEL;
  /** request id, unique per call */
  id: string;
  dir: 'request' | 'response' | 'cancel';
  request?: PageGetRequest;
  result?: PageGetResult;
}

export function isPageMessage(m: unknown): m is PageMessage {
  return typeof m === 'object' && m !== null && (m as PageMessage).source === PAGE_CHANNEL && typeof (m as PageMessage).id === 'string';
}

// ---- base64url ---------------------------------------------------------------

export function toB64url(data: ArrayBuffer | ArrayBufferView): string {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- origin / client data -------------------------------------------------------

/** Origins WebAuthn allows: https, or http on localhost. */
export function isSecureOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname.endsWith('.localhost'));
  } catch {
    return false;
  }
}

/**
 * Cheap pre-check that `rpId` is the page's host or a parent domain of it.
 * The desktop app does the authoritative check (including public suffixes).
 */
export function rpIdMatchesHost(rpId: string, host: string): boolean {
  const r = rpId.toLowerCase().replace(/\.$/, '');
  const h = host.toLowerCase().replace(/\.$/, '');
  return r.length > 0 && (h === r || h.endsWith(`.${r}`));
}

/**
 * The clientDataJSON a browser would produce for `navigator.credentials.get()`.
 * Built by the extension from the frame's real origin, never from page input.
 */
export function clientDataJSON(challenge: string, origin: string): string {
  return JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false });
}

export async function sha256B64url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toB64url(digest);
}
