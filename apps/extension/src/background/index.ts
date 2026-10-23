/**
 * Background service worker (Chrome) / background script (Firefox).
 *
 *  - owns the NativeClient (native messaging to the desktop app)
 *  - answers typed RPC from popup/options (full API) and content scripts
 *    (restricted API, URL taken from the sender)
 *  - keeps the toolbar badge = number of matching logins for the active tab
 *  - context menu "Vaultlet: fill login" on editable fields
 *  - keyboard shortcut "fill-login"
 *  - save / update prompts for submitted logins (./save-flow)
 */
import { ext, activeTab, getTab, invoke, queryTabs, sendTabMessage } from '../shared/browser';
import type { LoginEntry, PushEventName } from '../shared/protocol';
import {
  CONTENT_RPC_METHODS,
  isRpcRequest,
  type ContentMessage,
  type ContentRpcMethods,
  type ContentRpcName,
  type ExtensionState,
  type FillResult,
  type InlineLogins,
  type PageRpcMethods,
  type RpcRequest,
  type RpcResponse,
  type StateBroadcast,
} from '../shared/rpc';
import { addNeverSaveOrigin, getNeverSaveOrigins } from '../shared/storage';
import { NativeClient, NativeClientError, toSummary } from './native-client';
import { BadgeCache, isFillableUrl, setBadge } from './badge';
import { SaveFlow, type SessionArea } from './save-flow';
import { ICON_STORAGE_KEY, IconCache, type PersistedIcon } from './icon-cache';
import { iconHost, normalizeHost } from '../shared/site-icon';

const CONTEXT_MENU_ID = 'vaultlet-fill-login';
const FILL_COMMAND = 'fill-login';

const badges = new BadgeCache();
let lastPaired: boolean | undefined;

const client = new NativeClient({
  onStateChange() {
    void broadcast();
    void refreshActiveBadge();
    if (lastPaired !== undefined && lastPaired !== client.paired) void notifyContent('pairing');
    lastPaired = client.paired;
  },
  onEvent(event: PushEventName) {
    if (event === 'items-changed' || event === 'locked' || event === 'unlocked') {
      badges.clear();
    }
    void broadcast(event);
    void refreshActiveBadge();
    void notifyContent(event);
    if (event === 'unlocked') void saveFlow.offerAll();
  },
});

// ---- save / update prompts ------------------------------------------------

function sessionArea(): SessionArea | undefined {
  const area = ext.storage?.session;
  if (!area) return undefined;
  return {
    get: (key) => invoke<Record<string, unknown>>(area, 'get', key),
    set: (items) => invoke<void>(area, 'set', items),
    remove: (key) => invoke<void>(area, 'remove', key),
  };
}

// ---- site icons ------------------------------------------------------------

const icons = new IconCache((host) => client.getIcon(host), {
  load: async () =>
    (await invoke<Record<string, unknown>>(ext.storage.local, 'get', ICON_STORAGE_KEY))?.[ICON_STORAGE_KEY] as
      | Record<string, PersistedIcon>
      | undefined,
  save: (data) => invoke<void>(ext.storage.local, 'set', { [ICON_STORAGE_KEY]: data }),
});

/**
 * Hosts a tab's content script may ask icons for: the ones its inline menu or
 * save card shows. Keeps a page from using us to probe arbitrary hosts.
 */
const iconHostsByTab = new Map<number, Set<string>>();
function allowIconHost(tabId: number, host: string | null): void {
  if (!host) return;
  let set = iconHostsByTab.get(tabId);
  if (!set) iconHostsByTab.set(tabId, (set = new Set()));
  if (set.size < 500) set.add(host);
}

const saveFlow = new SaveFlow({
  session: sessionArea(),
  async getLogins(url) {
    if (!client.paired) throw new NativeClientError('not-paired');
    return client.getLogins(url);
  },
  saveLogin: (input) => client.saveLogin(input),
  async sendPrompt(tabId, prompt) {
    const tab = await getTab(tabId);
    if (!isFillableUrl(tab?.url)) return;
    allowIconHost(tabId, normalizeHost(prompt.host));
    await sendTabMessage(tabId, { type: 'vaultlet-prompt', prompt } satisfies ContentMessage, { frameId: 0 });
  },
  async tabStatus(tabId) {
    try {
      const tab = await getTab(tabId);
      return tab?.status === 'loading' ? 'loading' : 'complete';
    } catch {
      return 'gone';
    }
  },
  isNever: async (origin) => (await getNeverSaveOrigins()).includes(origin),
  addNever: (origin) => addNeverSaveOrigin(origin),
  onSaved() {
    badges.clear();
    void refreshActiveBadge();
  },
});

function snapshot(): ExtensionState {
  return {
    connection: client.connection,
    error: client.lastError,
    paired: client.paired,
    locked: client.locked,
    vaultName: client.vaultName,
    appVersion: client.appVersion,
    clientId: client.clientId,
    publicKey: client.publicKey,
  };
}

async function broadcast(event?: PushEventName): Promise<void> {
  const msg: StateBroadcast = { type: 'vaultlet-state', state: snapshot(), event };
  try {
    await invoke(ext.runtime, 'sendMessage', msg);
  } catch {
    // no popup/options open — expected
  }
}

/** Tell content scripts to drop their inline-menu cache. */
async function notifyContent(event: PushEventName | 'pairing'): Promise<void> {
  const msg: ContentMessage = { type: 'vaultlet-event', event };
  try {
    const tabs = await queryTabs({});
    for (const t of tabs) {
      if (t.id !== undefined && isFillableUrl(t.url)) sendTabMessage(t.id, msg).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

// ---- badge ---------------------------------------------------------------

async function updateBadgeForTab(tabId: number, url: string | undefined): Promise<void> {
  if (!isFillableUrl(url)) {
    await setBadge(tabId, null);
    return;
  }
  const cached = badges.get(tabId, url);
  if (cached !== undefined) {
    await setBadge(tabId, cached);
    return;
  }
  if (client.connection !== 'connected' || !client.paired || client.locked === true) {
    await setBadge(tabId, null);
    return;
  }
  try {
    const entries = await client.getLogins(url);
    badges.set(tabId, url, entries.length);
    await setBadge(tabId, entries.length);
  } catch {
    await setBadge(tabId, null);
  }
}

async function refreshActiveBadge(): Promise<void> {
  try {
    const tab = await activeTab();
    if (tab?.id !== undefined) await updateBadgeForTab(tab.id, tab.url);
  } catch {
    /* ignore */
  }
}

ext.tabs.onActivated.addListener(({ tabId }) => {
  getTab(tabId)
    .then((tab) => updateBadgeForTab(tabId, tab?.url))
    .catch(() => {});
});

ext.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'complete') {
    if (info.url) badges.forget(tabId);
    if (tab.active) void updateBadgeForTab(tabId, tab.url);
  }
  if (info.status === 'loading') void saveFlow.onTabLoading(tabId);
  if (info.status === 'complete') void saveFlow.onTabComplete(tabId);
});

ext.tabs.onRemoved.addListener((tabId) => {
  badges.forget(tabId);
  iconHostsByTab.delete(tabId);
  void saveFlow.drop(tabId);
});

// ---- fill ----------------------------------------------------------------

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await sendTabMessage(tabId, { type: 'vaultlet-ping' } satisfies ContentMessage);
    return;
  } catch {
    // not injected yet (tab opened before install / reload) → inject
  }
  await invoke(ext.scripting, 'executeScript', {
    target: { tabId, allFrames: true },
    files: ['content.js'],
  });
}

async function fillIntoTab(
  tabId: number,
  username: string,
  password: string,
  entryId?: string,
  notice?: string,
  totp?: string,
): Promise<FillResult> {
  await ensureContentScript(tabId);
  const msg: ContentMessage = { type: 'vaultlet-fill', username, password };
  if (notice) msg.notice = notice;
  if (totp) msg.totp = totp;
  // Send to the top frame; the content script also runs in iframes (all_frames)
  // but tabs.sendMessage without frameId delivers to every frame and the first
  // response wins. That is acceptable: the first frame that finds a form fills it.
  const res = await sendTabMessage<FillResult | undefined>(tabId, msg);
  if (entryId) {
    client.touch(entryId).catch(() => {
      /* best effort */
    });
  }
  return res ?? { filled: 'none' };
}

async function currentTotp(entry: LoginEntry): Promise<string | undefined> {
  if (!entry.totp) return undefined;
  try {
    return (await client.getTotp(entry.id)).code;
  } catch {
    return undefined;
  }
}

// ---- context menu --------------------------------------------------------

async function installContextMenu(): Promise<void> {
  if (!ext.contextMenus) return;
  try {
    await invoke(ext.contextMenus, 'removeAll');
  } catch {
    /* nothing to remove */
  }
  try {
    // contextMenus.create takes an optional callback in both browsers.
    ext.contextMenus.create(
      {
        id: CONTEXT_MENU_ID,
        title: 'Vaultlet: fill login',
        contexts: ['editable'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      },
      () => void ext.runtime.lastError,
    );
  } catch (e) {
    console.warn('[vaultlet] contextMenus.create failed', e);
  }
}

ext.runtime.onInstalled.addListener(() => void installContextMenu());
ext.runtime.onStartup?.addListener(() => void installContextMenu());

ext.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id || !isFillableUrl(tab.url)) return;
  void (async () => {
    try {
      const entries = await client.getLogins(tab.url!);
      const first = entries[0];
      if (!first) return;
      await fillIntoTab(tab.id!, first.username, first.password, first.id);
    } catch (e) {
      const code = e instanceof NativeClientError ? e.code : 'error';
      // Not paired / locked / not running: open the popup-equivalent hint by
      // bouncing the badge; the user can click the toolbar icon for details.
      console.info('[vaultlet] context-menu fill failed:', code);
      if (code === 'locked') client.unlockRequest().catch(() => {});
    }
  })();
});

// ---- keyboard shortcut -----------------------------------------------------

/** One match → fill it (+ copy TOTP). Several → open the inline menu on the focused field. */
async function fillFromShortcut(tab?: chrome.tabs.Tab): Promise<void> {
  const t = tab?.id !== undefined && tab.url ? tab : await activeTab();
  if (t?.id === undefined || !isFillableUrl(t.url)) return;
  let entries: LoginEntry[];
  try {
    entries = await client.getLogins(t.url);
  } catch (e) {
    if (e instanceof NativeClientError && e.code === 'locked') client.unlockRequest().catch(() => {});
    return;
  }
  if (entries.length === 0) return;
  if (entries.length === 1) {
    const e = entries[0];
    await fillIntoTab(t.id, e.username, e.password, e.id, undefined, await currentTotp(e));
    return;
  }
  await ensureContentScript(t.id);
  await sendTabMessage(t.id, { type: 'vaultlet-open-menu' } satisfies ContentMessage).catch(() => {});
}

ext.commands?.onCommand.addListener((command: string, tab?: chrome.tabs.Tab) => {
  if (command === FILL_COMMAND) void fillFromShortcut(tab).catch(() => {});
});

// ---- RPC -----------------------------------------------------------------

type PageHandlers = {
  [K in keyof PageRpcMethods]: (...args: PageRpcMethods[K]['args']) => Promise<PageRpcMethods[K]['result']>;
};

interface ContentContext {
  tabId: number;
  frameId: number;
  url: string;
}

type ContentHandlers = {
  [K in keyof ContentRpcMethods]: (
    ctx: ContentContext,
    ...args: ContentRpcMethods[K]['args']
  ) => Promise<ContentRpcMethods[K]['result']>;
};

const pageHandlers: PageHandlers = {
  async getState() {
    // Kick a connection attempt so the popup sees fresh state soon.
    client.ensureConnected().catch(() => {});
    await client.loadIdentity();
    return snapshot();
  },
  async reconnect() {
    try {
      await client.ensureConnected();
    } catch {
      /* state carries the error */
    }
    return snapshot();
  },
  status: () => client.status(),
  associate: () => client.associate(),
  getLogins: (url) => client.getLogins(url),
  async suggestions(url) {
    if (!isFillableUrl(url)) return [];
    return (await client.getLogins(url)).map(toSummary);
  },
  list: () => client.list(),
  search: (query) => client.search(query),
  getEntry: (entryId) => client.getEntry(entryId),
  icon: (host) => icons.get(host),
  async fillEntry(tabId, entryId, notice) {
    const e = await client.getEntry(entryId);
    return fillIntoTab(tabId, e.username, e.password, e.id, notice);
  },
  async saveLogin(input) {
    const r = await client.saveLogin(input);
    badges.clear();
    void refreshActiveBadge();
    return r;
  },
  getTotp: (entryId) => client.getTotp(entryId),
  touch: (entryId) => client.touch(entryId),
  lock: () => client.lock(),
  unlockRequest: () => client.unlockRequest(),
  fill: (tabId, username, password, entryId, notice) => fillIntoTab(tabId, username, password, entryId, notice),
  async resetPairing() {
    await client.resetIdentity();
    badges.clear();
    return snapshot();
  },
};

const contentHandlers: ContentHandlers = {
  async inlineLogins(ctx): Promise<InlineLogins> {
    if (!isFillableUrl(ctx.url)) return { status: 'unavailable' };
    await client.loadIdentity();
    if (!client.paired) return { status: 'unavailable' };
    try {
      const entries = await client.getLogins(ctx.url);
      for (const e of entries) allowIconHost(ctx.tabId, iconHost(e.url));
      return {
        status: 'ok',
        entries: entries.map(({ id, title, username, totp, url }) => ({ id, title, username, totp, url })),
      };
    } catch (e) {
      if (e instanceof NativeClientError && e.code === 'locked') return { status: 'locked' };
      return { status: 'unavailable' };
    }
  },
  async inlineFill(ctx, entryId) {
    if (!isFillableUrl(ctx.url)) throw new NativeClientError('not-found');
    // Only entries that match the calling frame's URL can be handed out.
    const entries = await client.getLogins(ctx.url);
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) throw new NativeClientError('not-found');
    client.touch(entry.id).catch(() => {});
    return { username: entry.username, password: entry.password, totp: await currentTotp(entry) };
  },
  unlockRequest: () => client.unlockRequest(),
  async icon(ctx, host) {
    const h = normalizeHost(host);
    if (!h || !iconHostsByTab.get(ctx.tabId)?.has(h)) return null;
    return icons.get(h);
  },
  async captureLogin(ctx, capture) {
    if (!capture || typeof capture.password !== 'string') return;
    await saveFlow.capture(ctx.tabId, ctx.url, String(capture.username ?? ''), capture.password);
  },
  promptAction: (ctx, promptId, action) => saveFlow.action(ctx.tabId, promptId, action),
};

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== ext.runtime.id) return false;
  const base = ext.runtime.getURL('');
  return typeof sender.url === 'string' && sender.url.startsWith(base);
}

function dispatch(req: RpcRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const args = (Array.isArray(req.args) ? req.args : []) as unknown[];
  if (isExtensionPage(sender)) {
    const handler = pageHandlers[req.method as keyof PageRpcMethods] as ((...a: unknown[]) => Promise<unknown>) | undefined;
    if (!handler) return Promise.reject(new Error(`unknown method ${String(req.method)}`));
    return handler(...args);
  }
  // content script
  const method = req.method as ContentRpcName;
  if (sender.id !== ext.runtime.id || sender.tab?.id === undefined || !CONTENT_RPC_METHODS.includes(method)) {
    return Promise.reject(new NativeClientError('forbidden', `method ${String(req.method)} not allowed here`));
  }
  const ctx: ContentContext = { tabId: sender.tab.id, frameId: sender.frameId ?? 0, url: sender.url ?? '' };
  const handler = contentHandlers[method] as (ctx: ContentContext, ...a: unknown[]) => Promise<unknown>;
  return handler(ctx, ...args);
}

ext.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isRpcRequest(message)) return false;
  dispatch(message as RpcRequest, sender)
    .then((result) => sendResponse({ ok: true, result } as RpcResponse))
    .catch((e: unknown) => {
      const err = e as Error & { code?: string };
      sendResponse({ ok: false, error: err?.message ?? String(e), code: err?.code } satisfies RpcResponse);
    });
  return true; // async response
});

// Connect eagerly so the badge works without opening the popup first.
void client.ensureConnected().catch(() => {});
