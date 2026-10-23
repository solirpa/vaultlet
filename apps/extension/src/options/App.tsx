import { useEffect, useState } from 'react';
import { KeyRound, RefreshCw, Unlink, X } from 'lucide-react';
import { detectBrowserName, ext, invoke, isFirefox } from '../shared/browser';
import { rpc } from '../shared/rpc';
import { getNeverSaveOrigins, removeNeverSaveOrigin } from '../shared/storage';
import { copyText, useExtensionState } from '../shared/useExtensionState';

/** Grouped block: tonal surface, rows separated by hairlines (no outlined cards). */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-7 first:mt-0">
      <h2 className="mb-2 px-1 text-xs font-medium text-muted">{title}</h2>
      <div className="divide-y divide-hairline rounded-lg bg-surface">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-4 px-4 py-2.5">
      <div className="w-36 shrink-0 text-[13px] text-muted">{label}</div>
      <div className="flex min-w-0 flex-1 items-center text-[13px]">{children}</div>
    </div>
  );
}

function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  const color = ok ? 'bg-success' : warn ? 'bg-warning' : 'bg-faint';
  return <span className={`mr-2 inline-block h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

function useShortcut(): string | null | undefined {
  const [shortcut, setShortcut] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!ext.commands?.getAll) {
      setShortcut(null);
      return;
    }
    invoke<chrome.commands.Command[]>(ext.commands, 'getAll')
      .then((all) => setShortcut(all.find((c) => c.name === 'fill-login')?.shortcut || null))
      .catch(() => setShortcut(null));
  }, []);
  return shortcut;
}

export function App() {
  const { state, reconnect, setState } = useExtensionState();
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [never, setNever] = useState<string[] | null>(null);
  const shortcut = useShortcut();
  const browserName = detectBrowserName();

  useEffect(() => {
    getNeverSaveOrigins()
      .then(setNever)
      .catch(() => setNever([]));
  }, []);

  const connected = state?.connection === 'connected';
  const connectionLabel = !state
    ? 'Loading…'
    : connected
      ? `Connected to Vaultlet ${state.appVersion ?? ''}`.trim()
      : state.connection === 'connecting'
        ? 'Connecting…'
        : state.error === 'host-missing'
          ? 'Native messaging host not found'
          : state.error === 'app-not-running'
            ? 'Vaultlet app is not running'
            : state.error === 'key-mismatch'
              ? 'Key mismatch — re-pair required'
              : 'Not connected';

  const onReset = async () => {
    setBusy(true);
    try {
      setState(await rpc('resetPairing'));
      setConfirmReset(false);
      setState(await rpc('reconnect'));
    } finally {
      setBusy(false);
    }
  };

  const onRemoveNever = async (origin: string) => {
    await removeNeverSaveOrigin(origin);
    setNever(await getNeverSaveOrigins());
  };

  const shortcutsPage = isFirefox ? 'about:addons → ⚙ → Manage Extension Shortcuts' : 'chrome://extensions/shortcuts';

  return (
    <div className="min-h-screen bg-bg">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <header className="mb-8 flex items-center gap-2.5 px-1">
          <KeyRound className="h-6 w-6 text-accent" />
          <h1 className="text-lg font-semibold">Vaultlet</h1>
          <span className="text-[13px] text-faint">Browser extension</span>
        </header>

        <Group title="Connection">
          <Row label="Desktop app">
            <Dot ok={connected} warn={state?.connection === 'connecting'} />
            <span className="truncate">{connectionLabel}</span>
            <button className="btn btn-ghost ml-auto h-7 px-2 text-xs" onClick={() => void reconnect()}>
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </button>
          </Row>
          <Row label="Pairing">
            <Dot ok={!!state?.paired} />
            {state?.paired ? 'Paired' : 'Not paired — open the popup and click "Connect to Vaultlet"'}
          </Row>
          <Row label="Vault">
            {state?.locked === undefined
              ? '—'
              : state.locked
                ? 'Locked'
                : `Unlocked${state.vaultName ? ` (${state.vaultName})` : ''}`}
          </Row>
          <Row label="Client ID">
            <code className="truncate rounded bg-surface-2 px-1.5 py-0.5 text-xs">{state?.clientId ?? '—'}</code>
            {state?.clientId && (
              <button className="btn btn-ghost ml-auto h-7 px-2 text-xs" onClick={() => void copyText(state.clientId!)}>
                Copy
              </button>
            )}
          </Row>
          <Row label="Public key">
            <code className="block truncate rounded bg-surface-2 px-1.5 py-0.5 text-xs" title={state?.publicKey}>
              {state?.publicKey ?? '—'}
            </code>
          </Row>
          <Row label="Browser">{browserName}</Row>
          <Row label="Re-pair">
            {!confirmReset ? (
              <button className="btn btn-tonal h-7 px-2.5 text-xs" onClick={() => setConfirmReset(true)} disabled={busy}>
                <Unlink className="h-3.5 w-3.5" /> Forget keys and pair again
              </button>
            ) : (
              <span className="flex items-center gap-2">
                <span className="text-xs text-muted">
                  This generates a new client ID and key pair. The app will ask you to approve again.
                </span>
                <button className="btn btn-primary h-7 px-2.5 text-xs" onClick={() => void onReset()} disabled={busy}>
                  Confirm
                </button>
                <button className="btn btn-ghost h-7 px-2.5 text-xs" onClick={() => setConfirmReset(false)} disabled={busy}>
                  Cancel
                </button>
              </span>
            )}
          </Row>
        </Group>

        <Group title="Autofill">
          <Row label="Inline menu">
            <span className="text-muted">Click or focus a username / password field, or the key icon inside it.</span>
          </Row>
          <Row label="Shortcut">
            <span className="flex flex-col gap-0.5">
              <span>
                {shortcut === undefined ? (
                  '…'
                ) : shortcut ? (
                  <kbd className="rounded bg-surface-2 px-1.5 py-0.5 font-sans text-xs">{shortcut}</kbd>
                ) : (
                  <span className="text-muted">Not set</span>
                )}{' '}
                <span className="text-muted">fills the login for the page</span>
              </span>
              <span className="text-xs text-faint">Change it at {shortcutsPage}</span>
            </span>
          </Row>
        </Group>

        <Group title="Never offer to save on these sites">
          {never === null ? (
            <Row label="">…</Row>
          ) : never.length === 0 ? (
            <div className="px-4 py-3 text-[13px] text-muted">
              None. Choose “Never for this site” on a save prompt to add one.
            </div>
          ) : (
            never.map((origin) => (
              <div key={origin} className="flex min-h-11 items-center gap-3 px-4">
                <span className="min-w-0 flex-1 truncate text-[13px]">{origin}</span>
                <button className="icon-btn" title="Remove" onClick={() => void onRemoveNever(origin)}>
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))
          )}
        </Group>

        <Group title="Setup">
          <ol className="list-decimal space-y-1.5 py-3.5 pr-4 pl-9 text-[13px] text-text">
            <li>Install and open the Vaultlet desktop app.</li>
            <li>
              In the app, open <b>Settings → Browser integration</b> and enable <b>{browserName}</b>. This writes the
              native messaging host manifest (<code className="text-xs">com.vaultlet.host</code>) for this browser.
            </li>
            <li>Restart the browser if the extension still reports "host not found".</li>
            <li>Click the Vaultlet toolbar icon and choose <b>Connect to Vaultlet</b>, then approve the request in the app.</li>
          </ol>
          {isFirefox && (
            <p className="px-4 py-3 text-xs text-muted">
              Firefox: this extension's ID is <code>vaultlet@vaultlet.app</code>; the app's host manifest lists it under
              <code> allowed_extensions</code>.
            </p>
          )}
        </Group>

        <Group title="How it works">
          <p className="px-4 py-3.5 text-[13px] leading-5 text-muted">
            The extension never stores passwords. It talks to the desktop app over native messaging; every message after
            the handshake is encrypted with NaCl box (X25519 + XSalsa20-Poly1305) using the key pair shown above and the
            app's key. Only the client ID, this key pair, the app's public key and the “never save” site list are kept in
            extension storage. A login you just submitted is held in memory (session storage) for at most 60 seconds
            while the save prompt is pending.
          </p>
        </Group>
      </div>
    </div>
  );
}
