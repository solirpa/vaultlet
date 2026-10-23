import { MonitorSmartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, onEvent } from '../api';
import { useT } from '../i18n';
import { useToast } from '../hooks/useToast';
import type { PairingRequest } from '../types';
import { errorMessage } from '../types';
import { Button, Modal } from './ui';

/** Listens for `pairing:request` and shows the approve/deny modal. */
export function PairingDialog() {
  const t = useT();
  const toast = useToast();
  const [queue, setQueue] = useState<PairingRequest[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => onEvent('pairing:request', (req) => setQueue((q) => [...q, req])), []);

  const current = queue[0];
  if (!current) return null;

  const respond = async (approve: boolean) => {
    setBusy(true);
    try {
      await api.pairingRespond({ requestId: current.requestId, approve });
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
      setQueue((q) => q.slice(1));
    }
  };

  return (
    <Modal open onClose={() => respond(false)} width="max-w-[360px]" closeOnBackdrop={false}>
      <div className="flex flex-col items-center px-2 pt-2 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <MonitorSmartphone size={22} />
        </div>
        <p className="mt-4 text-[15px] font-semibold tracking-[-0.01em]">{t('pairing.title', { name: current.clientName })}</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{t('pairing.body')}</p>
      </div>
      <div className="mt-6 grid grid-cols-2 gap-2">
        <Button onClick={() => respond(false)} disabled={busy} className="h-9">
          {t('pairing.deny')}
        </Button>
        <Button variant="primary" onClick={() => respond(true)} loading={busy} autoFocus className="h-9">
          {t('pairing.approve')}
        </Button>
      </div>
    </Modal>
  );
}
