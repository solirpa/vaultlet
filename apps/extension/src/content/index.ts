/**
 * Content script (every http(s) frame, manifest all_frames):
 *   - fills login forms on request from the background (popup, context menu, shortcut)
 *   - inline autofill menu + key icon on focused login fields
 *   - captures login submissions and hands them to the background (save / update prompt)
 *   - renders the save / update card (top frame only)
 */
import { ext } from '../shared/browser';
import { t } from '../shared/i18n';
import { RpcError, rpc, type ContentMessage, type FillResult, type InlineLogins } from '../shared/rpc';
import { CaptureWatcher } from './capture';
import { copyText } from './clipboard';
import { fillInput } from './fill';
import { detectLoginForms, findPasswordInputs, loginFieldKind, pickForm } from './forms';
import { uiContains } from './ui/host';
import { InlineMenu, deepActiveElement } from './ui/inline-menu';
import { removePrompt, showPrompt } from './ui/prompt';
import { showToast } from './ui/toast';

const TWO_STEP_WAIT_MS = 30_000;
const CACHE_TTL_MS = 30_000;
const UNAVAILABLE_TTL_MS = 5_000;

// ---- fill -------------------------------------------------------------------

let pendingPassword: { password: string; stop: () => void } | null = null;
/** true while we are focusing/blurring fields ourselves */
let filling = false;

function cancelPending(): void {
  pendingPassword?.stop();
  pendingPassword = null;
}

/** Two-step logins: wait up to 30 s for a password field to appear, then fill it. */
function waitForPasswordAndFill(password: string): void {
  cancelPending();
  const tryFill = (): boolean => {
    const pw = findPasswordInputs(document)[0];
    if (!pw) return false;
    withFilling(() => fillInput(pw, password));
    return true;
  };
  const observer = new MutationObserver(() => {
    if (tryFill()) cancelPending();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'style', 'class', 'hidden'],
  });
  const timer = window.setTimeout(() => cancelPending(), TWO_STEP_WAIT_MS);
  pendingPassword = {
    password,
    stop: () => {
      observer.disconnect();
      window.clearTimeout(timer);
    },
  };
}

function withFilling<T>(fn: () => T): T {
  filling = true;
  try {
    return fn();
  } finally {
    filling = false;
  }
}

/** Fill the form containing `anchor` (default: the focused element). Returns the field to show notices at. */
function fillForm(
  username: string,
  password: string,
  anchor?: Element | null,
): FillResult & { field: HTMLInputElement | null } {
  const forms = detectLoginForms(document);
  const target = pickForm(forms, anchor ?? deepActiveElement());
  if (!target) return { filled: 'none', field: null };
  let didUser = false;
  let didPass = false;
  withFilling(() => {
    if (target.username && username) {
      fillInput(target.username, username);
      didUser = true;
    }
    if (target.password && password) {
      fillInput(target.password, password);
      didPass = true;
    }
  });
  if (!didPass && didUser && password) waitForPasswordAndFill(password);
  const field = target.password && didPass ? target.password : target.username;
  const filled = didUser && didPass ? 'both' : didUser ? 'username' : didPass ? 'password' : 'none';
  return { filled, field };
}

export function fill(username: string, password: string): FillResult {
  return { filled: fillForm(username, password).filled };
}

async function copyTotpAndNotify(code: string, field: Element | null): Promise<void> {
  if (await copyText(code)) showToast(field, t('inline.totpCopied'));
}

// ---- inline menu --------------------------------------------------------------

let cache: { key: string; at: number; data: InlineLogins } | null = null;
let inflight: { key: string; promise: Promise<InlineLogins> } | null = null;

function pageKey(): string {
  return location.href.split('#')[0];
}

function invalidateCache(): void {
  cache = null;
  inflight = null;
}

async function loadInline(): Promise<InlineLogins> {
  const key = pageKey();
  const now = Date.now();
  if (cache && cache.key === key) {
    const ttl = cache.data.status === 'unavailable' ? UNAVAILABLE_TTL_MS : CACHE_TTL_MS;
    if (now - cache.at < ttl) return cache.data;
  }
  if (inflight && inflight.key === key) return inflight.promise;
  const promise = rpc('inlineLogins')
    .catch((): InlineLogins => ({ status: 'unavailable' }))
    .then((data) => {
      if (inflight?.promise === promise) {
        cache = { key, at: Date.now(), data };
        inflight = null;
      }
      return data;
    });
  inflight = { key, promise };
  return promise;
}

const menu = new InlineMenu({
  load: loadInline,
  async fill(anchor, entryId) {
    menu.detach();
    let creds;
    try {
      creds = await rpc('inlineFill', entryId);
    } catch (e) {
      if (e instanceof RpcError && (e.code === 'locked' || e.code === 'not-found')) invalidateCache();
      return;
    }
    const res = fillForm(creds.username, creds.password, anchor.isConnected ? anchor : null);
    if (creds.totp && res.filled !== 'none') await copyTotpAndNotify(creds.totp, res.field ?? anchor);
  },
  async unlock() {
    try {
      await rpc('unlockRequest');
    } catch {
      /* app not reachable: nothing to do */
    }
  },
});

function inputFromEvent(e: Event): HTMLInputElement | null {
  const t = (typeof e.composedPath === 'function' ? e.composedPath()[0] : e.target) as EventTarget | null;
  return t instanceof HTMLInputElement ? t : null;
}

function onFocusIn(e: Event): void {
  if (filling) return;
  const input = inputFromEvent(e);
  if (!input || !loginFieldKind(input)) return;
  void menu.focusField(input, 'focus');
}

function onClick(e: Event): void {
  if (filling) return;
  const input = inputFromEvent(e);
  if (!input) return;
  if (menu.attachedTo === input) {
    if (!menu.isOpen) void menu.focusField(input, 'click');
  } else if (loginFieldKind(input)) {
    void menu.focusField(input, 'click');
  }
}

/** Keyboard shortcut with several matches: open the menu on the focused (or first) login field. */
function openMenuFromShortcut(): void {
  if (!document.hasFocus()) return;
  const active = deepActiveElement();
  if (active && (active.tagName === 'IFRAME' || active.tagName === 'FRAME')) return; // the child frame handles it
  let field = active instanceof HTMLInputElement && loginFieldKind(active) ? active : null;
  if (!field) {
    const form = pickForm(detectLoginForms(document), active);
    field = form?.username ?? form?.password ?? null;
    if (!field) return;
    field.focus();
  }
  void menu.focusField(field, 'force');
}

// ---- capture ------------------------------------------------------------------

const watcher = new CaptureWatcher(
  document,
  (c) => {
    // straight to the background; never logged or stored here
    rpc('captureLogin', { username: c.username, password: c.password }).catch(() => {});
  },
  { ignore: (el) => uiContains(el) },
);

// ---- messages -------------------------------------------------------------------

function onMessage(message: ContentMessage, _sender: unknown, sendResponse: (r: unknown) => void): boolean {
  if (!message || typeof message !== 'object') return false;
  switch (message.type) {
    case 'vaultlet-ping':
      sendResponse({ ok: true });
      return false;
    case 'vaultlet-fill': {
      // Only frames that actually have a form answer; the background takes the first reply.
      const forms = detectLoginForms(document);
      if (forms.length === 0 && window !== window.top) return false;
      menu.detach();
      const res = fillForm(message.username, message.password);
      sendResponse({ filled: res.filled } satisfies FillResult);
      if (res.filled !== 'none') {
        if (message.totp) void copyTotpAndNotify(message.totp, res.field);
        else if (message.notice) showToast(res.field, message.notice);
      }
      return false;
    }
    case 'vaultlet-event':
      invalidateCache();
      if (message.event === 'locked') removePrompt(); // re-offered after unlock
      menu.refresh();
      return false;
    case 'vaultlet-prompt':
      if (window === window.top) {
        showPrompt(message.prompt, { act: (id, action) => rpc('promptAction', id, action) });
      }
      return false;
    case 'vaultlet-open-menu':
      openMenuFromShortcut();
      return false;
    default:
      return false;
  }
}

ext.runtime.onMessage.addListener(onMessage);
document.addEventListener('focusin', onFocusIn, true);
document.addEventListener('click', onClick, true);
watcher.start();
// A field that already has focus when we load (autofocus) gets the menu too.
{
  const active = deepActiveElement();
  if (active instanceof HTMLInputElement) onFocusIn({ target: active } as unknown as Event);
}
