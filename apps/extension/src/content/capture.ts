/**
 * Login-submission capture heuristics (pure DOM, unit-tested with jsdom).
 *
 * Triggers:
 *   submit     a <form> containing a non-empty password field is submitted
 *   button     click on a submit-like button (form or SPA)
 *   enter      Enter pressed in a login field while the password is non-empty
 *   disappear  click on any other button-like element, after which the
 *              non-empty password field disappears within ~2 s (SPA logins
 *              that are driven by JS and never fire submit)
 *
 * Values are read at trigger time (before an SPA tears the form down). Only
 * captures with a non-empty password are reported. Nothing here logs or
 * stores the password; it is handed straight to the callback.
 */
import { findPasswordInputs, findUsernameFor, isVisible } from './forms';

export type CaptureTrigger = 'submit' | 'button' | 'enter' | 'disappear';

export interface Capture {
  username: string;
  password: string;
  trigger: CaptureTrigger;
}

interface Credentials {
  username: string;
  password: string;
  passwordField: HTMLInputElement;
}

const BUTTONISH =
  'button, input[type=submit], input[type=button], input[type=image], [role=button], [role=link], a, [onclick]';
const SUBMIT_TEXT =
  /log\s*-?\s*in|sign\s*-?\s*in|log\s*on|sign\s*-?\s*up|register|create\s+account|submit|continue|next|verify|confirm|save|登录|登入|登陆|继续|繼續|下一步|确定|確定|提交|注册|ログイン|サインイン|로그인|anmelden|connexion|iniciar|entrar/i;
const NOT_SUBMIT_TEXT =
  /show|hide|reveal|toggle|eye|visib|cancel|back|forgot|reset|search|clear|close|显示|隐藏|忘记|取消|返回/i;

function textBlob(el: Element): string {
  const input = el as HTMLInputElement;
  return [
    el.textContent ?? '',
    typeof input.value === 'string' && el.tagName === 'INPUT' ? input.value : '',
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('title') ?? '',
    el.id,
    el.getAttribute('name') ?? '',
    el.getAttribute('data-testid') ?? '',
    typeof el.className === 'string' ? el.className : '',
  ]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Does clicking this element (very likely) submit a login? */
export function isSubmitLike(el: Element): boolean {
  const tag = el.tagName;
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (tag === 'INPUT' && (type === 'submit' || type === 'image')) return true;
  const blob = textBlob(el);
  if (NOT_SUBMIT_TEXT.test(blob) && !SUBMIT_TEXT.test(el.textContent ?? '')) return false;
  if (tag === 'BUTTON') {
    // <button> defaults to type=submit inside a form
    if (type === 'submit' || (type === '' && (el as HTMLButtonElement).form)) return true;
  }
  return SUBMIT_TEXT.test(blob);
}

/**
 * Pick the password the user is setting/using from the password fields of one form:
 *   - a non-empty autocomplete=new-password field wins (signup / change password)
 *   - 1 field → it
 *   - 2 equal fields → the first (password + confirm)
 *   - 2 different fields → the second (current + new)
 *   - 3 fields → the second (current + new + confirm)
 */
export function choosePassword(fields: HTMLInputElement[]): HTMLInputElement | null {
  const filled = fields.filter((f) => f.value !== '');
  if (filled.length === 0) return null;
  const fresh = filled.find((f) => /new-password/i.test(f.getAttribute('autocomplete') ?? ''));
  if (fresh) return fresh;
  if (filled.length === 1) return filled[0];
  if (filled.every((f) => f.value === filled[0].value)) return filled[0];
  return filled[1];
}

/** Hidden username carried along on step 2 of two-step logins (for password managers). */
function hiddenUsername(scope: ParentNode): string {
  const sel =
    'input[autocomplete~="username" i], input[autocomplete~="email" i], input[type=email], input[name*=user i], input[name*=email i], input[name*=login i], input[id*=username i]';
  for (const el of Array.from(scope.querySelectorAll<HTMLInputElement>(sel))) {
    if (el.type === 'password') continue;
    const v = el.value.trim();
    if (v) return v;
  }
  return '';
}

/**
 * Read username + password relevant to `origin` (a form, button or input).
 * Scope is the origin's form when it contains a password field, else the document.
 */
export function readCredentials(doc: Document, origin: Element | null): Credentials | null {
  const form =
    origin instanceof HTMLFormElement
      ? origin
      : ((origin as HTMLInputElement | null)?.form ?? (origin?.closest('form') as HTMLFormElement | null) ?? null);
  let fields = form ? findPasswordInputs(form) : [];
  let scope: ParentNode = form ?? doc;
  if (fields.length === 0) {
    if (form && origin instanceof HTMLFormElement) return null; // submitted form has no password (e.g. step 1)
    const all = findPasswordInputs(doc);
    // SPA: prefer fields outside any form, then everything
    const loose = all.filter((f) => !f.form);
    fields = loose.some((f) => f.value) ? loose : all;
    scope = doc;
    if (fields.length > 0 && fields[0].form && fields.every((f) => f.form === fields[0].form)) scope = fields[0].form;
  }
  const passwordField = choosePassword(fields);
  if (!passwordField) return null;
  const userField = findUsernameFor(fields[0], doc);
  const username = userField?.value.trim() || hiddenUsername(scope);
  return { username, password: passwordField.value, passwordField };
}

export interface CaptureWatcherOptions {
  /** how long to watch for the password field to disappear after a click */
  disappearMs?: number;
  pollMs?: number;
  /** identical captures within this window are reported once */
  dedupeMs?: number;
  /** clicks on these elements are ignored (our own UI host) */
  ignore?: (el: Element) => boolean;
}

export class CaptureWatcher {
  private last: { username: string; password: string; at: number } | null = null;
  private watch: { timer: ReturnType<typeof setInterval>; deadline: number } | null = null;
  private readonly disappearMs: number;
  private readonly pollMs: number;
  private readonly dedupeMs: number;
  private readonly ignore?: (el: Element) => boolean;

  constructor(
    private readonly doc: Document,
    private readonly onCapture: (c: Capture) => void,
    opts: CaptureWatcherOptions = {},
  ) {
    this.disappearMs = opts.disappearMs ?? 2000;
    this.pollMs = opts.pollMs ?? 200;
    this.dedupeMs = opts.dedupeMs ?? 1500;
    this.ignore = opts.ignore;
  }

  start(): void {
    this.doc.addEventListener('submit', this.onSubmit, true);
    this.doc.addEventListener('click', this.onClick, true);
    this.doc.addEventListener('keydown', this.onKeyDown, true);
  }

  stop(): void {
    this.doc.removeEventListener('submit', this.onSubmit, true);
    this.doc.removeEventListener('click', this.onClick, true);
    this.doc.removeEventListener('keydown', this.onKeyDown, true);
    this.stopWatch();
    this.last = null;
  }

  private emit(creds: Credentials | null, trigger: CaptureTrigger): void {
    if (!creds || !creds.password) return;
    const now = Date.now();
    if (
      this.last &&
      this.last.username === creds.username &&
      this.last.password === creds.password &&
      now - this.last.at < this.dedupeMs
    ) {
      return;
    }
    this.last = { username: creds.username, password: creds.password, at: now };
    this.stopWatch();
    this.onCapture({ username: creds.username, password: creds.password, trigger });
  }

  private onSubmit = (e: Event): void => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    this.emit(readCredentials(this.doc, form), 'submit');
  };

  private onKeyDown = (e: Event): void => {
    const ke = e as KeyboardEvent;
    if (ke.key !== 'Enter' || ke.isComposing) return;
    const target = ke.target;
    if (!(target instanceof HTMLInputElement)) return;
    const isPassword = target.type === 'password';
    const creds = readCredentials(this.doc, target);
    if (!creds) return;
    // Enter in the password field, or in the username field that belongs to it
    if (isPassword || findUsernameFor(creds.passwordField, this.doc) === target) this.emit(creds, 'enter');
  };

  private onClick = (e: Event): void => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const start = (path[0] ?? e.target) as Element | null;
    if (!start || typeof (start as Element).closest !== 'function') return;
    if (this.ignore?.(start)) return;
    const button = start.closest(BUTTONISH);
    if (button && isSubmitLike(button)) {
      this.emit(readCredentials(this.doc, button), 'button');
      return;
    }
    if (button || isPointerTarget(start)) this.watchForDisappearance(readCredentials(this.doc, button ?? start));
  };

  /** SPA heuristic: remember the credentials; report them if the password field goes away. */
  private watchForDisappearance(creds: Credentials | null): void {
    this.stopWatch();
    if (!creds) return;
    const field = creds.passwordField;
    const deadline = Date.now() + this.disappearMs;
    const timer = setInterval(() => {
      if (!field.isConnected || !isVisible(field)) {
        this.emit(creds, 'disappear');
      } else if (Date.now() >= deadline) {
        this.stopWatch();
      }
    }, this.pollMs);
    this.watch = { timer, deadline };
  }

  private stopWatch(): void {
    if (this.watch) clearInterval(this.watch.timer);
    this.watch = null;
  }
}

function isPointerTarget(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return false;
  try {
    return el.ownerDocument.defaultView?.getComputedStyle(el).cursor === 'pointer';
  } catch {
    return false;
  }
}
