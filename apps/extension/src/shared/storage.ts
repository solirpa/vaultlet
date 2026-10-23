import { ext, invoke } from './browser';

/** Everything the extension persists in storage.local (section 6: clientId, keypair, app public key). */
export interface PersistedState {
  clientId?: string;
  publicKey?: string; // our X25519 public key, base64
  secretKey?: string; // our X25519 secret key, base64
  appPublicKey?: string; // app's X25519 public key, base64 (set after hello)
  paired?: boolean;
  appVersion?: string;
  /** origins the user chose "Never for this site" for (save / update prompts) */
  neverSaveOrigins?: string[];
}

export const STORAGE_KEYS: (keyof PersistedState)[] = [
  'clientId',
  'publicKey',
  'secretKey',
  'appPublicKey',
  'paired',
  'appVersion',
];

export function storageGet<K extends keyof PersistedState>(
  keys: K[] | null = null,
): Promise<Pick<PersistedState, K>> {
  return invoke<Pick<PersistedState, K>>(ext.storage.local, 'get', keys);
}

export function storageSet(items: Partial<PersistedState>): Promise<void> {
  return invoke<void>(ext.storage.local, 'set', items);
}

export function storageRemove(keys: (keyof PersistedState)[]): Promise<void> {
  return invoke<void>(ext.storage.local, 'remove', keys);
}

export async function getNeverSaveOrigins(): Promise<string[]> {
  const s = await storageGet(['neverSaveOrigins']);
  return Array.isArray(s.neverSaveOrigins) ? s.neverSaveOrigins : [];
}

export async function addNeverSaveOrigin(origin: string): Promise<void> {
  const list = await getNeverSaveOrigins();
  if (!list.includes(origin)) await storageSet({ neverSaveOrigins: [...list, origin].sort() });
}

export async function removeNeverSaveOrigin(origin: string): Promise<void> {
  const list = await getNeverSaveOrigins();
  await storageSet({ neverSaveOrigins: list.filter((o) => o !== origin) });
}
