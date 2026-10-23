import { useEffect, useState } from 'react';
import { isTauri, onEvent } from './api';
import { mockDev } from './api.mock';
import { PairingDialog } from './components/PairingDialog';
import { Spinner } from './components/ui';
import { useTheme } from './hooks/useTheme';
import { useToast } from './hooks/useToast';
import { useVault } from './hooks/VaultContext';
import { useI18n } from './i18n';
import { CreateVaultScreen } from './screens/CreateVaultScreen';
import { FirstRunScreen } from './screens/FirstRunScreen';
import { MainScreen } from './screens/MainScreen';
import type { SettingsTab } from './screens/settings/SettingsModal';
import { UnlockScreen } from './screens/UnlockScreen';

type Route = { name: 'auto' } | { name: 'create'; thenImport: boolean };

export function App() {
  const { status, settings, loading } = useVault();
  const { t, setLang } = useI18n();
  const toast = useToast();
  const [route, setRoute] = useState<Route>({ name: 'auto' });
  const [initialTab, setInitialTab] = useState<SettingsTab | undefined>(undefined);

  useTheme(settings?.ui.theme ?? 'system');

  // Language follows settings once loaded.
  useEffect(() => {
    if (settings?.ui.language) setLang(settings.ui.language);
  }, [settings?.ui.language, setLang]);

  // Toasts for background events.
  useEffect(() => {
    const offLocked = onEvent('vault:locked', () => toast(t('toast.locked')));
    const offChanged = onEvent('items:changed', () => toast(t('toast.itemsChanged')));
    return () => {
      offLocked();
      offChanged();
    };
  }, [toast, t]);

  // Dev shortcut in the browser mock: Cmd/Ctrl+Shift+P fires a pairing request.
  useEffect(() => {
    if (isTauri) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        mockDev.triggerPairing('Chrome');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Leaving the create flow once the vault is unlocked.
  useEffect(() => {
    if (status?.state === 'unlocked' && route.name === 'create') setRoute({ name: 'auto' });
  }, [status?.state, route.name]);

  if (loading || !status) {
    return (
      <div className="flex h-full items-center justify-center bg-bg">
        <Spinner />
      </div>
    );
  }

  let screen: React.ReactNode;
  if (route.name === 'create') {
    screen = (
      <CreateVaultScreen
        thenImport={route.thenImport}
        onBack={() => setRoute({ name: 'auto' })}
        onCreated={() => {
          if (route.thenImport) setInitialTab('import');
          setRoute({ name: 'auto' });
        }}
      />
    );
  } else if (status.state === 'unlocked') {
    screen = <MainScreen key={initialTab ?? 'main'} initialSettingsTab={initialTab} />;
  } else if (status.state === 'no-vault') {
    screen = <FirstRunScreen onCreate={(thenImport) => setRoute({ name: 'create', thenImport })} />;
  } else {
    screen = <UnlockScreen onCreate={(thenImport) => setRoute({ name: 'create', thenImport })} />;
  }

  return (
    <>
      {screen}
      <PairingDialog />
    </>
  );
}
