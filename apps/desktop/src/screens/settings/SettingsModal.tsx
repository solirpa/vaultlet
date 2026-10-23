import { Download, FlaskConical, Globe, HardDrive, Settings2, ShieldCheck, X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { isTauri } from '../../api';
import { Backdrop, IconButton } from '../../components/ui';
import { useT } from '../../i18n';
import { cx } from '../../lib/utils';
import { BrowserTab } from './BrowserTab';
import { DeveloperTab } from './DeveloperTab';
import { GeneralTab } from './GeneralTab';
import { ImportTab } from './ImportTab';
import { SecurityTab } from './SecurityTab';
import { VaultSyncTab } from './VaultSyncTab';

export type SettingsTab = 'general' | 'vault' | 'browser' | 'import' | 'security' | 'developer';

interface SettingsModalProps {
  tab: SettingsTab;
  onTab: (t: SettingsTab) => void;
  onClose: () => void;
}

export function SettingsModal({ tab, onTab, onClose }: SettingsModalProps) {
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tabs: { id: SettingsTab; label: string; icon: ReactNode }[] = [
    { id: 'general', label: t('settings.general'), icon: <Settings2 size={14} /> },
    { id: 'vault', label: t('settings.vaultSync'), icon: <HardDrive size={14} /> },
    { id: 'browser', label: t('settings.browser'), icon: <Globe size={14} /> },
    { id: 'import', label: t('settings.import'), icon: <Download size={14} /> },
    { id: 'security', label: t('settings.security'), icon: <ShieldCheck size={14} /> },
  ];
  if (!isTauri) tabs.push({ id: 'developer', label: t('settings.developer'), icon: <FlaskConical size={14} /> });

  return (
    <Backdrop onClose={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="elev-modal animate-modal flex h-[min(540px,100%)] w-full max-w-[760px] overflow-hidden rounded-[14px]"
      >
        <aside className="flex w-[168px] shrink-0 flex-col bg-bg px-2 py-3">
          <div className="px-2 pt-1 pb-3 text-[15px] font-semibold tracking-[-0.01em]">{t('settings.title')}</div>
          <nav className="space-y-px">
            {tabs.map((tb) => (
              <button
                key={tb.id}
                type="button"
                onClick={() => onTab(tb.id)}
                className={cx(
                  'tr flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  tab === tb.id ? 'bg-accent-soft font-medium text-accent' : 'text-text hover:bg-hover active:bg-pressed',
                )}
              >
                <span className={cx('flex w-4 justify-center', tab === tb.id ? 'text-accent' : 'text-muted')}>{tb.icon}</span>
                <span className="truncate">{tb.label}</span>
              </button>
            ))}
          </nav>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col bg-surface">
          <div className="flex h-14 shrink-0 items-center justify-between pr-3 pl-7">
            <h2 className="text-[17px] font-semibold tracking-[-0.015em]">{tabs.find((x) => x.id === tab)?.label}</h2>
            <IconButton label={t('common.close')} onClick={onClose}>
              <X size={16} />
            </IconButton>
          </div>
          <div className="flex-1 overflow-y-auto px-7 pt-1 pb-7">
            {tab === 'general' && <GeneralTab />}
            {tab === 'vault' && <VaultSyncTab />}
            {tab === 'browser' && <BrowserTab />}
            {tab === 'import' && <ImportTab />}
            {tab === 'security' && <SecurityTab />}
            {tab === 'developer' && <DeveloperTab onClose={onClose} />}
          </div>
        </div>
      </div>
    </Backdrop>
  );
}

/** Label on the left, control on the right. Rows inside a section are separated by hairlines. */
export function SettingsRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-6 py-2">
      <div className="min-w-0">
        <div className="text-[13px]">{label}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      <div className="w-48 shrink-0">{children}</div>
    </div>
  );
}

/**
 * Settings section: a small sentence-case header and whitespace, never a box.
 * Direct children are rows separated by inset hairlines.
 */
export function SettingsSection({
  title,
  children,
  description,
  plain,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Skip hairlines between children (for free-form content). */
  plain?: boolean;
}) {
  return (
    <section className="mb-8 last:mb-0">
      <h3 className="text-[11px] font-semibold text-muted">{title}</h3>
      {description && <p className="mt-1 max-w-[520px] text-[12px] leading-relaxed text-muted">{description}</p>}
      <div className={cx('mt-2', !plain && 'rows')}>{children}</div>
    </section>
  );
}
