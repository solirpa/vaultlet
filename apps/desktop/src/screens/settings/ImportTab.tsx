import { AppWindow, Compass, FileUp, Flame, Shield, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '../../api';
import { Button, ErrorText, FieldLabel, PasswordInput, tileCls } from '../../components/ui';
import { useVault } from '../../hooks/VaultContext';
import { useToast } from '../../hooks/useToast';
import { useT } from '../../i18n';
import type { I18nKey } from '../../i18n/en';
import { pickFile } from '../../lib/platform';
import { baseName, cx } from '../../lib/utils';
import type { ImportFormat, ImportPreview, ImportSummary } from '../../types';
import { errorMessage } from '../../types';
import { SettingsSection } from './SettingsModal';

type Source = 'chrome' | 'firefox' | 'safari' | 'bitwarden';

const SOURCES: { id: Source; icon: ReactNode }[] = [
  { id: 'chrome', icon: <AppWindow size={16} /> },
  { id: 'firefox', icon: <Flame size={16} /> },
  { id: 'safari', icon: <Compass size={16} /> },
  { id: 'bitwarden', icon: <Shield size={16} /> },
];

const sourceOf = (f: ImportFormat): Source =>
  f === 'chrome-csv' ? 'chrome' : f === 'firefox-csv' ? 'firefox' : f === 'safari-csv' ? 'safari' : 'bitwarden';

/** Everything but a password-protected Bitwarden export holds the passwords in plain text. */
const isPlaintext = (f: ImportFormat) => f !== 'bitwarden-encrypted-json';

export function ImportTab() {
  const t = useT();
  const toast = useToast();
  const { status, refreshItems, refreshFolders } = useVault();
  const [source, setSource] = useState<Source>('chrome');
  const [path, setPath] = useState('');
  const [password, setPassword] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'import' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState<ImportSummary | null>(null);
  const [deleted, setDeleted] = useState(false);

  const runPreview = async (p: string, pw: string) => {
    setBusy('preview');
    setError('');
    setDone(null);
    setDeleted(false);
    try {
      const r = await api.importPreview({ path: p, password: pw || undefined });
      setPreview(r);
      setSource(sourceOf(r.format));
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
      filters: [{ name: 'CSV / JSON', extensions: ['csv', 'json'] }],
    });
    if (!p) return;
    setPath(p);
    setPassword('');
    setPreview(null);
    await runPreview(p, '');
  };

  const runImport = async () => {
    if (!preview) return;
    setBusy('import');
    setError('');
    try {
      const r = await api.importRun({ path, format: preview.format, password: password || undefined });
      setDone(r);
      toast(t('import.done', { created: r.created, updated: r.updated }), 'success');
      await Promise.all([refreshItems(), refreshFolders()]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const deleteFile = async () => {
    setBusy('delete');
    setError('');
    try {
      await api.importDeleteFile({ path });
      setDeleted(true);
      toast(t('import.deleted'), 'success');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const locked = status?.state !== 'unlocked';
  const canImport = !!path && !!preview && !preview.needsPassword && !locked && !done;
  const browserFormat = preview && preview.format.endsWith('-csv') && !preview.format.startsWith('bitwarden');
  const summary = done ?? preview?.summary ?? null;

  return (
    <SettingsSection title={t('unlock.import')} description={t('import.intro')} plain>
      <div className="max-w-[600px] space-y-4 pt-2">
        <div>
          <FieldLabel>{t('import.source')}</FieldLabel>
          <div className="grid grid-cols-2 gap-2">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSource(s.id)}
                className={cx(tileCls(source === s.id), 'flex items-center gap-3 px-3 py-2.5')}
              >
                <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', source === s.id ? 'bg-accent text-accent-fg' : 'bg-surface-3 text-muted')}>
                  {s.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">{t(`import.src.${s.id}` as I18nKey)}</span>
                  <span className="block truncate text-[11.5px] text-muted">{t(`import.src.${s.id}Sub` as I18nKey)}</span>
                </span>
              </button>
            ))}
          </div>
          <p className="mt-2 rounded-xl bg-surface-2 px-3.5 py-2.5 text-[12px] leading-relaxed text-muted">
            <span className="font-medium text-text">{t('import.how')}: </span>
            {t(`import.how.${source}` as I18nKey)}
          </p>
        </div>

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
            <div className="text-[12px] text-muted">
              {t('import.detected', { format: t(`import.format.${preview.format}` as I18nKey) })}
            </div>
            {summary ? (
              <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[13px] tabular-nums">
                <span className="font-medium">{t('import.sum.created', { n: summary.created })}</span>
                {summary.updated > 0 && <span className="font-medium text-accent">{t('import.sum.updated', { n: summary.updated })}</span>}
                {summary.unchanged > 0 && <span className="text-muted">{t('import.sum.unchanged', { n: summary.unchanged })}</span>}
                {summary.duplicates > 0 && <span className="text-muted">{t('import.sum.duplicates', { n: summary.duplicates })}</span>}
              </div>
            ) : (
              <div className="mt-1.5 flex gap-5 text-[13px] tabular-nums">
                <span className="font-medium">{t('import.items', { n: preview.items })}</span>
                {preview.folders > 0 && <span className="font-medium">{t('import.folders', { n: preview.folders })}</span>}
              </div>
            )}
            {browserFormat && (
              <>
                <p className="mt-2 text-muted">{t('import.matchHint')}</p>
                <p className="mt-1 text-muted">{t('import.limits')}</p>
              </>
            )}
            {preview.skipped.length > 0 && (
              <div className="mt-2 text-muted">
                {t('import.skipped')}: {preview.skipped.join('; ')}
              </div>
            )}
          </div>
        )}

        {locked && path && <p className="text-xs text-warning">{t('import.vaultLocked')}</p>}
        <ErrorText>{error}</ErrorText>

        {!done && (
          <Button variant="primary" onClick={runImport} disabled={!canImport} loading={busy === 'import'}>
            {busy === 'import' ? t('import.running') : t('import.run')}
          </Button>
        )}

        {done && (
          <div className="space-y-3">
            <p className="text-xs text-success">{t('import.done', { created: done.created, updated: done.updated })}</p>
            {preview && isPlaintext(preview.format) && (
              <div className="rounded-xl bg-warning-soft px-4 py-3">
                <div className="text-[13px] font-medium">{t('import.deleteTitle')}</div>
                <p className="mt-0.5 text-xs text-muted">{t('import.deleteBody')}</p>
                <div className="mt-2.5 flex items-center gap-2">
                  {deleted ? (
                    <span className="text-xs text-success">{t('import.deleted')}</span>
                  ) : (
                    <Button icon={<Trash2 size={13} />} onClick={deleteFile} loading={busy === 'delete'}>
                      {t('import.deleteButton')}
                    </Button>
                  )}
                </div>
              </div>
            )}
            {browserFormat && <p className="text-xs text-muted">{t('import.browserTip')}</p>}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
