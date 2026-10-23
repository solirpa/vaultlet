import { ext, invoke } from '../shared/browser';

const BADGE_COLOR = '#2563eb';

interface CacheEntry {
  url: string;
  count: number;
}

/** Per-tab cache of "how many logins match this tab's URL". */
export class BadgeCache {
  private byTab = new Map<number, CacheEntry>();

  get(tabId: number, url: string): number | undefined {
    const c = this.byTab.get(tabId);
    return c && c.url === url ? c.count : undefined;
  }

  set(tabId: number, url: string, count: number): void {
    this.byTab.set(tabId, { url, count });
  }

  forget(tabId: number): void {
    this.byTab.delete(tabId);
  }

  clear(): void {
    this.byTab.clear();
  }
}

export async function setBadge(tabId: number, count: number | null): Promise<void> {
  const text = count && count > 0 ? String(count > 99 ? '99+' : count) : '';
  try {
    await invoke(ext.action, 'setBadgeBackgroundColor', { color: BADGE_COLOR });
    await invoke(ext.action, 'setBadgeText', { tabId, text });
  } catch {
    /* tab may be gone */
  }
}

export function isFillableUrl(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url);
}
