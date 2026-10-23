// Thin wrappers over Tauri plugins with browser fallbacks so the UI runs in
// a plain browser during development.
import { isTauri } from '../api';

export async function pickFile(opts: {
  title?: string;
  filters?: { name: string; extensions: string[] }[];
  defaultPath?: string;
}): Promise<string | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const res = await open({ multiple: false, directory: false, ...opts });
    return typeof res === 'string' ? res : null;
  }
  const v = window.prompt(`${opts.title ?? 'File path'}`, opts.defaultPath ?? '~/Downloads/bitwarden_export.json');
  return v && v.trim() ? v.trim() : null;
}

export async function pickDirectory(opts: { title?: string; defaultPath?: string }): Promise<string | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const res = await open({ multiple: false, directory: true, ...opts });
    return typeof res === 'string' ? res : null;
  }
  const v = window.prompt(`${opts.title ?? 'Folder path'}`, opts.defaultPath ?? '~/Documents');
  return v && v.trim() ? v.trim() : null;
}

export async function openExternal(url: string): Promise<void> {
  if (isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export const isMac: boolean =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);
