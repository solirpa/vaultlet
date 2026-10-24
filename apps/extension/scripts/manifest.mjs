// Manifest templates for Chromium-family browsers and Firefox.
import { publicKeyBase64 } from './extension-id.mjs';

const VERSION = '0.1.1';

const common = {
  manifest_version: 3,
  name: 'Vaultlet',
  version: VERSION,
  description: 'Autofill logins from the Vaultlet desktop app (local-first password manager).',
  icons: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  action: {
    default_title: 'Vaultlet',
    default_popup: 'popup/index.html',
    default_icon: { 16: 'icons/icon16.png', 32: 'icons/icon32.png' },
  },
  options_ui: { page: 'options/index.html', open_in_tab: true },
  permissions: ['nativeMessaging', 'storage', 'activeTab', 'tabs', 'scripting', 'clipboardWrite', 'contextMenus'],
  host_permissions: ['<all_urls>'],
  commands: {
    'fill-login': {
      suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' },
      description: 'Fill login for this page (several matches: open the inline menu)',
    },
  },
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['content.js'],
      run_at: 'document_idle',
      all_frames: true,
    },
    // Passkeys: wrap navigator.credentials.get() in the page's own world before page scripts
    // run, and relay its requests through an isolated-world bridge.
    {
      matches: ['https://*/*', 'http://localhost/*', 'http://*.localhost/*'],
      js: ['passkey-page.js'],
      run_at: 'document_start',
      all_frames: true,
      world: 'MAIN',
    },
    {
      matches: ['https://*/*', 'http://localhost/*', 'http://*.localhost/*'],
      js: ['passkey-bridge.js'],
      run_at: 'document_start',
      all_frames: true,
    },
  ],
};

export function chromeManifest() {
  return {
    ...common,
    key: publicKeyBase64(),
    background: { service_worker: 'background.js' },
    minimum_chrome_version: '116',
  };
}

export function firefoxManifest() {
  return {
    ...common,
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      // 128: content scripts in the page's world (passkeys)
      gecko: { id: 'vaultlet@vaultlet.app', strict_min_version: '128.0' },
    },
  };
}
