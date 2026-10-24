#!/usr/bin/env node
// Build the Rust core (crates/vault-ffi) for Android and generate its Kotlin bindings:
//   apps/android/app/src/main/jniLibs/<abi>/libvault_ffi.so
//   apps/android/app/src/main/java/uniffi/vault_ffi/vault_ffi.kt
// Needs `cargo install cargo-ndk`, the Android NDK (ANDROID_NDK_HOME or $ANDROID_HOME/ndk/<version>)
// and `rustup target add aarch64-linux-android x86_64-linux-android`.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'apps/android/app/src/main');
const env = { ...process.env };
if (!env.ANDROID_NDK_HOME && env.ANDROID_HOME) {
  const ndkDir = join(env.ANDROID_HOME, 'ndk');
  const versions = existsSync(ndkDir) ? readdirSync(ndkDir).sort() : [];
  if (versions.length) env.ANDROID_NDK_HOME = join(ndkDir, versions.at(-1));
}
const run = (args) => execFileSync('cargo', args, { cwd: root, env, stdio: 'inherit' });

const debug = process.argv.includes('--debug');
const profile = debug ? [] : ['--release'];
run(['ndk', '-t', 'arm64-v8a', '-t', 'x86_64', '--platform', '26', '-o', join(app, 'jniLibs'), 'build', ...profile, '-p', 'vault-ffi']);
run([
  'run', '-q', '-p', 'vault-ffi', '--features', 'bindgen', '--bin', 'uniffi-bindgen', '--',
  'generate', '--library', join(root, 'target/x86_64-linux-android', debug ? 'debug' : 'release', 'libvault_ffi.so'),
  '--language', 'kotlin', '--out-dir', join(app, 'java'), '--no-format',
]);
console.log('Android core ready: jniLibs + uniffi bindings');
