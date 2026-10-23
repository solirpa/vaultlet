#!/usr/bin/env node
// Release build of the desktop app (with the native messaging host sidecar) for distribution.
//
// Rust embeds absolute source paths in the binaries (panic locations), which would leak the
// builder's user name and checkout location, e.g. C:\Users\<name>\.cargo\registry\... .
// Remap them to neutral prefixes before building.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// C dependencies (aws-lc-sys) bake __FILE__ paths into the binary too, and the remap below does
// not reach the C compiler. Keep the crate sources out of the home directory instead.
const cargoHome = join(root, 'target', 'cargo-home');

// When several prefixes match, rustc applies the last one, so go from general to specific.
const remaps = [
  [homedir(), '~'],
  process.env.RUSTUP_HOME && [resolve(process.env.RUSTUP_HOME), '~/.rustup'],
  [root, 'vaultlet'],
  [cargoHome, 'cargo'],
].filter(Boolean);
const flags = remaps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
// The encoded form survives spaces in paths, unlike RUSTFLAGS.
const env = { ...process.env, CARGO_HOME: cargoHome, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') };
delete env.RUSTFLAGS;

execFileSync(process.execPath, [join(root, 'scripts/prepare-host.mjs')], { cwd: root, env, stdio: 'inherit' });
// pnpm is a .cmd shim on Windows, which needs a shell to launch.
execFileSync('pnpm', ['tauri', 'build', '--config', 'src-tauri/tauri.bundle.conf.json'], {
  cwd: join(root, 'apps/desktop'),
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
