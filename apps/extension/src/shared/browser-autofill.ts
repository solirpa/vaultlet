/**
 * The browser's own password manager and autofill (chrome.privacy.services).
 *
 * The browser draws its autofill popup above the page, so the inline menu cannot cover it;
 * the only way to stop the two showing together is to turn the browser's features off.
 * The `privacy` permission is optional and requested from the options page when the user
 * asks for this. The browser puts the settings back when the extension is removed or
 * disabled, and when we clear them.
 */
import { ext, invoke, isFirefox } from './browser';

/** chrome.privacy.services keys; Firefox only has passwordSavingEnabled. */
export type ServiceKey = 'passwordSavingEnabled' | 'autofillAddressEnabled' | 'autofillCreditCardEnabled';

export const SERVICE_KEYS: readonly ServiceKey[] = isFirefox
  ? ['passwordSavingEnabled']
  : ['passwordSavingEnabled', 'autofillAddressEnabled', 'autofillCreditCardEnabled'];

export type LevelOfControl =
  | 'not_controllable'
  | 'controlled_by_other_extensions'
  | 'controllable_by_this_extension'
  | 'controlled_by_this_extension';

export interface ServiceState {
  key: ServiceKey;
  value: boolean;
  levelOfControl: LevelOfControl;
}

/**
 * no-permission  the privacy permission has not been granted
 * on             at least one feature is on and we can turn it off
 * off            every feature we can control is off because of us
 * blocked        a policy or another extension holds every feature that is on
 */
export type BrowserAutofillStatus = 'no-permission' | 'on' | 'off' | 'blocked';

export function summarize(states: ServiceState[]): BrowserAutofillStatus {
  const ours = states.filter((s) => s.levelOfControl === 'controlled_by_this_extension');
  const free = states.filter((s) => s.levelOfControl === 'controllable_by_this_extension');
  if (free.some((s) => s.value)) return 'on';
  if (ours.length > 0) return 'off';
  return states.some((s) => s.value) ? 'blocked' : 'off';
}

const PERMISSION = { permissions: ['privacy'] };

export function hasPrivacyPermission(): Promise<boolean> {
  return invoke<boolean>(ext.permissions, 'contains', PERMISSION).catch(() => false);
}

/** Must be called straight from a click handler (no await before it). */
export function requestPrivacyPermission(): Promise<boolean> {
  return invoke<boolean>(ext.permissions, 'request', PERMISSION).catch(() => false);
}

function setting(key: ServiceKey): chrome.types.ChromeSetting<boolean> | undefined {
  const services = (ext as { privacy?: { services?: Record<string, unknown> } }).privacy?.services;
  return services?.[key] as chrome.types.ChromeSetting<boolean> | undefined;
}

export async function readServices(): Promise<ServiceState[]> {
  const out: ServiceState[] = [];
  for (const key of SERVICE_KEYS) {
    const s = setting(key);
    if (!s) continue;
    const d = await invoke<{ value: boolean; levelOfControl: LevelOfControl }>(s, 'get', {});
    out.push({ key, value: d.value, levelOfControl: d.levelOfControl });
  }
  return out;
}

export async function browserAutofillStatus(): Promise<{ status: BrowserAutofillStatus; services: ServiceState[] }> {
  if (!(await hasPrivacyPermission())) return { status: 'no-permission', services: [] };
  const services = await readServices();
  return { status: summarize(services), services };
}

/** Turn off every feature this extension is allowed to control. */
export async function turnOffBrowserAutofill(): Promise<void> {
  const services = await readServices();
  if (services.length === 0) throw new Error('The browser settings are not available yet. Reload this page and try again.');
  for (const s of services) {
    if (s.levelOfControl === 'controllable_by_this_extension' || s.levelOfControl === 'controlled_by_this_extension') {
      await invoke(setting(s.key)!, 'set', { value: false });
    }
  }
}

/** Hand the features back to the browser's own settings, then drop the permission. */
export async function restoreBrowserAutofill(): Promise<void> {
  for (const s of await readServices()) {
    if (s.levelOfControl === 'controlled_by_this_extension') await invoke(setting(s.key)!, 'clear', {});
  }
  await invoke(ext.permissions, 'remove', PERMISSION).catch(() => false);
}
