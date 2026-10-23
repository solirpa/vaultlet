/** Helpers shared by the popup (React) and content-script (DOM) site icons. */
import { avatarHue } from './avatar';

/** Hue for the monogram gradient (same hash as the desktop app). */
export const monogramHue = avatarHue;

/** Host to ask the app for, or null for non-web URLs (androidapp://, ssh://, …). */
export function iconHost(url: string | undefined | null): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return normalizeHost(u.host);
}

/** Lower-cased host[:port]; null when it does not look like a host name. */
export function normalizeHost(host: string | undefined | null): string | null {
  const h = (host ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!h || h.length > 253) return null;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/.test(h) || /^\[[0-9a-f:.]+\](:\d{1,5})?$/.test(h) ? h : null;
}

/** First letter or digit of the title (any script, so CJK titles get their first character). */
export function monogram(title: string): string {
  const chars = Array.from(title.trim());
  const first = chars.find((c) => /[\p{L}\p{N}]/u.test(c)) ?? chars[0];
  return first ? first.toLocaleUpperCase() : '?';
}

/** Only raster/svg images as data: URLs, bounded in size. */
export function isAcceptableIcon(dataUrl: unknown): dataUrl is string {
  return (
    typeof dataUrl === 'string' &&
    dataUrl.length <= 256 * 1024 &&
    /^data:image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml|bmp|avif)[;,]/i.test(dataUrl)
  );
}
