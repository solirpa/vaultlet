// Language switch (English is in the HTML; Chinese below) and platform detection.
const zh = {
  'nav.features': '功能', 'nav.how': '工作原理', 'nav.download': '下载', 'nav.faq': '常见问题',
  'hero.eyebrow': '开源 · MIT · 本地优先',
  'hero.title': '你的密码，<br>你的文件，<br>你的云。',
  'hero.lead': 'Vaultlet 把整个密码库存成一个属于你的加密文件，通过你已经在用的网盘或 WebDAV 同步。没有账号，没有服务器，只信任你自己的设备。',
  'hero.download': '下载', 'hero.watch': '看 4 分钟介绍',
  'hero.platforms': 'macOS · Windows · Linux · Android · Chrome · Edge · Brave · Firefox',
  'trust.format': '标准 KDBX 4 文件', 'trust.compat': 'KeePassXC、KeePassium、Strongbox、KeePassDX 都能打开',
  'video.title': '四分钟看完', 'video.sub': '桌面端、WebDAV 同步、浏览器插件、通行密钥、Android，以及电脑和手机之间的实时同步，全部用演示数据录自真实应用。',
  'features.title': '密码管理器该有的都有，只是不需要服务器。',
  'f1.kicker': '同步方式由你定', 'f1.title': '一个加密文件，放在你选的地方',
  'f1.body': '把密码库放进 iCloud Drive、Dropbox 或 OneDrive 目录，或者连接坚果云、Nextcloud 等 WebDAV 服务器。离开设备的永远只是加密文件。',
  'f1.l1': '多台设备的修改按条目合并，旧版本进入历史记录', 'f1.l2': '离线也能用，恢复联网后自动上传', 'f1.l3': 'WebDAV 应用密码保存在系统钥匙串里',
  'f2.kicker': '桌面端', 'f2.title': '快速、安静、原生',
  'f2.body': '适用于 macOS、Windows 和 Linux 的简洁应用：边输入边搜索，实时显示两步验证码，一键复制。',
  'f2.l1': '密码生成器、文件夹、收藏和自定义字段', 'f2.l2': '从 Chrome、Edge、Brave、Firefox、Safari 或 Bitwarden 导入', 'f2.l3': '自动锁定、自动清空剪贴板；浅色和深色主题',
  'f3.kicker': '浏览器插件', 'f3.title': '在需要的地方填充、保存和编辑登录',
  'f3.body': '在登录页，Vaultlet 推荐对应的账号，点一下就填好；在新网站注册，它会提示保存登录。弹窗里可以搜索、复制验证码、编辑登录、生成密码。',
  'f3.l1': '支持 Chrome、Edge、Brave 和 Firefox', 'f3.l2': '通过配对后的加密通道与桌面端通信',
  'f4.kicker': '通行密钥', 'f4.title': '通行密钥，存在你自己的密码库里',
  'f4.body': '在网站上创建通行密钥时，Vaultlet 把它和登录信息存在一起；下次直接用它登录。私钥从不离开桌面端，签名前会先核对网站。',
  'f4.l1': '采用 KeePassXC 的通行密钥格式', 'f4.l2': '从 Bitwarden 导入的通行密钥也能用',
  'f5.kicker': 'Android', 'f5.title': '手机上也是同一个密码库',
  'f5.body': '指纹解锁，浏览、复制、查看实时验证码，还能在其他应用里自动填充。密码库通过 WebDAV 同步，在手机上也保持加密，离线可用。',
  'f5.l1': '指纹密钥存在 Android Keystore，指纹变更后自动失效', 'f5.l2': '禁止截屏，剪贴板 30 秒后清空', 'f5.l3': 'iPhone 和 iPad 上可以用 KeePassium 或 Strongbox 打开同一个文件',
  'how.title': '插件是怎么拿到密码的', 'how.sub': '密码库和密钥只在桌面端，插件只拿到你要求填充的那一条。',
  'how.n1': '网页', 'how.n2': 'Vaultlet 插件', 'how.e2': 'Native Messaging', 'how.e3': '本地套接字', 'how.n4': 'Vaultlet 桌面端', 'how.n4s': '密码库 + 密钥',
  'how.p1t': '配对由你批准', 'how.p1': '第一次使用时，插件发起连接，你在桌面端批准。',
  'how.p2t': '端到端加密', 'how.p2': '每条消息都用 NaCl box（X25519 + XSalsa20-Poly1305）加密，中间的 host 只转发字节。',
  'how.p3t': '锁定就是锁定', 'how.p3': '桌面端锁定时，插件什么都填不了、读不到。',
  'dl.title': '下载 Vaultlet', 'dl.sub': '免费开源。桌面端和插件都由 GitHub Actions 从源码构建。',
  'dl.win': '安装程序（.exe）或 .msi', 'dl.mac': 'Apple 芯片（.dmg）', 'dl.android': 'APK，Android 8.0 及以上', 'dl.chrome': '插件（.zip）', 'dl.firefox': '插件（.zip）',
  'dl.n1t': 'macOS 首次打开', 'dl.n1': '应用暂未使用 Apple 开发者 ID 签名，所以 macOS 会提示下载的副本"已损坏"。拖进"应用程序"后执行一次：',
  'dl.n2t': '浏览器插件', 'dl.n2': '插件还没上架商店。解压后，在 Chrome / Edge / Brave 的扩展程序页面打开开发者模式，选择"加载已解压的扩展程序"；Firefox 在 about:debugging 里作为临时附加组件加载。然后点插件图标选择连接，在桌面端批准（需要先在 设置 → 浏览器集成 里应用一次）。',
  'dl.n3t': 'Android', 'dl.n3': '允许从你打开 APK 的应用安装。坚果云请使用 账户信息 → 安全选项 里生成的应用密码，而不是登录密码。在 设置 → 密码和账号 → 自动填充服务 里开启自动填充。',
  'faq.title': '常见问题',
  'faq.q1': 'Vaultlet 会把我的密码上传到哪里吗？', 'faq.a1': '不会。Vaultlet 没有服务器，也没有账号。加解密都在你的设备上完成，同步只是把加密文件复制到你选的目录或 WebDAV 服务器。',
  'faq.q2': '忘了主密码怎么办？', 'faq.a2': '没有人能找回，包括我们：密码库是用由它派生的密钥加密的。请妥善保管主密码，并定期备份密码库文件。',
  'faq.q3': '能在 iPhone 或 iPad 上用吗？', 'faq.a3': '暂时没有 iOS 应用。密码库是标准 KDBX 4 文件，可以用 KeePassium 或 Strongbox 从同一个网盘目录打开。',
  'faq.q4': '能导入已有的密码吗？', 'faq.a4': '可以：导入浏览器导出的 CSV（Chrome、Edge、Brave、Firefox、Safari），或者 Bitwarden 导出文件，通行密钥和两步验证密钥也会一起导入。重复导入只会加入新的内容。其他 KeePass 应用的 KDBX 4 文件可以直接打开。',
  'faq.q5': 'Vaultlet 经过安全审计吗？', 'faq.a5': '还没有。这是一个基于标准格式和成熟库的个人开源项目；欢迎阅读代码，发现漏洞请按 SECURITY.md 的方式私下报告。',
  'footer.license': '以 MIT 许可证开源。', 'footer.releases': '版本发布', 'footer.security': '安全',
};
const meta = {
  en: { title: 'Vaultlet — a local-first password manager', toggle: '中文', mine: 'Your system', downloadFor: (os) => `Download for ${os}` },
  zh: { title: 'Vaultlet — 本地优先的密码管理器', toggle: 'English', mine: '你的系统', downloadFor: (os) => `下载 ${os} 版` },
};

const nodes = [...document.querySelectorAll('[data-i18n]')];
const en = Object.fromEntries(nodes.map((n) => [n.dataset.i18n, n.innerHTML]));

function storage(fn) {
  try { return fn(window.localStorage); } catch { return null; }
}

function detectOs() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return ['android', 'Android'];
  if (/iPhone|iPad|iPod/i.test(ua)) return [null, null];
  if (/Windows/i.test(ua)) return ['windows', 'Windows'];
  if (/Mac/i.test(ua)) return ['mac', 'macOS'];
  if (/Linux/i.test(ua)) return ['linux', 'Linux'];
  return [null, null];
}
const [osKey, osName] = detectOs();

function apply(lang) {
  const dict = lang === 'zh' ? zh : en;
  for (const n of nodes) {
    const v = dict[n.dataset.i18n] ?? en[n.dataset.i18n];
    if (v !== undefined) n.innerHTML = v;
  }
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = meta[lang].title;
  document.getElementById('lang-toggle').textContent = meta[lang].toggle;

  const video = document.getElementById('promo');
  const src = `media/vaultlet-promo-${lang}.mp4`;
  if (!video.currentSrc.endsWith(src)) {
    video.poster = `assets/poster-${lang}.jpg`;
    video.querySelector('source').src = src;
    video.load();
  }

  if (osKey) {
    const card = document.querySelector(`.dl[data-os="${osKey}"]`);
    card?.classList.add('mine');
    card?.setAttribute('data-mine', meta[lang].mine);
    card?.querySelector('h4')?.setAttribute('data-mine', meta[lang].mine);
    document.getElementById('hero-download').textContent = meta[lang].downloadFor(osName);
  }
}

let lang = new URLSearchParams(location.search).get('lang')
  ?? storage((s) => s.getItem('vaultlet-lang'))
  ?? (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en');
if (lang !== 'zh') lang = 'en';
apply(lang);

document.getElementById('lang-toggle').addEventListener('click', () => {
  lang = lang === 'zh' ? 'en' : 'zh';
  storage((s) => s.setItem('vaultlet-lang', lang));
  apply(lang);
});
