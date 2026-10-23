import { Button } from '../../components/ui';
import { useVault } from '../../hooks/VaultContext';
import { useT } from '../../i18n';
import { mockDev } from '../../api.mock';
import { SettingsSection } from './SettingsModal';

/** Only rendered in the browser (mock) build. */
export function DeveloperTab({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { refreshStatus } = useVault();
  return (
    <SettingsSection title={t('settings.developer')} description={t('dev.intro')} plain>
      <div className="flex flex-wrap gap-2 pt-3">
        <Button onClick={() => { onClose(); mockDev.triggerPairing('Chrome'); }}>{t('dev.pairing')}</Button>
        <Button onClick={() => mockDev.triggerItemsChanged()}>{t('dev.itemsChanged')}</Button>
        <Button onClick={() => mockDev.triggerSyncError()}>{t('dev.syncError')}</Button>
        <Button onClick={() => { onClose(); mockDev.triggerAutoLock(); }}>{t('dev.autoLock')}</Button>
        <Button variant="danger" onClick={() => { mockDev.resetToNoVault(); onClose(); refreshStatus(); }}>
          {t('dev.noVault')}
        </Button>
      </div>
      <p className="pt-4 text-[11px] text-faint">Shortcut: ⌘/Ctrl + Shift + P triggers a pairing request anywhere.</p>
    </SettingsSection>
  );
}
