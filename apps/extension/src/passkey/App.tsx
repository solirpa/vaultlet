/**
 * Passkey confirmation window. Opened by the background for a page's
 * `navigator.credentials.get()`; nothing is signed until the user picks a
 * passkey here. Closing the window refuses the request.
 */
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, Lock, Usb } from 'lucide-react';
import { ext } from '../shared/browser';
import { t } from '../shared/i18n';
import { isStateBroadcast, rpc, type PasskeyAnswer, type PasskeyPrompt } from '../shared/rpc';
import { Centered, StateIcon } from '../popup/ui';
import { SiteIcon } from '../popup/SiteIcon';

const LOCKED_POLL_MS = 1500;

export function PasskeyApp({ requestId }: { requestId: string }) {
  const [prompt, setPrompt] = useState<PasskeyPrompt | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    rpc('passkeyPending', requestId)
      .then(setPrompt)
      .catch(() => setPrompt(null));
  }, [requestId]);

  useEffect(refresh, [refresh]);

  // While locked, pick up the unlock (push event, with polling as a fallback).
  useEffect(() => {
    if (!prompt?.locked) return;
    const onMessage = (m: unknown) => {
      if (isStateBroadcast(m) && m.event === 'unlocked') refresh();
    };
    ext.runtime.onMessage.addListener(onMessage);
    const timer = setInterval(refresh, LOCKED_POLL_MS);
    return () => {
      ext.runtime.onMessage.removeListener(onMessage);
      clearInterval(timer);
    };
  }, [prompt?.locked, refresh]);

  const answer = useCallback(
    async (a: PasskeyAnswer) => {
      setBusy(typeof a === 'string' ? a : a.entryId);
      setError(null);
      try {
        await rpc('passkeyAnswer', requestId, a);
        window.close(); // the background closes it too
      } catch (e) {
        setError((e as Error).message || t('passkey.errSign'));
        setBusy(null);
      }
    },
    [requestId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void answer('cancel');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [answer]);

  if (prompt === undefined) return <div className="h-screen bg-surface" />;

  if (prompt === null) {
    return (
      <div className="flex h-screen flex-col bg-surface">
        <Centered>
          <StateIcon>
            <KeyRound className="h-5 w-5" />
          </StateIcon>
          <div className="text-[13px] font-semibold">{t('passkey.expired')}</div>
          <button className="btn btn-tonal mt-2" onClick={() => window.close()}>
            {t('passkey.close')}
          </button>
        </Centered>
      </div>
    );
  }

  const host = new URL(prompt.origin).host;
  return (
    <div className="flex h-screen flex-col bg-surface text-text">
      <header className="flex shrink-0 items-center gap-3 px-5 pt-5 pb-3">
        <SiteIcon title={prompt.rpId} url={prompt.origin} size={36} />
        <div className="min-w-0">
          <div className="text-[15px] font-semibold">{t('passkey.title')}</div>
          <div className="truncate text-xs text-muted" title={prompt.origin}>
            {host}
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-3">
        {prompt.locked ? (
          <Centered>
            <StateIcon accent>
              <Lock className="h-5 w-5" />
            </StateIcon>
            <div className="text-[13px] font-semibold">{t('app.locked')}</div>
            <div className="max-w-[300px] text-center text-xs text-muted">{t('passkey.lockedHint')}</div>
            <button className="btn btn-primary mt-2" onClick={() => rpc('unlockRequest').catch(() => {})}>
              {t('app.unlockInApp')}
            </button>
          </Centered>
        ) : prompt.entries.length === 0 ? (
          <Centered>
            <div className="text-xs text-muted">{t('passkey.none')}</div>
          </Centered>
        ) : (
          <>
            <div className="px-2 pt-1 pb-2 text-[11px] font-semibold text-muted">{t('passkey.choose')}</div>
            <ul className="flex flex-col gap-1">
              {prompt.entries.map((e, i) => (
                <li key={e.entryId}>
                  <button
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-[var(--c-hover)] disabled:opacity-60"
                    disabled={busy !== null}
                    autoFocus={i === 0}
                    onClick={() => void answer({ entryId: e.entryId })}
                  >
                    <KeyRound className="h-4 w-4 shrink-0 text-accent" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{e.username || e.title}</span>
                      <span className="block truncate text-xs text-muted">{e.title}</span>
                    </span>
                    {busy === e.entryId && <Loader2 className="h-4 w-4 animate-spin text-muted" />}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {error && <div className="px-3 pt-3 text-xs text-danger">{error}</div>}
      </main>

      <footer className="flex shrink-0 flex-col gap-2 px-5 pt-3 pb-5">
        <button className="btn btn-tonal h-9 w-full gap-2" disabled={busy !== null} onClick={() => void answer('fallback')}>
          <Usb className="h-4 w-4" />
          {t('passkey.otherDevice')}
        </button>
        <button className="btn btn-ghost h-8 w-full" disabled={busy !== null} onClick={() => void answer('cancel')}>
          {t('passkey.cancel')}
        </button>
      </footer>
    </div>
  );
}
