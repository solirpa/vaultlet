// One function per Tauri command (ARCHITECTURE.md section 5).
// Outside Tauri (plain browser) we fall back to the in-memory mock so the
// whole UI can be exercised with `pnpm dev`.

import type {
  BrowserApplyResult,
  CloudFolder,
  EventMap,
  EventName,
  Folder,
  ImportPreview,
  ImportResult,
  Item,
  ItemSummary,
  PairedBrowser,
  PasswordGenerateOptions,
  Settings,
  SyncStatus,
  TotpCode,
  VaultStatus,
  WebDavTestResult,
} from './types';

export interface Api {
  // state
  vaultStatus(): Promise<VaultStatus>;
  vaultCreate(args: { path: string; password: string; name: string }): Promise<void>;
  vaultUnlock(args: { password: string; keyfile?: string }): Promise<void>;
  vaultLock(): Promise<void>;
  vaultChangePassword(args: { current: string; next: string }): Promise<void>;
  // items
  itemsList(): Promise<ItemSummary[]>;
  itemGet(id: string): Promise<Item>;
  itemSave(item: Item): Promise<Item>;
  itemDelete(id: string): Promise<void>;
  itemRestore(id: string): Promise<void>;
  itemPurge(id: string): Promise<void>;
  itemTouch(id: string): Promise<void>;
  totpNow(id: string): Promise<TotpCode>;
  passwordGenerate(opts: PasswordGenerateOptions): Promise<string>;
  // folders
  foldersList(): Promise<Folder[]>;
  folderSave(folder: Folder): Promise<Folder>;
  folderDelete(id: string): Promise<void>;
  // import
  importBitwardenPreview(args: { path: string; password?: string }): Promise<ImportPreview>;
  importBitwarden(args: { path: string; password?: string }): Promise<ImportResult>;
  // settings & sync
  settingsGet(): Promise<Settings>;
  settingsSet(settings: Settings): Promise<void>;
  cloudFoldersDetect(): Promise<CloudFolder[]>;
  webdavSetPassword(password: string): Promise<void>;
  webdavTest(args: { url: string; username: string; password: string }): Promise<WebDavTestResult>;
  syncNow(): Promise<SyncStatus>;
  syncStatus(): Promise<SyncStatus>;
  // browser integration
  browserIntegrationApply(): Promise<BrowserApplyResult[]>;
  pairedBrowsersList(): Promise<PairedBrowser[]>;
  pairedBrowserRemove(clientId: string): Promise<void>;
  pairingRespond(args: { requestId: string; approve: boolean }): Promise<void>;
  // icons
  iconGet(host: string): Promise<string | null>;
}

export type Unlisten = () => void;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauri: boolean =
  typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;

function createTauriApi(): Api {
  // Lazy import keeps the browser bundle from touching Tauri globals at load.
  const core = import('@tauri-apps/api/core');
  const inv = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const { invoke } = await core;
    return invoke<T>(cmd, args);
  };
  return {
    vaultStatus: () => inv('vault_status'),
    vaultCreate: (a) => inv('vault_create', a),
    vaultUnlock: (a) => inv('vault_unlock', a),
    vaultLock: () => inv('vault_lock'),
    vaultChangePassword: (a) => inv('vault_change_password', a),

    itemsList: () => inv('items_list'),
    itemGet: (id) => inv('item_get', { id }),
    itemSave: (item) => inv('item_save', { item }),
    itemDelete: (id) => inv('item_delete', { id }),
    itemRestore: (id) => inv('item_restore', { id }),
    itemPurge: (id) => inv('item_purge', { id }),
    itemTouch: (id) => inv('item_touch', { id }),
    totpNow: (id) => inv('totp_now', { id }),
    passwordGenerate: (o) => inv('password_generate', { ...o }),

    foldersList: () => inv('folders_list'),
    folderSave: (folder) => inv('folder_save', { folder }),
    folderDelete: (id) => inv('folder_delete', { id }),

    importBitwardenPreview: (a) => inv('import_bitwarden_preview', a),
    importBitwarden: (a) => inv('import_bitwarden', a),

    settingsGet: () => inv('settings_get'),
    settingsSet: (settings) => inv('settings_set', { settings }),
    cloudFoldersDetect: () => inv('cloud_folders_detect'),
    webdavSetPassword: (password) => inv('webdav_set_password', { password }),
    webdavTest: (a) => inv('webdav_test', a),
    syncNow: () => inv('sync_now'),
    syncStatus: () => inv('sync_status'),

    browserIntegrationApply: () => inv('browser_integration_apply'),
    pairedBrowsersList: () => inv('paired_browsers_list'),
    pairedBrowserRemove: (clientId) => inv('paired_browser_remove', { clientId }),
    pairingRespond: (a) => inv('pairing_respond', a),
    iconGet: (host) => inv('icon_get', { host }),
  };
}

import { mockApi, mockEvents } from './api.mock';

export const api: Api = isTauri ? createTauriApi() : mockApi;

/** Subscribe to a backend event. Returns an unlisten function. */
export function onEvent<N extends EventName>(
  name: N,
  cb: (payload: EventMap[N]) => void,
): Unlisten {
  if (!isTauri) return mockEvents.on(name, cb as (p: unknown) => void);
  let disposed = false;
  let unlisten: Unlisten | null = null;
  import('@tauri-apps/api/event').then(({ listen }) =>
    listen<EventMap[N]>(name, (e) => cb(e.payload)).then((u) => {
      if (disposed) u();
      else unlisten = u;
    }),
  );
  return () => {
    disposed = true;
    unlisten?.();
  };
}
