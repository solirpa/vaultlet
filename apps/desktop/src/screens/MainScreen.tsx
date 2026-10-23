import { Inbox } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { ItemDetail } from '../components/ItemDetail';
import { ItemEditor } from '../components/ItemEditor';
import { ItemList } from '../components/ItemList';
import { Sidebar } from '../components/Sidebar';
import { ConfirmDialog, Kbd, Spinner } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { useVault } from '../hooks/VaultContext';
import { useT } from '../i18n';
import { itemsForView, type NavView } from '../lib/nav';
import { emptyItem, searchItems } from '../lib/utils';
import type { Item, ItemKind } from '../types';
import { errorMessage } from '../types';
import { SettingsModal, type SettingsTab } from './settings/SettingsModal';

type Pane = { mode: 'view' } | { mode: 'edit'; draft: Item } | { mode: 'new'; draft: Item };

export function MainScreen({ initialSettingsTab }: { initialSettingsTab?: SettingsTab }) {
  const t = useT();
  const toast = useToast();
  const { items, folders, refreshItems, refreshStatus } = useVault();
  const [view, setView] = useState<NavView>({ kind: 'all' });
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Item | null>(null);
  const [loadingItem, setLoadingItem] = useState(false);
  const [pane, setPane] = useState<Pane>({ mode: 'view' });
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(initialSettingsTab ?? null);
  const [confirm, setConfirm] = useState<{ kind: 'delete' | 'purge'; item: Item } | null>(null);

  const descendants = useCallback(
    (id: string) => {
      const set = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of folders) if (f.parent && set.has(f.parent) && !set.has(f.id)) (set.add(f.id), (grew = true));
      }
      return set;
    },
    [folders],
  );

  const visible = useMemo(() => searchItems(itemsForView([...items], view, descendants), query), [items, view, descendants, query]);

  // Load full item on selection; drop selection if it disappears from the list.
  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    if (!items.some((i) => i.id === selectedId)) {
      setSelectedId(null);
      return;
    }
    let cancelled = false;
    setLoadingItem(true);
    api
      .itemGet(selectedId)
      .then((it) => !cancelled && setSelected(it))
      .catch((e) => !cancelled && toast(errorMessage(e), 'error'))
      .finally(() => !cancelled && setLoadingItem(false));
    return () => {
      cancelled = true;
    };
  }, [selectedId, items, toast]);

  const select = (id: string) => {
    if (pane.mode !== 'view') return; // don't lose edits by accident
    setSelectedId(id);
  };

  const changeView = (v: NavView) => {
    setView(v);
    setQuery('');
    if (pane.mode === 'view') setSelectedId(null);
  };

  const startNew = (kind: ItemKind) => {
    const folder = view.kind === 'folder' ? view.id : null;
    setPane({ mode: 'new', draft: emptyItem(kind, folder) });
  };

  const save = async (item: Item) => {
    const saved = await api.itemSave(item);
    await refreshItems();
    setPane({ mode: 'view' });
    setSelectedId(saved.id);
    setSelected(saved);
    toast(t('editor.saved'), 'success');
  };

  const toggleFavorite = async () => {
    if (!selected) return;
    try {
      const saved = await api.itemSave({ ...selected, favorite: !selected.favorite });
      setSelected(saved);
      await refreshItems();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const doDelete = async (item: Item) => {
    setConfirm(null);
    try {
      await api.itemDelete(item.id);
      await refreshItems();
      setSelectedId(null);
      toast(t('toast.deleted'));
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const doRestore = async (item: Item) => {
    try {
      await api.itemRestore(item.id);
      await refreshItems();
      setSelectedId(null);
      toast(t('toast.restored'), 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const doPurge = async (item: Item) => {
    setConfirm(null);
    try {
      await api.itemPurge(item.id);
      await refreshItems();
      setSelectedId(null);
      toast(t('toast.purged'));
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const touch = (id: string) => {
    api.itemTouch(id).then(refreshItems).catch(() => undefined);
  };

  const lock = async () => {
    try {
      await api.vaultLock();
      await refreshStatus();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  // Global shortcuts: Cmd/Ctrl+N new login, Cmd/Ctrl+, settings, Cmd/Ctrl+L lock.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === 'n' && pane.mode === 'view') {
        e.preventDefault();
        startNew('login');
      } else if (e.key === ',') {
        e.preventDefault();
        setSettingsTab('general');
      } else if (e.key.toLowerCase() === 'l' && !e.shiftKey) {
        e.preventDefault();
        lock();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.mode, view]);

  return (
    <div className="flex h-full bg-bg">
      <Sidebar view={view} onSelect={changeView} onOpenSettings={() => setSettingsTab('general')} onLock={lock} />
      <ItemList
        items={visible}
        selectedId={selectedId}
        onSelect={select}
        query={query}
        onQueryChange={setQuery}
        onNew={startNew}
        isTrash={view.kind === 'trash'}
      />
      <main className="min-w-0 flex-1 bg-surface">
        {pane.mode !== 'view' ? (
          <ItemEditor
            key={pane.mode === 'edit' ? pane.draft.id : 'new'}
            initial={pane.draft}
            onSave={save}
            onCancel={() => setPane({ mode: 'view' })}
          />
        ) : selected ? (
          <ItemDetail
            item={selected}
            onEdit={() => setPane({ mode: 'edit', draft: selected })}
            onDelete={() => setConfirm({ kind: 'delete', item: selected })}
            onRestore={() => doRestore(selected)}
            onPurge={() => setConfirm({ kind: 'purge', item: selected })}
            onToggleFavorite={toggleFavorite}
            onTouch={() => touch(selected.id)}
          />
        ) : loadingItem ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <EmptyDetail />
        )}
      </main>

      {settingsTab && <SettingsModal tab={settingsTab} onTab={setSettingsTab} onClose={() => setSettingsTab(null)} />}

      <ConfirmDialog
        open={!!confirm}
        danger
        title={
          confirm?.kind === 'purge'
            ? t('detail.purgeConfirm', { title: confirm.item.title })
            : t('detail.deleteConfirm', { title: confirm?.item.title ?? '' })
        }
        confirmLabel={confirm?.kind === 'purge' ? t('detail.purge') : t('common.delete')}
        onConfirm={() => confirm && (confirm.kind === 'purge' ? doPurge(confirm.item) : doDelete(confirm.item))}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

function EmptyDetail() {
  const t = useT();
  return (
    <div className="flex h-full flex-col">
      <div data-tauri-drag-region className="h-toolbar shrink-0" />
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-faint">
          <Inbox size={22} />
        </span>
        <p className="text-[13px] font-medium text-muted">{t('detail.noSelection')}</p>
        <p className="mt-1 text-[11.5px] text-faint">{t('detail.noSelectionHint')}</p>
        <p className="mt-4 flex items-center gap-1.5 text-[11px] text-faint">
          <Kbd>⌘N</Kbd> <span>{t('list.new')}</span>
          <span className="mx-1">·</span>
          <Kbd>⌘F</Kbd> <span>{t('list.search')}</span>
        </p>
      </div>
    </div>
  );
}
