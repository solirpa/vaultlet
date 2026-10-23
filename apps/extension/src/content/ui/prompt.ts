/**
 * Save / update notification card, top-right of the page (top frame only).
 * The card never sees the password: the background keeps the capture and
 * performs `save-login` when the user clicks Save / Update.
 */
import { t } from '../../shared/i18n';
import type { PromptAction, SavePrompt } from '../../shared/rpc';
import { h, icon, uiLayer, uiRelease } from './host';
import { siteIcon } from './site-icon';

export const PROMPT_TIMEOUT_MS = 30_000;

export interface PromptDeps {
  act(promptId: string, action: PromptAction): Promise<{ ok: boolean; error?: string }>;
}

let current: { id: string; el: HTMLElement; timer: number } | null = null;

function errorText(code?: string): string {
  switch (code) {
    case 'locked':
      return t('save.errLocked');
    case 'not-paired':
      return t('save.errNotPaired');
    case 'not-found':
      return t('save.errNotFound');
    case 'expired':
      return t('save.errExpired');
    default:
      return t('save.errGeneric');
  }
}

export function removePrompt(): void {
  if (!current) return;
  window.clearTimeout(current.timer);
  current.el.remove();
  current = null;
  uiRelease();
}

export function showPrompt(prompt: SavePrompt, deps: PromptDeps): void {
  if (current?.id === prompt.id) return; // already showing (re-offer after a second load event)
  removePrompt();

  const isUpdate = prompt.kind === 'update';
  const layer = uiLayer(null, true);
  const card = h('div', 'surface card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Vaultlet');

  const head = h('div', 'card-head');
  head.append(icon('key'), h('span', undefined, 'Vaultlet'));
  const close = h('button', 'x');
  close.type = 'button';
  close.setAttribute('aria-label', t('save.close'));
  close.appendChild(icon('x'));
  head.appendChild(close);

  const body = h('div', 'card-body');
  const label = prompt.host || t('save.thisSite');
  const av = siteIcon(label, prompt.host ? `https://${prompt.host}` : null, 28);
  const text = h('div', 'text');
  text.append(
    h('div', 'card-msg', isUpdate ? t('save.updateFor', { user: prompt.username || label }) : t('save.saveFor', { host: label })),
    h('div', 'card-detail', isUpdate ? label : prompt.username || t('save.noUsername')),
  );
  body.append(av, text);

  const error = h('div', 'card-error');
  error.style.display = 'none';

  const actions = h('div', 'card-actions');
  const primary = h('button', 'btn btn-primary', isUpdate ? t('save.update') : t('save.save'));
  primary.type = 'button';
  const later = h('button', 'btn btn-tonal', t('save.notNow'));
  later.type = 'button';
  const never = h('button', 'btn-quiet', t('save.never'));
  never.type = 'button';
  actions.append(primary, later, never);

  card.append(head, body, error, actions);
  layer.appendChild(card);

  const id = prompt.id;
  const finish = () => {
    if (current?.id === id) removePrompt();
  };
  const act = async (action: PromptAction) => {
    for (const b of [primary, later, never]) b.disabled = true;
    let res: { ok: boolean; error?: string };
    try {
      res = await deps.act(id, action);
    } catch (e) {
      res = { ok: false, error: (e as { code?: string }).code };
    }
    if (current?.id !== id) return;
    if (action !== 'save') {
      finish();
      return;
    }
    if (!res.ok) {
      error.textContent = errorText(res.error);
      error.style.display = 'block';
      for (const b of [primary, later, never]) b.disabled = false;
      if (res.error === 'expired' || res.error === 'not-found') primary.disabled = true;
      return;
    }
    // brief confirmation, then go away
    const done = h('div', 'done');
    done.append(icon('check'), h('span', undefined, isUpdate ? t('save.updated') : t('save.saved')));
    card.replaceChildren(head, done);
    window.clearTimeout(current.timer);
    current.timer = window.setTimeout(finish, 1600);
  };

  primary.addEventListener('click', () => void act('save'));
  later.addEventListener('click', () => void act('dismiss'));
  close.addEventListener('click', () => void act('dismiss'));
  never.addEventListener('click', () => void act('never'));

  const timer = window.setTimeout(() => {
    if (current?.id !== id) return;
    void deps.act(id, 'dismiss').catch(() => {});
    finish();
  }, PROMPT_TIMEOUT_MS);
  current = { id, el: card, timer };
}
