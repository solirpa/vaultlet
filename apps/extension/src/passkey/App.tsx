/**
 * Passkey confirmation window. Opened by the background for a page's
 * `navigator.credentials.get()` (pick a passkey to sign in with) or `.create()`
 * (choose where to save a new passkey). Nothing is signed or created until the
 * user clicks here. Closing the window refuses the request.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, KeyRound, Loader2, Lock, Plus, Usb } from 'lucide-react';
import { ext } from '../shared/browser';
import { t } from '../shared/i18n';
import { isStateBroadcast, rpc, type PasskeyAnswer, type PasskeyPrompt } from '../shared/rpc';
import { Centered, StateIcon } from '../popup/ui';
import { SiteIcon } from '../popup/SiteIcon';

const LOCKED_POLL_MS = 1500;

type CreatePrompt = Extract<PasskeyPrompt, { kind: 'create' }>;
type GetPrompt = Extract<PasskeyPrompt, { kind: 'get' }>;

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
      setBusy(typeof a === 'string' ? a : 'entryId' in a ? a.entryId : a.saveTo);
      setError(null);
      try {
        await rpc('passkeyAnswer', requestId, a);
        window.close(); // the background closes it too
      } catch (e) {
        setError((e as Error).message || t(typeof a === 'object' && 'saveTo' in a ? 'passkey.errSave' : 'passkey.errSign'));
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

  const create = prompt.kind === 'create';
  return (
    <div className="flex h-screen flex-col bg-surface text-text">
      <header className="flex shrink-0 items-center gap-3 px-5 pt-5 pb-3">
        <SiteIcon title={create ? prompt.rpName || prompt.rpId : prompt.rpId} url={prompt.origin} size={36} />
        <div className="min-w-0">
          <div className="text-[15px] font-semibold">{t(create ? 'passkey.saveTitle' : 'passkey.title')}</div>
          <div className="truncate text-xs text-muted" title={prompt.origin}>
            {new URL(prompt.origin).host}
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
            <div className="max-w-[300px] text-center text-xs text-muted">{t(create ? 'passkey.lockedSaveHint' : 'passkey.lockedHint')}</div>
            <button className="btn btn-primary mt-2" onClick={() => rpc('unlockRequest').catch(() => {})}>
              {t('app.unlockInApp')}
            </button>
          </Centered>
        ) : create ? (
          <SaveBody prompt={prompt} busy={busy} onSave={(saveTo) => void answer({ saveTo })} onOk={() => void answer('cancel')} />
        ) : (
          <SignInBody prompt={prompt} busy={busy} onPick={(entryId) => void answer({ entryId })} />
        )}
        {error && <div className="px-3 pt-3 text-xs text-danger">{error}</div>}
      </main>

      <footer className="flex shrink-0 flex-col gap-2 px-5 pt-3 pb-5">
        <button className="btn btn-tonal h-9 w-full gap-2" disabled={busy !== null} onClick={() => void answer('fallback')}>
          <Usb className="h-4 w-4" />
          {t('passkey.otherDevice')}
        </button>
        {!(create && prompt.excluded && !prompt.locked) && (
          <button className="btn btn-ghost h-8 w-full" disabled={busy !== null} onClick={() => void answer('cancel')}>
            {t('passkey.cancel')}
          </button>
        )}
      </footer>
    </div>
  );
}

function SignInBody({ prompt, busy, onPick }: { prompt: GetPrompt; busy: string | null; onPick: (entryId: string) => void }) {
  if (prompt.entries.length === 0) {
    return (
      <Centered>
        <div className="text-xs text-muted">{t('passkey.none')}</div>
      </Centered>
    );
  }
  return (
    <>
      <div className="px-2 pt-1 pb-2 text-[11px] font-semibold text-muted">{t('passkey.choose')}</div>
      <ul className="flex flex-col gap-1">
        {prompt.entries.map((e, i) => (
          <li key={e.entryId}>
            <button
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-[var(--c-hover)] disabled:opacity-60"
              disabled={busy !== null}
              autoFocus={i === 0}
              onClick={() => onPick(e.entryId)}
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
  );
}

function SaveBody({
  prompt,
  busy,
  onSave,
  onOk,
}: {
  prompt: CreatePrompt;
  busy: string | null;
  onSave: (saveTo: string) => void;
  onOk: () => void;
}) {
  const [target, setTarget] = useState('new');
  const account = prompt.userName || prompt.userDisplayName;

  if (prompt.excluded) {
    return (
      <Centered>
        <StateIcon accent>
          <Check className="h-5 w-5" />
        </StateIcon>
        <div className="max-w-[300px] text-center text-[13px] font-semibold">{t('passkey.alreadySaved')}</div>
        {account && <div className="text-xs text-muted">{account}</div>}
        <button className="btn btn-primary mt-2" autoFocus onClick={onOk}>
          {t('passkey.ok')}
        </button>
      </Centered>
    );
  }

  const options = [{ entryId: 'new', title: t('passkey.newItem'), username: prompt.rpName || prompt.rpId }, ...prompt.targets];
  return (
    <>
      {account && (
        <div className="mx-2 mb-3 rounded-xl bg-surface-2 px-3 py-2">
          <div className="text-[11px] text-muted">{t('passkey.account')}</div>
          <div className="truncate text-[13px] font-medium">{account}</div>
          {prompt.userDisplayName && prompt.userDisplayName !== account && (
            <div className="truncate text-xs text-muted">{prompt.userDisplayName}</div>
          )}
        </div>
      )}
      <div className="px-2 pb-2 text-[11px] font-semibold text-muted">{t('passkey.saveTo')}</div>
      <ul className="flex flex-col gap-1" role="radiogroup">
        {options.map((o) => (
          <li key={o.entryId}>
            <button
              role="radio"
              aria-checked={target === o.entryId}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-[var(--c-hover)] ${target === o.entryId ? 'bg-[var(--c-hover)]' : ''}`}
              disabled={busy !== null}
              onClick={() => setTarget(o.entryId)}
            >
              {o.entryId === 'new' ? <Plus className="h-4 w-4 shrink-0 text-accent" /> : <KeyRound className="h-4 w-4 shrink-0 text-muted" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{o.title}</span>
                <span className="block truncate text-xs text-muted">{o.username}</span>
              </span>
              {target === o.entryId && <Check className="h-4 w-4 shrink-0 text-accent" />}
            </button>
          </li>
        ))}
      </ul>
      <div className="px-2 pt-3">
        <button className="btn btn-primary h-9 w-full gap-2" disabled={busy !== null} autoFocus onClick={() => onSave(target)}>
          {busy !== null && busy !== 'fallback' && busy !== 'cancel' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t('passkey.save')}
        </button>
      </div>
    </>
  );
}
