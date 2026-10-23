# Vaultlet browser extension

Manifest V3 extension for Chrome / Edge / Brave / Chromium and Firefox. It talks to the
Vaultlet desktop app through the native messaging host `com.vaultlet.host` using the protocol in
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) section 6 (plus the `search` and
`save-login` actions described below). The extension never stores passwords; it only keeps its
client id, an X25519 key pair, the app's public key, the "never save" site list and a cache of
site icons (`iconCache`, ≤ 2 MB) in `chrome.storage.local`.

## Features

- **Inline autofill menu.** Focus or click a username/email or password field and a small menu
  opens under it with the logins that match the page (letter avatar, title, username). Click a row
  or use <kbd>↓</kbd>/<kbd>↑</kbd> + <kbd>Enter</kbd> to fill; <kbd>Esc</kbd> closes it. If the
  login has a TOTP secret, the current code is copied to the clipboard and a "Verification code
  copied" toast appears next to the field. When the vault is locked the menu shows a single
  **Unlock Vaultlet** row (brings the desktop app forward). When the extension is not paired or the
  app is not running, nothing is shown. A key icon inside the right edge of the focused field
  (fields ≥ 80 px wide) reopens the menu.
- **Save / update prompt.** After you submit a login form (submit event, a click on a submit-like
  button, <kbd>Enter</kbd> in the password field, or a JS login where the password field disappears
  right after a click) Vaultlet compares it with the stored logins for that site once the next page
  has loaded (or after 2 s if nothing navigates): identical → nothing; same username with a new
  password → *Update password for …?*; otherwise → *Save login for …?*. The card sits in the
  top-right corner with **Save/Update**, **Not now** and **Never for this site**, and disappears
  after 30 s. It is never shown while the vault is locked or the extension is not paired; a login
  captured while locked is offered right after you unlock (within 60 s). Sites you excluded are
  listed (and can be removed) on the options page.
- **Popup (vault view, modelled on Bitwarden's vault tab), 380×560.** Header: filled search field,
  **+** (opens the desktop app to create an item) and **Lock**. With an empty search box the body
  shows *Autofill suggestions* (logins matching the current tab, each with a **Fill** button; a
  one-line note when the tab is not a web page or nothing matches), *Favorites* (only when there are
  any) and *All items* with a count. The list is windowed, so large vaults scroll smoothly. Typing
  switches to a single results list (`search`, 150 ms debounce). Clicking a row opens the **item
  view** (back arrow / Esc): username, masked password with reveal, live TOTP with a countdown ring,
  every URL with open-in-new-tab and copy, notes, and **Fill** at the bottom. If the entry does not
  match the tab it says so and the button reads *Fill on &lt;host&gt;*. The row's **…** menu has
  Copy username / password / verification code and View item. Filling also copies the TOTP code.
  A copied password is cleared from the clipboard after 30 s if the popup is still open (best
  effort).
- **Site icons.** Rows, the item view, the inline menu and the save card show the site's icon on a
  light tile (dark: `#2c2c31`). Otherwise they show a monogram: the first letter, CJK character or
  digit, in white on a soft gradient from the title's hue. Icons come only from the desktop app
  (`get-icon`, which fetches from the site itself and caches on disk); the extension never fetches
  icons from the network. The background keeps an LRU of up to 500 hosts / 2 MB, persisted to
  `chrome.storage.local`. It shares requests for the same host, runs at most 4 at a time (newest
  first) and remembers misses for 10 minutes. Only rows actually rendered ask for icons. Content
  scripts may only ask for hosts their own inline menu or save card is showing.
- **Passwords stay out of lists.** `list` and `search` return summaries without passwords, and the
  popup's suggestions are stripped of them too. The password is fetched with `get-entry` only at
  the moment of fill, copy or reveal. When you fill from the popup, the background fetches it and
  the popup never sees it.
- **Language** follows `navigator.language`: `zh*` → Chinese, otherwise English. This applies to
  the popup, the inline menu, the toast and the save card (`src/shared/i18n.ts`).
- **Keyboard shortcut** `fill-login`: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>
  (<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> on macOS). One match → fills it (and copies its
  TOTP code); several matches → opens the inline menu on the focused (or first) login field.
  Change it at `chrome://extensions/shortcuts` (Firefox: `about:addons` → ⚙ → *Manage Extension
  Shortcuts*). If another extension already uses the key, the browser leaves it unassigned.
- **Context menu** "Vaultlet: fill login" on editable fields fills the first matching login.

## Build

```sh
cd apps/extension
pnpm install
pnpm build       # → dist/chrome and dist/firefox
pnpm test        # vitest (see "Tests" below)
pnpm typecheck
```

`pnpm build` runs three Vite builds (background, content script, popup+options pages) and then
writes a `manifest.json` per browser. The background and content bundles are single-file IIFEs
(service workers cannot load chunks).

## Load unpacked

**Chrome / Edge / Brave / Chromium**

1. Open `chrome://extensions` (`edge://extensions`, `brave://extensions`).
2. Enable *Developer mode*.
3. *Load unpacked* → pick `apps/extension/dist/chrome`.

The Chrome manifest contains a fixed `key`, so the extension id is always the one in
[`EXTENSION_ID`](./EXTENSION_ID) (`nlmianfjplijohlfiejchffjambfbeil`). The desktop app's native host manifest
lists `chrome-extension://<that id>/` in `allowed_origins`.

**Firefox**

1. Open `about:debugging#/runtime/this-firefox`.
2. *Load Temporary Add-on…* → pick `apps/extension/dist/firefox/manifest.json`.

The Firefox id is `vaultlet@vaultlet.app` (`browser_specific_settings.gecko.id`), which the
native host manifest lists in `allowed_extensions`. Firefox treats MV3 `host_permissions` as
optional: if filling does not work, grant site access from the extension's permissions panel
(`about:addons` → Vaultlet → Permissions).

After a rebuild, click the reload icon on the extension card (Chrome) or *Reload* (Firefox) and
reload open tabs so they get the new content script.

## Pair with the desktop app

1. Start the Vaultlet desktop app.
2. In the app, open **Settings → Browser integration** and enable the browser you use. This writes
   the native messaging host manifest for that browser (see ARCHITECTURE.md section 6 for paths).
3. Click the Vaultlet toolbar icon → **Connect to Vaultlet** → approve the request in the app.

Until browser integration is enabled the popup reports *Vaultlet is not running* / *host not found*.

## Layout

```
keys/                 dev RSA key pair; public.der → manifest `key` and the extension id
EXTENSION_ID          computed Chrome extension id (one line)
scripts/build.mjs     vite builds + manifest generation
scripts/manifest.mjs  manifest templates (Chrome vs Firefox)
scripts/extension-id.mjs   id derivation (SHA-256 of DER public key, first 16 bytes, hex→a..p)
scripts/make-icons.mjs     regenerates the placeholder PNG icons
src/background/       native messaging client, RPC router, badge, context menu, shortcut,
                      save/update flow (save-flow.ts)
src/content/          login-form detection, fill, submission capture (capture.ts),
                      inline menu reducer (menu-state.ts)
src/content/ui/       closed-shadow-DOM UI: inline menu + key icon, toast, save/update card
src/popup/            React popup (380×560): vault list (sections.ts, VirtualList), item view
src/options/          React options page
src/shared/           protocol types, crypto helpers, storage, browser shim, RPC types,
                      save/update decision (save-decision.ts), avatar helpers
src/__tests__/        vitest unit tests
```

## Protocol additions

Inside the encrypted envelope, same `id` / `ok` / `code` conventions as the other actions:

| Request | Response | Errors |
|---|---|---|
| `{ id, action: "search", query }` | `{ id, ok: true, entries: [summary as in list] }` — title, username or any URL contains `query` (case-insensitive), ≤ 50, sorted by title, no password | `not-paired`, `locked` |
| `{ id, action: "list" }` | `{ id, ok: true, entries: [{ id, title, username, url, totp, favorite }] }` — every login, sorted by title, **no password** | `not-paired`, `locked` |
| `{ id, action: "get-entry", entryId }` | `{ id, ok: true, entry: { id, title, username, password, totp, url, urls, notes, favorite } }` | `not-found`, `locked`, `not-paired` |
| `{ id, action: "get-icon", host }` | `{ id, ok: true, dataUrl: string \| null }` — first lookup of a host can take seconds; null = no icon or disabled | — |
| `{ id, action: "save-login", url, username, password, title?, entryId? }` | with `entryId`: `{ id, ok: true, entryId, updated: true }` (old version kept in history); without: `{ id, ok: true, entryId, created: true }` (title defaults to the host, urls = `[origin of url]`) | `not-paired`, `locked`, `not-found` |

`get-logins` is unchanged (it still includes passwords) and is used for URL-matched fills and the
inline menu. For `save-login` the extension sends `url` = the page origin and omits `title`, so the
app's defaults apply.

## Behaviour notes

- **Badge** shows the number of logins matching the active tab (cached per tab, recomputed on
  tab switch / navigation / app events).
- **Fill** (popup, menu, shortcut) fills username + password into the page. If the page only has a
  username field (two-step login) the username is filled and the password is filled when the
  password field appears (watched for 30 s).
- **Styles.** `font-size: 13px` is set on `body`, not `html`: Tailwind spacing is rem-based, and a
  13px root shrank every utility. Custom classes in `src/styles.css` live in `@layer base` / `@layer components`, so
  Tailwind utilities always override them; in Tailwind v4 unlayered rules beat utilities. The
  shadow-DOM CSS uses zero-specificity `:where()` resets for the same reason.
- **Inline menu data** comes from `get-logins` for the frame's own URL and is cached in the page for
  30 s (5 s for "app not available"); `items-changed`, `locked` and `unlocked` events clear it. The
  menu never receives passwords: rows carry id / title / username, and the password (+ TOTP code)
  is requested from the background only when you pick a row — and only if that entry matches the
  frame's URL.
- **Isolation.** All in-page UI lives in a closed shadow root on a `<vaultlet-ui>` element attached
  to `<html>` (or to an open modal `<dialog>` that contains the field, since everything outside a
  modal dialog is inert). It is a manual popover (top layer) where supported, otherwise
  `z-index: 2147483647`; host styles are `!important` from inside the shadow tree so page CSS
  cannot hide or restyle it, and pointer/key events inside do not bubble out to page listeners.
  The only page DOM the extension writes to is the input being filled.
- **Content-script RPC is restricted.** The background only accepts `inlineLogins`, `inlineFill`,
  `unlockRequest`, `captureLogin` and `promptAction` from content scripts, and takes the URL and tab
  from the message sender, so a compromised page frame cannot ask for another site's logins.
- **Captured logins** (username + password of a submission) exist only in the background's
  in-memory per-tab map, mirrored to `chrome.storage.session` (memory-only, not readable by content
  scripts, cleared on browser restart) so a suspended MV3 service worker does not lose them. They
  are deleted after Save / Not now / Never, after an "identical" decision, when the tab closes, and
  60 s after capture (extended to ~35 s after the card is shown so its buttons keep working). They
  are never logged.
- `associate` waits up to 120 s for the user to approve in the app; all other requests time out
  after 10 s.

## Tests

`pnpm test` runs vitest (jsdom where DOM is needed):

- `crypto.test.ts` — NaCl envelope round trip, nonces, tamper detection
- `protocol.test.ts` — `search` / `save-login` on the wire through `NativeClient` against a fake app
- `forms.test.ts` — login form detection, `fillInput`
- `capture.test.ts` — submission capture: form submit, submit-like buttons, Enter, SPA disappearance, change-password forms
- `save-decision.test.ts` — capture + stored logins → none / save / update
- `save-flow.test.ts` — 2 s / next-load timing, locked → offer after unlock, 60 s expiry, never list, session-storage restore
- `menu-state.test.ts` — inline menu keyboard reducer
- `sections.test.ts` — popup sections (suggestions / favorites / all items / results) and windowing
- `icon-cache.test.ts` — icon LRU / byte cap, persistence + restore, dedupe, 4-way concurrency, miss / failure handling, monogram
- `i18n.test.ts` — language choice, interpolation, fallback, Chinese completeness
- `inline-ui.test.ts` — inline menu and save card DOM inside the closed shadow root
