import { useCallback } from 'react';
import { useToast } from './useToast';
import { useT } from '../i18n';
import { useVault } from './VaultContext';

let clearTimer: number | null = null;

/** Copy to clipboard with toast, and schedule a clipboard wipe per settings. */
export function useCopy(): (value: string, label?: string) => Promise<void> {
  const toast = useToast();
  const t = useT();
  const { settings } = useVault();
  const seconds = settings?.security.clearClipboardSeconds ?? 0;

  return useCallback(
    async (value: string, label?: string) => {
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        // Fallback for insecure contexts: a hidden textarea.
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      const prefix = label ? `${label}: ` : '';
      toast(prefix + (seconds > 0 ? t('common.copiedWillClear', { s: seconds }) : t('common.copied')), 'success');
      if (clearTimer) window.clearTimeout(clearTimer);
      if (seconds > 0) {
        clearTimer = window.setTimeout(() => {
          navigator.clipboard.writeText('').catch(() => undefined);
        }, seconds * 1000);
      }
    },
    [seconds, t, toast],
  );
}
