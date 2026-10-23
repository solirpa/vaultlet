/**
 * One closed shadow root per document for all Vaultlet UI.
 *
 * The host element is attached to document.documentElement (or, when the
 * focused field lives inside an open modal <dialog>, to that dialog: content
 * outside a modal dialog is inert and could not be clicked). It is a manual
 * popover when the browser supports it, which puts it in the top layer above
 * page overlays; otherwise z-index max. Page CSS cannot style the inside, the
 * page cannot read it (closed root), and pointer events inside do not bubble
 * out to page listeners.
 */
import { UI_CSS } from './styles';

const HOST_TAG = 'vaultlet-ui';

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let layer: HTMLElement | null = null;

const HOST_STYLE: Record<string, string> = {
  all: 'initial',
  position: 'fixed',
  inset: 'auto',
  top: '0',
  left: '0',
  width: '0',
  height: '0',
  margin: '0',
  padding: '0',
  border: '0',
  background: 'transparent',
  overflow: 'visible',
  display: 'block',
  visibility: 'visible',
  opacity: '1',
  transform: 'none',
  filter: 'none',
  'pointer-events': 'none',
  'z-index': '2147483647',
  contain: 'none',
};

const STOP_EVENTS = [
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'pointerdown',
  'pointerup',
  'touchstart',
  'touchend',
  'keydown',
  'keyup',
  'focusin',
  'focusout',
];

function applyHostStyle(el: HTMLElement): void {
  for (const [k, v] of Object.entries(HOST_STYLE)) el.style.setProperty(k, v, 'important');
}

function supportsPopover(el: HTMLElement): boolean {
  return typeof (el as HTMLElement & { showPopover?: unknown }).showPopover === 'function';
}

function isOpenPopover(el: HTMLElement): boolean {
  try {
    return el.matches(':popover-open');
  } catch {
    return false;
  }
}

function modalDialogOf(anchor: Element | null | undefined): HTMLElement | null {
  const dlg = anchor?.closest?.('dialog');
  if (!dlg) return null;
  try {
    return dlg.matches(':modal') ? (dlg as HTMLElement) : null;
  } catch {
    return null;
  }
}

/**
 * The element UI goes into (inside the closed shadow root). Pass the anchor
 * field when showing something next to it; `raise` re-enters the top layer so
 * the UI sits above overlays opened after it.
 */
export function uiLayer(anchor?: Element | null, raise = false): HTMLElement {
  if (!host || !root || !layer) {
    host = document.createElement(HOST_TAG);
    applyHostStyle(host);
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    // :host !important from inside the shadow tree beats page !important rules on the host
    const hostRule = Object.entries(HOST_STYLE)
      .map(([k, v]) => `${k}: ${v} !important;`)
      .join(' ');
    style.textContent = `:host { ${hostRule} }\n${UI_CSS}`;
    layer = document.createElement('div');
    layer.className = 'vl';
    for (const type of STOP_EVENTS) layer.addEventListener(type, (e) => e.stopPropagation());
    root.append(style, layer);
  }
  const parent = modalDialogOf(anchor) ?? document.documentElement;
  const moved = host.parentNode !== parent;
  if (moved) parent.appendChild(host);
  if (supportsPopover(host)) {
    try {
      if (!host.hasAttribute('popover')) host.setAttribute('popover', 'manual');
      if (raise && !moved && isOpenPopover(host)) host.hidePopover();
      if (!isOpenPopover(host)) host.showPopover();
    } catch {
      /* not connected / not supported: z-index fallback */
    }
  }
  return layer;
}

/** Leave the top layer when nothing is shown. */
export function uiRelease(): void {
  if (!host || !layer || layer.childElementCount > 0) return;
  try {
    if (isOpenPopover(host)) host.hidePopover();
  } catch {
    /* ignore */
  }
}

export function uiContains(node: Node | null): boolean {
  return !!node && !!host && (node === host || host.contains(node));
}

/** Viewport size excluding scrollbars. */
export function viewport(): { width: number; height: number } {
  const de = document.documentElement;
  return {
    width: Math.min(window.innerWidth, de.clientWidth || window.innerWidth),
    height: Math.min(window.innerHeight, de.clientHeight || window.innerHeight),
  };
}

// ---- tiny DOM helpers (never innerHTML with page or vault data) -----------

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Icons as lucide-style path lists (static, ours). */
export const ICONS = {
  key: ['M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z', 'M16.5 7.5h.01'],
  lock: ['M7 11V7a5 5 0 0 1 10 0v4', 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  check: ['M20 6 9 17l-5-5'],
} as const;

export function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name]) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}
