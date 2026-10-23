/**
 * Popup clipboard: copying a password schedules a best-effort clear after
 * 30 s (only while the popup is still open). Any later copy cancels it.
 */
import { copyText } from '../shared/useExtensionState';

export const CLEAR_AFTER_MS = 30_000;
let clearTimer: number | undefined;

export async function copy(value: string, opts: { secret?: boolean; onCleared?: () => void } = {}): Promise<boolean> {
  window.clearTimeout(clearTimer);
  clearTimer = undefined;
  const ok = await copyText(value);
  if (ok && opts.secret) {
    clearTimer = window.setTimeout(() => {
      clearTimer = undefined;
      navigator.clipboard
        .writeText('')
        .then(() => opts.onCleared?.())
        .catch(() => {});
    }, CLEAR_AFTER_MS);
  }
  return ok;
}
