/**
 * Styles for everything the content script renders (inline menu, key icon,
 * toast, save prompt). Lives inside a closed shadow root, so page CSS cannot
 * reach it. Tokens mirror apps/desktop/src/styles.css (tonal surfaces, single
 * accent, hairlines only where tone is not enough).
 */
export const UI_CSS = `
.vl {
  --bg: #ffffff;
  --surface-2: #f1f1f4;
  --surface-3: #e8e8ec;
  --text: #1d1d1f;
  --muted: #6e6e73;
  --faint: #a1a1a6;
  --accent: #2f6bff;
  --accent-hover: #2660ec;
  --hairline: rgba(0, 0, 0, 0.08);
  --hover: rgba(0, 0, 0, 0.045);
  --active: color-mix(in srgb, var(--accent) 12%, var(--bg));
  --danger: #d93a32;
  --shadow: 0 2px 6px rgba(0, 0, 0, 0.06), 0 12px 32px rgba(0, 0, 0, 0.12);
  --toast-bg: #1d1d1f;
  --toast-fg: #ffffff;
  --tile: #ffffff;
  --mono-s1: 72%; --mono-l1: 64%; --mono-s2: 62%; --mono-l2: 50%;
  all: initial;
  display: contents;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1.35;
  color: var(--text);
  color-scheme: light;
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  .vl {
    --bg: #2c2c31;
    --surface-2: #36363c;
    --surface-3: #414148;
    --text: #f5f5f7;
    --muted: #a0a0a6;
    --faint: #6e6e75;
    --accent: #5b8cff;
    --accent-hover: #6f9aff;
    --hairline: rgba(255, 255, 255, 0.08);
    --hover: rgba(255, 255, 255, 0.06);
    --active: color-mix(in srgb, var(--accent) 22%, var(--bg));
    --danger: #ff6b63;
    --shadow: 0 4px 10px rgba(0, 0, 0, 0.35), 0 16px 40px rgba(0, 0, 0, 0.5);
    --toast-bg: #f5f5f7;
    --toast-fg: #1d1d1f;
    --tile: #2c2c31;
    --mono-s1: 50%; --mono-l1: 50%; --mono-s2: 52%; --mono-l2: 38%;
    color-scheme: dark;
  }
}
/* Resets with zero specificity (:where) so component classes below always win;
   a plain \`.vl button { color: inherit }\` would beat \`.btn-primary { color: #fff }\`. */
:where(.vl) *, :where(.vl) *::before, :where(.vl) *::after { box-sizing: border-box; margin: 0; }
:where(.vl) button { font: inherit; color: inherit; letter-spacing: normal; text-transform: none; }

.surface {
  position: fixed;
  pointer-events: auto;
  background: var(--bg);
  border: 1px solid var(--hairline);
  border-radius: 10px;
  box-shadow: var(--shadow);
  animation: vl-in 120ms ease-out;
}
@keyframes vl-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .surface, .toast { animation: none; } }

/* ---- key icon inside the field ---- */
.key {
  position: fixed;
  pointer-events: auto;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.85;
}
.key:hover, .key[aria-expanded="true"] { background: var(--hover); opacity: 1; }
.key svg { width: 15px; height: 15px; display: block; }

/* ---- inline menu ---- */
.menu { padding: 4px; overflow-y: auto; overscroll-behavior: contain; }
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  padding: 0 8px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
}
.row.active { background: var(--active); }
.row.static { cursor: default; color: var(--muted); }
.site-icon, .monogram {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.site-icon { background: var(--tile); box-shadow: inset 0 0 0 1px var(--hairline); }
.site-icon img { display: block; object-fit: contain; image-rendering: auto; }
.monogram {
  color: #ffffff;
  font-weight: 600;
  line-height: 1;
  background: linear-gradient(180deg, hsl(var(--mono-h) var(--mono-s1) var(--mono-l1)), hsl(var(--mono-h) var(--mono-s2) var(--mono-l2)));
  text-shadow: 0 1px 1px rgb(0 0 0 / 0.12);
}
.avatar {
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.avatar.accent { background: var(--active); color: var(--accent); }
.avatar svg { width: 14px; height: 14px; }
.text { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.title, .sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.title { font-size: 13px; line-height: 17px; font-weight: 500; }
.sub { font-size: 11.5px; line-height: 15px; color: var(--muted); }
.totp-dot { flex: none; font-size: 10.5px; color: var(--faint); }

/* ---- toast ---- */
.toast {
  position: fixed;
  pointer-events: none;
  padding: 5px 10px;
  border-radius: 8px;
  background: var(--toast-bg);
  color: var(--toast-fg);
  font-size: 12px;
  line-height: 16px;
  white-space: nowrap;
  box-shadow: var(--shadow);
  animation: vl-in 120ms ease-out;
  transition: opacity 200ms ease;
}

/* ---- save / update card ---- */
.card { top: 16px; right: 16px; width: 320px; max-width: calc(100vw - 32px); padding: 12px 14px 12px; }
.card-head { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; line-height: 16px; }
.card-head svg { width: 14px; height: 14px; color: var(--accent); }
.card-head .x {
  margin-left: auto; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 6px;
  background: transparent; color: var(--faint); cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.card-head .x:hover { background: var(--hover); color: var(--text); }
.card-head .x svg { color: inherit; width: 12px; height: 12px; }
.card-body { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.card-msg { font-size: 13px; line-height: 17px; font-weight: 600; overflow-wrap: anywhere; }
.card-detail { font-size: 12px; line-height: 16px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-error { margin-top: 8px; font-size: 12px; color: var(--danger); }
.card-actions { display: flex; align-items: center; gap: 6px; margin-top: 12px; }
.btn {
  height: 28px; padding: 0 12px; border: 0; border-radius: 7px; cursor: pointer;
  font-size: 12.5px; font-weight: 500; line-height: 28px; white-space: nowrap;
}
.btn:disabled { opacity: 0.5; cursor: default; }
.btn-primary { background: var(--accent); color: #ffffff; }
.btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn-tonal { background: var(--surface-2); color: var(--text); }
.btn-tonal:hover:not(:disabled) { background: var(--surface-3); }
.btn-quiet {
  margin-left: auto; height: 28px; padding: 0 4px; border: 0; background: transparent; cursor: pointer;
  color: var(--muted); font-size: 12px; white-space: nowrap;
}
.btn-quiet:hover { color: var(--text); }
.done { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-weight: 500; }
.done svg { width: 16px; height: 16px; color: var(--accent); }
`;
