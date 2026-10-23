// In-memory mock backend used when the app runs outside Tauri (plain browser).
// Mirrors the semantics of ARCHITECTURE.md section 5 closely enough to drive
// the whole UI. Unlock accepts any non-empty password except "wrong".

import type { Api } from './api';
import type {
  ApiError,
  EventMap,
  EventName,
  Folder,
  Item,
  ItemSummary,
  PairedBrowser,
  Settings,
  SyncStatus,
  VaultState,
} from './types';
import { sampleFolders, sampleItems } from './mock/data';
import { totp } from './mock/totp';

type Listener = (payload: unknown) => void;

class Emitter {
  private map = new Map<string, Set<Listener>>();
  on(name: string, cb: Listener): () => void {
    if (!this.map.has(name)) this.map.set(name, new Set());
    this.map.get(name)!.add(cb);
    return () => this.map.get(name)?.delete(cb);
  }
  emit<N extends EventName>(name: N, payload: EventMap[N]): void {
    this.map.get(name)?.forEach((cb) => cb(payload));
  }
}

export const mockEvents = new Emitter();

const err = (code: string, message: string): ApiError => ({ code, message });
const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => structuredClone(v);
const nowIso = () => new Date().toISOString();
const uuid = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

const DEFAULT_PATH = '/Users/alex/Library/Mobile Documents/com~apple~CloudDocs/Vaultlet.kdbx';

const state = {
  vault: 'locked' as VaultState,
  path: DEFAULT_PATH as string | undefined,
  name: 'Vaultlet' as string | undefined,
  items: clone(sampleItems),
  folders: clone(sampleFolders),
  settings: {
    vault: { mode: 'folder', path: DEFAULT_PATH },
    security: { autoLockMinutes: 15, clearClipboardSeconds: 30, lockOnSleep: true },
    browserIntegration: { chrome: true, edge: false, brave: false, firefox: false, chromium: false },
    ui: { siteIcons: true, theme: 'system', language: navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en' },
  } as Settings,
  webdavPassword: '' as string,
  sync: {
    mode: 'folder',
    state: 'idle',
    lastSync: new Date(Date.now() - 7 * 60_000).toISOString(),
    conflictFiles: ['Vaultlet (conflicted copy 2024-10-21).kdbx'],
  } as SyncStatus,
  paired: [
    { clientId: 'c1d2e3f4-aaaa-4bbb-8ccc-000000000001', name: 'Chrome', pairedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() },
  ] as PairedBrowser[],
};

function requireUnlocked(): void {
  if (state.vault !== 'unlocked') throw err('locked', 'Vault is locked');
}

function summary(i: Item): ItemSummary {
  const { password: _p, totp: _t, fields: _f, notes: _n, ...rest } = i;
  return rest;
}

function findItem(id: string): Item {
  const it = state.items.find((i) => i.id === id);
  if (!it) throw err('not-found', `Item ${id} not found`);
  return it;
}

export const mockApi: Api = {
  async vaultStatus() {
    await delay(60);
    return {
      state: state.vault,
      path: state.vault === 'no-vault' ? undefined : state.path,
      mode: state.settings.vault.mode,
      name: state.vault === 'no-vault' ? undefined : state.name,
    };
  },
  async vaultCreate({ path, password, name }) {
    await delay(400);
    if (!password) throw err('invalid', 'Password must not be empty');
    state.path = path;
    state.name = name || 'Vaultlet';
    state.settings.vault = { ...state.settings.vault, mode: 'folder', path };
    state.items = [];
    state.folders = [];
    state.vault = 'unlocked';
  },
  async vaultUnlock({ password }) {
    await delay(500);
    if (state.vault === 'no-vault') throw err('no-vault', 'No vault configured');
    if (!password || password === 'wrong') throw err('bad-credentials', 'Incorrect master password');
    state.vault = 'unlocked';
  },
  async vaultLock() {
    await delay(80);
    state.vault = 'locked';
  },
  async vaultChangePassword({ current, next }) {
    await delay(400);
    requireUnlocked();
    if (!current || current === 'wrong') throw err('bad-credentials', 'Current password is incorrect');
    if (next.length < 8) throw err('weak', 'New password too short');
  },

  async itemsList() {
    await delay(80);
    requireUnlocked();
    return state.items.map(summary);
  },
  async itemGet(id) {
    await delay(40);
    requireUnlocked();
    return clone(findItem(id));
  },
  async itemSave(item) {
    await delay(150);
    requireUnlocked();
    const ts = nowIso();
    if (!item.id) {
      const created: Item = { ...clone(item), id: uuid(), created: ts, modified: ts };
      state.items.unshift(created);
      return clone(created);
    }
    const idx = state.items.findIndex((i) => i.id === item.id);
    if (idx < 0) throw err('not-found', 'Item not found');
    const updated: Item = { ...clone(item), modified: ts, created: state.items[idx].created };
    state.items[idx] = updated;
    return clone(updated);
  },
  async itemDelete(id) {
    await delay(100);
    requireUnlocked();
    const it = findItem(id);
    it.deleted = true;
    it.modified = nowIso();
  },
  async itemRestore(id) {
    await delay(100);
    requireUnlocked();
    const it = findItem(id);
    it.deleted = false;
    it.modified = nowIso();
  },
  async itemPurge(id) {
    await delay(100);
    requireUnlocked();
    findItem(id);
    state.items = state.items.filter((i) => i.id !== id);
  },
  async itemTouch(id) {
    requireUnlocked();
    findItem(id).lastUsed = nowIso();
  },
  async totpNow(id) {
    requireUnlocked();
    const it = findItem(id);
    if (!it.totp) throw err('no-totp', 'Item has no TOTP secret');
    return totp(it.totp);
  },
  async passwordGenerate({ length, upper, lower, digits, symbols }) {
    let pool = '';
    if (upper) pool += 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    if (lower) pool += 'abcdefghijkmnopqrstuvwxyz';
    if (digits) pool += '23456789';
    if (symbols) pool += '!@#$%^&*()-_=+[]{};:,.<>?';
    if (!pool) throw err('invalid', 'Select at least one character class');
    const buf = new Uint32Array(Math.max(1, length));
    crypto.getRandomValues(buf);
    return Array.from(buf, (n) => pool[n % pool.length]).join('');
  },

  async foldersList() {
    await delay(40);
    requireUnlocked();
    return clone(state.folders);
  },
  async folderSave(folder) {
    await delay(100);
    requireUnlocked();
    if (!folder.id) {
      const f: Folder = { ...folder, id: uuid() };
      state.folders.push(f);
      return clone(f);
    }
    const idx = state.folders.findIndex((f) => f.id === folder.id);
    if (idx < 0) throw err('not-found', 'Folder not found');
    state.folders[idx] = clone(folder);
    return clone(folder);
  },
  async folderDelete(id) {
    await delay(100);
    requireUnlocked();
    // Items inside (and inside sub-folders) go to the recycle bin.
    const doomed = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of state.folders) {
        if (f.parent && doomed.has(f.parent) && !doomed.has(f.id)) {
          doomed.add(f.id);
          grew = true;
        }
      }
    }
    for (const it of state.items) {
      if (it.folder && doomed.has(it.folder)) {
        it.folder = null;
        it.deleted = true;
      }
    }
    state.folders = state.folders.filter((f) => !doomed.has(f.id));
  },

  async importBitwardenPreview({ path, password }) {
    await delay(300);
    const encrypted = /encrypted|enc/i.test(path);
    if (encrypted && !password) return { items: 0, folders: 0, skipped: [], needsPassword: true };
    if (encrypted && password === 'wrong') throw err('bad-credentials', 'Wrong file password');
    return { items: 42, folders: 5, skipped: ['Send items are not supported (2)'], needsPassword: false };
  },
  async importBitwarden({ path, password }) {
    await delay(600);
    requireUnlocked();
    const encrypted = /encrypted|enc/i.test(path);
    if (encrypted && !password) throw err('needs-password', 'File is password protected');
    const ts = nowIso();
    const imported: Item[] = Array.from({ length: 3 }, (_, i) => ({
      id: uuid(),
      kind: 'login',
      title: `Imported login ${i + 1}`,
      username: `user${i + 1}@imported.example`,
      password: `imported-${i + 1}`,
      urls: [`https://imported${i + 1}.example.com`],
      totp: null,
      notes: '',
      fields: [],
      folder: null,
      favorite: false,
      tags: [],
      created: ts,
      modified: ts,
      lastUsed: null,
      deleted: false,
    }));
    state.items.push(...imported);
    mockEvents.emit('items:changed', undefined);
    return { imported: 42 };
  },

  async settingsGet() {
    await delay(30);
    return clone(state.settings);
  },
  async settingsSet(settings) {
    await delay(60);
    state.settings = clone(settings);
    state.sync.mode = settings.vault.mode;
    if (settings.vault.mode === 'folder' && settings.vault.path) {
      state.path = settings.vault.path;
      if (state.vault === 'no-vault') state.vault = 'locked';
    }
  },
  async cloudFoldersDetect() {
    await delay(150);
    return [
      { provider: 'icloud', path: '/Users/alex/Library/Mobile Documents/com~apple~CloudDocs' },
      { provider: 'dropbox', path: '/Users/alex/Dropbox' },
    ];
  },
  async webdavSetPassword(password) {
    await delay(60);
    state.webdavPassword = password;
  },
  async webdavTest({ url, username, password }) {
    await delay(700);
    if (!url.startsWith('http')) return { ok: false, message: 'URL must start with http(s)://' };
    if (!username || !password) return { ok: false, message: '401 Unauthorized' };
    return { ok: true, message: `Connected to ${new URL(url).host} (WebDAV class 1)` };
  },
  async syncNow() {
    state.sync = { ...state.sync, state: 'syncing', message: undefined };
    mockEvents.emit('sync:status', clone(state.sync));
    await delay(1200);
    state.sync = {
      ...state.sync,
      state: state.sync.conflictFiles.length ? 'conflict' : 'idle',
      lastSync: nowIso(),
      message: state.sync.conflictFiles.length ? 'Conflict copies found next to the vault' : undefined,
    };
    mockEvents.emit('sync:status', clone(state.sync));
    return clone(state.sync);
  },
  async syncStatus() {
    await delay(30);
    return clone(state.sync);
  },

  async browserIntegrationApply() {
    await delay(500);
    const b = state.settings.browserIntegration;
    const label: Record<keyof typeof b, string> = {
      chrome: 'Chrome',
      edge: 'Edge',
      brave: 'Brave',
      chromium: 'Chromium',
      firefox: 'Firefox',
    };
    return (Object.keys(b) as (keyof typeof b)[]).map((k) => ({
      browser: label[k],
      ok: k !== 'firefox' || !b.firefox,
      message: b[k]
        ? k === 'firefox'
          ? 'Firefox not installed'
          : 'Manifest written'
        : 'Manifest removed',
    }));
  },
  async pairedBrowsersList() {
    await delay(40);
    return clone(state.paired);
  },
  async pairedBrowserRemove(clientId) {
    await delay(80);
    state.paired = state.paired.filter((p) => p.clientId !== clientId);
  },
  async pairingRespond({ requestId, approve }) {
    await delay(80);
    if (approve) {
      state.paired.push({ clientId: uuid(), name: pendingPairing.get(requestId) ?? 'Browser', pairedAt: nowIso() });
    }
    pendingPairing.delete(requestId);
  },

  // Browser preview only: a few hosts get a simple SVG "site icon", the rest fall back to monograms.
  async iconGet(host) {
    await delay(120 + Math.random() * 300);
    const known: Record<string, [string, string]> = {
      'github.com': ['#181717', 'G'],
      'gist.github.com': ['#181717', 'G'],
      'accounts.google.com': ['#4285F4', 'G'],
      'console.aws.amazon.com': ['#FF9900', 'a'],
      'dash.cloudflare.com': ['#F38020', 'C'],
      'www.dropbox.com': ['#0061FF', 'D'],
      'www.netflix.com': ['#E50914', 'N'],
    };
    const k = known[host];
    if (!k) return null;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${k[0]}"/><text x="16" y="22" font-family="Helvetica,Arial" font-size="17" font-weight="700" fill="#fff" text-anchor="middle">${k[1]}</text></svg>`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
  },
};

const pendingPairing = new Map<string, string>();

/** Dev-only hooks exposed in the settings "Developer" section and on Cmd/Ctrl+Shift+P. */
export const mockDev = {
  triggerPairing(clientName = 'Chrome') {
    const requestId = uuid();
    pendingPairing.set(requestId, clientName);
    mockEvents.emit('pairing:request', { requestId, clientName });
  },
  triggerItemsChanged() {
    const ts = nowIso();
    state.items.unshift({
      id: uuid(),
      kind: 'login',
      title: `Synced from another device ${state.items.length}`,
      username: 'remote@example.com',
      password: 'remote-pass',
      urls: ['https://remote.example.com'],
      totp: null,
      notes: 'Arrived via external merge.',
      fields: [],
      folder: null,
      favorite: false,
      tags: [],
      created: ts,
      modified: ts,
      lastUsed: null,
      deleted: false,
    });
    mockEvents.emit('items:changed', undefined);
  },
  triggerAutoLock() {
    state.vault = 'locked';
    mockEvents.emit('vault:locked', undefined);
  },
  triggerSyncError() {
    state.sync = { ...state.sync, state: 'error', message: 'ENOENT: vault file moved or deleted' };
    mockEvents.emit('sync:status', clone(state.sync));
  },
  resetToNoVault() {
    state.vault = 'no-vault';
    state.path = undefined;
    state.settings.vault = { mode: 'folder' };
  },
};
