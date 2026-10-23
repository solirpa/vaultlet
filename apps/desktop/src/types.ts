// Types mirroring docs/ARCHITECTURE.md sections 1, 3 and 5.
// Rust structs are assumed to serialize with camelCase keys, UUIDs as strings
// and DateTime<Utc> as ISO-8601 strings. Option<T> is `T | null`.

export type ItemKind = 'login' | 'note' | 'card' | 'identity';

export interface Field {
  name: string;
  value: string;
  protected: boolean;
}

export interface Item {
  id: string; // '' when creating a new item (item_save assigns one)
  kind: ItemKind;
  title: string;
  username: string;
  password: string;
  urls: string[]; // urls[0] is the primary URL
  totp: string | null; // otpauth:// URI or bare base32 secret
  notes: string;
  fields: Field[]; // custom fields; card/identity structured fields live here too
  folder: string | null; // Folder id, null = root
  favorite: boolean;
  tags: string[];
  created: string; // ISO
  modified: string; // ISO
  lastUsed: string | null; // ISO
  deleted: boolean; // in recycle bin
}

/** items_list rows: no password / totp / fields / notes. */
export type ItemSummary = Omit<Item, 'password' | 'totp' | 'fields' | 'notes'>;

export interface Folder {
  id: string; // '' when creating
  name: string;
  parent: string | null;
}

export type SyncMode = 'folder' | 'webdav';

export interface WebDavSettings {
  url: string;
  username: string;
  remotePath: string;
}

export type ThemeSetting = 'system' | 'light' | 'dark';
export type Language = 'zh-CN' | 'en';

export interface Settings {
  vault: {
    mode: SyncMode;
    path?: string;
    webdav?: WebDavSettings;
  };
  security: {
    autoLockMinutes: number;
    clearClipboardSeconds: number;
    lockOnSleep: boolean;
  };
  browserIntegration: {
    chrome: boolean;
    edge: boolean;
    brave: boolean;
    firefox: boolean;
    chromium: boolean;
  };
  ui: {
    theme: ThemeSetting;
    language: Language;
    /** Show website icons (fetched from each site itself, cached locally). */
    siteIcons?: boolean;
  };
}

export type BrowserKey = keyof Settings['browserIntegration'];

export type VaultState = 'no-vault' | 'locked' | 'unlocked';

export interface VaultStatus {
  state: VaultState;
  path?: string;
  mode: SyncMode;
  name?: string;
}

export type SyncState = 'idle' | 'syncing' | 'error' | 'conflict';

export interface SyncStatus {
  mode: SyncMode;
  lastSync?: string; // ISO
  state: SyncState;
  message?: string;
  conflictFiles: string[];
}

export interface TotpCode {
  code: string;
  period: number;
  remaining: number;
}

export interface PasswordGenerateOptions {
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
}

export interface ImportPreview {
  items: number;
  folders: number;
  skipped: string[];
  needsPassword: boolean;
}

export interface ImportResult {
  imported: number;
}

export type CloudProvider = 'icloud' | 'dropbox' | 'onedrive';

export interface CloudFolder {
  provider: CloudProvider;
  path: string;
}

export interface WebDavTestResult {
  ok: boolean;
  message: string;
}

export interface BrowserApplyResult {
  browser: string;
  ok: boolean;
  message?: string;
}

export interface PairedBrowser {
  clientId: string;
  name: string;
  pairedAt: string; // ISO
}

export interface PairingRequest {
  requestId: string;
  clientName: string;
}

/** Unified error shape returned by every command. */
export interface ApiError {
  code: string;
  message: string;
}

export function isApiError(e: unknown): e is ApiError {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as ApiError).code === 'string' &&
    typeof (e as ApiError).message === 'string'
  );
}

export function errorMessage(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}

/** Backend -> frontend event payloads (section 5). */
export interface EventMap {
  'vault:locked': void;
  'sync:status': SyncStatus;
  'pairing:request': PairingRequest;
  'items:changed': void;
}

export type EventName = keyof EventMap;
