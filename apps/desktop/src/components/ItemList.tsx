import { CreditCard, KeyRound, Plus, Search, Star, StickyNote, UserRound, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { cx, hostOf } from '../lib/utils';
import { SiteIcon } from './SiteIcon';
import type { ItemKind, ItemSummary } from '../types';
import { Menu, MenuItem } from './Sidebar';
import { Button, IconButton, Input } from './ui';

interface ItemListProps {
  items: ItemSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
  onNew: (kind: ItemKind) => void;
  isTrash: boolean;
}

const kindIcon: Record<ItemKind, ReactNode> = {
  login: <KeyRound size={13} />,
  note: <StickyNote size={13} />,
  card: <CreditCard size={13} />,
  identity: <UserRound size={13} />,
};

export function ItemList({ items, selectedId, onSelect, query, onQueryChange, onNew, isTrash }: ItemListProps) {
  const t = useT();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [newMenu, setNewMenu] = useState(false);

  const move = (delta: number) => {
    if (!items.length) return;
    const idx = items.findIndex((i) => i.id === selectedId);
    const next = idx < 0 ? (delta > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, idx + delta));
    onSelect(items[next].id);
    listRef.current?.querySelector<HTMLElement>(`[data-id="${items[next].id}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  const moveRef = useRef(move);
  moveRef.current = move;

  // Cmd/Ctrl+F focuses search. ArrowUp/Down moves selection whenever focus is
  // not inside a text field or dialog (the list and search handle their own keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.closest('input, textarea, select, [contenteditable], [role="dialog"], [role="menu"]') || listRef.current?.contains(el))) return;
      e.preventDefault();
      moveRef.current(e.key === 'ArrowDown' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onKeyNav = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    }
  };

  return (
    <section className="flex h-full w-[256px] shrink-0 flex-col bg-surface shadow-[inset_-1px_0_0_var(--c-hairline)]">
      <div data-tauri-drag-region className="flex h-toolbar shrink-0 items-center gap-2 px-3">
        <div className="relative min-w-0 flex-1">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              onKeyNav(e);
              if (e.key === 'Escape') onQueryChange('');
            }}
            placeholder={t('list.search')}
            className="h-7 rounded-lg pl-8 pr-7 text-xs"
            spellCheck={false}
          />
          {query && (
            <IconButton label={t('common.close')} size="sm" className="absolute top-0.5 right-0.5" onClick={() => onQueryChange('')}>
              <X size={12} />
            </IconButton>
          )}
        </div>
        <div className="relative">
          <Button size="sm" variant="tonal" pill icon={<Plus size={14} strokeWidth={2.25} />} onClick={() => setNewMenu(!newMenu)} className="pr-3 pl-2">
            {t('list.new')}
          </Button>
          {newMenu && (
            <Menu onClose={() => setNewMenu(false)} className="right-0">
              {(['login', 'note', 'card', 'identity'] as ItemKind[]).map((k) => (
                <MenuItem key={k} icon={kindIcon[k]} onClick={() => { setNewMenu(false); onNew(k); }}>
                  {t(`kind.${k}`)}
                </MenuItem>
              ))}
            </Menu>
          )}
        </div>
      </div>

      <div
        ref={listRef}
        tabIndex={0}
        onKeyDown={onKeyNav}
        className="flex-1 overflow-y-auto px-2 pt-1.5 pb-2 focus:outline-none"
      >
        {items.length === 0 ? (
          <EmptyList query={query} isTrash={isTrash} />
        ) : (
          items.map((it) => <Row key={it.id} item={it} selected={it.id === selectedId} onClick={() => onSelect(it.id)} />)
        )}
      </div>
      <div className="shrink-0 px-4 py-2 text-center text-[11px] text-faint tabular-nums">
        {items.length === 1 ? t('list.countOne') : t('list.count', { n: items.length })}
      </div>
    </section>
  );
}

function Row({ item, selected, onClick }: { item: ItemSummary; selected: boolean; onClick: () => void }) {
  const t = useT();
  const sub =
    item.kind === 'login' ? item.username || (item.urls[0] ? hostOf(item.urls[0]) : '') || t('kind.login') : t(`kind.${item.kind}`);
  return (
    <div
      data-id={item.id}
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={cx(
        'tr flex h-11 cursor-default items-center gap-2.5 rounded-lg px-2 select-none',
        selected ? 'bg-accent-soft' : 'hover:bg-surface-2 active:bg-surface-3',
      )}
    >
      <SiteIcon title={item.title} url={item.urls[0]} kind={item.kind} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          <span className="truncate text-[13px] leading-[18px] font-medium">{item.title || '—'}</span>
          {item.favorite && <Star size={10} className="shrink-0 fill-warning text-warning" />}
        </span>
        <span className="block truncate text-[12px] leading-[16px] text-muted">
          {sub || ' '}
        </span>
      </span>
    </div>
  );
}

function EmptyList({ query, isTrash }: { query: string; isTrash: boolean }) {
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-faint">
        <Search size={18} />
      </span>
      <p className="text-xs font-medium text-muted">
        {query ? t('list.emptySearch', { q: query }) : isTrash ? t('list.emptyTrash') : t('list.empty')}
      </p>
      {!query && !isTrash && <p className="mt-1 text-[11px] text-faint">{t('list.emptyHint')}</p>}
    </div>
  );
}
