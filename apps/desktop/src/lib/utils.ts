import type { Item, ItemKind, ItemSummary } from '../types';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Stable 32-bit hash of a string (FNV-1a). */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Avatar hue derived from the title; the `.avatar` CSS class turns it into theme-aware colors. */
export function avatarStyle(title: string): React.CSSProperties {
  const hue = hash(title.trim().toLowerCase() || '?') % 360;
  return { '--avatar-h': String(hue) } as React.CSSProperties;
}

export function avatarLetter(title: string): string {
  const t = title.trim();
  if (!t) return '?';
  const first = Array.from(t)[0];
  return first.toUpperCase();
}

/** Fuzzy-ish match score. 0 = no match; higher is better. */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  if (!s) return 0;
  if (s === q) return 100;
  if (s.startsWith(q)) return 80;
  const idx = s.indexOf(q);
  if (idx >= 0) return 60 - Math.min(idx, 30) / 2;
  // subsequence match: every query char appears in order
  let qi = 0;
  let gaps = 0;
  let last = -1;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) {
      if (last >= 0 && i - last > 1) gaps += i - last - 1;
      last = i;
      qi++;
    }
  }
  if (qi < q.length) return 0;
  return Math.max(1, 30 - gaps);
}

export function searchItems<T extends ItemSummary>(items: T[], query: string): T[] {
  const q = query.trim();
  if (!q) return items;
  const words = q.split(/\s+/);
  const scored = items
    .map((it) => {
      const hay = [it.title, it.username, ...it.urls.map(hostOf), ...it.tags];
      let total = 0;
      for (const w of words) {
        const best = Math.max(0, ...hay.map((h) => fuzzyScore(w, h)));
        if (best === 0) return { it, score: 0 };
        total += best;
      }
      return { it, score: total };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.it.title.localeCompare(b.it.title));
  return scored.map((x) => x.it);
}

export function hostOf(url: string): string {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
    return u.host;
  } catch {
    return url;
  }
}

export function normalizeUrl(url: string): string {
  const u = url.trim();
  if (!u) return u;
  return /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`;
}

export function formatDateTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export function formatDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(d);
}

/** Rough password strength, 0..4. Not zxcvbn, but good enough for a meter. */
export function passwordStrength(pw: string): number {
  if (!pw) return 0;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  const uniq = new Set(pw).size;
  const bits = pw.length * Math.log2(Math.max(pool, 2)) * Math.min(1, uniq / Math.max(4, pw.length * 0.6));
  if (/^(.)\1+$/.test(pw) || /^(1234|password|qwerty|abcd)/i.test(pw)) return 0;
  if (bits < 28) return 0;
  if (bits < 40) return 1;
  if (bits < 60) return 2;
  if (bits < 80) return 3;
  return 4;
}

export const CARD_FIELDS = ['cardholderName', 'number', 'brand', 'expMonth', 'expYear', 'code'] as const;
export const CARD_PROTECTED = new Set<string>(['number', 'code']);

export const IDENTITY_FIELDS = [
  'firstName',
  'middleName',
  'lastName',
  'company',
  'email',
  'phone',
  'address1',
  'address2',
  'address3',
  'city',
  'state',
  'postalCode',
  'country',
  'ssn',
  'passportNumber',
  'licenseNumber',
] as const;
export const IDENTITY_PROTECTED = new Set<string>(['ssn', 'passportNumber', 'licenseNumber']);

export function structuredFieldNames(kind: ItemKind): readonly string[] {
  if (kind === 'card') return CARD_FIELDS;
  if (kind === 'identity') return IDENTITY_FIELDS;
  return [];
}

export function emptyItem(kind: ItemKind, folder: string | null = null): Item {
  const ts = new Date().toISOString();
  return {
    id: '',
    kind,
    title: '',
    username: '',
    password: '',
    urls: kind === 'login' ? [''] : [],
    totp: null,
    notes: '',
    fields: [],
    folder,
    favorite: false,
    tags: [],
    created: ts,
    modified: ts,
    lastUsed: null,
    deleted: false,
  };
}

export function fieldValue(item: Pick<Item, 'fields'>, name: string): string {
  return item.fields.find((f) => f.name === name)?.value ?? '';
}

export function joinPath(dir: string, file: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + file;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function dirName(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx > 0 ? path.slice(0, idx) : path;
}

/**
 * Human-friendly location of a vault: well-known cloud folders by name, the home directory as
 * "~", WebDAV URLs as host + path. Returns the place and the file name separately.
 */
export function friendlyLocation(path: string): { place: string; file: string; cloud?: 'icloud' | 'dropbox' | 'onedrive' | 'webdav' } {
  if (/^https?:\/\//i.test(path)) {
    try {
      const u = new URL(path);
      const parts = decodeURIComponent(u.pathname).split('/').filter(Boolean);
      const file = parts.pop() ?? '';
      return { place: u.host, file, cloud: 'webdav' };
    } catch {
      return { place: path, file: '' };
    }
  }
  const file = baseName(path);
  const dir = dirName(path);
  const icloud = dir.match(/\/Library\/Mobile Documents\/com~apple~CloudDocs(\/.*)?$/);
  if (icloud) return { place: 'iCloud' + (icloud[1] ?? ''), file, cloud: 'icloud' };
  const onedrive = dir.match(/\/Library\/CloudStorage\/OneDrive[^/]*(\/.*)?$/) ?? dir.match(/[\\/]OneDrive[^\\/]*([\\/].*)?$/);
  if (onedrive) return { place: 'OneDrive' + (onedrive[1] ?? ''), file, cloud: 'onedrive' };
  const dropbox = dir.match(/[\\/]Dropbox([\\/].*)?$/);
  if (dropbox) return { place: 'Dropbox' + (dropbox[1] ?? ''), file, cloud: 'dropbox' };
  const home = dir.match(/^(\/Users\/[^/]+|\/home\/[^/]+)(.*)$/);
  if (home) return { place: '~' + home[2], file };
  return { place: dir, file };
}

/** Shorten the home directory to "~" for display. */
export function tildePath(path: string): string {
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, '~');
}
