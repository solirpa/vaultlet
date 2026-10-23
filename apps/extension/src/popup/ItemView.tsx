/**
 * "View item" page inside the popup (Bitwarden-style). The password is never
 * kept in state except while revealed; copy / reveal / fill fetch it on demand.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Copy, ExternalLink, Eye, EyeOff, Star } from 'lucide-react';
import { ext, invoke } from '../shared/browser';
import { t } from '../shared/i18n';
import type { EntryDetail, LoginSummary } from '../shared/protocol';
import { rpc } from '../shared/rpc';
import { entryTitle } from './ui';
import { SiteIcon } from './SiteIcon';
import { displayHost } from './sections';

type Detail = Omit<EntryDetail, 'password'> & { hasPassword: boolean };

export interface FillTarget {
  tabId?: number;
  host: string;
  isWebPage: boolean;
}

export function ItemView({
  summary,
  target,
  matchesTab,
  reloadKey,
  onBack,
  onFill,
  onCopy,
  onCopyPassword,
}: {
  summary: LoginSummary;
  target: FillTarget;
  matchesTab: boolean;
  reloadKey: number;
  onBack: () => void;
  onFill: (entry: LoginSummary) => void;
  onCopy: (what: string, value: string) => void;
  onCopyPassword: (entryId: string) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc('getEntry', summary.id)
      .then(({ password, ...rest }) => {
        if (!cancelled) setDetail({ ...rest, hasPassword: password.length > 0 });
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [summary.id, reloadKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const toggleReveal = async () => {
    if (revealed !== null) {
      setRevealed(null);
      return;
    }
    try {
      setRevealed((await rpc('getEntry', summary.id)).password);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const d = detail ?? { ...summary, urls: summary.url ? [summary.url] : [], notes: '', favorite: !!summary.favorite, hasPassword: true };
  const host = displayHost(d.url);
  const title = entryTitle(d, host);
  const canFill = target.isWebPage && target.tabId !== undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 px-2">
        <button className="icon-btn h-8 w-8 text-muted" onClick={onBack} title={t('item.back')} autoFocus>
          <ArrowLeft className="h-[18px] w-[18px]" />
        </button>
        <span className="truncate text-[13px] font-semibold">{t('vault.view')}</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div className="flex items-center gap-3 px-1 pt-1 pb-4">
          <SiteIcon title={title} url={d.url} size={40} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[15px] font-semibold">{title}</span>
              {d.favorite && <Star className="h-3.5 w-3.5 shrink-0 fill-warning text-warning" aria-label={t('item.favorite')} />}
            </div>
            {host && <div className="truncate text-xs text-muted">{host}</div>}
          </div>
        </div>

        {error && <p className="mb-3 px-1 text-xs text-danger">{error}</p>}

        <Block>
          <Field label={t('item.username')}>
            <span className={`truncate ${d.username ? '' : 'text-faint'}`}>{d.username || t('vault.noUsername')}</span>
            {d.username && <CopyBtn onClick={() => onCopy(t('what.username'), d.username)} />}
          </Field>
          {d.hasPassword && (
            <Field label={t('item.password')}>
              <span className={`min-w-0 flex-1 ${revealed !== null ? 'font-mono text-[12.5px] break-all' : 'tracking-widest'}`}>
                {revealed !== null ? revealed : '••••••••••••'}
              </span>
              <button
                className="icon-btn"
                onClick={() => void toggleReveal()}
                title={revealed !== null ? t('item.hide') : t('item.show')}
              >
                {revealed !== null ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
              <CopyBtn onClick={() => onCopyPassword(summary.id)} />
            </Field>
          )}
          {d.totp && <TotpField entryId={summary.id} onCopy={(code) => onCopy(t('what.totp'), code)} />}
        </Block>

        {d.urls.length > 0 && (
          <Block title={d.urls.length > 1 ? t('item.websites') : t('item.website')}>
            {d.urls.map((u, i) => (
              <div key={`${u}-${i}`} className="flex min-h-11 items-center gap-1 px-3">
                <span className="min-w-0 flex-1 truncate text-[13px]" title={u}>
                  {u}
                </span>
                {/^https?:\/\//i.test(u) && (
                  <button
                    className="icon-btn"
                    title={t('item.open')}
                    onClick={() => void invoke(ext.tabs, 'create', { url: u }).catch(() => {})}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </button>
                )}
                <CopyBtn onClick={() => onCopy(t('what.website'), u)} />
              </div>
            ))}
          </Block>
        )}

        {d.notes && (
          <Block title={t('item.notes')}>
            <p className="px-3 py-2.5 text-[13px] leading-5 whitespace-pre-wrap break-words select-text">{d.notes}</p>
          </Block>
        )}
      </div>

      <div className="shrink-0 px-3 pt-1 pb-3">
        {canFill && !matchesTab && (
          <p className="mb-1.5 truncate px-1 text-[11.5px] text-muted">{t('item.notForSite', { host: target.host })}</p>
        )}
        {!canFill && <p className="mb-1.5 px-1 text-[11.5px] text-muted">{t('item.noFillTarget')}</p>}
        <button className="btn btn-primary h-9 w-full" disabled={!canFill} onClick={() => onFill(summary)}>
          {canFill && !matchesTab ? t('item.fillOn', { host: target.host }) : t('item.fill')}
        </button>
      </div>
    </div>
  );
}

function Block({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="mb-3">
      {title && <h3 className="mb-1.5 px-1 text-[11px] font-semibold text-muted">{title}</h3>}
      <div className="divide-y divide-hairline rounded-lg bg-surface-2">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="flex min-h-7 items-center gap-0.5 text-[13px]">{children}</div>
    </div>
  );
}

function CopyBtn({ onClick }: { onClick: () => void }) {
  return (
    <button className="icon-btn ml-auto shrink-0" onClick={onClick} title={t('item.copy')}>
      <Copy className="h-4 w-4" />
    </button>
  );
}

/** Live TOTP: local 1 s tick, re-fetch when the period rolls over. */
function TotpField({ entryId, onCopy }: { entryId: string; onCopy: (code: string) => void }) {
  const [totp, setTotp] = useState<{ code: string; remaining: number; at: number; period: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inflight = useRef(false);

  const fetchTotp = useCallback(() => {
    if (inflight.current) return;
    inflight.current = true;
    rpc('getTotp', entryId)
      .then((r) =>
        setTotp((prev) => ({ ...r, at: Date.now(), period: r.period ?? Math.max(prev?.period ?? 30, r.remaining > 30 ? 60 : 30) })),
      )
      .catch(() => setFailed(true))
      .finally(() => {
        inflight.current = false;
      });
  }, [entryId]);

  useEffect(() => {
    fetchTotp();
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [fetchTotp]);

  const remaining = totp ? Math.max(0, totp.remaining - Math.floor((now - totp.at) / 1000)) : 0;
  useEffect(() => {
    if (totp && remaining <= 0) fetchTotp();
  }, [totp, remaining, fetchTotp]);

  const r = 8;
  const c = 2 * Math.PI * r;
  const frac = totp ? remaining / totp.period : 0;
  const code = totp?.code ?? '';
  const pretty = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;

  return (
    <Field label={t('item.totp')}>
      <span className="font-mono text-[15px] font-medium tracking-wide tabular-nums">{failed && !totp ? '—' : pretty || '······'}</span>
      {totp && (
        <span className="ml-2 flex items-center gap-1 text-[11px] text-muted tabular-nums">
          <svg width="20" height="20" viewBox="0 0 20 20" className="-rotate-90">
            <circle cx="10" cy="10" r={r} fill="none" stroke="var(--c-hairline)" strokeWidth="2.5" />
            <circle
              cx="10"
              cy="10"
              r={r}
              fill="none"
              stroke={remaining <= 5 ? 'var(--c-danger)' : 'var(--c-accent)'}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - frac)}
              style={{ transition: 'stroke-dashoffset 1s linear' }}
            />
          </svg>
          {remaining}s
        </span>
      )}
      {code && <CopyBtn onClick={() => onCopy(code)} />}
    </Field>
  );
}
