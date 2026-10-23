# Vaultlet

Local-first 密码管理器，Bitwarden 的无服务器平替。

- Vault 是标准 **KDBX 4** 文件（Argon2id + AES-256），可与 KeePassXC / Strongbox / KeePassium / KeePassDX 互通，手机端直接用这些客户端。
- 多设备同步靠网盘：把 vault 放进 iCloud Drive / Dropbox / OneDrive 目录，或配置坚果云 WebDAV；冲突按条目级时间戳合并。
- 桌面端：Tauri 2 + React，支持 macOS / Windows / Linux。
- 浏览器插件：Chrome / Edge / Brave / Firefox，通过 Native Messaging 与桌面端通信，密钥不离开桌面进程。
- 导入 Bitwarden 导出（JSON / CSV / 密码保护 JSON），支持 TOTP。

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
| `apps/desktop` | Tauri 桌面端（`src/` 前端，`src-tauri/` 后端） |
| `apps/extension` | 浏览器插件 |
| `docs/ARCHITECTURE.md` | 架构与接口契约 |

## 使用

### 桌面端

```bash
cd apps/desktop && pnpm install && pnpm tauri:dev
```

首次启动：选择 vault 的存放位置（本地目录、探测到的 iCloud Drive / Dropbox / OneDrive 目录，或坚果云 WebDAV），设置主密码。
然后在 设置 → 导入 里选 Bitwarden 导出文件（`.json` / `.csv` / 密码保护的 `.json`）。

打包成可安装的应用：`pnpm tauri:build`（产物在 `target/release/bundle/`）。

### 浏览器插件

1. 桌面端 设置 → 浏览器集成，勾选你的浏览器，点"应用"（会写入 native messaging 清单）。
2. `cd apps/extension && pnpm install && pnpm build`，然后在浏览器里加载未打包的扩展：
   Chrome / Edge / Brave 用 `apps/extension/dist/chrome`，Firefox 用 `apps/extension/dist/firefox/manifest.json`。
3. 点插件图标 → "连接 Vaultlet"，在桌面端确认配对。

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
