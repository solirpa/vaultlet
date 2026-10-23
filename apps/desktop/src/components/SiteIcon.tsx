import { CreditCard, StickyNote, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useVault } from '../hooks/VaultContext';
import { avatarLetter, cx, hash } from '../lib/utils';
import type { ItemKind } from '../types';

// ---- icon cache -----------------------------------------------------------------------------
// One lookup per host for the lifetime of the window; at most 6 requests to the backend at once.

const cache = new Map<string, string | null>();
const waiting = new Map<string, Array<(v: string | null) => void>>();
const queue: string[] = [];
let active = 0;

function pump() {
  while (active < 6 && queue.length) {
    const host = queue.shift()!;
    active++;
    api
      .iconGet(host)
      .catch(() => null)
      .then((v) => {
        cache.set(host, v ?? null);
        waiting.get(host)?.forEach((cb) => cb(v ?? null));
        waiting.delete(host);
      })
      .finally(() => {
        active--;
        pump();
      });
  }
}

function requestIcon(host: string, cb: (v: string | null) => void): () => void {
  const list = waiting.get(host);
  if (list) list.push(cb);
  else {
    waiting.set(host, [cb]);
    queue.push(host);
    pump();
  }
  return () => {
    const l = waiting.get(host);
    if (l) waiting.set(host, l.filter((x) => x !== cb));
  };
}

/** Forget cached icons (after the user toggles the setting). */
export function resetSiteIcons() {
  cache.clear();
}

function webHost(url: string | undefined): string | null {
  if (!url) return null;
  const s = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return null; // androidapp:// etc.
  try {
    const h = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase();
    return h.includes('.') ? h : null;
  } catch {
    return null;
  }
}

function useSiteIcon(host: string | null, enabled: boolean): string | null {
  const [icon, setIcon] = useState<string | null>(() => (host && enabled ? cache.get(host) ?? null : null));
  useEffect(() => {
    if (!host || !enabled) {
      setIcon(null);
      return;
    }
    if (cache.has(host)) {
      setIcon(cache.get(host) ?? null);
      return;
    }
    setIcon(null);
    return requestIcon(host, setIcon);
  }, [host, enabled]);
  return icon;
}

// ---- component ------------------------------------------------------------------------------

const KIND_TILE: Record<Exclude<ItemKind, 'login'>, { icon: typeof CreditCard; hue: number }> = {
  card: { icon: CreditCard, hue: 32 },
  note: { icon: StickyNote, hue: 48 },
  identity: { icon: UserRound, hue: 190 },
};

/**
 * Item avatar: the website's own icon when available, otherwise a gradient monogram; cards,
 * notes and identities get a type glyph.
 */
export function SiteIcon({ title, url, kind, size = 28 }: { title: string; url?: string; kind: ItemKind; size?: number }) {
  const { settings } = useVault();
  const enabled = settings?.ui.siteIcons !== false;
  const host = kind === 'login' ? webHost(url) : null;
  const icon = useSiteIcon(host, enabled);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [icon]);
  const radius = Math.round(size * 0.27);
  const box = { width: size, height: size, borderRadius: radius };

  if (icon && !broken) {
    return (
      <span className="site-icon-tile flex shrink-0 items-center justify-center overflow-hidden" style={box}>
        <img src={icon} alt="" draggable={false} onError={() => setBroken(true)} style={{ width: Math.round(size * 0.68), height: Math.round(size * 0.68) }} className="object-contain" />
      </span>
    );
  }

  if (kind !== 'login') {
    const { icon: Glyph, hue } = KIND_TILE[kind];
    return (
      <span className="monogram flex shrink-0 items-center justify-center" style={{ ...box, '--mono-h': String(hue) } as React.CSSProperties}>
        <Glyph size={Math.round(size * 0.52)} strokeWidth={2} />
      </span>
    );
  }

  const hue = hash(title.trim().toLowerCase() || '?') % 360;
  return (
    <span
      className={cx('monogram flex shrink-0 items-center justify-center font-semibold')}
      style={{ ...box, fontSize: Math.round(size * 0.46), '--mono-h': String(hue) } as React.CSSProperties}
    >
      {avatarLetter(title)}
    </span>
  );
}
