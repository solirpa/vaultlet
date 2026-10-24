/**
 * Browser detection: newer Chrome exposes a `browser` global too, which must
 * not be mistaken for Firefox (pairing name, API calling convention).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

async function load(globals: Record<string, unknown>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(globals)) vi.stubGlobal(k, v);
  return import('../shared/browser');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectBrowserName', () => {
  it('Chrome with a `browser` alias is still Chrome', async () => {
    const runtime = { id: 'x' };
    const m = await load({ chrome: { runtime }, browser: { runtime }, navigator: { userAgent: CHROME_UA } });
    expect(m.isFirefox).toBe(false);
    expect(m.detectBrowserName()).toBe('Chrome');
  });

  it('Firefox is recognised by runtime.getBrowserInfo', async () => {
    const m = await load({
      browser: { runtime: { id: 'x', getBrowserInfo: async () => ({ name: 'Firefox' }) } },
      navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0' },
    });
    expect(m.isFirefox).toBe(true);
    expect(m.detectBrowserName()).toBe('Firefox');
  });
});
