/**
 * Popup, modelled on the Bitwarden browser extension's vault tab:
 * search + new + lock in the header; "Autofill suggestions", "Favorites" and
 * "All items" when the search is empty; a single result list while searching;
 * click a row to open the item view. Lists never contain passwords — they are
 * fetched with get-entry at the moment of fill / copy / reveal.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Ellipsis, KeyRound, Link2, Lock, LockOpen, Plus, RefreshCw, Search, Settings, X } from 'lucide-react';
import { openOptionsPage, queryTabs } from '../shared/browser';
import { t } from '../shared/i18n';
import type { LoginSummary } from '../shared/protocol';
import { RpcError, rpc } from '../shared/rpc';
import { useExtensionState } from '../shared/useExtensionState';
import { copy } from './clipboard';
import { ItemEditor } from './ItemEditor';
import { ItemView, type FillTarget } from './ItemView';
import { buildSearchItems, buildVaultItems, displayHost, type ListItem, type SectionId } from './sections';
import { Centered, StateIcon, entryTitle } from './ui';
import { SiteIcon } from './SiteIcon';
import { VirtualList } from './VirtualList';

type View =
  | { kind: 'loading' }
  | { kind: 'not-connected'; error?: string }
  | { kind: 'not-paired' }
  | { kind: 'pairing' }
  | { kind: 'locked' }
  | { kind: 'unlocked' };

const SEARCH_DEBOUNCE_MS = 150;

function isWebUrl(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url);
}

/** The tab the popup was opened over. */
async function popupTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const [tab] = await queryTabs({ active: true, currentWindow: true });
    if (tab) return tab;
    const [last] = await queryTabs({ active: true, lastFocusedWindow: true });
    return last ?? null;
  } catch {
    return null;
  }
}

function errorMessage(e: unknown): string {
  const err = e as RpcError;
  if (/unknown|unsupported/i.test(err?.code ?? '')) return t('vault.searchNeedsNewerApp');
  return err?.message ?? String(e);
}

interface RowMenuState {
  entry: LoginSummary;
  section: SectionId;
  top: number;
  right: number;
}

export function App() {
  const [tab, setTab] = useState<chrome.tabs.Tab | null | undefined>(undefined);
  const [suggestions, setSuggestions] = useState<LoginSummary[] | null>(null);
  const [list, setList] = useState<LoginSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [results, setResults] = useState<LoginSummary[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [pairing, setPairing] = useState<'idle' | 'waiting' | 'rejected'>('idle');
  const [page, setPage] = useState<
    | { kind: 'list' }
    | { kind: 'item'; entry: LoginSummary }
    /** `from` = the item view to return to; none = back to the list */
    | { kind: 'edit'; entryId?: string; from?: LoginSummary }
  >({ kind: 'list' });
  const [menu, setMenu] = useState<RowMenuState | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const listScroll = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1600);
  }, []);

  const { state, reconnect } = useExtensionState((event) => {
    if (event === 'items-changed' || event === 'unlocked') setReloadKey((k) => k + 1);
  });

  useEffect(() => {
    void popupTab().then(setTab);
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  const view: View = useMemo(() => {
    if (!state) return { kind: 'loading' };
    if (state.connection !== 'connected') {
      if (state.connection === 'connecting' && !state.error) return { kind: 'loading' };
      return { kind: 'not-connected', error: state.error };
    }
    if (!state.paired) return pairing === 'waiting' ? { kind: 'pairing' } : { kind: 'not-paired' };
    if (state.locked === true) return { kind: 'locked' };
    return { kind: 'unlocked' };
  }, [state, pairing]);

  const unlocked = view.kind === 'unlocked';
  const siteUrl = isWebUrl(tab?.url) ? tab.url : undefined;
  const target: FillTarget = { tabId: tab?.id, host: displayHost(siteUrl), isWebPage: !!siteUrl };

  // Autofill suggestions for the tab.
  useEffect(() => {
    if (!unlocked || tab === undefined) return;
    if (!siteUrl) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    rpc('suggestions', siteUrl)
      .then((s) => !cancelled && setSuggestions(s))
      .catch(() => !cancelled && setSuggestions([]));
    return () => {
      cancelled = true;
    };
  }, [unlocked, tab, siteUrl, reloadKey]);

  // Whole vault (summaries only).
  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;
    rpc('list')
      .then((l) => {
        if (cancelled) return;
        setList(l);
        setListError(null);
      })
      .catch((e) => {
        if (cancelled || (e as RpcError).code === 'locked') return;
        setListError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [unlocked, reloadKey]);

  // Search.
  useEffect(() => {
    if (!unlocked || !debounced) {
      setResults(null);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    rpc('search', debounced)
      .then((r) => {
        if (cancelled) return;
        setResults(r);
        setSearchError(null);
      })
      .catch((e) => !cancelled && setSearchError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [unlocked, debounced, reloadKey]);

  // Unlocked but the lock state is not known yet → ask.
  useEffect(() => {
    if (state?.connection === 'connected' && state.paired && state.locked === undefined) {
      rpc('status').catch(() => {});
    }
  }, [state?.connection, state?.paired, state?.locked]);

  const searching = debounced.length > 0;
  const items: ListItem[] = useMemo(
    () =>
      searching
        ? buildSearchItems(results, searchError)
        : buildVaultItems({ isWebPage: !!siteUrl, suggestions, list, listError }),
    [searching, results, searchError, siteUrl, suggestions, list, listError],
  );
  const suggestedIds = useMemo(() => new Set((suggestions ?? []).map((s) => s.id)), [suggestions]);

  // ---- actions --------------------------------------------------------------

  const copyValue = useCallback(
    async (what: string, value: string) => {
      showToast((await copy(value)) ? t('toast.copied', { what }) : t('toast.copyFailed'));
    },
    [showToast],
  );

  const copyPassword = useCallback(
    async (entryId: string) => {
      try {
        const e = await rpc('getEntry', entryId);
        const ok = await copy(e.password, { secret: true, onCleared: () => showToast(t('toast.passwordCleared')) });
        showToast(ok ? t('toast.copied', { what: t('what.password') }) : t('toast.copyFailed'));
        if (ok) rpc('touch', entryId).catch(() => {});
      } catch (err) {
        showToast(errorMessage(err));
      }
    },
    [showToast],
  );

  const copyTotp = useCallback(
    async (entryId: string) => {
      try {
        const r = await rpc('getTotp', entryId);
        await copyValue(t('what.totp'), r.code);
      } catch (err) {
        showToast(errorMessage(err));
      }
    },
    [copyValue, showToast],
  );

  const fill = useCallback(
    async (entry: LoginSummary) => {
      if (tab?.id === undefined || !siteUrl) return;
      try {
        // Copy the TOTP first, while the popup still has focus.
        let notice: string | undefined;
        if (entry.totp) {
          try {
            const r = await rpc('getTotp', entry.id);
            if (await copy(r.code)) notice = t('inline.totpCopied');
          } catch {
            /* fill anyway */
          }
        }
        const res = await rpc('fillEntry', tab.id, entry.id, notice);
        if (res.filled === 'none') showToast(notice ? t('toast.noFormCodeCopied') : t('toast.noForm'));
        else window.close();
      } catch (err) {
        showToast(errorMessage(err));
      }
    },
    [tab?.id, siteUrl, showToast],
  );

  const onAssociate = async () => {
    setPairing('waiting');
    try {
      const r = await rpc('associate');
      setPairing(r.ok ? 'idle' : 'rejected');
      if (!r.ok) showToast(t('app.pairingRejectedToast'));
    } catch (e) {
      setPairing('idle');
      showToast((e as Error).message);
    }
  };

  const openItem = (entry: LoginSummary) => {
    setMenu(null);
    setPage({ kind: 'item', entry });
  };

  const backToList = useCallback(() => {
    setPage({ kind: 'list' });
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }, []);

  /** New logins start from the current site: its host as the name, its origin as the website. */
  const newLoginDefaults = useMemo(() => {
    if (!siteUrl) return { title: '', url: '' };
    try {
      const u = new URL(siteUrl);
      return { title: u.hostname.replace(/^www\./, ''), url: u.origin };
    } catch {
      return { title: '', url: '' };
    }
  }, [siteUrl]);

  const firstRow = items.find((i): i is Extract<ListItem, { kind: 'row' }> => i.kind === 'row');

  // ---- render ---------------------------------------------------------------

  const renderItem = (it: ListItem) => {
    if (it.kind === 'header') {
      const label =
        it.section === 'suggestions'
          ? t('vault.suggestions')
          : it.section === 'favorites'
            ? t('vault.favorites')
            : it.section === 'all'
              ? t('vault.all')
              : t('vault.results');
      return (
        <div className="flex h-full items-end gap-1.5 px-4 pb-1.5 text-[11px] font-semibold text-muted">
          <span>{label}</span>
          {it.count !== undefined && <span className="font-normal text-faint tabular-nums">{it.count}</span>}
          {it.section === 'suggestions' && target.host && (
            <span className="ml-auto truncate font-normal text-faint">{target.host}</span>
          )}
        </div>
      );
    }
    if (it.kind === 'note') {
      const text =
        it.note === 'not-web'
          ? t('vault.notWeb')
          : it.note === 'no-match'
            ? t('vault.noMatch')
            : it.note === 'loading'
              ? t('vault.loading')
              : it.note === 'empty'
                ? t('vault.empty')
                : it.note === 'no-results'
                  ? t('vault.noResults', { q: debounced })
                  : (it.text ?? '');
      return (
        <div className={`flex h-full items-center px-4 text-xs ${it.note === 'error' ? 'text-danger' : 'text-faint'}`}>
          <span className="truncate">{text}</span>
        </div>
      );
    }
    return (
      <Row
        entry={it.entry}
        section={it.section}
        canFill={it.section === 'suggestions' && target.isWebPage}
        menuOpen={menu?.entry.id === it.entry.id && menu.section === it.section}
        onOpen={() => openItem(it.entry)}
        onFill={() => void fill(it.entry)}
        onMenu={(rect) =>
          setMenu((m) =>
            m && m.entry.id === it.entry.id && m.section === it.section
              ? null
              : (() => {
                  const root = rootRef.current?.getBoundingClientRect();
                  return {
                    entry: it.entry,
                    section: it.section,
                    top: rect.bottom - (root?.top ?? 0) + 4,
                    right: (root?.right ?? window.innerWidth) - rect.right,
                  };
                })(),
          )
        }
      />
    );
  };

  return (
    <div ref={rootRef} className="relative flex h-[560px] w-[380px] flex-col overflow-hidden bg-surface">
      {unlocked && page.kind === 'edit' ? (
        <ItemEditor
          entryId={page.entryId}
          defaults={newLoginDefaults}
          onCancel={() => (page.from ? setPage({ kind: 'item', entry: page.from }) : backToList())}
          onSaved={(id, f) => {
            setReloadKey((k) => k + 1);
            showToast(t('toast.saved'));
            setPage({ kind: 'item', entry: { id, title: f.title, username: f.username, url: f.url, totp: f.totp, favorite: f.favorite } });
          }}
          onTrashed={() => {
            setReloadKey((k) => k + 1);
            showToast(t('toast.trashed'));
            backToList();
          }}
        />
      ) : unlocked && page.kind === 'item' ? (
        <ItemView
          summary={page.entry}
          target={target}
          matchesTab={suggestedIds.has(page.entry.id)}
          reloadKey={reloadKey}
          onBack={backToList}
          onEdit={() => setPage({ kind: 'edit', entryId: page.entry.id, from: page.entry })}
          onFill={(e) => void fill(e)}
          onCopy={(what, value) => void copyValue(what, value)}
          onCopyPassword={(id) => void copyPassword(id)}
        />
      ) : unlocked ? (
        <>
          <header className="flex shrink-0 items-center gap-1 px-3 pt-3 pb-1.5">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint" />
              <input
                ref={searchRef}
                className="input pr-8 pl-9"
                placeholder={t('vault.search')}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setMenu(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && query) {
                    e.preventDefault();
                    setQuery('');
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (searching && firstRow) openItem(firstRow.entry);
                    else if (!searching && suggestions?.[0] && target.isWebPage) void fill(suggestions[0]);
                  }
                }}
                autoFocus
                spellCheck={false}
              />
              {query && (
                <button
                  className="icon-btn absolute top-1/2 right-1.5 h-6 w-6 -translate-y-1/2"
                  onClick={() => {
                    setQuery('');
                    searchRef.current?.focus();
                  }}
                  title={t('vault.clearSearch')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <button
              className="icon-btn h-9 w-9 text-muted"
              title={t('vault.new')}
              onClick={() => {
                setMenu(null);
                setPage({ kind: 'edit' });
              }}
            >
              <Plus className="h-[18px] w-[18px]" />
            </button>
            <button className="icon-btn h-9 w-9 text-muted" title={t('vault.lock')} onClick={() => rpc('lock').catch(() => {})}>
              <Lock className="h-4 w-4" />
            </button>
          </header>
          <VirtualList
            key={searching ? 'search' : 'vault'}
            items={items}
            render={renderItem}
            initialScrollTop={searching ? 0 : listScroll.current}
            onScrollTop={(top) => {
              if (!searching) listScroll.current = top;
              if (menu) setMenu(null);
            }}
          />
        </>
      ) : (
        <>
          <header className="flex h-12 shrink-0 items-center gap-2 px-4">
            <KeyRound className="h-[18px] w-[18px] text-accent" />
            <span className="text-[13px] font-semibold">Vaultlet</span>
          </header>
          <StateView view={view} pairing={pairing} vaultName={state?.vaultName} onRetry={() => void reconnect()} onAssociate={() => void onAssociate()} onToast={showToast} />
        </>
      )}

      {page.kind === 'list' && (
        <footer className="flex h-10 shrink-0 items-center gap-1.5 px-3 text-faint">
          <KeyRound className="h-3.5 w-3.5" />
          <span className="flex-1 truncate text-[11px]">
            {state?.vaultName ?? (state?.appVersion ? `Vaultlet ${state.appVersion}` : 'Vaultlet')}
          </span>
          <button className="icon-btn" onClick={openOptionsPage} title={t('vault.settings')}>
            <Settings className="h-4 w-4" />
          </button>
        </footer>
      )}

      {menu && (
        <RowMenu
          state={menu}
          onClose={() => setMenu(null)}
          onCopyUsername={() => void copyValue(t('what.username'), menu.entry.username)}
          onCopyPassword={() => void copyPassword(menu.entry.id)}
          onCopyTotp={() => void copyTotp(menu.entry.id)}
          onOpen={() => openItem(menu.entry)}
        />
      )}

      {toast && (
        <div className="pointer-events-none absolute bottom-12 left-1/2 z-30 -translate-x-1/2 rounded-lg bg-toast px-3 py-1.5 text-xs whitespace-nowrap text-toast-fg shadow-[var(--shadow-pop)]">
          {toast}
        </div>
      )}
    </div>
  );
}

function StateView({
  view,
  pairing,
  vaultName,
  onRetry,
  onAssociate,
  onToast,
}: {
  view: View;
  pairing: 'idle' | 'waiting' | 'rejected';
  vaultName?: string;
  onRetry: () => void;
  onAssociate: () => void;
  onToast: (m: string) => void;
}) {
  switch (view.kind) {
    case 'loading':
      return <Centered>{t('app.connecting')}</Centered>;
    case 'not-connected':
      return (
        <Centered>
          <StateIcon>
            <AlertCircle className="h-5 w-5" />
          </StateIcon>
          <p className="text-[13px] font-medium">{t('app.notRunning')}</p>
          <p className="px-8 text-center text-xs text-muted">
            {view.error === 'host-missing' ? t('app.hostMissing') : view.error === 'key-mismatch' ? t('app.keyMismatch') : t('app.openApp')}
          </p>
          <button className="btn btn-primary mt-2" onClick={onRetry}>
            <RefreshCw className="h-4 w-4" /> {t('app.retry')}
          </button>
        </Centered>
      );
    case 'not-paired':
      return (
        <Centered>
          <StateIcon>
            <Link2 className="h-5 w-5" />
          </StateIcon>
          <p className="text-[13px] font-medium">{t('app.notPaired')}</p>
          <p className="px-8 text-center text-xs text-muted">{pairing === 'rejected' ? t('app.pairRejected') : t('app.pairHint')}</p>
          <button className="btn btn-primary mt-2" onClick={onAssociate}>
            {t('app.connect')}
          </button>
        </Centered>
      );
    case 'pairing':
      return (
        <Centered>
          <StateIcon accent>
            <Link2 className="h-5 w-5 animate-pulse" />
          </StateIcon>
          <p className="text-[13px] font-medium">{t('app.approve')}</p>
          <p className="px-8 text-center text-xs text-muted">{t('app.approveHint')}</p>
        </Centered>
      );
    case 'locked':
      return (
        <Centered>
          <StateIcon>
            <Lock className="h-5 w-5" />
          </StateIcon>
          <p className="text-[13px] font-medium">{vaultName ? t('app.lockedNamed', { name: vaultName }) : t('app.locked')}</p>
          <button
            className="btn btn-primary mt-2"
            onClick={() =>
              rpc('unlockRequest')
                .then(() => onToast(t('app.unlockInApp')))
                .catch((e) => onToast((e as Error).message))
            }
          >
            <LockOpen className="h-4 w-4" /> {t('app.unlock')}
          </button>
        </Centered>
      );
    default:
      return null;
  }
}

function Row({
  entry,
  section,
  canFill,
  menuOpen,
  onOpen,
  onFill,
  onMenu,
}: {
  entry: LoginSummary;
  section: SectionId;
  canFill: boolean;
  menuOpen: boolean;
  onOpen: () => void;
  onFill: () => void;
  onMenu: (rect: DOMRect) => void;
}) {
  const host = displayHost(entry.url);
  const title = entryTitle(entry, host);
  return (
    <div className={`group mx-1.5 flex h-full items-center gap-1 rounded-md pr-1.5 hover:bg-hover ${menuOpen ? 'bg-hover' : ''}`}>
      <button
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md pl-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-ring)]"
        onClick={onOpen}
        data-section={section}
      >
        <SiteIcon title={title} url={entry.url} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] leading-[18px] font-medium">{title}</span>
          <span className="truncate text-[12px] leading-4 text-muted">{entry.username || host || '—'}</span>
        </span>
      </button>
      {canFill && (
        <button
          className="h-7 shrink-0 rounded-md bg-accent-soft px-3 text-xs font-medium text-accent transition-colors hover:bg-accent hover:text-white"
          onClick={onFill}
        >
          {t('vault.fill')}
        </button>
      )}
      <button
        className={`icon-btn shrink-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 ${menuOpen ? 'opacity-100' : 'opacity-50'}`}
        title={t('vault.more')}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect())}
      >
        <Ellipsis className="h-4 w-4" />
      </button>
    </div>
  );
}

function RowMenu({
  state,
  onClose,
  onCopyUsername,
  onCopyPassword,
  onCopyTotp,
  onOpen,
}: {
  state: RowMenuState;
  onClose: () => void;
  onCopyUsername: () => void;
  onCopyPassword: () => void;
  onCopyTotp: () => void;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(state.top);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      const h = el.offsetHeight;
      const limit = el.offsetParent?.clientHeight ?? window.innerHeight;
      // flip above the button when it would run off the bottom
      if (state.top + h > limit - 8) setTop(Math.max(8, state.top - h - 40));
      el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state, onClose]);

  const item = (label: string, action: () => void, disabled = false) => (
    <button
      className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-[13px] outline-none hover:bg-hover focus-visible:bg-hover disabled:text-faint"
      disabled={disabled}
      onClick={() => {
        onClose();
        action();
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <div className="absolute inset-0 z-10" onMouseDown={onClose} />
      <div
        ref={ref}
        role="menu"
        className="absolute z-20 w-48 rounded-[10px] border border-hairline bg-surface p-1 shadow-[var(--shadow-pop)]"
        style={{ top, right: Math.max(8, state.right) }}
      >
        {item(t('vault.copyUsername'), onCopyUsername, !state.entry.username)}
        {item(t('vault.copyPassword'), onCopyPassword)}
        {state.entry.totp && item(t('vault.copyTotp'), onCopyTotp)}
        <div className="my-1 h-px bg-hairline" />
        {item(t('vault.view'), onOpen)}
      </div>
    </>
  );
}
