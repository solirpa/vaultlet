import { ArrowLeft, Check, Cloud, FolderOpen, Server } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { useVault } from '../hooks/VaultContext';
import { pickDirectory } from '../lib/platform';
import { cx, friendlyLocation, joinPath, tildePath } from '../lib/utils';
import type { CloudFolder } from '../types';
import { isApiError } from '../types';
import { errorMessage } from '../types';
import { PasswordStrength } from '../components/PasswordStrength';
import { Button, ErrorText, FieldLabel, Input, PasswordInput, Spinner, tileCls } from '../components/ui';
import { AuthShell, VaultLogo } from './AuthShell';

interface CreateVaultScreenProps {
  thenImport: boolean;
  onBack: () => void;
  onCreated: () => void;
}

const JIANGUOYUN_URL = 'https://dav.jianguoyun.com/dav/';

export function CreateVaultScreen({ thenImport, onBack, onCreated }: CreateVaultScreenProps) {
  const t = useT();
  const { settings, saveSettings, refreshStatus } = useVault();
  const [clouds, setClouds] = useState<CloudFolder[] | null>(null);
  const [dir, setDir] = useState('');
  const [fileName, setFileName] = useState('Vaultlet.kdbx');
  const [name, setName] = useState('Vaultlet');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [storage, setStorage] = useState<'folder' | 'webdav'>('folder');
  const [webdav, setWebdav] = useState({ url: '', username: '', remotePath: '/Vaultlet/Vaultlet.kdbx' });
  const [webdavPw, setWebdavPw] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [remoteExists, setRemoteExists] = useState(false);

  useEffect(() => {
    api
      .cloudFoldersDetect()
      .then((c) => {
        setClouds(c);
        if (c.length && !dir) setDir(c[0].path);
      })
      .catch(() => setClouds([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const path = dir ? joinPath(dir, fileName.endsWith('.kdbx') ? fileName : `${fileName}.kdbx`) : '';
  const mismatch = pw2.length > 0 && pw !== pw2;
  const tooShort = pw.length > 0 && pw.length < 8;
  const webdavReady = !!webdav.url.trim() && !!webdav.username.trim() && !!webdavPw && !!webdav.remotePath.trim();
  const locationReady = storage === 'folder' ? !!path : webdavReady;
  const canSubmit = locationReady && pw.length >= 8 && pw === pw2 && !busy;

  const applyWebdavSettings = async () => {
    if (!settings) return;
    await saveSettings({ ...settings, vault: { ...settings.vault, mode: 'webdav', webdav } });
    await api.webdavSetPassword(webdavPw);
  };

  const testWebdav = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.webdavTest({ url: webdav.url, username: webdav.username, password: webdavPw }));
    } catch (err) {
      setTestResult({ ok: false, message: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  const openExisting = async () => {
    setBusy(true);
    try {
      await applyWebdavSettings();
      await refreshStatus();
      onBack();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      if (storage === 'webdav') {
        await applyWebdavSettings();
        await api.vaultCreate({ path: '', password: pw, name: name.trim() || 'Vaultlet' });
      } else {
        if (settings) await saveSettings({ ...settings, vault: { ...settings.vault, mode: 'folder', path } });
        await api.vaultCreate({ path, password: pw, name: name.trim() || 'Vaultlet' });
      }
      await refreshStatus();
      onCreated();
    } catch (err) {
      if (storage === 'webdav' && isApiError(err) && err.code === 'already-exists') {
        setRemoteExists(true);
        setError(t('create.webdav.exists'));
      } else {
        setError(errorMessage(err));
      }
      setBusy(false);
    }
  };

  return (
    <AuthShell
      width="max-w-[460px]"
      header={
        <>
          <VaultLogo size={48} />
          <h1 className="mt-3 text-[20px] font-semibold">{t('create.title')}</h1>
          {thenImport && (
            <p className="mt-2 rounded-full bg-accent-soft px-3 py-1 text-[11.5px] font-medium text-accent">{t('create.nextImport')}</p>
          )}
        </>
      }
      toolbar={
        <Button variant="subtle" size="sm" pill icon={<ArrowLeft size={13} />} onClick={onBack} className="pl-2">
          {t('common.back')}
        </Button>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        <div>
          <FieldLabel>{t('create.storage')}</FieldLabel>
          <div className="grid grid-cols-2 gap-2">
            <Tile
              icon={<Cloud size={16} />}
              title={t('create.storage.folder')}
              desc={t('create.storage.folderDesc')}
              selected={storage === 'folder'}
              onClick={() => setStorage('folder')}
            />
            <Tile
              icon={<Server size={16} />}
              title={t('create.storage.webdav')}
              desc={t('create.storage.webdavDesc')}
              selected={storage === 'webdav'}
              onClick={() => setStorage('webdav')}
            />
          </div>
        </div>

        {storage === 'folder' ? (
          <div>
            <FieldLabel>{t('create.location')}</FieldLabel>
            {clouds === null ? (
              <div className="flex h-12 items-center gap-2 text-xs text-muted">
                <Spinner /> {t('create.detecting')}
              </div>
            ) : (
              <div className="space-y-1.5">
                {clouds.length === 0 && <p className="text-xs text-muted">{t('create.noCloud')}</p>}
                {clouds.map((c) => (
                  <LocationTile
                    key={c.path}
                    icon={<Cloud size={15} />}
                    title={t(`cloud.${c.provider}` as const)}
                    path={c.path}
                    selected={dir === c.path}
                    onClick={() => setDir(c.path)}
                  />
                ))}
                {dir && !clouds.some((c) => c.path === dir) && (
                  <LocationTile icon={<FolderOpen size={15} />} title={t('common.folder')} path={dir} selected onClick={() => undefined} />
                )}
                <button
                  type="button"
                  className="tr flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-left text-[12.5px] text-muted hover:bg-surface-2 hover:text-text"
                  onClick={async () => {
                    const d = await pickDirectory({ title: t('create.pickFolder') });
                    if (d) setDir(d);
                  }}
                >
                  <FolderOpen size={15} className="text-faint" />
                  {t('create.pickFolder')}
                </button>
              </div>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-faint">{t('create.locationHint')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <FieldLabel>{t('vault.webdav.url')}</FieldLabel>
              <div className="flex gap-2">
                <Input
                  className="flex-1"
                  value={webdav.url}
                  onChange={(e) => setWebdav({ ...webdav, url: e.target.value })}
                  placeholder="https://dav.jianguoyun.com/dav/"
                  spellCheck={false}
                />
                <Button onClick={() => setWebdav({ ...webdav, url: JIANGUOYUN_URL })}>{t('vault.webdav.preset.jianguoyun')}</Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel>{t('vault.webdav.username')}</FieldLabel>
                <Input value={webdav.username} onChange={(e) => setWebdav({ ...webdav, username: e.target.value })} spellCheck={false} autoComplete="off" />
              </div>
              <div>
                <FieldLabel>{t('create.webdav.appPassword')}</FieldLabel>
                <PasswordInput value={webdavPw} onChange={(e) => setWebdavPw(e.target.value)} autoComplete="off" />
              </div>
            </div>
            <p className="-mt-1 text-[11px] text-faint">{t('vault.webdav.passwordHint')}</p>
            <div>
              <FieldLabel>{t('vault.webdav.remotePath')}</FieldLabel>
              <Input value={webdav.remotePath} onChange={(e) => setWebdav({ ...webdav, remotePath: e.target.value })} spellCheck={false} />
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={testWebdav} loading={testing} disabled={!webdav.url || !webdav.username || !webdavPw}>
                {testing ? t('vault.webdav.testing') : t('vault.webdav.test')}
              </Button>
              {testResult && (
                <span className={cx('text-xs', testResult.ok ? 'text-success' : 'text-danger')}>{testResult.message}</span>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          {storage === 'folder' && (
            <div>
              <FieldLabel>{t('create.fileName')}</FieldLabel>
              <Input value={fileName} onChange={(e) => setFileName(e.target.value)} spellCheck={false} />
            </div>
          )}
          <div>
            <FieldLabel>{t('create.vaultName')}</FieldLabel>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        {storage === 'folder' && path && (
          <p className="selectable -mt-3 truncate text-[11px] text-faint" title={path}>
            {t('create.willCreate', { path: (({ place, file }) => `${place} › ${file}`)(friendlyLocation(path)) })}
          </p>
        )}
        {storage === 'webdav' && webdavReady && (
          <p className="selectable -mt-3 truncate text-[11px] text-faint">{t('create.willUpload', { path: webdav.remotePath })}</p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>{t('create.masterPassword')}</FieldLabel>
            <PasswordInput value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
            <ErrorText>{tooShort ? t('create.tooShort') : ''}</ErrorText>
          </div>
          <div>
            <FieldLabel>{t('create.confirmPassword')}</FieldLabel>
            <PasswordInput value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
            <ErrorText>{mismatch ? t('create.mismatch') : ''}</ErrorText>
          </div>
        </div>
        <div className="-mt-3">
          <PasswordStrength password={pw} />
        </div>

        <ErrorText>{error}</ErrorText>
        {remoteExists && (
          <Button variant="primary" className="h-9 w-full" onClick={openExisting} loading={busy}>
            {t('create.webdav.openExisting')}
          </Button>
        )}
        <Button type="submit" variant="primary" className="h-9 w-full" disabled={!canSubmit} loading={busy && !remoteExists}>
          {busy ? t('create.creating') : !locationReady ? (storage === 'folder' ? t('create.noLocation') : t('create.webdav.incomplete')) : t('create.button')}
        </Button>
      </form>
    </AuthShell>
  );
}

function LocationTile({ icon, title, path, selected, onClick }: { icon: React.ReactNode; title: string; path: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cx(tileCls(selected), 'flex w-full items-center gap-3 px-3 py-2')}>
      <span className={selected ? 'text-accent' : 'text-muted'}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="block truncate text-[11px] text-faint" title={path}>
          {tildePath(path)}
        </span>
      </span>
      {selected && (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg">
          <Check size={11} strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

function Tile({ icon, title, desc, selected, onClick }: { icon: React.ReactNode; title: string; desc: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cx(tileCls(selected), 'flex flex-col items-start gap-2 px-3.5 py-3')}>
      <span className={cx('flex h-7 w-7 items-center justify-center rounded-lg', selected ? 'bg-accent text-accent-fg' : 'bg-surface-3 text-muted')}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="block text-[11px] leading-snug text-muted">{desc}</span>
      </span>
    </button>
  );
}
