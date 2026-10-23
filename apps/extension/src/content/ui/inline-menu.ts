/**
 * Inline autofill menu + key icon for the focused login field.
 *
 * Rendering lives in the closed shadow root (./host). The page's input keeps
 * focus the whole time (mousedown inside our UI is prevented), so keyboard
 * navigation is read from keydown on the input via the pure reducer in
 * ../menu-state. The menu never holds passwords: rows carry id/title/username
 * only and the password is fetched from the background on activation.
 */
import { hostOf } from '../../shared/avatar';
import { siteIcon } from './site-icon';
import { t } from '../../shared/i18n';
import type { InlineEntry, InlineLogins } from '../../shared/rpc';
import { initialMenuState, menuKeyDown, menuReducer, type MenuState } from '../menu-state';
import { h, icon, uiLayer, uiRelease, viewport } from './host';

export type MenuRow = { kind: 'login'; entry: InlineEntry } | { kind: 'unlock' } | { kind: 'empty'; text: string };

export interface InlineMenuDeps {
  load(): Promise<InlineLogins>;
  fill(anchor: HTMLInputElement, entryId: string): Promise<void>;
  unlock(): Promise<void>;
}

/**
 * focus  open when there is something to show, unless dismissed with Escape
 * click  open when there is something to show
 * force  open even with no matches ("No logins for this site")
 * none   only refresh the icon / open menu
 */
export type OpenMode = 'focus' | 'click' | 'force' | 'none';

const ROW_H = 36;
const MAX_ROWS = 6;
const GAP = 4;
const KEY_SIZE = 22;
const MIN_FIELD_WIDTH_FOR_KEY = 80;
const EDGE = 8;

export function rowsFor(data: InlineLogins | null): MenuRow[] {
  if (!data || data.status === 'unavailable') return [];
  if (data.status === 'locked') return [{ kind: 'unlock' }];
  if (data.entries.length === 0) return [{ kind: 'empty', text: t('inline.noLogins') }];
  return data.entries.map((entry) => ({ kind: 'login', entry }));
}

function looksLikeCombobox(input: HTMLInputElement): boolean {
  return (
    input.hasAttribute('list') ||
    input.getAttribute('role') === 'combobox' ||
    !!input.getAttribute('aria-autocomplete') ||
    input.getAttribute('aria-haspopup') === 'listbox'
  );
}

export class InlineMenu {
  private anchor: HTMLInputElement | null = null;
  private keyEl: HTMLButtonElement | null = null;
  private menuEl: HTMLDivElement | null = null;
  private rowEls: HTMLElement[] = [];
  private rows: MenuRow[] = [];
  private state: MenuState = initialMenuState;
  private data: InlineLogins | null = null;
  private dismissed = new WeakSet<HTMLInputElement>();
  private raf = 0;
  private lastLayout = '';
  private token = 0;

  constructor(private readonly deps: InlineMenuDeps) {}

  get attachedTo(): HTMLInputElement | null {
    return this.anchor;
  }

  get isOpen(): boolean {
    return this.state.open;
  }

  /** A login field gained focus / was clicked / the shortcut asked for the menu. */
  async focusField(field: HTMLInputElement, mode: OpenMode): Promise<void> {
    if (this.anchor !== field) {
      this.detach();
      this.attachTo(field);
    }
    if (mode === 'force') this.dismissed.delete(field);
    const token = ++this.token;
    let data: InlineLogins;
    try {
      data = await this.deps.load();
    } catch {
      data = { status: 'unavailable' };
    }
    if (token !== this.token || this.anchor !== field) return;
    this.data = data;
    if (data.status === 'unavailable') {
      this.detach();
      return;
    }
    this.showKey();
    if (this.state.open) {
      this.renderRows();
      return;
    }
    if (mode === 'none') return;
    const hasRows = data.status === 'locked' || data.entries.length > 0;
    if (mode === 'force' || (hasRows && mode === 'click') || (hasRows && mode === 'focus' && !this.dismissed.has(field))) {
      this.openMenu();
    }
  }

  /** Cached data changed (app event): reload for the attached field. */
  refresh(): void {
    if (this.anchor) void this.focusField(this.anchor, 'none');
  }

  detach(): void {
    this.token++;
    this.closeMenu();
    this.keyEl?.remove();
    this.keyEl = null;
    if (this.anchor) {
      this.anchor.removeEventListener('input', this.onInput);
      this.anchor.removeEventListener('blur', this.onBlur);
    }
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.anchor = null;
    this.data = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastLayout = '';
    uiRelease();
  }

  // ---- internals ------------------------------------------------------------

  private attachTo(field: HTMLInputElement): void {
    this.anchor = field;
    field.addEventListener('input', this.onInput);
    field.addEventListener('blur', this.onBlur);
    window.addEventListener('keydown', this.onKeyDown, true);
    // Follow scroll, resize and layout shifts: cheap rect comparison per frame while a field is focused.
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.position();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private showKey(): void {
    if (this.keyEl || !this.anchor) return;
    const layer = uiLayer(this.anchor);
    const btn = h('button', 'key');
    btn.type = 'button';
    btn.tabIndex = -1;
    btn.setAttribute('aria-label', t('inline.showLogins'));
    btn.setAttribute('aria-expanded', 'false');
    btn.appendChild(icon('key'));
    btn.style.display = 'none';
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!this.anchor) return;
      if (this.state.open) {
        this.dismissed.add(this.anchor);
        this.closeMenu();
      } else {
        void this.focusField(this.anchor, 'force');
      }
    });
    layer.appendChild(btn);
    this.keyEl = btn;
    this.lastLayout = '';
    this.position();
  }

  private openMenu(): void {
    if (!this.anchor) return;
    const layer = uiLayer(this.anchor, true);
    if (this.keyEl && this.keyEl.parentNode !== layer) layer.appendChild(this.keyEl);
    const menu = h('div', 'surface menu');
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', t('inline.listLabel'));
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    layer.appendChild(menu);
    this.menuEl = menu;
    this.state = menuReducer(this.state, { type: 'open', count: 0 });
    this.renderRows();
    this.keyEl?.setAttribute('aria-expanded', 'true');
  }

  private closeMenu(): void {
    this.state = menuReducer(this.state, { type: 'close' });
    this.menuEl?.remove();
    this.menuEl = null;
    this.rowEls = [];
    this.rows = [];
    this.keyEl?.setAttribute('aria-expanded', 'false');
  }

  private renderRows(): void {
    const menu = this.menuEl;
    if (!menu) return;
    this.rows = rowsFor(this.data);
    if (this.rows.length === 0) {
      this.closeMenu();
      return;
    }
    const selectable = this.rows[0].kind === 'empty' ? 0 : this.rows.length;
    this.state = menuReducer(this.state, { type: 'set-count', count: selectable });
    menu.replaceChildren();
    this.rowEls = this.rows.map((row, i) => {
      const el = h('div', row.kind === 'empty' ? 'row static' : 'row');
      if (row.kind === 'empty') {
        el.appendChild(h('div', 'text')).appendChild(h('div', 'sub', row.text));
        menu.appendChild(el);
        return el;
      }
      el.setAttribute('role', 'option');
      if (row.kind === 'login') {
        const e = row.entry;
        const title = e.title || hostOf(e.url) || e.username || 'Login';
        const av = siteIcon(title, e.url, 24);
        const text = h('div', 'text');
        text.append(h('div', 'title', title), h('div', 'sub', e.username || '—'));
        el.append(av, text);
        if (e.totp) el.appendChild(h('div', 'totp-dot', '2FA'));
      } else {
        const av = h('div', 'avatar accent');
        av.appendChild(icon('lock'));
        const text = h('div', 'text');
        text.append(h('div', 'title', t('inline.unlock')), h('div', 'sub', t('inline.lockedSub')));
        el.append(av, text);
      }
      el.addEventListener('mousedown', (ev) => ev.preventDefault());
      el.addEventListener('mousemove', () => {
        if (this.state.active !== i) {
          this.state = menuReducer(this.state, { type: 'hover', index: i });
          this.updateActive(false);
        }
      });
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        this.activate(i);
      });
      menu.appendChild(el);
      return el;
    });
    this.updateActive(true);
    this.lastLayout = '';
    this.position();
  }

  private updateActive(scroll: boolean): void {
    this.rowEls.forEach((el, i) => {
      const on = i === this.state.active;
      el.classList.toggle('active', on);
      if (el.getAttribute('role') === 'option') el.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const menu = this.menuEl;
    const el = this.rowEls[this.state.active];
    if (scroll && menu && el) {
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      if (top < menu.scrollTop) menu.scrollTop = top - 4;
      else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight + 4;
    }
  }

  private activate(index: number): void {
    const row = this.rows[index];
    const anchor = this.anchor;
    if (!row || !anchor || row.kind === 'empty') return;
    this.closeMenu();
    if (row.kind === 'login') void this.deps.fill(anchor, row.entry.id);
    else void this.deps.unlock();
  }

  private position(): void {
    const a = this.anchor;
    if (!a) return;
    if (!a.isConnected) {
      this.detach();
      return;
    }
    const r = a.getBoundingClientRect();
    const vp = viewport();
    const layout = `${r.left}|${r.top}|${r.width}|${r.height}|${vp.width}|${vp.height}|${this.rows.length}`;
    if (layout === this.lastLayout) return;
    this.lastLayout = layout;
    const onScreen = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vp.height && r.right > 0 && r.left < vp.width;

    if (this.keyEl) {
      if (onScreen && r.width >= MIN_FIELD_WIDTH_FOR_KEY && r.height >= 16) {
        const size = Math.min(KEY_SIZE, r.height - 2);
        const inset = Math.max(4, Math.min(8, (r.height - size) / 2));
        this.keyEl.style.width = `${size}px`;
        this.keyEl.style.height = `${size}px`;
        this.keyEl.style.left = `${r.right - size - inset}px`;
        this.keyEl.style.top = `${r.top + (r.height - size) / 2}px`;
        this.keyEl.style.display = 'flex';
      } else {
        this.keyEl.style.display = 'none';
      }
    }

    const menu = this.menuEl;
    if (!menu) return;
    if (!onScreen) {
      this.closeMenu();
      return;
    }
    const width = Math.min(Math.max(r.width, 240), 360, vp.width - 2 * EDGE);
    const below = vp.height - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const wanted = Math.min(this.rows.length, MAX_ROWS) * ROW_H + 10;
    const placeBelow = below >= wanted || below >= above;
    const maxH = Math.max(ROW_H + 10, Math.min(wanted, placeBelow ? below : above));
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${maxH}px`;
    const mh = Math.min(menu.offsetHeight || wanted, maxH);
    let top = placeBelow ? r.bottom + GAP : r.top - GAP - mh;
    top = Math.max(EDGE, Math.min(top, vp.height - mh - EDGE));
    const left = Math.max(EDGE, Math.min(r.left, vp.width - width - EDGE));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const anchor = this.anchor;
    if (!anchor || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = (typeof e.composedPath === 'function' ? e.composedPath()[0] : e.target) as EventTarget | null;
    if (target !== anchor) return;
    const wasOpen = this.state.open;
    const r = menuKeyDown(this.state, e.key);
    if (r.requestOpen) {
      if (!this.data || looksLikeCombobox(anchor)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void this.focusField(anchor, 'force');
      return;
    }
    this.state = r.state;
    if (r.handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    if (e.key === 'Escape' && wasOpen) this.dismissed.add(anchor);
    if (r.activate !== undefined) {
      this.activate(r.activate);
      return;
    }
    if (wasOpen && !this.state.open) this.closeMenu();
    else if (r.handled) this.updateActive(true);
  };

  private onInput = (e: Event): void => {
    // the user is typing: get out of the way (the key icon stays)
    if (e.isTrusted && this.state.open) this.closeMenu();
  };

  private onBlur = (): void => {
    const anchor = this.anchor;
    // focus moves synchronously; check after the event settles
    setTimeout(() => {
      if (this.anchor === anchor && deepActiveElement() !== anchor) this.detach();
    }, 0);
  };
}

export function deepActiveElement(doc: Document = document): Element | null {
  let el: Element | null = doc.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}
