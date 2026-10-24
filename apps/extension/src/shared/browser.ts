/**
 * Tiny cross-browser shim. Firefox exposes a Promise-based `browser.*`
 * namespace; Chromium exposes `chrome.*` (callback-based, Promise-based for
 * most APIs in MV3). `invoke()` normalises both to Promises.
 */

declare global {
  // eslint-disable-next-line no-var
  var browser: typeof chrome | undefined;
}

export const ext: typeof chrome = (globalThis.browser ?? globalThis.chrome) as typeof chrome;

// Newer Chrome also exposes a Promise-based `browser.*`, so its presence alone does not mean
// Firefox. `runtime.getBrowserInfo` only exists in Firefox.
export const isFirefox =
  typeof (globalThis.browser?.runtime as { getBrowserInfo?: unknown } | undefined)?.getBrowserInfo === 'function';

export function detectBrowserName(): string {
  if (isFirefox) return 'Firefox';
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Vivaldi/.test(ua)) return 'Vivaldi';
  // Brave hides itself in the UA; navigator.brave exists in the popup/options context
  if (typeof navigator !== 'undefined' && 'brave' in navigator) return 'Brave';
  if (/Chromium/.test(ua)) return 'Chromium';
  if (/Chrome\//.test(ua)) return 'Chrome';
  return 'Browser';
}

export function lastError(): string | undefined {
  return ext.runtime.lastError?.message;
}

type AnyFn = (...args: never[]) => unknown;

/**
 * Call an extension API method and always get a Promise back.
 * Firefox's `browser.*` returns Promises and rejects extra callback args, so
 * call it directly; Chrome's `chrome.*` gets a trailing callback and
 * `runtime.lastError` is turned into a rejection.
 */
export function invoke<T>(api: object, method: string, ...args: unknown[]): Promise<T> {
  const fn = (api as Record<string, AnyFn>)[method];
  if (typeof fn !== 'function') return Promise.reject(new Error(`${method} is not available`));
  if (isFirefox) {
    try {
      return Promise.resolve(fn.apply(api, args as never[]) as T);
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return new Promise<T>((resolve, reject) => {
    try {
      fn.apply(api, [
        ...args,
        (result: T) => {
          const err = lastError();
          if (err) reject(new Error(err));
          else resolve(result);
        },
      ] as never[]);
    } catch (e) {
      reject(e);
    }
  });
}

/** Send a message to the extension (background) and resolve with its reply. */
export function sendRuntimeMessage<T = unknown>(message: unknown): Promise<T> {
  return invoke<T>(ext.runtime, 'sendMessage', message);
}

/** Send a message to a tab's content script (every frame, or one frame via `options.frameId`). */
export function sendTabMessage<T = unknown>(
  tabId: number,
  message: unknown,
  options?: { frameId?: number },
): Promise<T> {
  return options
    ? invoke<T>(ext.tabs, 'sendMessage', tabId, message, options)
    : invoke<T>(ext.tabs, 'sendMessage', tabId, message);
}

export function queryTabs(query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
  return invoke<chrome.tabs.Tab[]>(ext.tabs, 'query', query);
}

export function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  return invoke<chrome.tabs.Tab>(ext.tabs, 'get', tabId);
}

export async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await queryTabs({ active: true, lastFocusedWindow: true });
  return tabs[0];
}

export function openOptionsPage(): void {
  void invoke(ext.runtime, 'openOptionsPage').catch(() => {});
}
