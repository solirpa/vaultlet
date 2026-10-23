import { Check, Globe, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { relativeTime } from '../../components/Sidebar';
import { Button, Toggle } from '../../components/ui';
import { useVault } from '../../hooks/VaultContext';
import { useToast } from '../../hooks/useToast';
import { useI18n } from '../../i18n';
import type { BrowserApplyResult, BrowserKey, PairedBrowser } from '../../types';
import { errorMessage } from '../../types';
import { SettingsSection } from './SettingsModal';

const BROWSERS: BrowserKey[] = ['chrome', 'edge', 'brave', 'chromium', 'firefox'];

export function BrowserTab() {
  const { t, lang } = useI18n();
  const { settings, saveSettings } = useVault();
  const toast = useToast();
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<BrowserApplyResult[] | null>(null);
  const [paired, setPaired] = useState<PairedBrowser[]>([]);

  const loadPaired = () => api.pairedBrowsersList().then(setPaired).catch(() => setPaired([]));
  useEffect(() => {
    loadPaired();
  }, []);

  if (!settings) return null;

  const toggle = async (key: BrowserKey, v: boolean) => {
    try {
      await saveSettings({ ...settings, browserIntegration: { ...settings.browserIntegration, [key]: v } });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const apply = async () => {
    setApplying(true);
    try {
      setResults(await api.browserIntegrationApply());
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setApplying(false);
    }
  };

  const remove = async (clientId: string) => {
    try {
      await api.pairedBrowserRemove(clientId);
      await loadPaired();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <>
      <SettingsSection title={t('settings.browser')} description={t('browser.intro')}>
        {BROWSERS.map((b) => (
          <Toggle key={b} label={t(`browser.${b}` as const)} checked={settings.browserIntegration[b]} onChange={(v) => toggle(b, v)} />
        ))}
        <div className="flex items-center gap-3 pt-4">
          <Button variant="primary" onClick={apply} loading={applying}>
            {applying ? t('browser.applying') : t('browser.apply')}
          </Button>
        </div>
      </SettingsSection>

      {results && (
        <SettingsSection title={t('browser.results')}>
          {results.map((r) => (
            <div key={r.browser} className="flex min-h-[36px] items-center gap-2.5 py-1.5 text-xs">
              <span className={r.ok ? 'flex h-5 w-5 items-center justify-center rounded-full bg-success-soft text-success' : 'flex h-5 w-5 items-center justify-center rounded-full bg-danger-soft text-danger'}>
                {r.ok ? <Check size={12} /> : <X size={12} />}
              </span>
              <span className="w-24 font-medium">{r.browser}</span>
              <span className="text-muted">{r.message}</span>
            </div>
          ))}
        </SettingsSection>
      )}

      <SettingsSection title={t('browser.paired')}>
        {paired.length === 0 && <p className="py-2 text-xs text-muted">{t('browser.noPaired')}</p>}
        {paired.map((p) => (
          <div key={p.clientId} className="flex min-h-[52px] items-center gap-3 py-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
              <Globe size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px]">{p.name}</div>
              <div className="truncate font-mono text-[11px] text-faint">
                {t('browser.pairedAt', { time: relativeTime(p.pairedAt, t, lang) })} · {p.clientId}
              </div>
            </div>
            <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={() => remove(p.clientId)}>
              {t('browser.remove')}
            </Button>
          </div>
        ))}
      </SettingsSection>
    </>
  );
}
