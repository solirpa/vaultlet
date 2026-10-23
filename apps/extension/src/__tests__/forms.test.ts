// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { detectLoginForms, findUsernameFor, pickForm } from '../content/forms';
import { fillInput } from '../content/fill';

function mount(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

describe('login form detection', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('finds a classic username + password form', () => {
    mount(`
      <form id="login">
        <input type="text" name="search" placeholder="Search" />
        <label>Email <input type="email" name="email" /></label>
        <label>Password <input type="password" name="password" /></label>
        <button>Sign in</button>
      </form>
    `);
    const forms = detectLoginForms(document);
    expect(forms).toHaveLength(1);
    expect(forms[0].form?.id).toBe('login');
    expect(forms[0].password?.name).toBe('password');
    expect(forms[0].username?.name).toBe('email');
  });

  it('prefers autocomplete=username over a nearer plain text input', () => {
    mount(`
      <form>
        <input type="text" autocomplete="username" id="user" />
        <input type="text" name="nickname" />
        <input type="password" id="pw" />
      </form>
    `);
    const [f] = detectLoginForms(document);
    expect(f.username?.id).toBe('user');
  });

  it('uses the nearest preceding text input when nothing has hints', () => {
    mount(`
      <div>
        <input type="text" id="first" />
        <input type="text" id="second" />
        <input type="password" id="pw" />
      </div>
    `);
    const [f] = detectLoginForms(document);
    expect(f.form).toBeNull();
    expect(f.username?.id).toBe('second');
  });

  it('skips hidden, disabled and non-text inputs', () => {
    mount(`
      <form>
        <input type="hidden" name="csrf" />
        <input type="checkbox" name="remember" />
        <input type="text" name="login" disabled />
        <input type="text" name="username" style="display:none" />
        <input type="tel" name="phone" />
        <input type="password" name="pw" />
      </form>
    `);
    const [f] = detectLoginForms(document);
    expect(f.username?.name).toBe('phone');
  });

  it('detects a username-only page (two-step login)', () => {
    mount(`
      <form>
        <input type="email" name="identifier" autocomplete="username" />
        <button>Next</button>
      </form>
    `);
    const forms = detectLoginForms(document);
    expect(forms).toHaveLength(1);
    expect(forms[0].password).toBeNull();
    expect(forms[0].username?.name).toBe('identifier');
  });

  it('ignores search boxes when looking for a username-only form', () => {
    mount(`<input type="text" name="q" placeholder="Search the site" />`);
    expect(detectLoginForms(document)).toHaveLength(0);
    expect(findUsernameFor(null, document)).toBeNull();
  });

  it('collapses password + confirm-password in a signup form into one target', () => {
    mount(`
      <form>
        <input type="email" name="email" />
        <input type="password" name="password" />
        <input type="password" name="password_confirm" />
      </form>
    `);
    const forms = detectLoginForms(document);
    expect(forms).toHaveLength(1);
    expect(forms[0].password?.name).toBe('password');
  });

  it('looks outside the form when the username lives elsewhere', () => {
    mount(`
      <input type="email" id="outside" />
      <form><input type="password" id="pw" /></form>
    `);
    const [f] = detectLoginForms(document);
    expect(f.username?.id).toBe('outside');
  });

  it('pickForm prefers the form containing the focused element', () => {
    mount(`
      <form id="a"><input type="text" name="user_a" /><input type="password" name="pw_a" /></form>
      <form id="b"><input type="text" name="user_b" /><input type="password" name="pw_b" /></form>
    `);
    const forms = detectLoginForms(document);
    expect(forms).toHaveLength(2);
    const pwB = document.querySelector<HTMLInputElement>('[name=pw_b]')!;
    pwB.focus();
    expect(pickForm(forms, document.activeElement)?.form?.id).toBe('b');
    expect(pickForm(forms, null)?.form?.id).toBe('a');
  });
});

describe('fillInput', () => {
  it('sets the value through the native setter and fires input/change', () => {
    mount(`<input type="text" id="u" />`);
    const input = document.getElementById('u') as HTMLInputElement;
    const seen: string[] = [];
    input.addEventListener('input', (e) => seen.push('input:' + (e as InputEvent).bubbles));
    input.addEventListener('change', () => seen.push('change'));
    // emulate a framework that patches the instance setter
    let patched = '';
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() {
        return patched;
      },
      set(v: string) {
        patched = 'patched:' + v;
      },
    });
    fillInput(input, 'alice');
    expect(seen).toEqual(['input:true', 'change']);
    // The prototype setter was used, so the patched instance setter was bypassed
    const nativeGet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!;
    expect(nativeGet.call(input)).toBe('alice');
  });
});
