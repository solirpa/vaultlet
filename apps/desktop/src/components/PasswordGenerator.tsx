import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import type { PasswordGenerateOptions } from '../types';
import { cx } from '../lib/utils';
import { Button, IconButton } from './ui';

const STORAGE_KEY = 'vaultlet.generator';

function loadOpts(): PasswordGenerateOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { length: 20, upper: true, lower: true, digits: true, symbols: true, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { length: 20, upper: true, lower: true, digits: true, symbols: true };
}

export function PasswordGenerator({ onUse, onClose }: { onUse: (pw: string) => void; onClose: () => void }) {
  const t = useT();
  const [opts, setOpts] = useState<PasswordGenerateOptions>(loadOpts);
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const generate = useCallback(async (o: PasswordGenerateOptions) => {
    try {
      setPw(await api.passwordGenerate(o));
      setError('');
    } catch (e) {
      setError(String((e as { message?: string }).message ?? e));
    }
  }, []);

  useEffect(() => {
    generate(opts);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(opts));
    } catch {
      /* ignore */
    }
  }, [opts, generate]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const classes: { key: keyof Omit<PasswordGenerateOptions, 'length'>; label: string }[] = [
    { key: 'upper', label: t('gen.upper') },
    { key: 'lower', label: t('gen.lower') },
    { key: 'digits', label: t('gen.digits') },
    { key: 'symbols', label: t('gen.symbols') },
  ];

  return (
    <div
      ref={ref}
      className="elev-pop animate-pop absolute top-full right-0 z-30 mt-1.5 w-80 rounded-2xl p-4"
    >
      <div className="mb-2.5 text-[11px] font-semibold text-muted">{t('gen.title')}</div>
      <div className="flex items-center gap-1 rounded-xl bg-surface-2 py-2 pr-1.5 pl-3">
        <code className="selectable min-w-0 flex-1 font-mono text-[13px] break-all">{pw || '…'}</code>
        <IconButton label={t('gen.regenerate')} size="sm" onClick={() => generate(opts)}>
          <RefreshCw size={13} />
        </IconButton>
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      <div className="mt-4 flex items-center gap-2.5">
        <span className="w-12 text-xs text-muted">{t('gen.length')}</span>
        <input
          type="range"
          min={8}
          max={64}
          value={opts.length}
          onChange={(e) => setOpts({ ...opts, length: Number(e.target.value) })}
          className="flex-1"
        />
        <span className="w-6 text-right font-mono text-xs tabular-nums">{opts.length}</span>
      </div>
      <div className="mt-3 flex gap-1.5">
        {classes.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setOpts({ ...opts, [c.key]: !opts[c.key] })}
            className={cx(
              'tr h-7 flex-1 rounded-lg font-mono text-xs',
              opts[c.key] ? 'bg-accent-soft font-medium text-accent shadow-[inset_0_0_0_1px_var(--c-ring-soft)]' : 'bg-surface-2 text-muted hover:bg-surface-3',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant="primary" disabled={!pw} onClick={() => onUse(pw)}>
          {t('gen.use')}
        </Button>
      </div>
    </div>
  );
}
