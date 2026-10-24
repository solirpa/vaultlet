# Vaultlet — 架构与接口契约

Vaultlet 是一个 local-first 的密码管理器，定位是 Bitwarden 的无服务器平替。
所有加解密在客户端完成，vault 是一个标准 **KDBX 4** 文件，多设备同步靠网盘搬运密文。

工作名 `Vaultlet`，bundle id `com.vaultlet.app`，native messaging host 名 `com.vaultlet.host`。

## 目录

```
crates/vault-core        Rust 核心库：KDBX 读写、数据模型、Bitwarden 导入、TOTP、URL 匹配、合并、WebDAV
crates/vault-cli         调试用 CLI（vaultlet-cli）
crates/native-host       浏览器 native messaging host（stdio <-> 本地 socket 的代理，无任何业务逻辑）
apps/desktop             Tauri 2 桌面端（src/ 前端 React，src-tauri/ 后端）
apps/extension           浏览器插件（MV3，Chrome/Edge/Brave + Firefox）
docs/                    文档
```

## 1. 核心数据模型（vault-core）

核心库对外暴露自己的模型，不把 keepass crate 的类型泄露出去。KDBX 只是存储格式。

```rust
pub enum ItemKind { Login, Note, Card, Identity }

pub struct Field { pub name: String, pub value: String, pub protected: bool }

pub struct Item {
    pub id: Uuid,
    pub kind: ItemKind,
    pub title: String,
    pub username: String,        // Login
    pub password: String,        // Login（protected）
    pub urls: Vec<String>,       // Login，第一个是主 URL
    pub totp: Option<String>,    // otpauth:// URI 或裸 base32 secret
    pub notes: String,
    pub fields: Vec<Field>,      // 自定义字段；Card/Identity 的结构化字段也放这里
    pub folder: Option<Uuid>,    // 所属 Folder（KDBX Group），None = 根
    pub favorite: bool,
    pub tags: Vec<String>,
    pub created: DateTime<Utc>,
    pub modified: DateTime<Utc>,
    pub last_used: Option<DateTime<Utc>>,
    pub deleted: bool,           // 在回收站（KDBX 的 "Recycle Bin" Group）
}

pub struct Folder { pub id: Uuid, pub name: String, pub parent: Option<Uuid> }
```

### KDBX 映射约定（必须和 KeePassXC / Strongbox / KeePassium 互通）

| Item 字段 | KDBX Entry |
|---|---|
| title / username / password / notes | 标准字段 `Title` / `UserName` / `Password` / `Notes` |
| urls[0] | `URL` |
| urls[1..] | 自定义字段 `KP2A_URL_1`, `KP2A_URL_2`…（KeePass2Android 约定，KeePassXC 也认） |
| totp | 自定义字段 `otp`（值为 `otpauth://totp/...` URI，protected） |
| kind | 自定义字段 `_vaultlet_kind` = `login`/`note`/`card`/`identity`；缺省按 login |
| favorite | tag `Favorite` |
| fields | 其余自定义字段原样映射，protected 标记保留 |
| last_used | `Times/LastAccessTime` |
| deleted | Entry 位于 Meta.RecycleBinUUID 指向的 Group 下 |
| Card 字段 | 自定义字段 `cardholderName` `number`(protected) `brand` `expMonth` `expYear` `code`(protected) |
| Identity 字段 | 自定义字段 `firstName` `lastName` `email` `phone` `address1` … 等，名字沿用 Bitwarden JSON 字段名 |

Folder = KDBX Group。根 Group 的名字是数据库名。回收站 Group 由核心库在需要时创建并写入 Meta.RecycleBinUUID。

## 2. vault-core 对外 API

```rust
pub struct Vault { ... }          // 已解锁的内存数据库

impl Vault {
    pub fn create(name: &str) -> Vault;
    pub fn open(bytes: &[u8], key: &Credentials) -> Result<Vault>;
    pub fn save(&mut self, key: &Credentials) -> Result<Vec<u8>>;   // 序列化为 KDBX4（Argon2id + AES256 或 ChaCha20）
    pub fn items(&self) -> Vec<Item>;                 // 含 deleted
    pub fn item(&self, id: Uuid) -> Option<Item>;
    pub fn upsert_item(&mut self, item: Item) -> Result<()>;   // 新建或修改；自动更新 modified；修改时写入 History
    pub fn delete_item(&mut self, id: Uuid) -> Result<()>;     // 移到回收站
    pub fn restore_item(&mut self, id: Uuid) -> Result<()>;
    pub fn purge_item(&mut self, id: Uuid) -> Result<()>;      // 彻底删除，写 DeletedObjects
    pub fn folders(&self) -> Vec<Folder>;
    pub fn upsert_folder(&mut self, f: Folder) -> Result<()>;
    pub fn delete_folder(&mut self, id: Uuid) -> Result<()>;   // 其中条目移到回收站
    pub fn touch_used(&mut self, id: Uuid);
    pub fn merge_from(&mut self, other: &Vault) -> MergeReport; // 见第 5 节
    pub fn change_key(...);
}

pub struct Credentials { pub password: Option<String>, pub keyfile: Option<Vec<u8>> }

pub mod totp {
    pub struct Code { pub code: String, pub period: u32, pub remaining: u32 }
    pub fn generate(secret_or_uri: &str, now: SystemTime) -> Result<Code>;   // 支持 otpauth:// 与裸 base32；SHA1/256/512，6/7/8 位
}

pub mod matching {
    /// 给定页面 URL 返回匹配的条目，按匹配强度排序：完全 host 匹配 > 同 eTLD+1 > 其它。
    /// 用 psl 做 eTLD+1；忽略 scheme 差异；端口相同优先。
    pub fn match_items<'a>(items: &'a [Item], page_url: &str) -> Vec<&'a Item>;
}

pub mod import {
    pub enum BitwardenSource { Json(String), Csv(String), EncryptedJson { json: String, password: String } }
    pub struct ImportResult { pub items: Vec<Item>, pub folders: Vec<Folder>, pub skipped: Vec<String> }
    pub fn bitwarden(src: BitwardenSource) -> Result<ImportResult>;
    pub fn apply(vault: &mut Vault, r: &ImportResult) -> usize;   // 写入 vault，folder 按名字去重
}

pub mod sync { /* 第 4 节 */ }
```

### Bitwarden 导出格式要点

- 明文 JSON：`{ encrypted:false, folders:[{id,name}], items:[{id,type,name,notes,favorite,folderId,login:{uris:[{uri,match}],username,password,totp},fields:[{name,value,type}],card:{...},identity:{...},secureNote:{}}] }`，type 1=login 2=note 3=card 4=identity；fields.type 0=text 1=hidden 2=boolean 3=linked。
- CSV：表头 `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp`；fields 是 `name: value` 换行分隔。
- 密码保护 JSON：`{ encrypted:true, passwordProtected:true, salt, kdfType(0=PBKDF2-SHA256,1=Argon2id), kdfIterations, kdfMemory, kdfParallelism, encKeyValidation_DO_NOT_EDIT, data }`。
  派生：PBKDF2(password, salt, iterations) 或 Argon2id(password, SHA256(salt), mem MiB, iter, par) 得 32 字节 master key；
  HKDF-Expand(master, "enc") → encKey 32 字节，HKDF-Expand(master, "mac") → macKey 32 字节（HKDF-SHA256，无 extract）；
  EncString 格式 `2.<iv b64>|<ct b64>|<mac b64>`：AES-256-CBC + HMAC-SHA256(iv||ct)；先验 encKeyValidation 再解 data，data 解出来就是明文 JSON。

## 3. 存储布局与应用设置（桌面端）

- 设置文件：`<app_config_dir>/settings.json`，由 Tauri 后端读写。
- 设置结构：

```ts
type SyncMode = 'folder' | 'webdav';
interface Settings {
  vault: {
    mode: SyncMode;
    path?: string;            // folder 模式：kdbx 文件完整路径（可以在 iCloud/Dropbox/OneDrive 目录下）
    webdav?: { url: string; username: string; remotePath: string; };   // 密码存在系统钥匙串（keyring crate），不落 settings.json
  };
  security: { autoLockMinutes: number; clearClipboardSeconds: number; lockOnSleep: boolean; };
  browserIntegration: { chrome: boolean; edge: boolean; brave: boolean; firefox: boolean; chromium: boolean; };
  ui: { theme: 'system' | 'light' | 'dark'; language: 'zh-CN' | 'en'; };
}
```

- WebDAV 模式本地缓存：`<app_data_dir>/vault.kdbx` + `<app_data_dir>/vault.etag`。
- 已配对浏览器：`<app_config_dir>/paired.json`，`[{ clientId, publicKey(b64), name, pairedAt }]`；应用自身的 X25519 密钥对存系统钥匙串。

### 网盘目录自动探测（folder 模式的快捷选项）

| 网盘 | macOS | Windows | Linux |
|---|---|---|---|
| iCloud Drive | `~/Library/Mobile Documents/com~apple~CloudDocs` | `%USERPROFILE%\iCloudDrive` | 不支持 |
| Dropbox | `~/Dropbox`，或读 `~/.dropbox/info.json` 的 `personal.path` | `%USERPROFILE%\Dropbox`，或 `%LOCALAPPDATA%\Dropbox\info.json` | `~/Dropbox` |
| OneDrive | `~/OneDrive` 或 `~/Library/CloudStorage/OneDrive-*` | `%OneDrive%` 环境变量 | 无官方客户端 |
| 坚果云 | WebDAV `https://dav.jianguoyun.com/dav/`，账号 + 应用密码 | 同左 | 同左 |

探测到的目录在 UI 里显示为可选项，缺省文件名 `Vaultlet.kdbx`。

## 4. 同步与冲突合并

### folder 模式
- 后端用 `notify` 监听 vault 文件；外部变化（网盘同步下来）时：读新文件 → `merge_from` → 若合并后有本地未写入的变化则再保存。
- 保存前先检查文件 mtime/size 是否与上次读取时不同；不同则先合并再写，写入用"写临时文件 + rename"保证原子。
- 网盘自己产生的冲突副本（如 `Vaultlet (冲突).kdbx`、`Vaultlet (xxx's conflicted copy).kdbx`）不处理，但在 UI 的同步面板里列出来提示用户可以"合并并删除"。

### webdav 模式
- `sync::webdav::Client { url, username, password }`：`get(path) -> (bytes, etag)`、`put(path, bytes, if_match: Option<etag>) -> etag`、`exists`、`mkcol`。
- 同步流程：GET（带 If-None-Match 缓存的 etag）→ 有新版本则 merge → 有本地变更则 PUT（If-Match）→ 412 则重新 GET 合并重试，最多 3 次。
- 触发：解锁后、每次保存后、每 5 分钟、手动。
- 坚果云限制：WebDAV 需要在网页端生成"应用密码"；单文件足够小，不用考虑分片。

### merge_from 规则（两路合并，按 KeePass "Synchronize" 语义）
- 以 uuid 为键。两边都有：取 `modified` 更新的那份，旧的那份进 History。
- 只有一边有：若另一边 DeletedObjects 里有该 uuid 且 deletion time > 该条 modified → 视为已删除，否则保留。
- Folder 同理；回收站状态（所在 Group）随更新者。
- 返回 `MergeReport { added, updated, deleted, conflicts_resolved }`。

## 5. 桌面端 Tauri 命令接口（前端 ↔ src-tauri）

所有命令用 `invoke(name, args)`，返回值和错误都是 JSON。错误统一为 `{ code: string; message: string }`。
密码等敏感字段只在前端需要显示时才由后端返回。

```ts
// 状态
invoke('vault_status'): Promise<{ state: 'no-vault' | 'locked' | 'unlocked'; path?: string; mode: SyncMode; name?: string }>
invoke('vault_create', { path: string; password: string; name: string }): Promise<void>
invoke('vault_unlock', { password: string; keyfile?: string }): Promise<void>
invoke('vault_lock'): Promise<void>
invoke('vault_change_password', { current: string; next: string }): Promise<void>

// 条目（ItemSummary 不含 password/totp/fields/notes）
invoke('items_list'): Promise<ItemSummary[]>
invoke('item_get', { id }): Promise<Item>
invoke('item_save', { item: Item }): Promise<Item>           // id 为空字符串时新建
invoke('item_delete', { id }): Promise<void>                  // 进回收站
invoke('item_restore', { id }): Promise<void>
invoke('item_purge', { id }): Promise<void>
invoke('item_touch', { id }): Promise<void>
invoke('totp_now', { id }): Promise<{ code: string; period: number; remaining: number }>
invoke('password_generate', { length: number; upper: boolean; lower: boolean; digits: boolean; symbols: boolean }): Promise<string>

// 文件夹
invoke('folders_list'): Promise<Folder[]>
invoke('folder_save', { folder: Folder }): Promise<Folder>
invoke('folder_delete', { id }): Promise<void>

// 导入
invoke('import_bitwarden_preview', { path: string; password?: string }): Promise<{ items: number; folders: number; skipped: string[]; needsPassword: boolean }>
invoke('import_bitwarden', { path: string; password?: string }): Promise<{ imported: number }>

// 设置与同步
invoke('settings_get'): Promise<Settings>
invoke('settings_set', { settings: Settings }): Promise<void>
invoke('cloud_folders_detect'): Promise<{ provider: 'icloud'|'dropbox'|'onedrive'; path: string }[]>
invoke('webdav_set_password', { password: string }): Promise<void>
invoke('webdav_test', { url, username, password }): Promise<{ ok: boolean; message: string }>
invoke('sync_now'): Promise<SyncStatus>
invoke('sync_status'): Promise<SyncStatus>
// SyncStatus = { mode, lastSync?: string(ISO), state: 'idle'|'syncing'|'error'|'conflict', message?: string, conflictFiles: string[] }

// 浏览器集成
invoke('browser_integration_apply'): Promise<{ browser: string; ok: boolean; message?: string }[]>   // 按 settings 写/删 native host manifest
invoke('paired_browsers_list'): Promise<{ clientId: string; name: string; pairedAt: string }[]>
invoke('paired_browser_remove', { clientId }): Promise<void>
invoke('pairing_respond', { requestId: string; approve: boolean }): Promise<void>
```

后端 → 前端事件（`listen`）：
- `vault:locked`（自动锁定触发）
- `sync:status`（SyncStatus）
- `pairing:request`（`{ requestId, clientName }`，前端弹对话框，用 `pairing_respond` 回复）
- `items:changed`（外部合并导致数据变化，前端重新拉列表）

## 6. 浏览器集成协议

### 进程关系

```
browser extension  <-- native messaging (stdio, 4 字节小端长度前缀 + JSON) -->  native-host  <-- 本地 socket --> desktop app
```

- 本地 socket：macOS/Linux 为 `$XDG_RUNTIME_DIR/vaultlet.sock` 或 `~/Library/Application Support/com.vaultlet.app/vaultlet.sock`（mac）/ `/tmp/vaultlet-<uid>.sock`（linux 兜底）；Windows 为按用户区分的命名管道 `\\.\pipe\vaultlet-<域>.<用户名>`（可用 `VAULTLET_SOCKET` 覆盖管道名）。用 `interprocess` crate。
- socket 上的帧格式和 native messaging 一样（4 字节小端长度 + JSON），native-host 只做双向转发，桌面 app 没启动时 host 返回 `{ "error": "app-not-running" }`。
- Native host manifest：

```json
{ "name": "com.vaultlet.host", "description": "Vaultlet browser integration", "path": "<host 可执行文件绝对路径>", "type": "stdio",
  "allowed_origins": ["chrome-extension://<id>/"] }          // Firefox 用 "allowed_extensions": ["vaultlet@vaultlet.app"]
```

manifest 位置：
- macOS：`~/Library/Application Support/{Google/Chrome, Microsoft Edge, BraveSoftware/Brave-Browser, Chromium}/NativeMessagingHosts/com.vaultlet.host.json`；Firefox `~/Library/Application Support/Mozilla/NativeMessagingHosts/`
- Linux：`~/.config/{google-chrome, microsoft-edge, BraveSoftware/Brave-Browser, chromium}/NativeMessagingHosts/`；Firefox `~/.mozilla/native-messaging-hosts/`
- Windows：manifest 放 `%APPDATA%\Vaultlet\`，注册表 `HKCU\Software\{Google\Chrome, Microsoft\Edge, BraveSoftware\Brave-Browser, Chromium}\NativeMessagingHosts\com.vaultlet.host` 和 `HKCU\Software\Mozilla\NativeMessagingHosts\com.vaultlet.host` 默认值指向 json 路径。

Chrome 插件 ID 要固定：manifest 里带 `key`（公钥 base64），仓库里 `apps/extension/keys/` 存开发用密钥对，ID 写在 `apps/extension/EXTENSION_ID`。

### 消息协议（扩展 ↔ 桌面 app，经 host 透传）

加密用 NaCl box（X25519 + XSalsa20-Poly1305）：扩展端 tweetnacl，Rust 端 `crypto_box` crate（`crypto_box::SalsaBox`）。

1. 握手（明文）：扩展发 `{ "type": "hello", "clientId": "<uuid>", "publicKey": "<b64>", "clientName": "Chrome" }`；
   app 回 `{ "type": "hello", "publicKey": "<b64 app 公钥>", "paired": true|false, "version": "0.1.0" }`。
   app 若已知 clientId 但公钥不一致 → 回 `{ "type":"error", "code":"key-mismatch" }` 并断开。
2. 之后所有消息：`{ "clientId", "nonce": "<b64 24 字节>", "payload": "<b64 box(json)>" }`，双向同样封装。
3. 解密后的请求 / 响应（`id` 用于配对请求与响应）：

| 请求 | 响应 |
|---|---|
| `{ id, action:"associate" }` | app 弹出确认框；通过 → `{ id, ok:true }`，拒绝 → `{ id, ok:false, code:"rejected" }` |
| `{ id, action:"status" }` | `{ id, ok:true, locked: bool, vaultName }` |
| `{ id, action:"get-logins", url }` | 未配对 → `code:"not-paired"`；锁定 → `code:"locked"`；否则 `{ id, ok:true, entries:[{ id, title, username, password, totp: bool, url }] }`（用 matching 模块排序） |
| `{ id, action:"list" }` | `{ id, ok:true, entries:[{ id, title, username, url, totp: bool, favorite }] }`：全部未删除的登录条目，按标题排序，不含密码 |
| `{ id, action:"search", query }` | 同 list 的条目格式（不含密码）：标题、用户名或任一网址包含 query 的登录条目，按标题排序，最多 50 条 |
| `{ id, action:"get-entry", entryId }` | `{ id, ok:true, entry:{ id, title, username, password, totp: bool, url, urls, notes, favorite } }`：弹窗在用户点击填充/复制/查看详情时调用 |
| `{ id, action:"save-login", url, username, password, title?, entryId? }` | 有 entryId：更新该条目的用户名（非空时）和密码，旧版本进历史 → `{ id, ok:true, entryId, updated:true }`；无 entryId：新建登录条目，标题缺省为站点 host，网址为页面 origin → `{ id, ok:true, entryId, created:true }` |
| `{ id, action:"get-totp", entryId }` | `{ id, ok:true, code, remaining }` |
| `{ id, action:"touch", entryId }` | `{ id, ok:true }` |
| `{ id, action:"lock" }` | `{ id, ok:true }` |
| `{ id, action:"unlock-request" }` | app 把窗口带到前台显示解锁界面，`{ id, ok:true }` |
| `{ id, action:"passkey-list", origin, rpId, allowCredentials? }` | 校验 rpId 对 origin 合法（https 或 localhost，rpId 为 host 或其可注册的上级域，不能是公共后缀）→ `{ id, ok:true, entries:[{ entryId, title, username, credentialId }] }`：该 RP 的通行密钥，不含私钥；`allowCredentials`（base64url）非空时只返回其中的 |
| `{ id, action:"passkey-sign", origin, rpId, entryId, clientDataHash }` | 同样校验 rpId，且条目的 RP 必须等于 rpId；用 ES256 签 `authenticatorData ‖ clientDataHash` → `{ id, ok:true, credentialId, authenticatorData, signature, userHandle }`（均为 base64url）。私钥不离开桌面端 |

| `{ id, action:"passkey-create", origin, rpId, rpName?, userId, userName, entryId?, excludeCredentials? }` | 同样校验 rpId；`excludeCredentials` 中已有凭据在库里 → `code:"excluded"`；`entryId` 指向的条目已有通行密钥 → `code:"already-exists"`（绝不覆盖）。否则生成 P-256 密钥对，私钥存入该条目或新建的登录条目并写盘 → `{ id, ok:true, entryId, credentialId, authenticatorData, attestationObject, publicKey, publicKeyAlgorithm:-7 }`（"none" 证明，AAGUID 全零，`publicKey` 为 SPKI DER） |

`get-logins` 的条目另带 `passkey: bool`，表示该条目已有通行密钥。

通行密钥按 KeePassXC 格式存在条目的 `KPEX_PASSKEY_*` 字段里（凭据 ID 为 base64url；兼容旧导入留下的 Bitwarden GUID 形式）。扩展侧流程：页面世界的脚本包装 `navigator.credentials.get()` / `.create()`，经隔离世界的桥接脚本交给后台；后台用浏览器给出的发送方 URL 确定 origin、自己构造 clientDataJSON，并弹出扩展自己的确认窗口，用户选中后才请求签名。Vaultlet 里没有匹配的通行密钥、条件式（autofill）请求、跨源 iframe，以及注册时要求外部安全密钥或不接受 ES256 的，交还浏览器原生 WebAuthn。注册时确认窗口列出该站点尚无通行密钥的登录条目，缺省存为新条目。

app → 扩展主动推送：`{ action:"event", event:"locked" | "unlocked" | "items-changed" }`。

扩展侧：`clientId`、密钥对、app 公钥存在 `chrome.storage.local`。

## 7. UI 设计原则（桌面端）

- 三栏：左侧导航（全部 / 收藏 / 最近使用 / 回收站；按类型：登录、笔记、卡片、身份；文件夹树；底部同步状态与设置入口），中间列表（顶部搜索框 + 新建按钮，列表项：favicon 首字母头像、标题、用户名），右侧详情（可复制字段、密码显示切换、TOTP 带倒计时环、URL 可点击、备注、自定义字段、时间信息；编辑态为表单）。
- 解锁页：居中卡片，显示 vault 名与路径，密码框，"打开其它 vault / 新建 vault / 从 Bitwarden 导入"链接。
- 设置页：通用、Vault 与同步、浏览器集成、导入、安全。
- 视觉：跟随系统深浅色；中性灰 + 单一强调色（蓝）；圆角 8px；系统字体栈；macOS 透明标题栏（`titleBarStyle: overlay`）；无多余装饰。
- 中英双语，缺省跟随系统，字符串集中在 `src/i18n/`。
