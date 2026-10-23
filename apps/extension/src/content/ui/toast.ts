/** Tiny toast next to a field ("Verification code copied"). */
import { h, uiLayer, uiRelease, viewport } from './host';

let current: { el: HTMLElement; timer: number } | null = null;

export function showToast(anchor: Element | null, text: string, ms = 2200): void {
  hideToast();
  const layer = uiLayer(anchor, true);
  const el = h('div', 'toast', text);
  el.setAttribute('role', 'status');
  layer.appendChild(el);
  const vp = viewport();
  const r = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
  const w = el.offsetWidth || 180;
  const ht = el.offsetHeight || 26;
  let left: number;
  let top: number;
  if (r && r.width > 0 && r.bottom > 0 && r.top < vp.height) {
    left = r.left;
    top = r.bottom + 6;
    if (top + ht > vp.height - 8) top = r.top - ht - 6;
  } else {
    left = vp.width - w - 16;
    top = 16;
  }
  el.style.left = `${Math.max(8, Math.min(left, vp.width - w - 8))}px`;
  el.style.top = `${Math.max(8, top)}px`;
  const timer = window.setTimeout(() => {
    el.style.opacity = '0';
    window.setTimeout(() => {
      if (current?.el === el) hideToast();
    }, 220);
  }, ms);
  current = { el, timer };
}

export function hideToast(): void {
  if (!current) return;
  window.clearTimeout(current.timer);
  current.el.remove();
  current = null;
  uiRelease();
}
