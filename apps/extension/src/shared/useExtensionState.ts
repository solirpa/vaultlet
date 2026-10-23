import { useCallback, useEffect, useState } from 'react';
import { ext } from './browser';
import { isStateBroadcast, rpc, type ExtensionState } from './rpc';
import type { PushEventName } from './protocol';

/** Subscribe to the background's state (initial fetch + broadcasts). */
export function useExtensionState(onEvent?: (event: PushEventName) => void) {
  const [state, setState] = useState<ExtensionState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await rpc('getState'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const reconnect = useCallback(async () => {
    try {
      setState(await rpc('reconnect'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const listener = (message: unknown) => {
      if (isStateBroadcast(message)) {
        setState(message.state);
        if (message.event && onEvent) onEvent(message.event);
      }
    };
    ext.runtime.onMessage.addListener(listener);
    return () => ext.runtime.onMessage.removeListener(listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  return { state, error, refresh, reconnect, setState };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for contexts where the async clipboard API is unavailable.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
