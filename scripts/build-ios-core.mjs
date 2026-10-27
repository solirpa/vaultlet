#!/usr/bin/env node
// Build the Rust core (crates/vault-ffi) for iOS and generate its Swift bindings:
//   apps/ios/Frameworks/VaultFFI.xcframework   (device + simulator static libraries, C header, module map)
//   apps/ios/Generated/vault_ffi.swift         (UniFFI Swift bindings)
// then regenerate apps/ios/Vaultlet.xcodeproj from apps/ios/project.yml when XcodeGen is installed.
// Needs Xcode, and `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ios = join(root, 'apps/ios');
const out = join(root, 'target/ios');
const debug = process.argv.includes('--debug');
const profile = debug ? 'debug' : 'release';

const env = { ...process.env, IPHONEOS_DEPLOYMENT_TARGET: '17.0' };
if (!debug) {
  // As in build-release.mjs: keep the builder's home and checkout paths out of the library.
  const cargoHome = join(root, 'target', 'cargo-home');
  const remaps = [
    [homedir(), '~'],
    env.RUSTUP_HOME && [resolve(env.RUSTUP_HOME), '~/.rustup'],
    [root, 'vaultlet'],
    [cargoHome, 'cargo'],
  ].filter(Boolean);
  env.CARGO_HOME = cargoHome;
  env.CARGO_ENCODED_RUSTFLAGS = remaps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`).join('\x1f');
  delete env.RUSTFLAGS;
}
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, env, stdio: 'inherit', ...opts });
const lib = (target) => join(root, 'target', target, profile, 'libvault_ffi.a');

// 1. Static libraries: one for devices, one universal for the simulator.
const device = 'aarch64-apple-ios';
const simulators = ['aarch64-apple-ios-sim', 'x86_64-apple-ios'];
for (const target of [device, ...simulators]) {
  run('cargo', ['build', '-p', 'vault-ffi', '--lib', '--target', target, ...(debug ? [] : ['--release'])]);
}
mkdirSync(join(out, 'sim'), { recursive: true });
const simLib = join(out, 'sim', 'libvault_ffi.a');
run('lipo', ['-create', ...simulators.map(lib), '-output', simLib]);

// 2. Swift bindings and the C header/module map for the xcframework.
const gen = join(out, 'gen');
rmSync(gen, { recursive: true, force: true });
run('cargo', [
  'run', '-q', '-p', 'vault-ffi', '--features', 'bindgen', '--bin', 'uniffi-bindgen', '--',
  'generate', '--library', lib(device), '--language', 'swift', '--out-dir', gen, '--no-format',
]);
const headers = join(out, 'headers');
rmSync(headers, { recursive: true, force: true });
mkdirSync(headers, { recursive: true });
copyFileSync(join(gen, 'vault_ffiFFI.h'), join(headers, 'vault_ffiFFI.h'));
renameSync(join(gen, 'vault_ffiFFI.modulemap'), join(headers, 'module.modulemap'));
mkdirSync(join(ios, 'Generated'), { recursive: true });
copyFileSync(join(gen, 'vault_ffi.swift'), join(ios, 'Generated', 'vault_ffi.swift'));

// 3. The xcframework the Xcode targets link against.
const framework = join(ios, 'Frameworks', 'VaultFFI.xcframework');
rmSync(framework, { recursive: true, force: true });
mkdirSync(dirname(framework), { recursive: true });
run('xcodebuild', [
  '-create-xcframework',
  '-library', lib(device), '-headers', headers,
  '-library', simLib, '-headers', headers,
  '-output', framework,
]);

// 4. The Xcode project, when XcodeGen is around (brew install xcodegen).
try {
  execFileSync('xcodegen', ['--version'], { stdio: 'ignore' });
  run('xcodegen', ['generate', '--quiet'], { cwd: ios });
} catch {
  if (!existsSync(join(ios, 'Vaultlet.xcodeproj'))) {
    writeFileSync(join(ios, 'XCODEGEN_NEEDED.txt'), 'Install XcodeGen (brew install xcodegen) and run `xcodegen generate` in apps/ios.\n');
  }
}
console.log('iOS core ready: apps/ios/Frameworks/VaultFFI.xcframework + apps/ios/Generated/vault_ffi.swift');
