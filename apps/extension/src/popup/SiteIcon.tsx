/**
 * Site icon tile for the popup. Icons come from the background (which asks the
 * app and caches them); nothing is fetched from the network here. Only mounted
 * rows request icons, so this works with the windowed list.
 */
import { useEffect, useState } from 'react';
import { ext, invoke } from '../shared/browser';
import { rpc } from '../shared/rpc';
import { iconHost, isAcceptableIcon, monogram, monogramHue } from '../shared/site-icon';

const ICON_STORAGE_KEY = 'iconCache';
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/** Seed the cache from the background's persisted icons so a reopened popup renders them at once. */
export async function preloadIcons(timeoutMs = 80): Promise<void> {
  const load = invoke<Record<string, unknown>>(ext.storage.local, 'get', ICON_STORAGE_KEY)
    .then((r) => {
      const data = (r?.[ICON_STORAGE_KEY] ?? {}) as Record<string, { d?: unknown }>;
      for (const [host, v] of Object.entries(data)) if (isAcceptableIcon(v?.d)) cache.set(host, v.d);
    })
    .catch(() => {});
  await Promise.race([load, new Promise((r) => setTimeout(r, timeoutMs))]);
}

function request(host: string): Promise<string | null> {
  let p = inflight.get(host);
  if (!p) {
    p = rpc('icon', host)
      .then((d) => (isAcceptableIcon(d) ? d : null))
      .catch(() => null)
      .then((d) => {
        cache.set(host, d);
        inflight.delete(host);
        return d;
      });
    inflight.set(host, p);
  }
  return p;
}

function useIcon(host: string | null): string | null {
  const [src, setSrc] = useState<string | null>(() => (host ? (cache.get(host) ?? null) : null));
  useEffect(() => {
    if (!host) {
      setSrc(null);
      return;
    }
    if (cache.has(host)) {
      setSrc(cache.get(host) ?? null);
      return;
    }
    let alive = true;
    void request(host).then((d) => alive && setSrc(d));
    return () => {
      alive = false;
    };
  }, [host]);
  return src;
}

export function SiteIcon({ title, url, size = 28 }: { title: string; url?: string; size?: number }) {
  const host = iconHost(url);
  const src = useIcon(host);
  const [broken, setBroken] = useState<string | null>(null);
  const radius = Math.round(size / 4);
  if (src && broken !== src) {
    const img = Math.round(size * (20 / 28));
    return (
      <span className="site-icon" style={{ width: size, height: size, borderRadius: radius }} aria-hidden="true">
        <img src={src} width={img} height={img} alt="" draggable={false} onError={() => setBroken(src)} />
      </span>
    );
  }
  return (
    <span
      className="monogram"
      aria-hidden="true"
      style={
        {
          '--mono-h': String(monogramHue(title)),
          width: size,
          height: size,
          borderRadius: radius,
          fontSize: Math.round(size * 0.46),
        } as React.CSSProperties
      }
    >
      {monogram(title)}
    </span>
  );
}
