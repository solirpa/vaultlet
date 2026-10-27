# Vaultlet

English | [简体中文](README.zh-CN.md)

A local-first password manager: a serverless alternative to Bitwarden.

- The vault is a standard **KDBX 4** file (Argon2id + AES-256), compatible with KeePassXC / Strongbox / KeePassium / KeePassDX, so on mobile you can use those clients directly.
- Sync across devices through your own cloud drive: put the vault in an iCloud Drive / Dropbox / OneDrive folder, or use a WebDAV server (e.g. Nutstore). Conflicts are merged per entry by timestamp.
- Desktop app: Tauri 2 + React, for macOS / Windows / Linux.
- Android app: Kotlin + Jetpack Compose on the same Rust core; autofill in apps and browsers, fingerprint unlock, WebDAV sync. Phones and tablets (list and item side by side on wide screens).
- iOS app: SwiftUI on the same Rust core, for iPhone and iPad; Password AutoFill in Safari and apps, Face ID / Touch ID unlock, the vault in iCloud Drive (via the Files app) or on WebDAV.
- Browser extension: Chrome / Edge / Brave / Firefox. It talks to the desktop app over Native Messaging; keys never leave the desktop process.
- Imports Bitwarden exports (JSON / CSV / password-protected JSON), with TOTP support.

> **Status:** a personal project that has not had an independent security audit. Use it at your own risk and keep backups of your vault file. Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

| Light | Dark |
|---|---|
| ![](docs/screenshots/main-light.jpg) | ![](docs/screenshots/main-dark.jpg) |

## Layout

| Path | Contents |
|---|---|
| `crates/vault-core` | Core library: KDBX read/write, data model, import, TOTP, URL matching, merge, WebDAV |
| `crates/vault-cli` | Debugging CLI |
| `crates/vault-ipc` | Socket naming and frame format shared by the desktop app and the native host |
| `crates/native-host` | Browser native messaging host (a pure proxy) |
| `crates/vault-ffi` | vault-core for the mobile apps (UniFFI bindings) |
| `apps/desktop` | Tauri desktop app (`src/` frontend, `src-tauri/` backend) |
| `apps/extension` | Browser extension |
| `apps/android` | Android app (Kotlin, Jetpack Compose) |
| `apps/ios` | iOS app (Swift, SwiftUI) with its Password AutoFill extension |
| `docs/ARCHITECTURE.md` | Architecture and interface contracts |

## Usage

### Desktop app

```bash
cd apps/desktop && pnpm install && pnpm tauri:dev
```

On first launch, choose where the vault lives (a local folder, a detected iCloud Drive / Dropbox / OneDrive folder, or WebDAV) and set a master password.
Then pick a Bitwarden export (`.json` / `.csv` / password-protected `.json`) under Settings → Import.

To build installable packages: `pnpm tauri:build` (output in `target/release/bundle/`; on Windows this produces an `.msi` and an NSIS `-setup.exe`). Build paths and the builder's user name are stripped from the release binaries.

The macOS release is not signed with an Apple Developer ID, so macOS reports a downloaded copy as "damaged". After moving it to Applications, clear the download quarantine once:

```bash
xattr -cr /Applications/Vaultlet.app
```

Building on Windows requires Rust (MSVC toolchain) and Visual Studio / Build Tools with the "Desktop development with C++" workload. The WebView2 runtime ships with Windows 11.

### Browser extension

1. In the desktop app, open Settings → Browser integration, tick your browsers and click Apply (this installs the native messaging manifests).
2. Run `cd apps/extension && pnpm install && pnpm build`, then load the unpacked extension in your browser:
   `apps/extension/dist/chrome` for Chrome / Edge / Brave, `apps/extension/dist/firefox/manifest.json` for Firefox.
3. Click the extension icon → "Connect to Vaultlet" and approve the pairing in the desktop app.

### Android

```bash
rustup target add aarch64-linux-android x86_64-linux-android
cargo install cargo-ndk
node scripts/build-android-core.mjs        # Rust core -> app/src/main/jniLibs + Kotlin bindings
cd apps/android && ./gradlew assembleDebug # app/build/outputs/apk/debug/app-debug.apk
```

Needs the Android SDK (compileSdk 37) and NDK (`ANDROID_HOME`, or `ANDROID_NDK_HOME`), and JDK 17+. On first launch, choose where the vault comes from: a `.kdbx` picked with the system file picker (Google Drive, 坚果云, OneDrive or any app that exposes files; changes merge back into the same file), or a WebDAV server (e.g. 坚果云 with an app password) with the vault's path on it. The encrypted vault is cached on the phone, so unlocking works offline; changes sync in the background. Turn on autofill in Settings → Passwords & accounts → Autofill service. Web page domains are only trusted from known browsers; other apps match by package name (`androidapp://<package>`, as Bitwarden stores it).

On tablets, foldables and in split-screen (700 dp and wider) the list stays on the left and the open item is shown next to it.

### iOS

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
brew install xcodegen                      # optional: regenerates apps/ios/Vaultlet.xcodeproj from project.yml
node scripts/build-ios-core.mjs            # Rust core -> apps/ios/Frameworks/VaultFFI.xcframework + Swift bindings
open apps/ios/Vaultlet.xcodeproj           # then run the Vaultlet scheme on an iPhone or iPad
```

Needs Xcode 16 or newer (iOS 17+). Set your development team under Signing & Capabilities for the `Vaultlet` and `VaultletAutoFill` targets: the app group (`group.com.vaultlet.ios`) and the AutoFill capability need one; without them the app still runs, but the AutoFill extension cannot see the vault.

On first launch choose where the vault lives: the `.kdbx` your Mac syncs through iCloud Drive (picked in the Files app; changes merge back into the same file), or a WebDAV server as on Android. The encrypted vault is cached on the device, so unlocking works offline. Turn on Password AutoFill in Settings → General → AutoFill & Passwords → Vaultlet; logins then show up in the QuickType bar in Safari and apps, and the extension unlocks with Face ID / Touch ID. On iPad the list and the open item sit side by side.

### Command line

```bash
cargo run -p vault-cli -- import-bitwarden ~/Vaultlet.kdbx ~/Downloads/bitwarden_export.json
cargo run -p vault-cli -- ls ~/Vaultlet.kdbx
cargo run -p vault-cli -- totp ~/Vaultlet.kdbx GitHub
```

The master password comes from `--password`, the `VAULTLET_PASSWORD` environment variable, or an interactive prompt.

### Turning real data into test data

```bash
python3 -I scripts/sanitize-bitwarden.py <export directory> <output directory>
```

Standard library only, no network access. Every value is replaced while the structure is kept (item types, field combinations, URL shapes, folder hierarchy, TOTP formats).

## Development

```bash
# Core library and CLI
cargo test -p vault-core
cargo run -p vault-cli -- --help

# Desktop backend end-to-end tests (Tauri mock runtime, no window)
cargo test -p vaultlet

# Desktop app
cd apps/desktop && pnpm install && pnpm tauri dev

# Browser extension
cd apps/extension && pnpm install && pnpm build   # output in dist/chrome and dist/firefox
```

CI runs the tests on macOS, Windows and Linux for every push and pull request. Pushing a tag such as `v0.1.0` builds installers for all three platforms plus the extension zips and attaches them to a draft GitHub release.

## Security

Please do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md) for how to report them privately and for an overview of the security design.

## License

[MIT](LICENSE)
