// @vitest-environment jsdom
/** Smoke test of the real inline menu / prompt DOM inside the closed shadow root. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { InlineMenu } from '../content/ui/inline-menu';
import { removePrompt, showPrompt } from '../content/ui/prompt';
import type { InlineLogins } from '../shared/rpc';

let shadow: ShadowRoot | null = null;

beforeAll(() => {
  // The UI uses a closed root; capture it so the test can look inside.
  const orig = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
    shadow = orig.call(this, init);
    return shadow;
  });
});

afterEach(() => {
  removePrompt();
  document.body.innerHTML = '';
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const texts = (sel: string) => Array.from(shadow!.querySelectorAll(sel)).map((e) => e.textContent);
const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, composed: true }));

function setup(data: InlineLogins) {
  document.body.innerHTML = `<form><input type="email" id="u"><input type="password" id="p"></form>`;
  const input = document.getElementById('u') as HTMLInputElement;
  // jsdom has no layout; a zero-size field counts as off-screen
  input.getBoundingClientRect = () => ({ left: 20, top: 40, right: 320, bottom: 72, width: 300, height: 32, x: 20, y: 40, toJSON() {} }) as DOMRect;
  const deps = { load: vi.fn(async () => data), fill: vi.fn(async () => {}), unlock: vi.fn(async () => {}) };
  const menu = new InlineMenu(deps);
  input.focus();
  return { input, deps, menu };
}

describe('inline menu DOM', () => {
  it('renders matching logins in a closed shadow root attached to <html>', async () => {
    const { input, menu } = setup({
      status: 'ok',
      entries: [
        { id: 'a', title: 'GitHub', username: 'alice', totp: true, url: 'https://github.com' },
        { id: 'b', title: '', username: 'bob', totp: false, url: 'https://github.com' },
      ],
    });
    await menu.focusField(input, 'focus');
    const host = document.documentElement.querySelector(':scope > vaultlet-ui');
    expect(host).not.toBeNull();
    expect(host!.shadowRoot).toBeNull(); // closed: the page cannot reach in
    expect(texts('.row .title')).toEqual(['GitHub', 'github.com']);
    expect(texts('.row .sub')).toEqual(['alice', 'bob']);
    expect(shadow!.innerHTML).not.toContain('password');
    menu.detach();
  });

  it('ArrowDown / Enter fills the highlighted login; Escape closes', async () => {
    const { input, deps, menu } = setup({
      status: 'ok',
      entries: [
        { id: 'a', title: 'A', username: 'a', totp: false, url: '' },
        { id: 'b', title: 'B', username: 'b', totp: false, url: '' },
      ],
    });
    await menu.focusField(input, 'focus');
    key(input, 'ArrowDown');
    key(input, 'ArrowDown');
    expect(shadow!.querySelector('.row.active .title')?.textContent).toBe('B');
    key(input, 'Enter');
    expect(deps.fill).toHaveBeenCalledWith(input, 'b');
    expect(menu.isOpen).toBe(false);

    await menu.focusField(input, 'click');
    expect(menu.isOpen).toBe(true);
    key(input, 'Escape');
    expect(menu.isOpen).toBe(false);
    await menu.focusField(input, 'focus'); // dismissed: focus alone does not reopen
    expect(menu.isOpen).toBe(false);
    key(input, 'ArrowDown'); // …but ArrowDown does
    await flush();
    expect(menu.isOpen).toBe(true);
    menu.detach();
  });

  it('shows a single "Unlock Vaultlet" row when locked', async () => {
    const { input, deps, menu } = setup({ status: 'locked' });
    await menu.focusField(input, 'focus');
    expect(texts('.row .title')).toEqual(['Unlock Vaultlet']);
    (shadow!.querySelector('.row') as HTMLElement).click();
    expect(deps.unlock).toHaveBeenCalled();
    menu.detach();
  });

  it('shows nothing when not paired / app not running', async () => {
    const { input, menu } = setup({ status: 'unavailable' });
    await menu.focusField(input, 'force');
    expect(menu.isOpen).toBe(false);
    expect(menu.attachedTo).toBeNull();
    expect(shadow?.querySelector('.key, .menu') ?? null).toBeNull();
  });

  it('does not auto-open without matches, but the key icon / force does', async () => {
    const { input, menu } = setup({ status: 'ok', entries: [] });
    await menu.focusField(input, 'focus');
    expect(menu.isOpen).toBe(false);
    expect(shadow!.querySelector('.key')).not.toBeNull();
    (shadow!.querySelector('.key') as HTMLElement).click();
    await flush();
    expect(texts('.row .sub')).toEqual(['No logins for this site']);
    menu.detach();
  });
});

describe('save prompt DOM', () => {
  it('renders the update card and reports the chosen action', async () => {
    const act = vi.fn(async () => ({ ok: true }));
    showPrompt({ id: 'p1', kind: 'update', host: 'example.com', username: 'alice' }, { act });
    expect(shadow!.querySelector('.card-msg')?.textContent).toBe('Update password for alice?');
    const buttons = Array.from(shadow!.querySelectorAll('.card button')).map((b) => b.textContent);
    expect(buttons).toEqual(['', 'Update', 'Not now', 'Never for this site']);
    (Array.from(shadow!.querySelectorAll('.card button')).find((b) => b.textContent === 'Update') as HTMLElement).click();
    await flush();
    expect(act).toHaveBeenCalledWith('p1', 'save');
    expect(shadow!.querySelector('.done')?.textContent).toBe('Password updated');
  });

  it('auto-dismisses after 30 s', async () => {
    vi.useFakeTimers();
    const act = vi.fn(async () => ({ ok: true }));
    showPrompt({ id: 'p2', kind: 'save', host: 'example.com', username: 'bob' }, { act });
    expect(shadow!.querySelector('.card-msg')?.textContent).toBe('Save login for example.com?');
    vi.advanceTimersByTime(30_000);
    expect(act).toHaveBeenCalledWith('p2', 'dismiss');
    expect(shadow!.querySelector('.card')).toBeNull();
    vi.useRealTimers();
  });
});
