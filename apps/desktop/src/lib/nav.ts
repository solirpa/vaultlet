import type { ItemKind, ItemSummary } from '../types';

export type NavView =
  | { kind: 'all' }
  | { kind: 'favorites' }
  | { kind: 'recent' }
  | { kind: 'trash' }
  | { kind: 'type'; type: ItemKind }
  | { kind: 'folder'; id: string };

export function navKey(v: NavView): string {
  switch (v.kind) {
    case 'type':
      return `type:${v.type}`;
    case 'folder':
      return `folder:${v.id}`;
    default:
      return v.kind;
  }
}

export function sameView(a: NavView, b: NavView): boolean {
  return navKey(a) === navKey(b);
}

/** Filter + order items for a navigation view (search is applied separately). */
export function itemsForView(items: ItemSummary[], view: NavView, descendants?: (folderId: string) => Set<string>): ItemSummary[] {
  const live = items.filter((i) => !i.deleted);
  const byTitle = (a: ItemSummary, b: ItemSummary) => a.title.localeCompare(b.title);
  switch (view.kind) {
    case 'all':
      return live.sort(byTitle);
    case 'favorites':
      return live.filter((i) => i.favorite).sort(byTitle);
    case 'recent':
      return live
        .filter((i) => i.lastUsed)
        .sort((a, b) => (b.lastUsed ?? '').localeCompare(a.lastUsed ?? ''))
        .slice(0, 50);
    case 'trash':
      return items.filter((i) => i.deleted).sort((a, b) => b.modified.localeCompare(a.modified));
    case 'type':
      return live.filter((i) => i.kind === view.type).sort(byTitle);
    case 'folder': {
      const ids = descendants ? descendants(view.id) : new Set([view.id]);
      return live.filter((i) => i.folder && ids.has(i.folder)).sort(byTitle);
    }
  }
}
