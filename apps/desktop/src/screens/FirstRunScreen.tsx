import { ChevronRight, FolderOpen, Import, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { useVault } from '../hooks/VaultContext';
import { pickFile } from '../lib/platform';
import { errorMessage } from '../types';
import { ErrorText } from '../components/ui';
import { cx } from '../lib/utils';
import { AuthShell, VaultLogo } from './AuthShell';

export function FirstRunScreen({ onCreate }: { onCreate: (thenImport: boolean) => void }) {
  const t = useT();
  const { settings, saveSettings, refreshStatus } = useVault();
  const [error, setError] = useState('');

  const openExisting = async () => {
    const path = await pickFile({ title: t('firstRun.open'), filters: [{ name: 'KeePass', extensions: ['kdbx'] }] });
    if (!path || !settings) return;
    try {
      await saveSettings({ ...settings, vault: { ...settings.vault, mode: 'folder', path } });
      await refreshStatus();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <AuthShell
      width="max-w-[468px]"
      header={
        <>
          <VaultLogo size={60} />
          <h1 className="mt-4 text-[22px] font-semibold">{t('firstRun.welcome')}</h1>
          <p className="mt-1.5 max-w-[380px] text-[12.5px] leading-relaxed text-muted">{t('firstRun.subtitle')}</p>
        </>
      }
    >
      <div className="-m-2 space-y-1">
        <Option icon={<Plus size={16} />} title={t('firstRun.create')} desc={t('firstRun.createDesc')} onClick={() => onCreate(false)} primary />
        <Option icon={<FolderOpen size={16} />} title={t('firstRun.open')} desc={t('firstRun.openDesc')} onClick={openExisting} />
        <Option icon={<Import size={16} />} title={t('firstRun.import')} desc={t('firstRun.importDesc')} onClick={() => onCreate(true)} />
      </div>
      <ErrorText>{error}</ErrorText>
    </AuthShell>
  );
}

function Option({ icon, title, desc, onClick, primary }: { icon: ReactNode; title: string; desc: string; onClick: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="tr group flex w-full items-center gap-3.5 rounded-2xl px-3.5 py-3 text-left hover:bg-surface-2 active:bg-surface-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className={cx(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
          primary ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-muted group-hover:bg-surface-3',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="block text-[11.5px] text-muted">{desc}</span>
      </span>
      <ChevronRight size={15} className="text-faint" />
    </button>
  );
}
