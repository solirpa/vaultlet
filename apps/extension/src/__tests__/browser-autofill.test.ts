/**
 * Turning the browser's own password manager off and back on (chrome.privacy.services).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LevelOfControl, ServiceState } from '../shared/browser-autofill';

type Setting = { value: boolean; levelOfControl: LevelOfControl };

/** A fake chrome.* with callback-style permissions and privacy.services. */
function fakeChrome(initial: Record<string, Setting>, granted: boolean) {
  const settings = structuredClone(initial);
  const before = structuredClone(initial);
  const perms = { granted };
  const cb = <T>(fn: () => T) => (...args: unknown[]) => (args.at(-1) as (r: T) => void)(fn());
  const services = Object.fromEntries(
    Object.keys(settings).map((key) => [
      key,
      {
        get: cb(() => ({ ...settings[key] })),
        set: (d: { value: boolean }, done: () => void) => {
          settings[key] = { value: d.value, levelOfControl: 'controlled_by_this_extension' };
          done();
        },
        clear: (_: object, done: () => void) => {
          settings[key] = { ...before[key] };
          done();
        },
      },
    ]),
  );
  const chrome = {
    runtime: { id: 'x' },
    permissions: {
      contains: cb(() => perms.granted),
      request: cb(() => (perms.granted = true)),
      remove: cb(() => !(perms.granted = false)),
    },
    privacy: { services },
  };
  return { chrome, settings, perms };
}

async function load(chrome: object) {
  vi.resetModules();
  vi.stubGlobal('chrome', chrome);
  vi.stubGlobal('browser', undefined);
  return import('../shared/browser-autofill');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const free = (value: boolean): Setting => ({ value, levelOfControl: 'controllable_by_this_extension' });

describe('summarize', () => {
  const s = (key: ServiceState['key'], value: boolean, levelOfControl: LevelOfControl): ServiceState => ({
    key,
    value,
    levelOfControl,
  });

  it('is on while a feature we can control is on', async () => {
    const { summarize } = await load(fakeChrome({}, true).chrome);
    expect(
      summarize([
        s('passwordSavingEnabled', false, 'controlled_by_this_extension'),
        s('autofillAddressEnabled', true, 'controllable_by_this_extension'),
      ]),
    ).toBe('on');
  });

  it('is blocked when only a policy or another extension keeps a feature on', async () => {
    const { summarize } = await load(fakeChrome({}, true).chrome);
    expect(summarize([s('passwordSavingEnabled', true, 'not_controllable')])).toBe('blocked');
    expect(summarize([s('passwordSavingEnabled', true, 'controlled_by_other_extensions')])).toBe('blocked');
  });
});

describe('turning the browser features off and back', () => {
  it('reports no permission until it is granted', async () => {
    const { chrome } = fakeChrome({ passwordSavingEnabled: free(true) }, false);
    const m = await load(chrome);
    expect((await m.browserAutofillStatus()).status).toBe('no-permission');
  });

  it('turns off what it may control, leaves policy settings alone, and restores them', async () => {
    const { chrome, settings, perms } = fakeChrome(
      {
        passwordSavingEnabled: free(true),
        autofillAddressEnabled: free(true),
        autofillCreditCardEnabled: { value: true, levelOfControl: 'not_controllable' },
      },
      false,
    );
    const m = await load(chrome);
    expect(await m.requestPrivacyPermission()).toBe(true);
    expect((await m.browserAutofillStatus()).status).toBe('on');

    await m.turnOffBrowserAutofill();
    expect(settings.passwordSavingEnabled).toEqual({ value: false, levelOfControl: 'controlled_by_this_extension' });
    expect(settings.autofillAddressEnabled.value).toBe(false);
    expect(settings.autofillCreditCardEnabled).toEqual({ value: true, levelOfControl: 'not_controllable' });
    expect((await m.browserAutofillStatus()).status).toBe('off');

    await m.restoreBrowserAutofill();
    expect(settings.passwordSavingEnabled).toEqual(free(true));
    expect(settings.autofillAddressEnabled).toEqual(free(true));
    expect(perms.granted).toBe(false);
    expect((await m.browserAutofillStatus()).status).toBe('no-permission');
  });
});
