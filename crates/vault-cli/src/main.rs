//! `vaultlet-cli`: open, inspect and modify a Vaultlet/KeePass vault from the terminal.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};
use vault_core::import;
use vault_core::sync::folder::atomic_write;
use vault_core::{Credentials, Item, ItemKind, Vault};

#[derive(Parser)]
#[command(name = "vaultlet-cli", version, about = "Vaultlet command-line tool")]
struct Cli {
    /// Master password (or set VAULTLET_PASSWORD); prompted when omitted.
    #[arg(long, env = "VAULTLET_PASSWORD", global = true, hide_env_values = true)]
    password: Option<String>,
    /// Key file to use in addition to (or instead of) the password.
    #[arg(long, global = true)]
    keyfile: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create a new empty vault file.
    Create {
        file: PathBuf,
        #[arg(long, default_value = "Vaultlet")]
        name: String,
    },
    /// List items (title, username, first URL).
    Ls {
        file: PathBuf,
        #[arg(long)]
        trash: bool,
    },
    /// Show one item by id or title.
    Show { file: PathBuf, query: String },
    /// Add a login item.
    Add {
        file: PathBuf,
        #[arg(long)]
        title: String,
        #[arg(long, default_value = "")]
        username: String,
        #[arg(long, default_value = "")]
        item_password: String,
        #[arg(long)]
        url: Vec<String>,
        #[arg(long)]
        totp: Option<String>,
        #[arg(long)]
        folder: Option<String>,
    },
    /// Import an export: Chrome / Edge / Brave, Firefox or Safari CSV, or Bitwarden (.json,
    /// .csv or password-protected .json). Logins from browsers are matched by site and
    /// username, so importing again only adds what is new.
    #[command(alias = "import-bitwarden")]
    Import {
        file: PathBuf,
        export: PathBuf,
        /// The export's format (detected when omitted): chrome-csv, firefox-csv, safari-csv,
        /// bitwarden-json, bitwarden-encrypted-json or bitwarden-csv.
        #[arg(long)]
        format: Option<String>,
        /// Password of a password-protected export.
        #[arg(long)]
        import_password: Option<String>,
        /// Parse and report only; do not write.
        #[arg(long)]
        dry_run: bool,
    },
    /// Print the current TOTP code of an item.
    Totp { file: PathBuf, query: String },
    /// Merge another vault file into this one (same credentials unless --other-password).
    Merge {
        file: PathBuf,
        other: PathBuf,
        #[arg(long)]
        other_password: Option<String>,
    },
    /// Detect iCloud Drive / Dropbox / OneDrive folders on this machine.
    CloudFolders,
    /// Check a WebDAV server (e.g. 坚果云) accepts the credentials.
    WebdavTest {
        #[arg(long)]
        url: String,
        #[arg(long)]
        user: String,
        #[arg(long)]
        pass: String,
    },
}

fn creds(cli: &Cli, confirm: bool) -> Result<Credentials> {
    let keyfile = match &cli.keyfile {
        Some(p) => Some(std::fs::read(p).with_context(|| format!("reading key file {}", p.display()))?),
        None => None,
    };
    let password = match &cli.password {
        Some(p) => Some(p.clone()),
        None if keyfile.is_some() && !confirm => None,
        None => {
            let p = rpassword::prompt_password("Master password: ")?;
            if confirm {
                let again = rpassword::prompt_password("Confirm master password: ")?;
                if p != again {
                    bail!("passwords do not match");
                }
            }
            Some(p)
        }
    };
    Ok(Credentials { password, keyfile })
}

fn open(path: &Path, c: &Credentials) -> Result<Vault> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    Vault::open(&bytes, c).map_err(|e| anyhow!("{e}"))
}

fn save(path: &Path, v: &mut Vault, c: &Credentials) -> Result<()> {
    let bytes = v.save(c).map_err(|e| anyhow!("{e}"))?;
    atomic_write(path, &bytes).with_context(|| format!("writing {}", path.display()))
}

fn find(v: &Vault, query: &str) -> Result<Item> {
    if let Ok(id) = uuid::Uuid::parse_str(query) {
        if let Some(i) = v.item(id) {
            return Ok(i);
        }
    }
    let q = query.to_lowercase();
    let mut hits: Vec<Item> = v.items().into_iter().filter(|i| !i.deleted && i.title.to_lowercase() == q).collect();
    if hits.is_empty() {
        hits = v.items().into_iter().filter(|i| !i.deleted && i.title.to_lowercase().contains(&q)).collect();
    }
    match hits.len() {
        0 => bail!("no item matches '{query}'"),
        1 => Ok(hits.remove(0)),
        n => bail!("{n} items match '{query}'; use the id: {}", hits.iter().map(|i| format!("{} ({})", i.title, i.id)).collect::<Vec<_>>().join(", ")),
    }
}

fn kind_label(k: ItemKind) -> &'static str {
    match k {
        ItemKind::Login => "login",
        ItemKind::Note => "note",
        ItemKind::Card => "card",
        ItemKind::Identity => "identity",
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match &cli.cmd {
        Cmd::Create { file, name } => {
            if file.exists() {
                bail!("{} already exists", file.display());
            }
            let c = creds(&cli, true)?;
            let mut v = Vault::create(name);
            save(file, &mut v, &c)?;
            println!("created {}", file.display());
        }
        Cmd::Ls { file, trash } => {
            let c = creds(&cli, false)?;
            let v = open(file, &c)?;
            let folders = v.folders();
            for i in v.items().iter().filter(|i| i.deleted == *trash) {
                let folder = i
                    .folder
                    .and_then(|f| folders.iter().find(|x| x.id == f))
                    .map(|f| format!(" [{}]", f.name))
                    .unwrap_or_default();
                println!(
                    "{}  {:<8} {:<30} {:<28} {}{}{}",
                    i.id,
                    kind_label(i.kind),
                    truncate(&i.title, 30),
                    truncate(&i.username, 28),
                    i.urls.first().map(String::as_str).unwrap_or(""),
                    folder,
                    if i.has_totp() { "  (totp)" } else { "" }
                );
            }
        }
        Cmd::Show { file, query } => {
            let c = creds(&cli, false)?;
            let v = open(file, &c)?;
            let i = find(&v, query)?;
            println!("id:        {}", i.id);
            println!("kind:      {}", kind_label(i.kind));
            println!("title:     {}", i.title);
            if !i.username.is_empty() {
                println!("username:  {}", i.username);
            }
            if !i.password.is_empty() {
                println!("password:  {}", i.password);
            }
            for u in &i.urls {
                println!("url:       {u}");
            }
            if i.has_totp() {
                match vault_core::totp::generate(i.totp.as_deref().unwrap(), std::time::SystemTime::now()) {
                    Ok(code) => println!("totp:      {} ({}s left)", code.code, code.remaining),
                    Err(e) => println!("totp:      <error: {e}>"),
                }
            }
            for f in &i.fields {
                println!("{:<10} {}", format!("{}:", f.name), if f.protected { format!("{} (protected)", f.value) } else { f.value.clone() });
            }
            if !i.notes.is_empty() {
                println!("notes:\n{}", i.notes);
            }
            println!("created:   {}", i.created);
            println!("modified:  {}", i.modified);
            if i.deleted {
                println!("(in recycle bin)");
            }
        }
        Cmd::Add { file, title, username, item_password, url, totp, folder } => {
            let c = creds(&cli, false)?;
            let mut v = open(file, &c)?;
            let mut item = Item::new(ItemKind::Login, title);
            item.username = username.clone();
            item.password = item_password.clone();
            item.urls = url.clone();
            if let Some(t) = totp {
                item.totp = Some(vault_core::totp::normalize_to_uri(t, title).map_err(|e| anyhow!("{e}"))?);
            }
            if let Some(name) = folder {
                let existing = v.folders().into_iter().find(|f| f.name == *name && f.parent.is_none());
                let f = match existing {
                    Some(f) => f,
                    None => v.upsert_folder(vault_core::Folder::new(name)).map_err(|e| anyhow!("{e}"))?,
                };
                item.folder = Some(f.id);
            }
            let saved = v.upsert_item(item).map_err(|e| anyhow!("{e}"))?;
            save(file, &mut v, &c)?;
            println!("added {} ({})", saved.title, saved.id);
        }
        Cmd::Import { file, export, format, import_password, dry_run } => {
            let text = std::fs::read_to_string(export).with_context(|| format!("reading {}", export.display()))?;
            let fmt = match format {
                Some(f) => import::Format::parse(f).ok_or_else(|| anyhow!("unknown format {f}"))?,
                None => import::detect(&text).ok_or_else(|| anyhow!("not a supported export; pass --format"))?,
            };
            let password = match (fmt, import_password) {
                (import::Format::BitwardenEncryptedJson, Some(p)) => Some(p.clone()),
                (import::Format::BitwardenEncryptedJson, None) => Some(rpassword::prompt_password("Export file password: ")?),
                _ => None,
            };
            let r = import::parse(fmt, &text, password.as_deref()).map_err(|e| anyhow!("{e}"))?;
            println!("{}: {} items, {} folders", fmt.as_str(), r.items.len(), r.folders.len());
            for s in &r.skipped {
                println!("  note: {s}");
            }
            if *dry_run {
                return Ok(());
            }
            let c = creds(&cli, !file.exists())?;
            let mut v = if file.exists() { open(file, &c)? } else { Vault::create("Vaultlet") };
            let s = import::apply(&mut v, &r).map_err(|e| anyhow!("{e}"))?;
            save(file, &mut v, &c)?;
            println!(
                "{} new, {} updated, {} already there, {} repeated in the file -> {}",
                s.created, s.updated, s.unchanged, s.duplicates, file.display()
            );
        }
        Cmd::Totp { file, query } => {
            let c = creds(&cli, false)?;
            let v = open(file, &c)?;
            let i = find(&v, query)?;
            let t = i.totp.as_deref().ok_or_else(|| anyhow!("'{}' has no TOTP", i.title))?;
            let code = vault_core::totp::generate(t, std::time::SystemTime::now()).map_err(|e| anyhow!("{e}"))?;
            println!("{} ({}s left)", code.code, code.remaining);
        }
        Cmd::Merge { file, other, other_password } => {
            let c = creds(&cli, false)?;
            let mut v = open(file, &c)?;
            let oc = match other_password {
                Some(p) => Credentials { password: Some(p.clone()), keyfile: c.keyfile.clone() },
                None => c.clone(),
            };
            let o = open(other, &oc)?;
            let r = v.merge_from(&o);
            println!("added {}, updated {}, deleted {}, conflicts resolved {}", r.added, r.updated, r.deleted, r.conflicts_resolved);
            if !r.is_empty() {
                save(file, &mut v, &c)?;
            }
        }
        Cmd::CloudFolders => {
            for f in vault_core::sync::detect_cloud_folders() {
                println!("{:?}\t{}", f.provider, f.path.display());
            }
        }
        Cmd::WebdavTest { url, user, pass } => {
            let rt = tokio::runtime::Runtime::new()?;
            rt.block_on(async {
                let client = vault_core::sync::WebDavClient::new(url, user, pass).map_err(|e| anyhow!("{e}"))?;
                client.test_connection().await.map_err(|e| anyhow!("{e}"))?;
                println!("ok: {url} accepted the credentials");
                Ok::<(), anyhow::Error>(())
            })?;
        }
    }
    Ok(())
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n - 1).collect::<String>() + "…"
    }
}
