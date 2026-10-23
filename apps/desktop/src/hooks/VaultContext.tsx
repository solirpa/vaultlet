import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, onEvent } from '../api';
import type { Folder, ItemSummary, Settings, SyncStatus, VaultStatus } from '../types';

interface VaultContextValue {
  status: VaultStatus | null;
  settings: Settings | null;
  items: ItemSummary[];
  folders: Folder[];
  sync: SyncStatus | null;
  loading: boolean;
  refreshStatus: () => Promise<VaultStatus>;
  refreshItems: () => Promise<void>;
  refreshFolders: () => Promise<void>;
  refreshSync: () => Promise<void>;
  saveSettings: (next: Settings) => Promise<void>;
  setSync: (s: SyncStatus) => void;
}

const VaultContext = createContext<VaultContextValue | null>(null);

export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const unlockedRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    const s = await api.vaultStatus();
    setStatus(s);
    unlockedRef.current = s.state === 'unlocked';
    return s;
  }, []);

  const refreshItems = useCallback(async () => {
    if (!unlockedRef.current) return;
    setItems(await api.itemsList());
  }, []);

  const refreshFolders = useCallback(async () => {
    if (!unlockedRef.current) return;
    setFolders(await api.foldersList());
  }, []);

  const refreshSync = useCallback(async () => {
    try {
      setSync(await api.syncStatus());
    } catch {
      /* sync status is best-effort */
    }
  }, []);

  const saveSettings = useCallback(async (next: Settings) => {
    await api.settingsSet(next);
    setSettings(next);
  }, []);

  // Boot: settings first (theme/language), then status.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, st] = await Promise.all([api.settingsGet(), api.vaultStatus()]);
        if (cancelled) return;
        setSettings(s);
        setStatus(st);
        unlockedRef.current = st.state === 'unlocked';
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // When unlocked, load data; when locked, drop it.
  useEffect(() => {
    if (status?.state === 'unlocked') {
      refreshItems();
      refreshFolders();
      refreshSync();
    } else {
      setItems([]);
      setFolders([]);
    }
  }, [status?.state, refreshItems, refreshFolders, refreshSync]);

  // Backend events.
  useEffect(() => {
    const offLocked = onEvent('vault:locked', () => {
      refreshStatus();
    });
    const offChanged = onEvent('items:changed', () => {
      refreshItems();
      refreshFolders();
    });
    const offSync = onEvent('sync:status', (s) => setSync(s));
    return () => {
      offLocked();
      offChanged();
      offSync();
    };
  }, [refreshStatus, refreshItems, refreshFolders]);

  const value = useMemo<VaultContextValue>(
    () => ({
      status,
      settings,
      items,
      folders,
      sync,
      loading,
      refreshStatus,
      refreshItems,
      refreshFolders,
      refreshSync,
      saveSettings,
      setSync,
    }),
    [status, settings, items, folders, sync, loading, refreshStatus, refreshItems, refreshFolders, refreshSync, saveSettings],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error('useVault must be used inside VaultProvider');
  return ctx;
}
