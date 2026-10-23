/**
 * Popup vault list model (pure, unit-tested): which sections/rows to show and
 * the fixed-height layout used for windowed rendering.
 */
import type { LoginSummary } from '../shared/protocol';

export type SectionId = 'suggestions' | 'favorites' | 'all' | 'results';
export type NoteKind = 'not-web' | 'no-match' | 'loading' | 'empty' | 'no-results' | 'error';

export type ListItem =
  | { kind: 'header'; key: string; section: SectionId; count?: number }
  | { kind: 'note'; key: string; note: NoteKind; text?: string }
  | { kind: 'row'; key: string; section: SectionId; entry: LoginSummary };

export const ITEM_HEIGHT: Record<ListItem['kind'], number> = { header: 34, note: 34, row: 44 };

export interface VaultInput {
  /** the active tab is an http(s) page */
  isWebPage: boolean;
  /** get-logins for the tab (no passwords); null = still loading */
  suggestions: LoginSummary[] | null;
  /** every login; null = still loading */
  list: LoginSummary[] | null;
  listError?: string | null;
}

/**
 * Empty search box: "Autofill suggestions" (always, with a one-line note
 * instead of an empty block), "Favorites" (only when there are any) and
 * "All items" (with a count).
 */
export function buildVaultItems({ isWebPage, suggestions, list, listError }: VaultInput): ListItem[] {
  const items: ListItem[] = [{ kind: 'header', key: 'h:suggestions', section: 'suggestions', count: suggestions?.length || undefined }];
  if (!isWebPage) items.push({ kind: 'note', key: 'n:suggestions', note: 'not-web' });
  else if (suggestions === null) items.push({ kind: 'note', key: 'n:suggestions', note: 'loading' });
  else if (suggestions.length === 0) items.push({ kind: 'note', key: 'n:suggestions', note: 'no-match' });
  else for (const e of suggestions) items.push({ kind: 'row', key: `suggestions:${e.id}`, section: 'suggestions', entry: e });

  if (listError) {
    items.push({ kind: 'header', key: 'h:all', section: 'all' });
    items.push({ kind: 'note', key: 'n:all', note: 'error', text: listError });
    return items;
  }
  if (list === null) {
    items.push({ kind: 'header', key: 'h:all', section: 'all' });
    items.push({ kind: 'note', key: 'n:all', note: 'loading' });
    return items;
  }
  const favorites = list.filter((e) => e.favorite);
  if (favorites.length > 0) {
    items.push({ kind: 'header', key: 'h:favorites', section: 'favorites', count: favorites.length });
    for (const e of favorites) items.push({ kind: 'row', key: `favorites:${e.id}`, section: 'favorites', entry: e });
  }
  items.push({ kind: 'header', key: 'h:all', section: 'all', count: list.length });
  if (list.length === 0) items.push({ kind: 'note', key: 'n:all', note: 'empty' });
  else for (const e of list) items.push({ kind: 'row', key: `all:${e.id}`, section: 'all', entry: e });
  return items;
}

/** Search box not empty: a single results list. */
export function buildSearchItems(results: LoginSummary[] | null, error?: string | null): ListItem[] {
  const items: ListItem[] = [{ kind: 'header', key: 'h:results', section: 'results', count: results?.length || undefined }];
  if (error) items.push({ kind: 'note', key: 'n:results', note: 'error', text: error });
  else if (results === null) items.push({ kind: 'note', key: 'n:results', note: 'loading' });
  else if (results.length === 0) items.push({ kind: 'note', key: 'n:results', note: 'no-results' });
  else for (const e of results) items.push({ kind: 'row', key: `results:${e.id}`, section: 'results', entry: e });
  return items;
}

export interface Layout {
  offsets: number[];
  total: number;
}

export function layout(items: ListItem[]): Layout {
  const offsets: number[] = new Array(items.length);
  let y = 0;
  for (let i = 0; i < items.length; i++) {
    offsets[i] = y;
    y += ITEM_HEIGHT[items[i].kind];
  }
  return { offsets, total: y };
}

/** Indices [start, end) intersecting the viewport, plus `overscan` px above and below. */
export function visibleRange(
  { offsets, total }: Layout,
  scrollTop: number,
  viewportHeight: number,
  overscan = 220,
): [number, number] {
  const n = offsets.length;
  if (n === 0) return [0, 0];
  const top = Math.max(0, scrollTop - overscan);
  const bottom = Math.min(total, scrollTop + viewportHeight + overscan);
  // first item whose bottom edge is below `top`
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= top) lo = mid;
    else hi = mid - 1;
  }
  let end = lo;
  while (end < n && offsets[end] < bottom) end++;
  return [lo, Math.max(end, lo + 1)];
}

/** Short host for display ("www." dropped). */
export function displayHost(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}
