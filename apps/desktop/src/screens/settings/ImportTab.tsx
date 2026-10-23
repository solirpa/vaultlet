import { FileUp } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api';
import { Button, ErrorText, FieldLabel, PasswordInput } from '../../components/ui';
import { useVault } from '../../hooks/VaultContext';
import { useToast } from '../../hooks/useToast';
import { useT } from '../../i18n';
import { pickFile } from '../../lib/platform';
import { baseName } from '../../lib/utils';
import type { ImportPreview } from '../../types';
import { errorMessage } from '../../types';
import { SettingsSection } from './SettingsModal';

export function ImportTab() {
  const t = useT();
  const toast = useToast();
  const { status, refreshItems, refreshFolders } = useVault();
  const [path, setPath] = useState('');
  const [password, setPassword] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState<number | null>(null);

  const runPreview = async (p: string, pw: string) => {
    setBusy('preview');
    setError('');
    setDone(null);
    try {
      setPreview(await api.importBitwardenPreview({ path: p, password: pw || undefined }));
    } catch (e) {
      setError(errorMessage(e));
      setPreview(null);
    } finally {
      setBusy(null);
    }
  };

  const choose = async () => {
    const p = await pickFile({
      title: t('import.pickFile'),
      filters: [{ name: 'Bitwarden export', extensions: ['json', 'csv'] }],
    });
    if (!p) return;
    setPath(p);
    setPassword('');
    setPreview(null);
    await runPreview(p, '');
  };

  const runImport = async () => {
    setBusy('import');
    setError('');
    try {
      const r = await api.importBitwarden({ path, password: password || undefined });
      setDone(r.imported);
      toast(t('import.done', { n: r.imported }), 'success');
      await Promise.all([refreshItems(), refreshFolders()]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const locked = status?.state !== 'unlocked';
  const canImport = !!path && !!preview && !preview.needsPassword && !locked;

  return (
    <SettingsSection title={t('unlock.importBitwarden')} description={t('import.intro')} plain>
      <div className="max-w-[560px] space-y-4 pt-2">
        <div className="flex items-center gap-2">
          <Button icon={<FileUp size={13} />} onClick={choose} loading={busy === 'preview'}>
            {busy === 'preview' ? t('import.previewing') : t('import.pickFile')}
          </Button>
          {path && (
            <span className="selectable min-w-0 truncate font-mono text-xs text-muted" title={path}>
              {baseName(path)}
            </span>
          )}
        </div>

        {preview?.needsPassword && (
          <div>
            <p className="mb-1 text-xs text-muted">{t('import.needsPassword')}</p>
            <FieldLabel>{t('import.filePassword')}</FieldLabel>
            <div className="flex gap-1.5">
              <PasswordInput className="flex-1" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
              <Button onClick={() => runPreview(path, password)} disabled={!password} loading={busy === 'preview'}>
                {t('import.preview')}
              </Button>
            </div>
          </div>
        )}

        {preview && !preview.needsPassword && (
          <div className="rounded-xl bg-surface-2 px-4 py-3 text-xs">
            <div className="flex gap-5 text-[13px] tabular-nums">
              <span className="font-medium">{t('import.items', { n: preview.items })}</span>
              <span className="font-medium">{t('import.folders', { n: preview.folders })}</span>
            </div>
            {preview.skipped.length > 0 && (
              <div className="mt-1 text-muted">
                {t('import.skipped')}: {preview.skipped.join('; ')}
              </div>
            )}
          </div>
        )}

        {locked && path && <p className="text-xs text-warning">{t('import.vaultLocked')}</p>}
        <ErrorText>{error}</ErrorText>
        {done !== null && <p className="text-xs text-success">{t('import.done', { n: done })}</p>}

        <Button variant="primary" onClick={runImport} disabled={!canImport} loading={busy === 'import'}>
          {busy === 'import' ? t('import.running') : t('import.run')}
        </Button>
      </div>
    </SettingsSection>
  );
}
