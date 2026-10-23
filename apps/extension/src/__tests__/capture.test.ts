// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureWatcher, choosePassword, isSubmitLike, readCredentials, type Capture } from '../content/capture';

let captures: Capture[] = [];
let watcher: CaptureWatcher | null = null;

function mount(html: string): void {
  document.body.innerHTML = html;
  // jsdom cannot navigate; keep real submissions from logging "not implemented"
  document.querySelectorAll('form').forEach((f) => f.addEventListener('submit', (e) => e.preventDefault()));
}

function type(selector: string, value: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(selector)!;
  el.value = value;
  return el;
}

function pressEnter(el: Element): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

beforeEach(() => {
  captures = [];
  watcher = new CaptureWatcher(document, (c) => captures.push(c), { disappearMs: 2000, pollMs: 100 });
  watcher.start();
});

afterEach(() => {
  watcher?.stop();
  watcher = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('capture: form submit', () => {
  it('captures username + password when a login form is submitted', () => {
    mount(`<form id="f"><input type="email" name="email"><input type="password" name="pw"><button>Sign in</button></form>`);
    type('[name=email]', ' alice@example.com ');
    type('[name=pw]', 'hunter2');
    document.getElementById('f')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(captures).toEqual([{ username: 'alice@example.com', password: 'hunter2', trigger: 'submit' }]);
  });

  it('ignores a submission with an empty password', () => {
    mount(`<form id="f"><input type="text" name="user"><input type="password" name="pw"></form>`);
    type('[name=user]', 'alice');
    document.getElementById('f')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(captures).toEqual([]);
  });

  it('ignores forms without a password field (step 1 of a two-step login, search forms)', () => {
    mount(`<form id="f"><input type="email" name="email"></form>`);
    type('[name=email]', 'alice@example.com');
    document.getElementById('f')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(captures).toEqual([]);
  });

  it('reports a click on the submit button and the resulting submit event once', () => {
    mount(`<form><input type="text" name="login"><input type="password" name="pw"><button type="submit" id="go">Continue</button></form>`);
    type('[name=login]', 'alice');
    type('[name=pw]', 's3cret');
    document.getElementById('go')!.click(); // click → (jsdom) submit event
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ username: 'alice', password: 's3cret', trigger: 'button' });
  });

  it('uses the hidden username that two-step logins carry on the password page', () => {
    mount(`<form id="f"><input type="hidden" name="username" value="alice@example.com"><input type="password" name="pw"></form>`);
    type('[name=pw]', 'pw-2');
    document.getElementById('f')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(captures[0]).toMatchObject({ username: 'alice@example.com', password: 'pw-2' });
  });
});

describe('capture: button click (SPA)', () => {
  it('captures on a submit-like button outside any form', () => {
    mount(`<div><input type="email" id="u"><input type="password" id="p"><button type="button" id="b">Log in</button></div>`);
    type('#u', 'bob@example.com');
    type('#p', 'pw');
    document.getElementById('b')!.click();
    expect(captures).toEqual([{ username: 'bob@example.com', password: 'pw', trigger: 'button' }]);
  });

  it('captures when clicking an element inside a submit-like button (icon span)', () => {
    mount(`<div><input type="text" name="username"><input type="password" id="p"><div role="button" aria-label="Sign in"><span id="icon">→</span></div></div>`);
    type('[name=username]', 'bob');
    type('#p', 'pw');
    document.getElementById('icon')!.click();
    expect(captures[0]).toMatchObject({ username: 'bob', trigger: 'button' });
  });

  it('does not capture on non-submit buttons such as "Show password" or "Forgot password"', () => {
    vi.useFakeTimers();
    mount(`<div><input type="text" name="user"><input type="password" id="p">
      <button type="button" id="show">Show password</button><a href="#" id="forgot">Forgot password?</a></div>`);
    type('[name=user]', 'bob');
    type('#p', 'pw');
    document.getElementById('show')!.click();
    document.getElementById('forgot')!.click();
    vi.advanceTimersByTime(3000);
    expect(captures).toEqual([]);
  });

  it('captures when the password field disappears shortly after a click (JS-driven login)', () => {
    vi.useFakeTimers();
    mount(`<div id="login"><input type="text" name="user"><input type="password" id="p"><div role="button" id="go">→</div></div>`);
    type('[name=user]', 'carol');
    type('#p', 'pw-spa');
    document.getElementById('go')!.click();
    expect(captures).toEqual([]); // "→" is not submit-like by itself
    vi.advanceTimersByTime(300);
    document.getElementById('login')!.remove(); // SPA swaps the view
    vi.advanceTimersByTime(200);
    expect(captures).toEqual([{ username: 'carol', password: 'pw-spa', trigger: 'disappear' }]);
  });

  it('does not capture when the password field stays after such a click', () => {
    vi.useFakeTimers();
    mount(`<div><input type="text" name="user"><input type="password" id="p"><div role="button" id="go">→</div></div>`);
    type('[name=user]', 'carol');
    type('#p', 'pw');
    document.getElementById('go')!.click();
    vi.advanceTimersByTime(5000);
    expect(captures).toEqual([]);
  });

  it('ignores clicks on our own UI', () => {
    watcher!.stop();
    const own = document.createElement('div');
    watcher = new CaptureWatcher(document, (c) => captures.push(c), { ignore: (el) => own.contains(el) });
    watcher.start();
    mount(`<div><input type="text" name="user"><input type="password" id="p"></div>`);
    const btn = document.createElement('button');
    btn.textContent = 'Save';
    own.appendChild(btn);
    document.body.appendChild(own);
    type('#p', 'pw');
    btn.click();
    expect(captures).toEqual([]);
  });
});

describe('capture: Enter key', () => {
  it('captures on Enter in the password field', () => {
    mount(`<div><input type="text" name="username"><input type="password" id="p"></div>`);
    type('[name=username]', 'dave');
    pressEnter(type('#p', 'pw-enter'));
    expect(captures).toEqual([{ username: 'dave', password: 'pw-enter', trigger: 'enter' }]);
  });

  it('captures on Enter in the username field when the password is filled', () => {
    mount(`<div><input type="text" name="username" id="u"><input type="password" id="p"></div>`);
    type('#p', 'pw');
    pressEnter(type('#u', 'dave'));
    expect(captures[0]).toMatchObject({ username: 'dave', trigger: 'enter' });
  });

  it('ignores Enter while the password is empty and Enter in unrelated inputs', () => {
    mount(`<input type="search" name="q" id="q"><div><input type="text" name="username"><input type="password" id="p"></div>`);
    type('[name=username]', 'dave');
    pressEnter(document.getElementById('p')!);
    expect(captures).toEqual([]);
    type('#p', 'pw');
    pressEnter(type('#q', 'kittens'));
    expect(captures).toEqual([]);
  });

  it('ignores Enter during IME composition', () => {
    mount(`<div><input type="text" name="username"><input type="password" id="p"></div>`);
    const p = type('#p', 'pw');
    p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    expect(captures).toEqual([]);
  });
});

describe('capture helpers', () => {
  it('isSubmitLike', () => {
    document.body.innerHTML = `
      <input type="submit" id="a" value="Go">
      <button id="b">Sign in</button>
      <button type="button" id="c">Show</button>
      <a id="d">Forgot password?</a>
      <span role="button" id="e">登录</span>
      <form><button id="f"></button></form>
      <button type="button" id="g" aria-label="Toggle password visibility"></button>`;
    const el = (id: string) => document.getElementById(id)!;
    expect(isSubmitLike(el('a'))).toBe(true);
    expect(isSubmitLike(el('b'))).toBe(true);
    expect(isSubmitLike(el('c'))).toBe(false);
    expect(isSubmitLike(el('d'))).toBe(false);
    expect(isSubmitLike(el('e'))).toBe(true);
    expect(isSubmitLike(el('f'))).toBe(true); // implicit type=submit inside a form
    expect(isSubmitLike(el('g'))).toBe(false);
  });

  it('choosePassword picks the new password in change-password and signup forms', () => {
    const mk = (v: string, ac = '') => {
      const i = document.createElement('input');
      i.type = 'password';
      i.value = v;
      if (ac) i.setAttribute('autocomplete', ac);
      return i;
    };
    expect(choosePassword([mk('old'), mk('new'), mk('new')])?.value).toBe('new');
    expect(choosePassword([mk('old'), mk('new')])?.value).toBe('new');
    expect(choosePassword([mk('same'), mk('same')])?.value).toBe('same');
    expect(choosePassword([mk('cur', 'current-password'), mk('next', 'new-password')])?.value).toBe('next');
    expect(choosePassword([mk(''), mk('')])).toBeNull();
  });

  it('readCredentials scopes to the submitted form', () => {
    mount(`
      <form id="a"><input type="text" name="user_a" value="alice"><input type="password" id="pa" value="pa"></form>
      <form id="b"><input type="text" name="user_b" value="bob"><input type="password" id="pb" value="pb"></form>`);
    const creds = readCredentials(document, document.getElementById('b'));
    expect(creds).toMatchObject({ username: 'bob', password: 'pb' });
  });
});
