/**
 * Login-form detection heuristics. Pure DOM code so it can be unit-tested with jsdom.
 */

export interface LoginForm {
  form: HTMLFormElement | null;
  username: HTMLInputElement | null;
  password: HTMLInputElement | null;
}

const USERNAME_HINT = /user|email|e-mail|login|account|identifier|phone|mobile|tel/i;
const USERNAME_TYPES = new Set(['text', 'email', 'tel', '']);
const SEARCH_HINT = /search|query|captcha|otp|code|token/i;

export function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  const type = (el as HTMLInputElement).type;
  if (type === 'hidden') return false;
  // jsdom has no layout; getClientRects is empty for everything there, so only
  // treat offset/rect info as negative evidence when a real layout engine exists.
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  if (typeof el.getClientRects === 'function' && typeof (el as HTMLElement).offsetParent !== 'undefined') {
    const rects = el.getClientRects();
    if (rects.length === 0 && el.offsetWidth === 0 && el.offsetHeight === 0 && hasLayout(el)) return false;
  }
  return true;
}

function hasLayout(el: HTMLElement): boolean {
  // Real browsers give body a non-zero size; jsdom gives 0 everywhere.
  const body = el.ownerDocument.body;
  return !!body && (body.offsetWidth > 0 || body.offsetHeight > 0);
}

function allInputs(root: ParentNode): HTMLInputElement[] {
  return Array.from(root.querySelectorAll('input')) as HTMLInputElement[];
}

export function findPasswordInputs(root: ParentNode = document): HTMLInputElement[] {
  return allInputs(root).filter(
    (i) => i.type === 'password' && !i.disabled && !i.readOnly && isVisible(i),
  );
}

function usernameScore(input: HTMLInputElement): number {
  if (input.disabled || input.readOnly) return -1;
  const type = (input.getAttribute('type') ?? '').toLowerCase();
  if (!USERNAME_TYPES.has(type)) return -1;
  if (!isVisible(input)) return -1;
  const ac = (input.getAttribute('autocomplete') ?? '').toLowerCase();
  if (/new-password|current-password|one-time-code|cc-|off$/.test(ac) && ac !== 'off') return -1;
  const blob = [input.name, input.id, input.placeholder, input.getAttribute('aria-label') ?? '', ac]
    .join(' ')
    .toLowerCase();
  if (SEARCH_HINT.test(blob) && !USERNAME_HINT.test(blob)) return -1;
  let score = 1;
  if (ac === 'username' || ac === 'email') score += 10;
  if (type === 'email') score += 6;
  if (USERNAME_HINT.test(blob)) score += 4;
  if (type === 'tel') score += 1;
  return score;
}

/**
 * Find the best username candidate for a password field: the nearest preceding
 * (in document order) text-like input, preferring ones with username hints,
 * inside the same form if there is one.
 */
export function findUsernameFor(
  password: HTMLInputElement | null,
  root: ParentNode = document,
): HTMLInputElement | null {
  const scope: ParentNode = password?.form ?? root;
  const inputs = allInputs(scope);
  const idx = password ? inputs.indexOf(password) : inputs.length;
  const preceding = idx >= 0 ? inputs.slice(0, idx) : inputs;

  let best: HTMLInputElement | null = null;
  let bestScore = 0;
  // iterate backwards so that, on a tie, the nearest preceding input wins
  for (let i = preceding.length - 1; i >= 0; i--) {
    const s = usernameScore(preceding[i]);
    if (s > bestScore) {
      best = preceding[i];
      bestScore = s;
    }
  }
  if (best || !password) return best;

  // Nothing before the password inside its form; look at the whole document
  // (some sites keep the username in a separate <form> or outside any form).
  if (scope !== root) {
    const all = allInputs(root);
    const pi = all.indexOf(password);
    const before = pi >= 0 ? all.slice(0, pi) : all;
    for (let i = before.length - 1; i >= 0; i--) {
      const s = usernameScore(before[i]);
      if (s > bestScore) {
        best = before[i];
        bestScore = s;
      }
    }
  }
  return best;
}

/**
 * Detect login forms on the page. Returns one entry per visible password field,
 * plus a username-only entry when the page looks like step 1 of a two-step login.
 */
export function detectLoginForms(root: ParentNode = document): LoginForm[] {
  const passwords = findPasswordInputs(root);
  const forms: LoginForm[] = [];
  for (const pw of passwords) {
    // Registration forms: two password fields (password + confirm). Still fill
    // the first one; skip the second if it belongs to the same form.
    if (forms.some((f) => f.form && f.form === pw.form && f.password)) continue;
    forms.push({ form: pw.form, password: pw, username: findUsernameFor(pw, root) });
  }
  if (forms.length === 0) {
    const username = findUsernameFor(null, root);
    if (username) forms.push({ form: username.form, password: null, username });
  }
  return forms;
}

/** Prefer the form containing the focused element, else the first detected. */
export function pickForm(forms: LoginForm[], active: Element | null): LoginForm | null {
  if (forms.length === 0) return null;
  if (active) {
    const hit = forms.find(
      (f) => f.username === active || f.password === active || (f.form && f.form.contains(active)),
    );
    if (hit) return hit;
  }
  return forms[0];
}

function isNewPassword(input: HTMLInputElement | null): boolean {
  return !!input && /new-password/i.test(input.getAttribute('autocomplete') ?? '');
}

/**
 * Is this input a login field the inline menu should attach to?
 * Password fields of signup / change-password forms (autocomplete=new-password)
 * and the username fields that belong to them are excluded.
 */
export function loginFieldKind(input: HTMLInputElement, root: ParentNode = document): 'username' | 'password' | null {
  if (input.disabled || input.readOnly) return null;
  if (input.type === 'password') {
    if (!isVisible(input) || isNewPassword(input)) return null;
    return 'password';
  }
  const forms = detectLoginForms(root);
  const hit = forms.find((f) => f.username === input);
  if (!hit || isNewPassword(hit.password)) return null;
  return 'username';
}
