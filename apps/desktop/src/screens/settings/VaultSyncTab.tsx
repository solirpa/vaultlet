import { AlertTriangle, Check, Cloud, FileText, FolderOpen, RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { relativeTime } from '../../components/Sidebar';
import { Button, FieldLabel, Input, PasswordInput, StatusPill, tileCls } from '../../components/ui';
import { useVault } from '../../hooks/VaultContext';
import { useToast } from '../../hooks/useToast';
import { useI18n } from '../../i18n';
import { pickFile } from '../../lib/platform';
import { cx, dirName, friendlyLocation, joinPath, tildePath } from '../../lib/utils';
import type { CloudFolder, Settings, SyncMode } from '../../types';
import { errorMessage } from '../../types';
import { SettingsSection } from './SettingsModal';

const JIANGUOYUN_URL = 'https://dav.jianguoyun.com/dav/';

export function VaultSyncTab() {
  const { t, lang } = useI18n();
  const { settings, saveSettings, sync, setSync, refreshStatus } = useVault();
  const toast = useToast();
  const [clouds, setClouds] = useState<CloudFolder[]>([]);
  const [webdav, setWebdav] = useState({ url: '', username: '', remotePath: '/Vaultlet/Vaultlet.kdbx' });
  const [webdavPw, setWebdavPw] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    api.cloudFoldersDetect().then(setClouds).catch(() => setClouds([]));
  }, []);

  useEffect(() => {
    if (settings?.vault.webdav) setWebdav(settings.vault.webdav);
  }, [settings?.vault.webdav]);

  if (!settings) return null;

  const update = async (patch: (s: Settings) => Settings) => {
    try {
      await saveSettings(patch(settings));
      await refreshStatus();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const setMode = (mode: SyncMode) =>
    update((s) => ({ ...s, vault: { ...s.vault, mode, webdav: mode === 'webdav' ? s.vault.webdav ?? webdav : s.vault.webdav } }));

  const useCloud = (c: CloudFolder) => {
    const current = settings.vault.path;
    const file = current ? current.split(/[\\/]/).pop()! : 'Vaultlet.kdbx';
    update((s) => ({ ...s, vault: { ...s.vault, mode: 'folder', path: joinPath(c.path, file) } }));
  };

  const chooseFile = async () => {
    const p = await pickFile({ title: t('vault.changePath'), filters: [{ name: 'KeePass', extensions: ['kdbx'] }] });
    if (p) update((s) => ({ ...s, vault: { ...s.vault, mode: 'folder', path: p } }));
  };

  const saveWebdav = () => update((s) => ({ ...s, vault: { ...s.vault, mode: 'webdav', webdav } }));

  const savePassword = async () => {
    try {
      await api.webdavSetPassword(webdavPw);
      toast(t('settings.saved'), 'success');
      setWebdavPw('');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.webdavTest({ url: webdav.url, username: webdav.username, password: webdavPw }));
    } catch (e) {
      setTestResult({ ok: false, message: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      setSync(await api.syncNow());
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSyncing(false);
    }
  };

  const currentDir = settings.vault.path ? dirName(settings.vault.path) : '';

  return (
    <>
      <SettingsSection title={t('vault.mode')} plain>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <ModeCard
            selected={settings.vault.mode === 'folder'}
            icon={<FolderOpen size={16} />}
            title={t('vault.mode.folder')}
            desc={t('vault.mode.folderDesc')}
            onClick={() => setMode('folder')}
          />
          <ModeCard
            selected={settings.vault.mode === 'webdav'}
            icon={<Cloud size={16} />}
            title={t('vault.mode.webdav')}
            desc={t('vault.mode.webdavDesc')}
            onClick={() => setMode('webdav')}
          />
        </div>
      </SettingsSection>

      {settings.vault.mode === 'folder' ? (
        <>
          <SettingsSection title={t('vault.currentPath')} plain>
            <div className="flex items-center gap-3 rounded-xl bg-surface-2 py-2 pr-2 pl-3.5">
              <FileText size={15} className="shrink-0 text-muted" />
              <span className="selectable min-w-0 flex-1 truncate text-[13px]" title={settings.vault.path}>
                {settings.vault.path ? (
                  (() => {
                    const loc = friendlyLocation(settings.vault.path);
                    return (
                      <>
                        <span className="text-muted">{loc.place}</span>
                        <span className="mx-1 text-faint">›</span>
                        <span className="font-medium">{loc.file}</span>
                      </>
                    );
                  })()
                ) : (
                  '—'
                )}
              </span>
              <Button size="sm" variant="link" onClick={chooseFile}>
                {t('vault.changePath')}
              </Button>
            </div>
          </SettingsSection>
          <SettingsSection title={t('vault.cloudFolders')}>
            {clouds.length === 0 && <p className="py-2 text-xs text-muted">{t('create.noCloud')}</p>}
            {clouds.map((c) => {
              const inUse = currentDir === c.path;
              return (
                <div key={c.path} className="flex min-h-[48px] items-center gap-3 py-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                    <Cloud size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px]">{t(`cloud.${c.provider}` as const)}</div>
                    <div className="truncate text-[11px] text-faint" title={c.path}>{tildePath(c.path)}</div>
                  </div>
                  {inUse ? (
                    <StatusPill tone="success" icon={<Check size={12} />}>
                      {t('cloud.inUse')}
                    </StatusPill>
                  ) : (
                    <Button size="sm" onClick={() => useCloud(c)}>
                      {t('cloud.useThis')}
                    </Button>
                  )}
                </div>
              );
            })}
          </SettingsSection>
        </>
      ) : (
        <SettingsSection title={t('vault.mode.webdav')} plain>
          <div className="max-w-[560px] space-y-4 pt-1">
            <div>
              <FieldLabel>{t('vault.webdav.url')}</FieldLabel>
              <div className="flex gap-1.5">
                <Input
                  value={webdav.url}
                  onChange={(e) => setWebdav({ ...webdav, url: e.target.value })}
                  placeholder="https://dav.example.com/"
                  spellCheck={false}
                />
                <Button size="md" onClick={() => setWebdav({ ...webdav, url: JIANGUOYUN_URL })}>
                  {t('vault.webdav.preset.jianguoyun')}
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel>{t('vault.webdav.username')}</FieldLabel>
                <Input value={webdav.username} onChange={(e) => setWebdav({ ...webdav, username: e.target.value })} spellCheck={false} />
              </div>
              <div>
                <FieldLabel>{t('vault.webdav.remotePath')}</FieldLabel>
                <Input value={webdav.remotePath} onChange={(e) => setWebdav({ ...webdav, remotePath: e.target.value })} spellCheck={false} />
              </div>
            </div>
            <div>
              <FieldLabel hint={t('vault.webdav.passwordStored')}>{t('vault.webdav.password')}</FieldLabel>
              <div className="flex gap-1.5">
                <PasswordInput className="flex-1" value={webdavPw} onChange={(e) => setWebdavPw(e.target.value)} autoComplete="off" />
                <Button onClick={savePassword} disabled={!webdavPw}>
                  {t('vault.webdav.savePassword')}
                </Button>
              </div>
              <p className="mt-1.5 text-[11px] text-faint">{t('vault.webdav.passwordHint')}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={test} loading={testing} disabled={!webdav.url}>
                {testing ? t('vault.webdav.testing') : t('vault.webdav.test')}
              </Button>
              <Button variant="primary" onClick={saveWebdav} disabled={!webdav.url}>
                {t('common.save')}
              </Button>
              {testResult && (
                <span className={cx('inline-flex items-center gap-1 text-xs', testResult.ok ? 'text-success' : 'text-danger')}>
                  {testResult.ok ? <Check size={13} /> : <X size={13} />} {testResult.message}
                </span>
              )}
            </div>
          </div>
        </SettingsSection>
      )}

      <SettingsSection title={t('vault.syncStatus')}>
        <div className="flex min-h-[48px] items-center gap-3 py-2">
          <StatusPill
            tone={sync?.state === 'error' ? 'danger' : sync?.state === 'conflict' ? 'warning' : 'success'}
            icon={sync?.state === 'conflict' || sync?.state === 'error' ? <AlertTriangle size={12} /> : <Check size={12} />}
          >
            {t(`sync.${sync?.state ?? 'idle'}` as const)}
          </StatusPill>
          <span className="min-w-0 flex-1 truncate text-xs text-muted">
            {sync?.lastSync ? t('sync.last', { time: relativeTime(sync.lastSync, t, lang) }) : t('sync.never')}
            {sync?.message ? ` · ${sync.message}` : ''}
          </span>
          <Button size="sm" icon={<RefreshCw size={12} />} onClick={syncNow} loading={syncing || sync?.state === 'syncing'}>
            {t('sync.now')}
          </Button>
        </div>
        <div className="py-3">
          <div className="text-[13px]">{t('vault.conflicts')}</div>
          {sync?.conflictFiles.length ? (
            <>
              <p className="mt-0.5 text-xs text-muted">{t('vault.conflictsHint')}</p>
              <ul className="mt-2.5 space-y-1">
                {sync.conflictFiles.map((f) => (
                  <li key={f} className="flex items-center gap-2 rounded-lg bg-warning-soft px-3 py-2 font-mono text-[11px]">
                    <AlertTriangle size={12} className="shrink-0 text-warning" />
                    <span className="selectable truncate">{f}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-0.5 text-xs text-muted">{t('vault.noConflicts')}</p>
          )}
        </div>
      </SettingsSection>
    </>
  );
}

function ModeCard({ selected, icon, title, desc, onClick }: { selected: boolean; icon: React.ReactNode; title: string; desc: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cx(tileCls(selected), 'flex items-start gap-3 p-3.5')}>
      <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', selected ? 'bg-accent text-accent-fg' : 'bg-surface-3 text-muted')}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">{desc}</span>
      </span>
    </button>
  );
}
