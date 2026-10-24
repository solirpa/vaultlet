/**
 * Wire types for the Vaultlet browser integration protocol
 * (docs/ARCHITECTURE.md section 6). The extension talks to the native host
 * `com.vaultlet.host`, which forwards frames verbatim to the desktop app.
 */

export const NATIVE_HOST_NAME = 'com.vaultlet.host';
export const PROTOCOL_VERSION = '0.1.0';

/** Plaintext handshake sent by the extension right after connecting. */
export interface HelloRequest {
  type: 'hello';
  clientId: string;
  publicKey: string; // base64 X25519 public key
  clientName: string;
}

/** Plaintext handshake reply from the app. */
export interface HelloResponse {
  type: 'hello';
  publicKey: string; // base64 app X25519 public key
  paired: boolean;
  version: string;
}

/** Plaintext error (e.g. key-mismatch) — the app disconnects after sending it. */
export interface ProtocolError {
  type: 'error';
  code: string;
  message?: string;
}

/** Sent by the native host itself when the desktop app is not running. */
export interface HostError {
  error: 'app-not-running' | string;
}

/** Every message after the handshake, in both directions. */
export interface Envelope {
  clientId: string;
  nonce: string; // base64, 24 bytes
  payload: string; // base64 nacl.box(JSON)
}

export type Action =
  | 'associate'
  | 'status'
  | 'get-logins'
  | 'get-totp'
  | 'touch'
  | 'lock'
  | 'unlock-request'
  | 'search'
  | 'save-login'
  | 'list'
  | 'get-entry'
  | 'get-icon'
  | 'passkey-list'
  | 'passkey-sign'
  | 'passkey-create';

export type Request =
  | { id: string; action: 'associate' }
  | { id: string; action: 'status' }
  | { id: string; action: 'get-logins'; url: string }
  | { id: string; action: 'get-totp'; entryId: string }
  | { id: string; action: 'touch'; entryId: string }
  | { id: string; action: 'lock' }
  | { id: string; action: 'unlock-request' }
  | { id: string; action: 'search'; query: string }
  | { id: string; action: 'list' }
  | { id: string; action: 'get-entry'; entryId: string }
  | { id: string; action: 'get-icon'; host: string }
  | ({ id: string; action: 'save-login' } & SaveLoginInput)
  | { id: string; action: 'passkey-list'; origin: string; rpId: string; allowCredentials?: string[] }
  | { id: string; action: 'passkey-sign'; origin: string; rpId: string; entryId: string; clientDataHash: string }
  | ({ id: string; action: 'passkey-create' } & PasskeyCreateInput);

/**
 * `passkey-create`: the app generates the key pair and stores the private key in the vault,
 * on `entryId` (a login without a passkey) or on a new login. `code: "excluded"` when one of
 * `excludeCredentials` is already in the vault for this RP.
 */
export interface PasskeyCreateInput {
  origin: string;
  rpId: string;
  rpName?: string;
  /** user handle, base64url */
  userId: string;
  userName: string;
  entryId?: string;
  excludeCredentials?: string[];
}

/** A passkey the app holds for a relying party (`passkey-list`). No key material. */
export interface PasskeyCandidate {
  entryId: string;
  title: string;
  username: string;
  /** base64url */
  credentialId: string;
}

/**
 * `save-login`: with `entryId` the app updates that login's username/password
 * (old version kept in history); without it the app creates a new login whose
 * title defaults to the site host and whose urls are `[origin of url]`.
 */
export interface SaveLoginInput {
  url: string;
  username: string;
  password: string;
  title?: string;
  entryId?: string;
}

export interface LoginEntry {
  id: string;
  title: string;
  username: string;
  password: string;
  totp: boolean;
  url: string;
  /** the entry already holds a passkey (app 0.1.2+) */
  passkey?: boolean;
}

/** A login without its password (`list`, `search`). */
export interface LoginSummary {
  id: string;
  title: string;
  username: string;
  url: string;
  totp: boolean;
  favorite?: boolean;
}

/** One login with everything the popup's item view needs (`get-entry`). */
export interface EntryDetail {
  id: string;
  title: string;
  username: string;
  password: string;
  totp: boolean;
  url: string;
  urls: string[];
  notes: string;
  favorite: boolean;
}

export interface OkResponse {
  id: string;
  ok: true;
}
export interface ErrResponse {
  id: string;
  ok: false;
  code: 'rejected' | 'not-paired' | 'locked' | 'not-found' | string;
  message?: string;
}
export interface StatusResponse extends OkResponse {
  locked: boolean;
  vaultName?: string;
}
export interface GetLoginsResponse extends OkResponse {
  entries: LoginEntry[];
}
/** `search`: title/username/any URL contains the query (case-insensitive), ≤ 50, sorted by title. No passwords. */
export interface SearchResponse extends OkResponse {
  entries: LoginSummary[];
}
/** `list`: every non-deleted login, sorted by title. No passwords. */
export interface ListResponse extends OkResponse {
  entries: LoginSummary[];
}
/** `get-icon`: the site's own icon as a data: URL, or null (none / disabled by the user). */
export interface GetIconResponse extends OkResponse {
  dataUrl: string | null;
}
export interface GetEntryResponse extends OkResponse {
  entry: EntryDetail;
}
export interface SaveLoginResponse extends OkResponse {
  entryId: string;
  created?: true;
  updated?: true;
}
export interface SaveLoginResult {
  entryId: string;
  created: boolean;
  updated: boolean;
}
export interface GetTotpResponse extends OkResponse {
  code: string;
  remaining: number;
  /** Seconds per code; sent by app 0.1.0+ (older apps omit it). */
  period?: number;
}

export interface PasskeyListResponse extends OkResponse {
  entries: PasskeyCandidate[];
}
/** `passkey-sign`: the app signs authenticatorData ‖ clientDataHash; all binary values base64url. */
export interface PasskeySignResponse extends OkResponse {
  credentialId: string;
  authenticatorData: string;
  signature: string;
  userHandle: string | null;
}

/** `passkey-create`: binary values base64url; `publicKey` is the SubjectPublicKeyInfo DER. */
export interface PasskeyCreateResponse extends OkResponse {
  entryId: string;
  credentialId: string;
  authenticatorData: string;
  attestationObject: string;
  publicKey: string;
  publicKeyAlgorithm: number;
}

export type Response =
  | OkResponse
  | ErrResponse
  | StatusResponse
  | GetLoginsResponse
  | GetTotpResponse
  | SearchResponse
  | ListResponse
  | GetEntryResponse
  | GetIconResponse
  | SaveLoginResponse
  | PasskeyListResponse
  | PasskeySignResponse
  | PasskeyCreateResponse;

export type PushEventName = 'locked' | 'unlocked' | 'items-changed';
export interface PushEvent {
  action: 'event';
  event: PushEventName;
}

export function isEnvelope(m: unknown): m is Envelope {
  return (
    typeof m === 'object' &&
    m !== null &&
    typeof (m as Envelope).nonce === 'string' &&
    typeof (m as Envelope).payload === 'string'
  );
}

export function isPushEvent(m: unknown): m is PushEvent {
  return typeof m === 'object' && m !== null && (m as PushEvent).action === 'event';
}

export function isHostError(m: unknown): m is HostError {
  return typeof m === 'object' && m !== null && typeof (m as HostError).error === 'string';
}
