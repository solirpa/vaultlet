import { useState, type FormEvent } from 'react';
import { api } from '../../api';
import { PasswordStrength } from '../../components/PasswordStrength';
import { Button, ErrorText, FieldLabel, PasswordInput } from '../../components/ui';
import { useToast } from '../../hooks/useToast';
import { useT } from '../../i18n';
import { errorMessage } from '../../types';
import { SettingsSection } from './SettingsModal';

export function SecurityTab() {
  const t = useT();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const mismatch = confirm.length > 0 && next !== confirm;
  const can = current && next.length >= 8 && next === confirm && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!can) return;
    setBusy(true);
    setError('');
    try {
      await api.vaultChangePassword({ current, next });
      toast(t('security.changed'), 'success');
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={t('security.changePassword')} plain>
      <form onSubmit={submit} className="max-w-sm space-y-4 pt-2">
        <div>
          <FieldLabel>{t('security.current')}</FieldLabel>
          <PasswordInput value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </div>
        <div>
          <FieldLabel>{t('security.new')}</FieldLabel>
          <PasswordInput value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          <PasswordStrength password={next} />
          <ErrorText>{next.length > 0 && next.length < 8 ? t('create.tooShort') : ''}</ErrorText>
        </div>
        <div>
          <FieldLabel>{t('security.confirm')}</FieldLabel>
          <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          <ErrorText>{mismatch ? t('create.mismatch') : ''}</ErrorText>
        </div>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="primary" disabled={!can} loading={busy}>
          {busy ? t('security.changing') : t('security.change')}
        </Button>
      </form>
    </SettingsSection>
  );
}
