import type { Folder, Item, ItemKind } from '../types';

const now = Date.now();
const d = (daysAgo: number, hours = 0) =>
  new Date(now - daysAgo * 86_400_000 - hours * 3_600_000).toISOString();

export const FOLDER_IDS = {
  work: '7a5c1a1e-2d1e-4f2a-9b7c-1c0f3a1d0001',
  personal: '7a5c1a1e-2d1e-4f2a-9b7c-1c0f3a1d0002',
  finance: '7a5c1a1e-2d1e-4f2a-9b7c-1c0f3a1d0003',
};

export const sampleFolders: Folder[] = [
  { id: FOLDER_IDS.work, name: 'Work', parent: null },
  { id: FOLDER_IDS.personal, name: 'Personal', parent: null },
  { id: FOLDER_IDS.finance, name: 'Finance', parent: FOLDER_IDS.personal },
];

let seq = 0;
function mk(partial: Partial<Item> & { title: string; kind: ItemKind }): Item {
  seq += 1;
  return {
    id: `1b2e4c6a-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    username: '',
    password: '',
    urls: [],
    totp: null,
    notes: '',
    fields: [],
    folder: null,
    favorite: false,
    tags: [],
    created: d(120),
    modified: d(30),
    lastUsed: null,
    deleted: false,
    ...partial,
  };
}

export const sampleItems: Item[] = [
  mk({
    kind: 'login',
    title: 'GitHub',
    username: 'alex@example.com',
    password: 'Gh-p4ssw0rd!2024',
    urls: ['https://github.com/login', 'https://gist.github.com'],
    totp: 'otpauth://totp/GitHub:alex?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
    notes: 'Recovery codes are in the Finance folder note.',
    folder: FOLDER_IDS.work,
    favorite: true,
    lastUsed: d(0, 2),
    modified: d(3),
  }),
  mk({
    kind: 'login',
    title: 'Google',
    username: 'alex.chen@example.com',
    password: 'correct horse battery staple',
    urls: ['https://accounts.google.com'],
    totp: 'JBSWY3DPEHPK3PXP',
    favorite: true,
    folder: FOLDER_IDS.personal,
    lastUsed: d(0, 5),
  }),
  mk({
    kind: 'login',
    title: 'Slack',
    username: 'alex',
    password: 'sl4ck-W0rkspace',
    urls: ['https://vaultlet.slack.com'],
    folder: FOLDER_IDS.work,
    lastUsed: d(1),
    fields: [
      { name: 'Workspace', value: 'vaultlet', protected: false },
      { name: 'Backup code', value: '9921-7731-2210', protected: true },
    ],
  }),
  mk({
    kind: 'login',
    title: '坚果云',
    username: 'alex@example.com',
    password: 'jgy-app-password-xxxx',
    urls: ['https://www.jianguoyun.com'],
    folder: FOLDER_IDS.personal,
    notes: 'WebDAV 需要使用应用密码，不是登录密码。',
    lastUsed: d(2),
  }),
  mk({
    kind: 'login',
    title: 'AWS Console',
    username: 'alex-admin',
    password: 'Aw$-R00t-Acc0unt-2024',
    urls: ['https://console.aws.amazon.com'],
    totp: 'otpauth://totp/AWS:alex-admin?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=AWS&digits=6',
    folder: FOLDER_IDS.work,
    tags: ['infra'],
    lastUsed: d(4),
  }),
  mk({
    kind: 'login',
    title: 'Netflix',
    username: 'family@example.com',
    password: 'movie-night-2023',
    urls: ['https://www.netflix.com/login'],
    folder: FOLDER_IDS.personal,
    lastUsed: d(9),
  }),
  mk({
    kind: 'login',
    title: 'Cloudflare',
    username: 'alex@example.com',
    password: 'cf-Edge-W0rker!',
    urls: ['https://dash.cloudflare.com/login'],
    folder: FOLDER_IDS.work,
    modified: d(1),
  }),
  mk({
    kind: 'login',
    title: 'Old forum account',
    username: 'alex_2009',
    password: 'hunter2',
    urls: ['http://forum.example.org'],
    deleted: true,
    modified: d(40),
  }),
  mk({
    kind: 'note',
    title: 'Wi-Fi passwords',
    notes: 'Home 5G: sunflower-7781\nOffice guest: welcome2024\nCabin: no wifi, enjoy the lake.',
    folder: FOLDER_IDS.personal,
    favorite: true,
  }),
  mk({
    kind: 'note',
    title: 'GitHub recovery codes',
    notes: 'a1b2c-d3e4f\nf6g7h-i8j9k\nl0m1n-o2p3q\n(used: r4s5t-u6v7w)',
    folder: FOLDER_IDS.finance,
    fields: [{ name: 'Generated', value: '2024-03-02', protected: false }],
  }),
  mk({
    kind: 'note',
    title: 'Server runbook',
    notes:
      '1. ssh ops@10.0.0.4\n2. sudo systemctl restart vaultlet-sync\n3. Check journalctl -u vaultlet-sync -f',
    folder: FOLDER_IDS.work,
  }),
  mk({
    kind: 'card',
    title: 'Visa — personal',
    folder: FOLDER_IDS.finance,
    fields: [
      { name: 'cardholderName', value: 'ALEX CHEN', protected: false },
      { name: 'number', value: '4111111111111111', protected: true },
      { name: 'brand', value: 'Visa', protected: false },
      { name: 'expMonth', value: '09', protected: false },
      { name: 'expYear', value: '2028', protected: false },
      { name: 'code', value: '123', protected: true },
    ],
    notes: 'Daily spending card.',
    lastUsed: d(6),
  }),
  mk({
    kind: 'card',
    title: 'Company Amex',
    folder: FOLDER_IDS.work,
    fields: [
      { name: 'cardholderName', value: 'VAULTLET LTD', protected: false },
      { name: 'number', value: '378282246310005', protected: true },
      { name: 'brand', value: 'Amex', protected: false },
      { name: 'expMonth', value: '01', protected: false },
      { name: 'expYear', value: '2027', protected: false },
      { name: 'code', value: '9876', protected: true },
    ],
  }),
  mk({
    kind: 'identity',
    title: 'Alex Chen',
    username: 'alexchen',
    folder: FOLDER_IDS.personal,
    fields: [
      { name: 'firstName', value: 'Alex', protected: false },
      { name: 'lastName', value: 'Wang', protected: false },
      { name: 'company', value: 'Vaultlet', protected: false },
      { name: 'email', value: 'alex@example.com', protected: false },
      { name: 'phone', value: '+86 138 0000 0000', protected: false },
      { name: 'address1', value: '88 Nanjing West Road', protected: false },
      { name: 'city', value: 'Shanghai', protected: false },
      { name: 'postalCode', value: '200041', protected: false },
      { name: 'country', value: 'CN', protected: false },
      { name: 'passportNumber', value: 'E12345678', protected: true },
    ],
  }),
  mk({
    kind: 'identity',
    title: 'Work identity',
    username: 'swang',
    folder: FOLDER_IDS.work,
    fields: [
      { name: 'firstName', value: 'Alex', protected: false },
      { name: 'lastName', value: 'Wang', protected: false },
      { name: 'company', value: 'Vaultlet Ltd', protected: false },
      { name: 'email', value: 'alex@example.org', protected: false },
    ],
    deleted: true,
  }),
  mk({
    kind: 'login',
    title: 'Dropbox',
    username: 'alex@example.com',
    password: 'Dr0pb0x-sync-2024',
    urls: ['https://www.dropbox.com/login'],
    folder: FOLDER_IDS.personal,
    lastUsed: d(12),
  }),
];
