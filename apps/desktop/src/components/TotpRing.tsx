import { useEffect, useState } from 'react';
import { api } from '../api';
import type { TotpCode } from '../types';
import { cx } from '../lib/utils';

/** Displays the current TOTP code with a circular countdown; refetches on rollover. */
export function TotpRing({ itemId, onCode }: { itemId: string; onCode?: (code: string) => void }) {
  const [code, setCode] = useState<TotpCode | null>(null);
  const [error, setError] = useState(false);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const fetch = async () => {
      try {
        const c = await api.totpNow(itemId);
        if (cancelled) return;
        setCode(c);
        setRemaining(c.remaining);
        setError(false);
        onCode?.(c.code);
      } catch {
        if (!cancelled) setError(true);
      }
    };

    fetch();
    timer = window.setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          fetch();
          return 0;
        }
        return r - 1;
      });
    }, 1000);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
    // onCode intentionally omitted; callers pass stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  if (error) return <span className="text-xs text-danger">—</span>;
  if (!code) return <span className="font-mono text-[18px] leading-6 text-faint">······</span>;

  const period = code.period || 30;
  const frac = remaining / period;
  const r = 9;
  const circ = 2 * Math.PI * r;
  const urgent = remaining <= 5;
  const pretty = code.code.length === 6 ? `${code.code.slice(0, 3)} ${code.code.slice(3)}` : code.code;

  return (
    <div className="flex items-center gap-3">
      <span className={cx('tr font-mono text-[18px] leading-6 font-medium tracking-[0.08em] tabular-nums', urgent && 'text-danger')}>
        {pretty}
      </span>
      <span className="relative inline-flex h-6 w-6 items-center justify-center" title={`${remaining}s`}>
        <svg width="24" height="24" viewBox="0 0 24 24" className="-rotate-90">
          <circle cx="12" cy="12" r={r} fill="none" stroke="var(--c-hairline-strong)" strokeWidth="2.5" />
          <circle
            cx="12"
            cy="12"
            r={r}
            fill="none"
            stroke={urgent ? 'var(--c-danger)' : 'var(--c-accent)'}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - frac)}
            style={{ transition: 'stroke-dashoffset 1s linear' }}
          />
        </svg>
        <span className="absolute text-[9px] font-medium tabular-nums text-muted">{remaining}</span>
      </span>
    </div>
  );
}
