import { FolderOpen, Import, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, isTauri } from '../api';
import { useT } from '../i18n';
import { useVault } from '../hooks/VaultContext';
import { pickFile } from '../lib/platform';
import { errorMessage } from '../types';
import { Button, ErrorText, FieldLabel, PasswordInput } from '../components/ui';
import { AuthShell, VaultLogo } from './AuthShell';
import { baseName, friendlyLocation } from '../lib/utils';

interface UnlockScreenProps {
  onCreate: (thenImport: boolean) => void;
}

export function UnlockScreen({ onCreate }: UnlockScreenProps) {
  const t = useT();
  const { status, settings, refreshStatus, saveSettings } = useVault();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError('');
    try {
      await api.vaultUnlock({ password });
      await refreshStatus();
    } catch (err) {
      const msg = errorMessage(err);
      setError(/credential|password/i.test(msg) ? t('unlock.wrongPassword') : msg);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const openOther = async () => {
    const path = await pickFile({ title: t('unlock.openOther'), filters: [{ name: 'KeePass', extensions: ['kdbx'] }] });
    if (!path || !settings) return;
    try {
      await saveSettings({ ...settings, vault: { ...settings.vault, mode: 'folder', path } });
      await refreshStatus();
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const name = status?.name ?? (status?.path ? baseName(status.path).replace(/\.kdbx$/i, '') : t('app.name'));

  return (
    <AuthShell
      header={
        <>
          <VaultLogo size={56} />
          <h1 className="mt-4 text-[20px] font-semibold">{name}</h1>
          {status?.path && (
            <p className="mt-1 max-w-[340px] truncate text-[12px] text-muted" title={status.path}>
              {(() => {
                const loc = friendlyLocation(status.path);
                return (
                  <>
                    {loc.place}
                    <span className="mx-1 text-faint">›</span>
                    {loc.file}
                  </>
                );
              })()}
            </p>
          )}
        </>
      }
      footer={
        <div className="flex flex-col items-center gap-0.5">
          <LinkButton icon={<FolderOpen size={14} />} onClick={openOther}>
            {t('unlock.openOther')}
          </LinkButton>
          <LinkButton icon={<Plus size={14} />} onClick={() => onCreate(false)}>
            {t('unlock.createNew')}
          </LinkButton>
          <LinkButton icon={<Import size={14} />} onClick={() => onCreate(true)}>
            {t('unlock.import')}
          </LinkButton>
        </div>
      }
    >
      <form onSubmit={submit}>
        <FieldLabel htmlFor="master">{t('unlock.masterPassword')}</FieldLabel>
        <PasswordInput
          id="master"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          disabled={busy}
          autoComplete="current-password"
          className="[&>input]:h-9"
        />
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="primary" className="mt-4 h-9 w-full" loading={busy} disabled={!password}>
          {busy ? t('unlock.unlocking') : t('unlock.button')}
        </Button>
        {!isTauri && <p className="mt-3 text-center text-[11px] text-faint">{t('unlock.hintMock')}</p>}
      </form>
    </AuthShell>
  );
}

export function LinkButton({ icon, children, onClick }: { icon?: React.ReactNode; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="tr inline-flex h-8 items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-muted hover:bg-hover hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="text-faint">{icon}</span>
      {children}
    </button>
  );
}
