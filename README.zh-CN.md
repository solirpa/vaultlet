# Vaultlet

[English](README.md) | 简体中文

Local-first 密码管理器，Bitwarden 的无服务器平替。

- Vault 是标准 **KDBX 4** 文件（Argon2id + AES-256），可与 KeePassXC / Strongbox / KeePassium / KeePassDX 互通，手机端直接用这些客户端。
- 多设备同步靠网盘：把 vault 放进 iCloud Drive / Dropbox / OneDrive 目录，或配置坚果云 WebDAV；冲突按条目级时间戳合并。
- 桌面端：Tauri 2 + React，支持 macOS / Windows / Linux。
- Android 应用：Kotlin + Jetpack Compose，复用同一个 Rust 核心；支持在其他应用和浏览器中自动填充、指纹解锁、WebDAV 同步。手机和平板都适配（宽屏下列表与条目并排）。
- iOS 应用：SwiftUI，复用同一个 Rust 核心，支持 iPhone 和 iPad；Safari 和各应用内的密码自动填充、面容 / 触控 ID 解锁，密码库可放在 iCloud 云盘（通过「文件」App）或 WebDAV。
- 浏览器插件：Chrome / Edge / Brave / Firefox，通过 Native Messaging 与桌面端通信，密钥不离开桌面进程。
- 导入 Bitwarden 导出（JSON / CSV / 密码保护 JSON），支持 TOTP。

> **状态：** 个人项目，尚未经过独立的安全审计。使用风险自负，请定期备份 vault 文件。发现安全漏洞请私下报告，见 [SECURITY.md](SECURITY.md)。

| 浅色 | 深色 |
|---|---|
| ![](docs/screenshots/main-light.jpg) | ![](docs/screenshots/main-dark.jpg) |

## 目录

| 路径 | 内容 |
|---|---|
| `crates/vault-core` | 核心库：KDBX 读写、数据模型、导入、TOTP、URL 匹配、合并、WebDAV |
| `crates/vault-cli` | 调试 CLI |
| `crates/vault-ipc` | 桌面端与 native host 共用的 socket 命名与帧格式 |
| `crates/native-host` | 浏览器 native messaging host（纯代理） |
| `crates/vault-ffi` | 给移动端用的 vault-core（UniFFI 绑定） |
| `apps/desktop` | Tauri 桌面端（`src/` 前端，`src-tauri/` 后端） |
| `apps/extension` | 浏览器插件 |
| `apps/android` | Android 应用（Kotlin、Jetpack Compose） |
| `apps/ios` | iOS 应用（Swift、SwiftUI）及其密码自动填充扩展 |
| `docs/ARCHITECTURE.md` | 架构与接口契约 |

## 使用

### 桌面端

```bash
cd apps/desktop && pnpm install && pnpm tauri:dev
```

首次启动：选择 vault 的存放位置（本地目录、探测到的 iCloud Drive / Dropbox / OneDrive 目录，或坚果云 WebDAV），设置主密码。
然后在 设置 → 导入 里选 Bitwarden 导出文件（`.json` / `.csv` / 密码保护的 `.json`）。

打包成可安装的应用：`pnpm tauri:build`（产物在 `target/release/bundle/`；Windows 上生成 `.msi` 和 NSIS `-setup.exe`）。发布产物里会去掉构建路径和构建者的用户名。

macOS 版本没有用 Apple 开发者 ID 签名，从网上下载后 macOS 会提示"已损坏"。拖进"应用程序"后，执行一次下面的命令清除下载隔离标记即可打开：

```bash
xattr -cr /Applications/Vaultlet.app
```

Windows 构建需要 Rust（MSVC 工具链）和装了"使用 C++ 的桌面开发"工作负载的 Visual Studio / Build Tools；WebView2 运行时 Windows 11 自带。

### 浏览器插件

1. 桌面端 设置 → 浏览器集成，勾选你的浏览器，点"应用"（会写入 native messaging 清单）。
2. `cd apps/extension && pnpm install && pnpm build`，然后在浏览器里加载未打包的扩展：
   Chrome / Edge / Brave 用 `apps/extension/dist/chrome`，Firefox 用 `apps/extension/dist/firefox/manifest.json`。
3. 点插件图标 → "连接 Vaultlet"，在桌面端确认配对。

### Android

```bash
rustup target add aarch64-linux-android x86_64-linux-android
cargo install cargo-ndk
node scripts/build-android-core.mjs        # Rust 核心 -> app/src/main/jniLibs + Kotlin 绑定
cd apps/android && ./gradlew assembleDebug # 产物在 app/build/outputs/apk/debug/app-debug.apk
```

需要 Android SDK（compileSdk 37）和 NDK（`ANDROID_HOME`，或 `ANDROID_NDK_HOME`），以及 JDK 17+。首次启动填写 WebDAV 服务器（例如坚果云和应用密码）、密码库在服务器上的路径和主密码。加密后的密码库会缓存在手机上，离线也能解锁；修改在后台同步。在 设置 → 密码和账号 → 自动填充服务 里开启自动填充。网页域名只信任已知浏览器上报的；其他应用按包名匹配（`androidapp://<包名>`，与 Bitwarden 的存法一致）。

平板、折叠屏和分屏（宽度 700 dp 及以上）下，列表固定在左侧，打开的条目显示在右侧。

### iOS

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
brew install xcodegen                      # 可选：从 project.yml 重新生成 apps/ios/Vaultlet.xcodeproj
node scripts/build-ios-core.mjs            # Rust 核心 -> apps/ios/Frameworks/VaultFFI.xcframework + Swift 绑定
open apps/ios/Vaultlet.xcodeproj           # 然后在 iPhone 或 iPad 上运行 Vaultlet scheme
```

需要 Xcode 16 及以上（iOS 17+）。在 Signing & Capabilities 里给 `Vaultlet` 和 `VaultletAutoFill` 两个 target 选好开发团队：App Group（`group.com.vaultlet.ios`）和自动填充能力都需要；没有的话应用也能运行，只是自动填充扩展看不到密码库。

首次启动选择密码库的来源：Mac 通过 iCloud 云盘同步的那个 `.kdbx`（在「文件」App 里选，修改会合并回同一个文件），或像 Android 一样连接 WebDAV。加密后的密码库会缓存在设备上，离线也能解锁。在 设置 → 通用 → 自动填充与密码 里打开 Vaultlet，之后 Safari 和各应用的键盘上方会直接推荐登录信息，扩展用面容 / 触控 ID 解锁。iPad 上列表与打开的条目并排显示。

### 命令行

```bash
cargo run -p vault-cli -- import-bitwarden ~/Vaultlet.kdbx ~/Downloads/bitwarden_export.json
cargo run -p vault-cli -- ls ~/Vaultlet.kdbx
cargo run -p vault-cli -- totp ~/Vaultlet.kdbx GitHub
```

主密码通过 `--password`、环境变量 `VAULTLET_PASSWORD` 或交互提示给出。

### 把真实数据脱敏成测试数据

```bash
python3 -I scripts/sanitize-bitwarden.py <导出文件所在目录> <输出目录>
```

只用标准库、不联网；替换所有值但保留结构（类型、字段组合、URL 形状、文件夹层级、TOTP 格式）。

## 开发

```bash
# 核心库与 CLI
cargo test -p vault-core
cargo run -p vault-cli -- --help

# 桌面后端端到端测试（Tauri mock runtime，不开窗口）
cargo test -p vaultlet

# 桌面端
cd apps/desktop && pnpm install && pnpm tauri dev

# 浏览器插件
cd apps/extension && pnpm install && pnpm build   # 产物在 dist/chrome 与 dist/firefox
```

CI 会在每次 push 和 PR 时在 macOS / Windows / Linux 上跑测试。推送 `v0.1.0` 这样的 tag 会构建三个平台的安装包和插件 zip，并附到一个 GitHub Release 草稿上。

## 安全

请不要在公开 issue 里报告安全漏洞。私下报告的方式和安全设计概要见 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)
