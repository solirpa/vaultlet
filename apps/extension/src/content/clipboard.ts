/**
 * Copy text from the content script. The async clipboard API works after a
 * user gesture (menu click / Enter); the execCommand fallback runs on a
 * textarea inside our closed shadow root so the value never enters the page DOM.
 */
import { h, uiLayer, uiRelease } from './ui/host';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through */
  }
  try {
    const layer = uiLayer();
    const ta = h('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;';
    layer.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    uiRelease();
    return ok;
  } catch {
    return false;
  }
}
