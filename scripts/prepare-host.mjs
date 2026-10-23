#!/usr/bin/env node
// Build the native messaging host in release mode and place it where Tauri expects a sidecar
// (apps/desktop/src-tauri/binaries/vaultlet-host-<target triple>[.exe]).
// Plain Node so it runs the same from pnpm on macOS, Linux and Windows.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const triple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (\S+)/m)[1];
execFileSync('cargo', ['build', '--release', '-p', 'vaultlet-host', '--manifest-path', join(root, 'Cargo.toml')], {
  stdio: 'inherit',
});
const ext = triple.includes('windows') ? '.exe' : '';
const outDir = join(root, 'apps/desktop/src-tauri/binaries');
mkdirSync(outDir, { recursive: true });
copyFileSync(join(root, `target/release/vaultlet-host${ext}`), join(outDir, `vaultlet-host-${triple}${ext}`));
console.log(`sidecar ready: binaries/vaultlet-host-${triple}${ext}`);
