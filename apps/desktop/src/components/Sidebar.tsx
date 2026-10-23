import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock,
  CreditCard,
  FolderIcon,
  FolderPlus,
  KeyRound,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Settings,
  Star,
  StickyNote,
  Trash2,
  UserRound,
  Layers,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { useToast } from '../hooks/useToast';
import { useVault } from '../hooks/VaultContext';
import type { NavView } from '../lib/nav';
import { cx } from '../lib/utils';
import type { Folder, ItemKind } from '../types';
import { errorMessage } from '../types';
import { ConfirmDialog, IconButton, Input } from './ui';

interface SidebarProps {
  view: NavView;
  onSelect: (v: NavView) => void;
  onOpenSettings: () => void;
  onLock: () => void;
}

const kindIcon: Record<ItemKind, ReactNode> = {
  login: <KeyRound size={15} />,
  note: <StickyNote size={15} />,
  card: <CreditCard size={15} />,
  identity: <UserRound size={15} />,
};

export function Sidebar({ view, onSelect, onOpenSettings, onLock }: SidebarProps) {
  const { t } = useI18n();
  const { items, folders, refreshFolders, refreshItems } = useVault();
  const toast = useToast();

  const counts = useMemo(() => {
    const live = items.filter((i) => !i.deleted);
    const c = {
      all: live.length,
      favorites: live.filter((i) => i.favorite).length,
      recent: live.filter((i) => i.lastUsed).length,
      trash: items.length - live.length,
      byKind: { login: 0, note: 0, card: 0, identity: 0 } as Record<ItemKind, number>,
      byFolder: new Map<string, number>(),
    };
    for (const i of live) {
      c.byKind[i.kind]++;
      if (i.folder) c.byFolder.set(i.folder, (c.byFolder.get(i.folder) ?? 0) + 1);
    }
    return c;
  }, [items]);

  const [creatingUnder, setCreatingUnder] = useState<string | null | false>(false);
  const [renaming, setRenaming] = useState<Folder | null>(null);
  const [deleting, setDeleting] = useState<Folder | null>(null);

  const createFolder = async (name: string, parent: string | null) => {
    setCreatingUnder(false);
    if (!name.trim()) return;
    try {
      const f = await api.folderSave({ id: '', name: name.trim(), parent });
      await refreshFolders();
      toast(t('toast.folderCreated'), 'success');
      onSelect({ kind: 'folder', id: f.id });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const renameFolder = async (f: Folder, name: string) => {
    setRenaming(null);
    if (!name.trim() || name.trim() === f.name) return;
    try {
      await api.folderSave({ ...f, name: name.trim() });
      await refreshFolders();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const deleteFolder = async (f: Folder) => {
    setDeleting(null);
    try {
      await api.folderDelete(f.id);
      await Promise.all([refreshFolders(), refreshItems()]);
      if (view.kind === 'folder' && view.id === f.id) onSelect({ kind: 'all' });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <aside className="flex h-full w-[192px] shrink-0 flex-col bg-bg">
      {/* Toolbar-height drag strip: the macOS traffic lights sit centred in it (see tauri.conf.json). */}
      <div data-tauri-drag-region className="h-toolbar shrink-0" />

      <nav className="flex-1 overflow-y-auto px-2.5 pt-1 pb-2">
        <NavRow icon={<Layers size={15} />} label={t('nav.all')} count={counts.all} active={view.kind === 'all'} onClick={() => onSelect({ kind: 'all' })} />
        <NavRow icon={<Star size={15} />} label={t('nav.favorites')} count={counts.favorites} active={view.kind === 'favorites'} onClick={() => onSelect({ kind: 'favorites' })} />
        <NavRow icon={<Clock size={15} />} label={t('nav.recent')} count={counts.recent} active={view.kind === 'recent'} onClick={() => onSelect({ kind: 'recent' })} />
        <NavRow icon={<Trash2 size={15} />} label={t('nav.trash')} count={counts.trash} active={view.kind === 'trash'} onClick={() => onSelect({ kind: 'trash' })} />

        <GroupLabel>{t('nav.types')}</GroupLabel>
        {(['login', 'note', 'card', 'identity'] as ItemKind[]).map((k) => (
          <NavRow
            key={k}
            icon={kindIcon[k]}
            label={t(`kind.plural.${k}`)}
            count={counts.byKind[k]}
            active={view.kind === 'type' && view.type === k}
            onClick={() => onSelect({ kind: 'type', type: k })}
          />
        ))}

        <GroupLabel
          action={
            <IconButton label={t('nav.newFolder')} size="sm" onClick={() => setCreatingUnder(null)}>
              <FolderPlus size={13} />
            </IconButton>
          }
        >
          {t('nav.folders')}
        </GroupLabel>
        <FolderTree
          folders={folders}
          parent={null}
          depth={0}
          view={view}
          counts={counts.byFolder}
          onSelect={onSelect}
          creatingUnder={creatingUnder}
          onCreate={createFolder}
          onCancelCreate={() => setCreatingUnder(false)}
          onStartCreate={(parent) => setCreatingUnder(parent)}
          renaming={renaming}
          onStartRename={setRenaming}
          onRename={renameFolder}
          onCancelRename={() => setRenaming(null)}
          onDelete={setDeleting}
        />
        {creatingUnder === null && (
          <InlineInput
            placeholder={t('nav.folderName')}
            depth={0}
            onSubmit={(name) => createFolder(name, null)}
            onCancel={() => setCreatingUnder(false)}
          />
        )}
      </nav>

      <div className="flex shrink-0 items-center gap-0.5 px-2.5 pt-1 pb-2.5">
        <SyncPill />
        <IconButton label={t('nav.settings')} onClick={onOpenSettings}>
          <Settings size={15} />
        </IconButton>
        <IconButton label={t('nav.lock')} onClick={onLock}>
          <Lock size={15} />
        </IconButton>
      </div>

      <ConfirmDialog
        open={!!deleting}
        title={deleting ? t('nav.deleteFolderConfirm', { name: deleting.name }) : ''}
        danger
        confirmLabel={t('common.delete')}
        onConfirm={() => deleting && deleteFolder(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </aside>
  );
}

function GroupLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mt-3 mb-0.5 flex h-5 items-center justify-between pr-0.5 pl-2">
      <span className="text-[11px] font-semibold text-faint">{children}</span>
      {action}
    </div>
  );
}

function NavRow({
  icon,
  label,
  count,
  active,
  onClick,
  depth = 0,
  trailing,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  depth?: number;
  trailing?: ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick()}
      className={cx(
        'tr group flex h-[26px] cursor-default items-center gap-2 rounded-md pr-1.5 text-[13px] select-none',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-accent-soft font-medium text-accent' : 'text-text hover:bg-hover active:bg-pressed',
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      <span className={cx('flex w-4 shrink-0 justify-center', active ? 'text-accent' : 'text-muted')}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
      {count !== undefined && count > 0 && (
        <span className={cx('text-[11px] font-normal tabular-nums group-hover:hidden', active ? 'text-accent/70' : 'text-faint')}>{count}</span>
      )}
    </div>
  );
}

interface FolderTreeProps {
  folders: Folder[];
  parent: string | null;
  depth: number;
  view: NavView;
  counts: Map<string, number>;
  onSelect: (v: NavView) => void;
  creatingUnder: string | null | false;
  onCreate: (name: string, parent: string | null) => void;
  onCancelCreate: () => void;
  onStartCreate: (parent: string) => void;
  renaming: Folder | null;
  onStartRename: (f: Folder) => void;
  onRename: (f: Folder, name: string) => void;
  onCancelRename: () => void;
  onDelete: (f: Folder) => void;
}

function FolderTree(props: FolderTreeProps) {
  const { folders, parent, depth } = props;
  const children = folders.filter((f) => f.parent === parent).sort((a, b) => a.name.localeCompare(b.name));
  if (!children.length && depth === 0 && props.creatingUnder === false) {
    return null;
  }
  return (
    <>
      {children.map((f) => (
        <FolderNode key={f.id} folder={f} {...props} />
      ))}
    </>
  );
}

function FolderNode({ folder, ...props }: FolderTreeProps & { folder: Folder }) {
  const { t } = useI18n();
  const { folders, depth, view, counts } = props;
  const hasChildren = folders.some((f) => f.parent === folder.id);
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState(false);
  const active = view.kind === 'folder' && view.id === folder.id;
  const isRenaming = props.renaming?.id === folder.id;

  if (isRenaming) {
    return (
      <InlineInput
        initial={folder.name}
        depth={depth}
        onSubmit={(name) => props.onRename(folder, name)}
        onCancel={props.onCancelRename}
      />
    );
  }

  return (
    <>
      <div className="relative">
        <NavRow
          icon={<FolderIcon size={15} />}
          label={folder.name}
          count={counts.get(folder.id)}
          active={active}
          depth={depth}
          onClick={() => props.onSelect({ kind: 'folder', id: folder.id })}
          trailing={
            <>
            {hasChildren && (
              <span
                role="button"
                aria-label={open ? 'collapse' : 'expand'}
                className="tr flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint hover:bg-hover hover:text-muted"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(!open);
                }}
              >
                <ChevronRight size={12} className={cx('tr', open && 'rotate-90')} />
              </span>
            )}
            <IconButton
              label="…"
              size="sm"
              className={cx('opacity-0 group-hover:opacity-100 focus-visible:opacity-100', menu && 'opacity-100')}
              onClick={(e) => {
                e.stopPropagation();
                setMenu(!menu);
              }}
            >
              <MoreHorizontal size={13} />
            </IconButton>
            </>
          }
        />
        {menu && (
          <Menu onClose={() => setMenu(false)}>
            <MenuItem icon={<FolderPlus size={13} />} onClick={() => { setMenu(false); setOpen(true); props.onStartCreate(folder.id); }}>
              {t('nav.newSubfolder')}
            </MenuItem>
            <MenuItem icon={<Pencil size={13} />} onClick={() => { setMenu(false); props.onStartRename(folder); }}>
              {t('common.rename')}
            </MenuItem>
            <MenuItem icon={<Trash2 size={13} />} danger onClick={() => { setMenu(false); props.onDelete(folder); }}>
              {t('common.delete')}
            </MenuItem>
          </Menu>
        )}
      </div>
      {open && (
        <FolderTree {...props} parent={folder.id} depth={depth + 1} />
      )}
      {props.creatingUnder === folder.id && (
        <InlineInput
          placeholder={t('nav.folderName')}
          depth={depth + 1}
          onSubmit={(name) => props.onCreate(name, folder.id)}
          onCancel={props.onCancelCreate}
        />
      )}
    </>
  );
}

function InlineInput({
  initial = '',
  placeholder,
  depth,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  placeholder?: string;
  depth: number;
  onSubmit: (v: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="flex items-center gap-0.5 py-0.5 pr-0.5" style={{ paddingLeft: 8 + depth * 14 }}>
      <Input
        ref={ref}
        value={v}
        placeholder={placeholder}
        className="h-6 rounded-md bg-surface px-1.5 text-xs shadow-[inset_0_0_0_1px_var(--c-hairline-strong)]"
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit(v);
          if (e.key === 'Escape') onCancel();
        }}
        onBlur={() => (v.trim() ? onSubmit(v) : onCancel())}
      />
      <IconButton label="OK" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={() => onSubmit(v)}>
        <Check size={12} />
      </IconButton>
      <IconButton label="Cancel" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={onCancel}>
        <X size={12} />
      </IconButton>
    </div>
  );
}

export function Menu({ children, onClose, className }: { children: ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      className={cx('elev-pop animate-pop absolute top-full right-1 z-40 mt-1 min-w-[160px] rounded-xl p-1', className)}
    >
      {children}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cx(
        'tr flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px] hover:bg-hover active:bg-pressed',
        danger ? 'text-danger' : 'text-text',
      )}
    >
      {icon && <span className={danger ? 'text-danger/80' : 'text-muted'}>{icon}</span>}
      {children}
    </button>
  );
}

function SyncPill() {
  const { t, lang } = useI18n();
  const { sync, setSync } = useVault();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setSync(await api.syncNow());
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const state = sync?.state ?? 'idle';
  const syncing = state === 'syncing' || busy;
  const icon = syncing ? (
    <Loader2 size={13} className="animate-spin-slow" />
  ) : state === 'error' ? (
    <X size={13} />
  ) : state === 'conflict' ? (
    <AlertTriangle size={13} />
  ) : (
    <span className="h-2 w-2 rounded-full bg-current" />
  );
  const tone =
    state === 'error' ? 'text-danger' : state === 'conflict' ? 'text-warning' : syncing ? 'text-accent' : 'text-success';
  const label = syncing ? t('sync.syncing') : t(`sync.${state}` as const);
  const when = sync?.lastSync ? relativeTime(sync.lastSync, t, lang) : t('sync.never');

  return (
    <button
      type="button"
      onClick={run}
      title={`${sync?.message ?? ''}\n${t('sync.clickToSync')}`.trim()}
      className="tr flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left hover:bg-hover active:bg-pressed focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className={cx('flex h-4 w-4 shrink-0 items-center justify-center', tone)}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] leading-tight font-medium">{label}</span>
        <span className="block truncate text-[10.5px] leading-tight text-faint">{when}</span>
      </span>
    </button>
  );
}

export function relativeTime(iso: string, t: ReturnType<typeof useI18n>['t'], locale: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return t('sync.justNow');
  if (m < 60) return t('sync.minutesAgo', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('sync.hoursAgo', { n: h });
  const d = Math.floor(h / 24);
  if (d < 7) return t('sync.daysAgo', { n: d });
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
}

