/** Letter avatars, same scheme as the desktop app (FNV-1a hash of the title → hue). */

export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function avatarHue(title: string): number {
  return hash(title.trim().toLowerCase() || '?') % 360;
}

export function avatarLetter(title: string): string {
  const t = title.trim();
  if (!t) return '?';
  return Array.from(t)[0].toUpperCase();
}

export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
