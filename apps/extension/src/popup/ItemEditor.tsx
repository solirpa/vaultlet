/**
 * Create / edit a login inside the popup. Saves through the desktop app (`item-save`), which
 * keeps everything this form does not show (custom fields, passkeys, folder, tags) and puts
 * the previous version into the item's history.
 *
 * The TOTP secret is never sent to the extension: an existing one shows as "set" and can be
 * replaced or removed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Eye, EyeOff, Loader2, Minus, Plus, RefreshCw, Star, Trash2, Wand2 } from 'lucide-react';
import { t } from '../shared/i18n';
import type { GeneratorOptions, ItemSaveInput } from '../shared/protocol';
import { RpcError, rpc } from '../shared/rpc';

export interface EditorDefaults {
  title: string;
  url: string;
}

interface Form {
  title: string;
  username: string;
  password: string;
  urls: string[];
  notes: string;
  favorite: boolean;
}

/** What to do with the TOTP secret on save. */
type TotpEdit = { kind: 'keep' } | { kind: 'remove' } | { kind: 'set'; value: string };

const DEFAULT_GENERATOR: GeneratorOptions = { length: 20, upper: true, lower: true, digits: true, symbols: true };

export function ItemEditor({
  entryId,
  defaults,
  onCancel,
  onSaved,
  onTrashed,
}: {
  /** undefined = new login */
  entryId?: string;
  defaults: EditorDefaults;
  onCancel: () => void;
  onSaved: (entryId: string, form: { title: string; username: string; url: string; totp: boolean; favorite: boolean }) => void;
  onTrashed: () => void;
}) {
  const isNew = entryId === undefined;
  const [form, setForm] = useState<Form | null>(
    isNew ? { title: defaults.title, username: '', password: '', urls: defaults.url ? [defaults.url] : [], notes: '', favorite: false } : null,
  );
  const [hadTotp, setHadTotp] = useState(false);
  const [totp, setTotp] = useState<TotpEdit>({ kind: 'keep' });
  const [showPassword, setShowPassword] = useState(isNew);
  const [generator, setGenerator] = useState<GeneratorOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    rpc('getEntry', entryId)
      .then((e) => {
        if (cancelled) return;
        setForm({ title: e.title, username: e.username, password: e.password, urls: e.urls, notes: e.notes, favorite: e.favorite });
        setHadTotp(e.totp);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [entryId, isNew]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const generate = useCallback(async (opts: GeneratorOptions) => {
    setGenerator(opts);
    try {
      const p = await rpc('generatePassword', opts);
      setForm((f) => (f ? { ...f, password: p } : f));
      setShowPassword(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const save = async () => {
    if (!form || busy) return;
    if (!form.title.trim()) {
      setError(t('editor.errTitle'));
      titleRef.current?.focus();
      return;
    }
    if (totp.kind === 'set' && !totp.value.trim()) {
      setError(t('editor.errTotp'));
      return;
    }
    setBusy(true);
    setError(null);
    const entry: ItemSaveInput = {
      title: form.title.trim(),
      username: form.username,
      password: form.password,
      urls: form.urls.map((u) => u.trim()).filter(Boolean),
      notes: form.notes,
      favorite: form.favorite,
    };
    if (!isNew) entry.id = entryId;
    if (totp.kind === 'remove') entry.totp = '';
    if (totp.kind === 'set') entry.totp = totp.value.trim();
    try {
      const id = await rpc('saveItem', entry);
      const hasTotp = totp.kind === 'set' || (totp.kind === 'keep' && hadTotp);
      onSaved(id, { title: entry.title, username: form.username, url: entry.urls?.[0] ?? '', totp: hasTotp, favorite: form.favorite });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : undefined;
      setError(code === 'invalid-totp' ? t('editor.errTotp') : (e as Error).message);
      setBusy(false);
    }
  };

  const trash = async () => {
    if (!confirmTrash) {
      setConfirmTrash(true);
      return;
    }
    setBusy(true);
    try {
      await rpc('trashItem', entryId!);
      onTrashed();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 px-2">
        <button className="icon-btn h-8 w-8 text-muted" onClick={onCancel} title={t('editor.cancel')}>
          <ArrowLeft className="h-[18px] w-[18px]" />
        </button>
        <span className="flex-1 truncate text-[13px] font-semibold">{t(isNew ? 'editor.newTitle' : 'editor.editTitle')}</span>
        {form && (
          <button
            className={`icon-btn h-8 w-8 ${form.favorite ? 'text-warning' : 'text-muted'}`}
            onClick={() => set('favorite', !form.favorite)}
            title={t('item.favorite')}
            aria-pressed={form.favorite}
          >
            <Star className={`h-4 w-4 ${form.favorite ? 'fill-warning' : ''}`} />
          </button>
        )}
        {!isNew && form && (
          <button
            className={`icon-btn h-8 ${confirmTrash ? 'w-auto gap-1 px-2 text-xs text-danger' : 'w-8 text-muted'}`}
            onClick={() => void trash()}
            disabled={busy}
            title={t('editor.trash')}
          >
            <Trash2 className="h-4 w-4" />
            {confirmTrash && t('editor.trashConfirm')}
          </button>
        )}
      </header>

      {!form ? (
        <div className="flex flex-1 items-center justify-center">
          {error ? <p className="px-4 text-xs text-danger">{error}</p> : <Loader2 className="h-5 w-5 animate-spin text-muted" />}
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            <Label text={t('editor.title')}>
              <input
                ref={titleRef}
                className="input"
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
                autoFocus={isNew}
                spellCheck={false}
              />
            </Label>
            <Label text={t('item.username')}>
              <input
                className="input"
                value={form.username}
                onChange={(e) => set('username', e.target.value)}
                autoFocus={!isNew}
                autoComplete="off"
                spellCheck={false}
              />
            </Label>
            <Label text={t('item.password')}>
              <div className="relative">
                <input
                  className="input pr-[68px] font-mono text-[12.5px]"
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={(e) => set('password', e.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                />
                <div className="absolute top-1/2 right-1 flex -translate-y-1/2">
                  <button className="icon-btn h-7 w-7" onClick={() => setShowPassword((v) => !v)} title={showPassword ? t('item.hide') : t('item.show')}>
                    {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    className={`icon-btn h-7 w-7 ${generator ? 'text-accent' : ''}`}
                    onClick={() => (generator ? setGenerator(null) : void generate(DEFAULT_GENERATOR))}
                    title={t('editor.generate')}
                  >
                    <Wand2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              {generator && <GeneratorPanel opts={generator} onChange={(o) => void generate(o)} />}
            </Label>

            <Label text={t('editor.totp')}>
              {hadTotp && totp.kind === 'keep' ? (
                <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
                  <span className="flex-1 text-muted">{t('editor.totpSet')}</span>
                  <button className="btn btn-ghost h-7 px-2 text-xs" onClick={() => setTotp({ kind: 'set', value: '' })}>
                    {t('editor.totpReplace')}
                  </button>
                  <button className="btn btn-ghost h-7 px-2 text-xs text-danger" onClick={() => setTotp({ kind: 'remove' })}>
                    {t('editor.totpRemove')}
                  </button>
                </div>
              ) : totp.kind === 'remove' ? (
                <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
                  <span className="flex-1 text-muted">{t('editor.totpRemoved')}</span>
                  <button className="btn btn-ghost h-7 px-2 text-xs" onClick={() => setTotp({ kind: 'keep' })}>
                    {t('editor.undo')}
                  </button>
                </div>
              ) : (
                <input
                  className="input font-mono text-[12.5px]"
                  value={totp.kind === 'set' ? totp.value : ''}
                  onChange={(e) => setTotp(e.target.value ? { kind: 'set', value: e.target.value } : hadTotp ? { kind: 'set', value: '' } : { kind: 'keep' })}
                  placeholder="otpauth://totp/… / JBSWY3DPEHPK3PXP"
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </Label>

            <Label text={t('item.websites')}>
              <div className="flex flex-col gap-1.5">
                {form.urls.map((u, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <input
                      className="input"
                      value={u}
                      onChange={(e) => set('urls', form.urls.map((x, j) => (j === i ? e.target.value : x)))}
                      placeholder="https://"
                      spellCheck={false}
                    />
                    <button
                      className="icon-btn h-8 w-8 shrink-0 text-muted"
                      onClick={() => set('urls', form.urls.filter((_, j) => j !== i))}
                      title={t('editor.removeUrl')}
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <button className="btn btn-ghost h-8 justify-start gap-1.5 px-2 text-xs" onClick={() => set('urls', [...form.urls, ''])}>
                  <Plus className="h-3.5 w-3.5" />
                  {t('editor.addUrl')}
                </button>
              </div>
            </Label>

            <Label text={t('item.notes')}>
              <textarea
                className="input min-h-[64px] resize-y py-2 leading-5"
                value={form.notes}
                onChange={(e) => set('notes', e.target.value)}
                rows={3}
              />
            </Label>
            {!isNew && <p className="px-1 pt-1 text-[11px] text-faint">{t('editor.keptHint')}</p>}
          </div>

          <div className="shrink-0 px-3 pt-1 pb-3">
            {error && <p className="mb-1.5 px-1 text-xs text-danger">{error}</p>}
            <div className="flex gap-2">
              <button className="btn btn-tonal h-9 flex-1" onClick={onCancel} disabled={busy}>
                {t('editor.cancel')}
              </button>
              <button className="btn btn-primary h-9 flex-[2] gap-2" onClick={() => void save()} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('editor.save')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    // Not a <label>: some sections hold only buttons, which a label click would trigger.
    <div className="mb-3" role="group" aria-label={text}>
      <span className="mb-1 block px-1 text-[11px] font-semibold text-muted">{text}</span>
      {children}
    </div>
  );
}

function GeneratorPanel({ opts, onChange }: { opts: GeneratorOptions; onChange: (o: GeneratorOptions) => void }) {
  const toggle = (k: 'upper' | 'lower' | 'digits' | 'symbols') => {
    const next = { ...opts, [k]: !opts[k] };
    if (next.upper || next.lower || next.digits || next.symbols) onChange(next);
  };
  const classes: { key: 'upper' | 'lower' | 'digits' | 'symbols'; label: string }[] = [
    { key: 'upper', label: 'A-Z' },
    { key: 'lower', label: 'a-z' },
    { key: 'digits', label: '0-9' },
    { key: 'symbols', label: '!@#' },
  ];
  return (
    <div className="mt-1.5 rounded-lg bg-surface-2 px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="w-16 shrink-0 whitespace-nowrap tabular-nums">
          {t('editor.length')} {opts.length}
        </span>
        <input
          type="range"
          className="flex-1"
          min={8}
          max={64}
          value={opts.length}
          onChange={(e) => onChange({ ...opts, length: Number(e.target.value) })}
          aria-label={t('editor.length')}
        />
        <button className="icon-btn h-7 w-7" onClick={() => onChange({ ...opts })} title={t('editor.regenerate')}>
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {classes.map((c) => (
          <button
            key={c.key}
            className={`h-7 flex-1 rounded-md font-mono text-xs ${opts[c.key] ? 'bg-accent-soft text-accent' : 'bg-surface text-faint'}`}
            onClick={() => toggle(c.key)}
            aria-pressed={opts[c.key]}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}
