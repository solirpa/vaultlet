/**
 * Site icon tile for the inline menu and save card (DOM, inside the closed
 * shadow root). Icons come from the background RPC, never from the page or
 * the network; the monogram shows until (and unless) one arrives.
 */
import { rpc } from '../../shared/rpc';
import { iconHost, isAcceptableIcon, monogram, monogramHue } from '../../shared/site-icon';
import { h } from './host';

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

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

export function siteIcon(title: string, url: string | null | undefined, size: number): HTMLElement {
  const tile = h('div', 'monogram', monogram(title));
  const radius = `${Math.round(size / 4)}px`;
  tile.style.cssText = `width:${size}px;height:${size}px;border-radius:${radius};font-size:${Math.round(size * 0.46)}px;`;
  tile.style.setProperty('--mono-h', String(monogramHue(title)));
  const host = iconHost(url);
  if (!host) return tile;
  const show = (src: string | null) => {
    if (!src || !tile.isConnected) return;
    const img = h('img');
    const px = Math.round(size * (20 / 28));
    img.width = px;
    img.height = px;
    img.alt = '';
    img.draggable = false;
    img.addEventListener('load', () => {
      tile.className = 'site-icon';
      tile.replaceChildren(img);
    });
    img.src = src; // swapped in only once decoded; on error the monogram stays
  };
  if (cache.has(host)) queueMicrotask(() => show(cache.get(host) ?? null));
  else void request(host).then(show);
  return tile;
}
