import { useI18n } from '../../i18n';
import { Select, Toggle } from '../../components/ui';
import { resetSiteIcons } from '../../components/SiteIcon';
import { useVault } from '../../hooks/VaultContext';
import { useToast } from '../../hooks/useToast';
import type { Language, Settings, ThemeSetting } from '../../types';
import { errorMessage } from '../../types';
import { SettingsRow, SettingsSection } from './SettingsModal';

export function GeneralTab() {
  const { t, setLang } = useI18n();
  const { settings, saveSettings } = useVault();
  const toast = useToast();
  if (!settings) return null;

  const update = async (patch: (s: Settings) => Settings) => {
    try {
      await saveSettings(patch(settings));
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <>
      <SettingsSection title={t('general.section.display')}>
        <SettingsRow label={t('general.theme')}>
          <Select
            value={settings.ui.theme}
            onChange={(e) => update((s) => ({ ...s, ui: { ...s.ui, theme: e.target.value as ThemeSetting } }))}
          >
            <option value="system">{t('general.theme.system')}</option>
            <option value="light">{t('general.theme.light')}</option>
            <option value="dark">{t('general.theme.dark')}</option>
          </Select>
        </SettingsRow>
        <SettingsRow label={t('general.language')}>
          <Select
            value={settings.ui.language}
            onChange={(e) => {
              const language = e.target.value as Language;
              setLang(language);
              update((s) => ({ ...s, ui: { ...s.ui, language } }));
            }}
          >
            <option value="en">English</option>
            <option value="zh-CN">简体中文</option>
          </Select>
        </SettingsRow>
        <Toggle
          label={t('general.siteIcons')}
          description={t('general.siteIconsDesc')}
          checked={settings.ui.siteIcons !== false}
          onChange={(v) => {
            resetSiteIcons();
            update((s) => ({ ...s, ui: { ...s.ui, siteIcons: v } }));
          }}
        />
      </SettingsSection>

      <SettingsSection title={t('general.section.locking')}>
        <SettingsRow label={t('general.autoLock')}>
          <Select
            value={settings.security.autoLockMinutes}
            onChange={(e) => update((s) => ({ ...s, security: { ...s.security, autoLockMinutes: Number(e.target.value) } }))}
          >
            {[1, 5, 15, 30, 60, 240].map((n) => (
              <option key={n} value={n}>
                {t('general.minutes', { n })}
              </option>
            ))}
            <option value={0}>{t('general.autoLockNever')}</option>
          </Select>
        </SettingsRow>
        <SettingsRow label={t('general.clearClipboard')}>
          <Select
            value={settings.security.clearClipboardSeconds}
            onChange={(e) => update((s) => ({ ...s, security: { ...s.security, clearClipboardSeconds: Number(e.target.value) } }))}
          >
            {[10, 20, 30, 60, 120].map((n) => (
              <option key={n} value={n}>
                {t('general.seconds', { n })}
              </option>
            ))}
            <option value={0}>{t('general.clearClipboardNever')}</option>
          </Select>
        </SettingsRow>
        <Toggle
          label={t('general.lockOnSleep')}
          checked={settings.security.lockOnSleep}
          onChange={(v) => update((s) => ({ ...s, security: { ...s.security, lockOnSleep: v } }))}
        />
      </SettingsSection>
    </>
  );
}
