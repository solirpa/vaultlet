//! The unlocked vault: a thin, Bitwarden-shaped façade over a KDBX 4 database.
//!
//! Mapping between [`Item`]/[`Folder`] and KDBX entries/groups follows the table in
//! `docs/ARCHITECTURE.md` section 1 so that the file stays fully usable from KeePassXC,
//! Strongbox, KeePassium and KeePassDX.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, NaiveDateTime, Utc};
use keepass::config::{DatabaseConfig, InnerCipherConfig, KdfConfig, OuterCipherConfig};
use keepass::db::{fields, Entry, EntryId, GroupId, Times, Value};
use keepass::{Database, DatabaseKey};
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::{Error, Result};
use crate::merge::MergeReport;
use crate::model::{Field, Folder, Item, ItemKind};

/// Custom field holding the Vaultlet item kind.
pub const KIND_FIELD: &str = "_vaultlet_kind";
/// Tag marking favourites.
pub const FAVORITE_TAG: &str = "Favorite";
/// Prefix of the KeePass2Android extra-URL fields (`KP2A_URL_1`, ...).
pub const EXTRA_URL_PREFIX: &str = "KP2A_URL_";
/// Name of the recycle bin group created on demand.
pub const RECYCLE_BIN_NAME: &str = "Recycle Bin";

/// Master password and/or key file.
#[derive(Clone, Default, Zeroize, ZeroizeOnDrop)]
pub struct Credentials {
    pub password: Option<String>,
    pub keyfile: Option<Vec<u8>>,
}

impl Credentials {
    pub fn password(p: impl Into<String>) -> Credentials {
        Credentials {
            password: Some(p.into()),
            keyfile: None,
        }
    }

    fn to_key(&self) -> Result<DatabaseKey> {
        let mut key = DatabaseKey::new();
        if let Some(p) = &self.password {
            key = key.with_password(p);
        }
        if let Some(k) = &self.keyfile {
            key = key.with_keyfile(&mut k.as_slice())?;
        }
        if self.password.is_none() && self.keyfile.is_none() {
            return Err(Error::InvalidArgument("a password or key file is required".into()));
        }
        Ok(key)
    }
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("password", &self.password.as_ref().map(|_| "***"))
            .field("keyfile", &self.keyfile.as_ref().map(|k| k.len()))
            .finish()
    }
}

/// KDF parameters used when a vault is created or its key is changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    pub memory_bytes: u64,
    pub iterations: u64,
    pub parallelism: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        KdfParams {
            memory_bytes: 64 * 1024 * 1024,
            iterations: 3,
            parallelism: 4,
        }
    }
}

impl KdfParams {
    /// Small parameters for unit tests.
    pub fn fast() -> KdfParams {
        KdfParams {
            memory_bytes: 8 * 1024 * 1024,
            iterations: 1,
            parallelism: 1,
        }
    }
}

/// An unlocked vault held in memory.
#[derive(Debug, Clone)]
pub struct Vault {
    db: Database,
    dirty: bool,
}

// ---------------------------------------------------------------------------------------------
// Time helpers: KDBX stores naive UTC seconds.

fn to_naive(t: DateTime<Utc>) -> NaiveDateTime {
    DateTime::from_timestamp(t.timestamp(), 0)
        .unwrap_or_default()
        .naive_utc()
}

fn from_naive(t: Option<NaiveDateTime>) -> Option<DateTime<Utc>> {
    t.map(|n| n.and_utc())
}

/// Truncate to whole seconds, matching what the file format can store.
pub fn truncate_secs(t: DateTime<Utc>) -> DateTime<Utc> {
    to_naive(t).and_utc()
}

fn now_secs() -> DateTime<Utc> {
    truncate_secs(Utc::now())
}

// ---------------------------------------------------------------------------------------------

impl Vault {
    /// A new, empty vault with the given database name.
    pub fn create(name: &str) -> Vault {
        Vault::create_with_kdf(name, KdfParams::default())
    }

    /// A new vault with explicit KDF parameters (tests use [`KdfParams::fast`]).
    pub fn create_with_kdf(name: &str, kdf: KdfParams) -> Vault {
        let mut config = DatabaseConfig::default();
        config.outer_cipher_config = OuterCipherConfig::AES256;
        config.inner_cipher_config = InnerCipherConfig::ChaCha20;
        config.kdf_config = KdfConfig::Argon2id {
            iterations: kdf.iterations,
            memory: kdf.memory_bytes,
            parallelism: kdf.parallelism,
            version: argon2::Version::Version13,
        };
        let mut db = Database::with_config(config);
        db.meta.generator = Some("Vaultlet".into());
        db.meta.database_name = Some(name.to_string());
        db.meta.database_name_changed = Some(Times::now());
        db.meta.recyclebin_enabled = Some(true);
        db.meta.history_max_items = Some(10);
        db.meta.history_max_size = Some(6 * 1024 * 1024);
        db.root_mut().name = name.to_string();
        Vault { db, dirty: true }
    }

    /// Open a KDBX file from bytes.
    pub fn open(bytes: &[u8], key: &Credentials) -> Result<Vault> {
        let db = Database::parse(bytes, key.to_key()?)?;
        Ok(Vault { db, dirty: false })
    }

    /// Serialize as KDBX 4. Clears the dirty flag on success.
    pub fn save(&mut self, key: &Credentials) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        self.db.save(&mut out, key.to_key()?)?;
        self.dirty = false;
        Ok(out)
    }

    /// Set new KDF parameters, applied at the next save (used together with a new key).
    pub fn change_key(&mut self, kdf: KdfParams) {
        self.db.config.kdf_config = KdfConfig::Argon2id {
            iterations: kdf.iterations,
            memory: kdf.memory_bytes,
            parallelism: kdf.parallelism,
            version: argon2::Version::Version13,
        };
        self.db.meta.master_key_changed = Some(Times::now());
        self.dirty = true;
    }

    pub fn name(&self) -> String {
        self.db
            .meta
            .database_name
            .clone()
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| self.db.root().name.clone())
    }

    pub fn set_name(&mut self, name: &str) {
        self.db.meta.database_name = Some(name.to_string());
        self.db.meta.database_name_changed = Some(Times::now());
        self.db.root_mut().name = name.to_string();
        self.dirty = true;
    }

    pub fn has_unsaved_changes(&self) -> bool {
        self.dirty
    }

    /// Clear the dirty flag after the caller persisted a serialized copy (see `save`).
    pub fn mark_saved(&mut self) {
        self.dirty = false;
    }

    /// Direct access for advanced callers (merge, tests).
    pub fn database(&self) -> &Database {
        &self.db
    }

    // ---- groups ------------------------------------------------------------------------------

    fn root_id(&self) -> GroupId {
        self.db.root().id()
    }

    fn recycle_bin_id(&self) -> Option<GroupId> {
        let uuid = self.db.meta.recyclebin_uuid?;
        let id = GroupId::from(uuid);
        self.db.group(id).map(|g| g.id())
    }

    fn ensure_recycle_bin(&mut self) -> GroupId {
        if let Some(id) = self.recycle_bin_id() {
            return id;
        }
        let id = self
            .db
            .root_mut()
            .add_group()
            .edit(|g| {
                g.name = RECYCLE_BIN_NAME.to_string();
                g.enable_searching = Some(false);
                g.enable_autotype = Some(false);
            })
            .id();
        self.db.meta.recyclebin_enabled = Some(true);
        self.db.meta.recyclebin_uuid = Some(id.uuid());
        self.db.meta.recyclebin_changed = Some(Times::now());
        self.dirty = true;
        id
    }

    /// True if `group` is the recycle bin or one of its descendants.
    fn in_recycle_bin(&self, mut group: GroupId) -> bool {
        let Some(bin) = self.recycle_bin_id() else {
            return false;
        };
        loop {
            if group == bin {
                return true;
            }
            match self.db.group(group).and_then(|g| g.parent().map(|p| p.id())) {
                Some(p) => group = p,
                None => return false,
            }
        }
    }

    fn folder_from_group(&self, g: &keepass::db::GroupRef<'_>) -> Folder {
        let root = self.root_id();
        Folder {
            id: g.id().uuid(),
            name: g.name.clone(),
            parent: match g.parent().map(|p| p.id()) {
                Some(p) if p != root => Some(p.uuid()),
                _ => None,
            },
        }
    }

    /// All folders (every group except the root and the recycle bin subtree), parents first.
    pub fn folders(&self) -> Vec<Folder> {
        let mut out = Vec::new();
        let mut stack: Vec<GroupId> = self.db.root().groups().map(|g| g.id()).collect();
        stack.reverse();
        while let Some(id) = stack.pop() {
            if self.in_recycle_bin(id) {
                continue;
            }
            if let Some(g) = self.db.group(id) {
                out.push(self.folder_from_group(&g));
                let children: Vec<GroupId> = g.groups().map(|c| c.id()).collect();
                for c in children.into_iter().rev() {
                    stack.push(c);
                }
            }
        }
        out
    }

    pub fn folder(&self, id: Uuid) -> Option<Folder> {
        let gid = GroupId::from(id);
        if gid == self.root_id() || self.in_recycle_bin(gid) {
            return None;
        }
        self.db.group(gid).map(|g| self.folder_from_group(&g))
    }

    /// Create or update a folder. `parent == None` puts it under the root.
    pub fn upsert_folder(&mut self, mut folder: Folder) -> Result<Folder> {
        self.upsert_folder_at(&mut folder, None)?;
        Ok(folder)
    }

    /// Like [`upsert_folder`](Self::upsert_folder) but with an explicit modification time
    /// (used by merge so the winner's timestamp is kept).
    pub(crate) fn upsert_folder_at(
        &mut self,
        folder: &mut Folder,
        modified: Option<DateTime<Utc>>,
    ) -> Result<()> {
        let root = self.root_id();
        let parent = match folder.parent {
            Some(p) => {
                let pid = GroupId::from(p);
                if self.db.group(pid).is_none() || self.in_recycle_bin(pid) {
                    return Err(Error::NotFound(format!("folder {p}")));
                }
                pid
            }
            None => root,
        };
        if folder.name.trim().is_empty() {
            return Err(Error::InvalidArgument("folder name is empty".into()));
        }
        let stamp = to_naive(modified.unwrap_or_else(now_secs));
        let gid = if folder.id.is_nil() {
            GroupId::new()
        } else {
            GroupId::from(folder.id)
        };
        if self.db.group(gid).is_some() {
            if gid == root || self.in_recycle_bin(gid) {
                return Err(Error::InvalidArgument("cannot edit this folder".into()));
            }
            let mut g = self.db.group_mut(gid).ok_or_else(|| Error::NotFound("folder".into()))?;
            if g.name != folder.name {
                g.name = folder.name.clone();
            }
            if g.as_ref().parent().map(|p| p.id()) != Some(parent) {
                g.move_to(parent)
                    .map_err(|e| Error::InvalidArgument(e.to_string()))?;
                g.times.location_changed = Some(stamp);
            }
            g.times.last_modification = Some(stamp);
        } else {
            let mut p = self.db.group_mut(parent).ok_or_else(|| Error::NotFound("folder".into()))?;
            let mut g = p
                .add_group_with_id(gid)
                .map_err(|e| Error::InvalidArgument(e.to_string()))?;
            g.name = folder.name.clone();
            g.times = Times::new();
            g.times.creation = Some(stamp);
            g.times.last_modification = Some(stamp);
            g.times.location_changed = Some(stamp);
        }
        folder.id = gid.uuid();
        self.dirty = true;
        Ok(())
    }

    /// Delete a folder: its items (and sub-folders' items) go to the recycle bin, the groups
    /// themselves are removed and recorded in DeletedObjects.
    pub fn delete_folder(&mut self, id: Uuid) -> Result<()> {
        let gid = GroupId::from(id);
        if gid == self.root_id() || self.db.group(gid).is_none() {
            return Err(Error::NotFound(format!("folder {id}")));
        }
        if self.in_recycle_bin(gid) {
            return Err(Error::InvalidArgument("cannot delete the recycle bin".into()));
        }
        let bin = self.ensure_recycle_bin();
        // Collect the subtree.
        let mut groups = vec![gid];
        let mut i = 0;
        while i < groups.len() {
            if let Some(g) = self.db.group(groups[i]) {
                groups.extend(g.groups().map(|c| c.id()));
            }
            i += 1;
        }
        let entries: Vec<EntryId> = groups
            .iter()
            .filter_map(|g| self.db.group(*g))
            .flat_map(|g| g.entries().map(|e| e.id()).collect::<Vec<_>>())
            .collect();
        let now = Times::now();
        for e in entries {
            if let Some(mut em) = self.db.entry_mut(e) {
                let _ = em.move_to(bin);
                em.times.location_changed = Some(now);
            }
        }
        if let Some(g) = self.db.group_mut(gid) {
            g.remove();
        }
        for g in groups {
            self.db.deleted_objects.insert(g.uuid(), Some(now));
        }
        self.dirty = true;
        Ok(())
    }

    // ---- entries -----------------------------------------------------------------------------

    fn item_from_entry(&self, e: &keepass::db::EntryRef<'_>) -> Item {
        let root = self.root_id();
        let parent = e.parent().id();
        let deleted = self.in_recycle_bin(parent);
        let folder_group = if deleted {
            e.previous_parent().map(|p| p.id())
        } else {
            Some(parent)
        };
        let folder = folder_group
            .filter(|g| *g != root && self.db.group(*g).is_some() && !self.in_recycle_bin(*g))
            .map(|g| g.uuid());

        let get = |k: &str| e.get(k).map(str::to_string).unwrap_or_default();
        let mut urls = Vec::new();
        let primary = get(fields::URL);
        if !primary.is_empty() {
            urls.push(primary);
        }
        // Extra URLs are numbered; keep them in numeric order.
        let mut extra: Vec<(usize, String)> = e
            .fields
            .iter()
            .filter_map(|(k, v)| {
                k.strip_prefix(EXTRA_URL_PREFIX)
                    .and_then(|n| n.parse::<usize>().ok())
                    .map(|n| (n, v.get().to_string()))
            })
            .filter(|(_, v)| !v.is_empty())
            .collect();
        extra.sort_by_key(|(n, _)| *n);
        urls.extend(extra.into_iter().map(|(_, v)| v));

        let mut custom: Vec<(String, Field)> = e
            .fields
            .iter()
            .filter(|(k, _)| !is_reserved_field(k))
            .map(|(k, v)| {
                (
                    k.clone(),
                    Field {
                        name: k.clone(),
                        value: v.get().to_string(),
                        protected: v.is_protected(),
                    },
                )
            })
            .collect();
        custom.sort_by(|a, b| a.0.cmp(&b.0));

        let totp = e.get(fields::OTP).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
        let kind = e.get(KIND_FIELD).map(ItemKind::parse).unwrap_or_default();
        let favorite = e.tags.iter().any(|t| t == FAVORITE_TAG);
        let tags = e.tags.iter().filter(|t| *t != FAVORITE_TAG).cloned().collect();
        let used = e.times.usage_count.unwrap_or(0) > 0;

        Item {
            id: e.id().uuid(),
            kind,
            title: get(fields::TITLE),
            username: get(fields::USERNAME),
            password: get(fields::PASSWORD),
            urls,
            totp,
            notes: get(fields::NOTES),
            fields: custom.into_iter().map(|(_, f)| f).collect(),
            folder,
            favorite,
            tags,
            created: from_naive(e.times.creation).unwrap_or_default(),
            modified: from_naive(e.times.last_modification).unwrap_or_default(),
            last_used: if used { from_naive(e.times.last_access) } else { None },
            deleted,
        }
    }

    /// Every item, including those in the recycle bin.
    pub fn items(&self) -> Vec<Item> {
        let mut out: Vec<Item> = self
            .db
            .iter_all_entries()
            .map(|e| self.item_from_entry(&e))
            .collect();
        out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()).then(a.id.cmp(&b.id)));
        out
    }

    pub fn item(&self, id: Uuid) -> Option<Item> {
        self.db.entry(EntryId::from(id)).map(|e| self.item_from_entry(&e))
    }

    /// Create or update an item. A nil id creates a new entry. On update the previous version is
    /// pushed into the entry's history and `modified` is bumped to now.
    pub fn upsert_item(&mut self, item: Item) -> Result<Item> {
        self.upsert_item_at(item, None)
    }

    /// Like [`upsert_item`](Self::upsert_item) with an explicit `modified` timestamp; `None`
    /// means "now". Used by import (keeps Bitwarden's revision dates) and merge.
    pub fn upsert_item_at(&mut self, mut item: Item, modified: Option<DateTime<Utc>>) -> Result<Item> {
        let root = self.root_id();
        let target_group = match item.folder {
            Some(f) => {
                let gid = GroupId::from(f);
                if self.db.group(gid).is_none() || self.in_recycle_bin(gid) {
                    return Err(Error::NotFound(format!("folder {f}")));
                }
                gid
            }
            None => root,
        };
        let stamp = modified.map(truncate_secs).unwrap_or_else(now_secs);
        let eid = if item.id.is_nil() {
            EntryId::new()
        } else {
            EntryId::from(item.id)
        };
        let exists = self.db.entry(eid).is_some();
        if !exists {
            let created = truncate_secs(item.created);
            let mut parent = self
                .db
                .group_mut(target_group)
                .ok_or_else(|| Error::NotFound("folder".into()))?;
            let mut e = parent
                .add_entry_with_id(eid)
                .map_err(|e| Error::InvalidArgument(e.to_string()))?;
            e.times = Times::new();
            e.times.creation = Some(to_naive(created));
            e.times.last_access = Some(to_naive(created));
            e.times.location_changed = Some(to_naive(stamp));
        } else {
            // Snapshot into history before touching anything.
            let snapshot = self
                .db
                .entry(eid)
                .map(|e| (*e).clone())
                .ok_or_else(|| Error::NotFound("item".into()))?;
            let mut e = self.db.entry_mut(eid).ok_or_else(|| Error::NotFound("item".into()))?;
            e.history.get_or_insert_with(Default::default).add_entry(snapshot);
            trim_history(&mut e.history, 10);
        }

        let bin = if item.deleted { Some(self.ensure_recycle_bin()) } else { None };
        let mut e = self.db.entry_mut(eid).ok_or_else(|| Error::NotFound("item".into()))?;

        // Standard fields.
        set_or_remove(&mut e, fields::TITLE, &item.title, false);
        set_or_remove(&mut e, fields::USERNAME, &item.username, false);
        set_or_remove(&mut e, fields::PASSWORD, &item.password, true);
        set_or_remove(&mut e, fields::NOTES, &item.notes, false);
        set_or_remove(&mut e, fields::OTP, item.totp.as_deref().unwrap_or(""), true);
        set_or_remove(&mut e, KIND_FIELD, item.kind.as_str(), false);

        // URLs.
        let urls: Vec<String> = item.urls.iter().map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).collect();
        set_or_remove(&mut e, fields::URL, urls.first().map(String::as_str).unwrap_or(""), false);
        let old_extra: Vec<String> = e.fields.keys().filter(|k| k.starts_with(EXTRA_URL_PREFIX)).cloned().collect();
        for k in old_extra {
            e.fields.remove(&k);
        }
        for (i, u) in urls.iter().skip(1).enumerate() {
            e.set_unprotected(format!("{EXTRA_URL_PREFIX}{}", i + 1), u.clone());
        }
        item.urls = urls;

        // Custom fields: replace all non-reserved fields.
        let old_custom: Vec<String> = e.fields.keys().filter(|k| !is_reserved_field(k)).cloned().collect();
        for k in old_custom {
            e.fields.remove(&k);
        }
        let mut seen = HashSet::new();
        for f in &mut item.fields {
            let mut name = f.name.trim().to_string();
            if name.is_empty() {
                name = "Field".to_string();
            }
            let base = name.clone();
            let mut n = 2;
            while is_reserved_field(&name) || !seen.insert(name.clone()) {
                name = format!("{base} ({n})");
                n += 1;
            }
            f.name = name.clone();
            e.set(name, if f.protected { Value::protected(f.value.clone()) } else { Value::unprotected(f.value.clone()) });
        }

        // Tags / favourite.
        let mut tags: Vec<String> = item.tags.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty() && t != FAVORITE_TAG).collect();
        tags.dedup();
        if item.favorite {
            tags.insert(0, FAVORITE_TAG.to_string());
        }
        e.tags = tags;

        // Times.
        e.times.last_modification = Some(to_naive(stamp));
        if let Some(lu) = item.last_used {
            e.times.last_access = Some(to_naive(lu));
            if e.times.usage_count.unwrap_or(0) == 0 {
                e.times.usage_count = Some(1);
            }
        }

        // Location: folder or recycle bin.
        let current_parent = e.as_ref().parent().id();
        match bin {
            Some(bin) if current_parent != bin => {
                // Remember where it came from if it is not already in the bin.
                e.move_to(bin).map_err(|e| Error::InvalidArgument(e.to_string()))?;
                e.times.location_changed = Some(to_naive(stamp));
            }
            Some(_) => {}
            None if current_parent != target_group => {
                e.move_to(target_group).map_err(|e| Error::InvalidArgument(e.to_string()))?;
                e.times.location_changed = Some(to_naive(stamp));
            }
            None => {}
        }
        self.dirty = true;
        self.item(eid.uuid()).ok_or_else(|| Error::NotFound("item".into()))
    }

    /// Move an item to the recycle bin.
    pub fn delete_item(&mut self, id: Uuid) -> Result<()> {
        let eid = EntryId::from(id);
        if self.db.entry(eid).is_none() {
            return Err(Error::NotFound(format!("item {id}")));
        }
        let bin = self.ensure_recycle_bin();
        let mut e = self.db.entry_mut(eid).ok_or_else(|| Error::NotFound("item".into()))?;
        if e.as_ref().parent().id() != bin {
            e.move_to(bin).map_err(|e| Error::InvalidArgument(e.to_string()))?;
            let now = Times::now();
            e.times.location_changed = Some(now);
            e.times.last_modification = Some(now);
        }
        self.dirty = true;
        Ok(())
    }

    /// Move an item out of the recycle bin, back to its previous folder (or the root).
    pub fn restore_item(&mut self, id: Uuid) -> Result<()> {
        let eid = EntryId::from(id);
        let root = self.root_id();
        let (parent, previous) = {
            let e = self.db.entry(eid).ok_or_else(|| Error::NotFound(format!("item {id}")))?;
            (e.parent().id(), e.previous_parent().map(|p| p.id()))
        };
        if !self.in_recycle_bin(parent) {
            return Ok(());
        }
        let target = previous
            .filter(|p| self.db.group(*p).is_some() && !self.in_recycle_bin(*p))
            .unwrap_or(root);
        let mut e = self.db.entry_mut(eid).ok_or_else(|| Error::NotFound("item".into()))?;
        e.move_to(target).map_err(|e| Error::InvalidArgument(e.to_string()))?;
        let now = Times::now();
        e.times.location_changed = Some(now);
        e.times.last_modification = Some(now);
        self.dirty = true;
        Ok(())
    }

    /// Permanently remove an item and record it in DeletedObjects.
    pub fn purge_item(&mut self, id: Uuid) -> Result<()> {
        let eid = EntryId::from(id);
        let e = self.db.entry_mut(eid).ok_or_else(|| Error::NotFound(format!("item {id}")))?;
        e.remove();
        self.db.deleted_objects.insert(id, Some(Times::now()));
        self.dirty = true;
        Ok(())
    }

    /// Record that the item was used (autofill / copy).
    pub fn touch_used(&mut self, id: Uuid) {
        if let Some(mut e) = self.db.entry_mut(EntryId::from(id)) {
            e.times.last_access = Some(Times::now());
            e.times.usage_count = Some(e.times.usage_count.unwrap_or(0) + 1);
            self.dirty = true;
        }
    }

    /// Deletion records (uuid → time) used by merge.
    pub fn deleted_objects(&self) -> HashMap<Uuid, Option<DateTime<Utc>>> {
        self.db
            .deleted_objects
            .iter()
            .map(|(k, v)| (*k, from_naive(*v)))
            .collect()
    }

    pub(crate) fn record_deleted(&mut self, id: Uuid, at: Option<DateTime<Utc>>) {
        let entry = self.db.deleted_objects.entry(id).or_insert(None);
        let new = at.map(to_naive);
        if new > *entry {
            *entry = new;
        }
        self.dirty = true;
    }

    /// Folder modification times (for merge).
    pub(crate) fn folder_modified(&self, id: Uuid) -> Option<DateTime<Utc>> {
        self.db.group(GroupId::from(id)).and_then(|g| from_naive(g.times.last_modification))
    }

    /// Remove an entry outright without touching DeletedObjects (merge helper).
    pub(crate) fn remove_item_raw(&mut self, id: Uuid) {
        if let Some(e) = self.db.entry_mut(EntryId::from(id)) {
            e.remove();
            self.dirty = true;
        }
    }

    /// Two-way merge; see [`crate::merge`].
    pub fn merge_from(&mut self, other: &Vault) -> MergeReport {
        crate::merge::merge(self, other)
    }
}

fn is_reserved_field(name: &str) -> bool {
    fields::KNOWN_FIELDS.contains(&name)
        || name == fields::OTP
        || name == KIND_FIELD
        || name.starts_with(EXTRA_URL_PREFIX)
}

fn set_or_remove(e: &mut keepass::db::EntryMut<'_>, key: &str, value: &str, protected: bool) {
    if value.is_empty() {
        if fields::KNOWN_FIELDS.contains(&key) {
            // KeePass clients expect the standard fields to exist.
            e.set(key, if protected { Value::protected(String::new()) } else { Value::unprotected(String::new()) });
        } else {
            e.fields.remove(key);
        }
    } else if protected {
        e.set_protected(key, value);
    } else {
        e.set_unprotected(key, value);
    }
}

fn trim_history(h: &mut Option<keepass::db::History>, max: usize) {
    if let Some(h) = h {
        let n = h.get_entries().len();
        if n > max {
            // History is newest-first; drop the oldest versions.
            let keep: Vec<Entry> = h.get_entries().iter().take(max).cloned().collect();
            let mut fresh = keepass::db::History::default();
            for e in keep.into_iter().rev() {
                fresh.add_entry(e);
            }
            *h = fresh;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds() -> Credentials {
        Credentials::password("test-password")
    }

    fn sample_vault() -> (Vault, Folder, Folder) {
        let mut v = Vault::create_with_kdf("Test", KdfParams::fast());
        let work = v.upsert_folder(Folder::new("Work")).unwrap();
        let infra = v
            .upsert_folder(Folder {
                id: Uuid::nil(),
                name: "Infra".into(),
                parent: Some(work.id),
            })
            .unwrap();
        let mut login = Item::new(ItemKind::Login, "GitHub");
        login.username = "me@example.com".into();
        login.password = "hunter2".into();
        login.urls = vec!["https://github.com/login".into(), "gist.github.com".into()];
        login.totp = Some("otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP&issuer=GitHub".into());
        login.notes = "line1\nline2".into();
        login.fields = vec![Field::protected("PIN", "1234"), Field::new("Plan", "pro")];
        login.folder = Some(infra.id);
        login.favorite = true;
        login.tags = vec!["dev".into()];
        v.upsert_item(login).unwrap();

        let mut card = Item::new(ItemKind::Card, "Visa");
        card.fields = vec![
            Field::new("cardholderName", "Me"),
            Field::protected("number", "4111111111111111"),
            Field::new("brand", "Visa"),
            Field::new("expMonth", "12"),
            Field::new("expYear", "2030"),
            Field::protected("code", "123"),
        ];
        v.upsert_item(card).unwrap();

        let mut note = Item::new(ItemKind::Note, "Router");
        note.notes = "admin / admin".into();
        v.upsert_item(note).unwrap();

        let mut ident = Item::new(ItemKind::Identity, "Me");
        ident.fields = vec![Field::new("firstName", "A"), Field::protected("ssn", "1")];
        ident.folder = Some(work.id);
        v.upsert_item(ident).unwrap();
        (v, work, infra)
    }

    #[test]
    fn round_trip_through_kdbx() {
        let (mut v, _, _) = sample_vault();
        let note_id = v.items().iter().find(|i| i.title == "Router").unwrap().id;
        v.delete_item(note_id).unwrap();
        let before = v.items();
        let folders_before = v.folders();
        assert!(v.has_unsaved_changes());

        let bytes = v.save(&creds()).unwrap();
        assert!(!v.has_unsaved_changes());
        let reopened = Vault::open(&bytes, &creds()).unwrap();
        assert_eq!(reopened.name(), "Test");
        assert_eq!(reopened.items(), before);
        assert_eq!(reopened.folders(), folders_before);

        let gh = reopened.items().into_iter().find(|i| i.title == "GitHub").unwrap();
        assert_eq!(gh.urls, vec!["https://github.com/login", "gist.github.com"]);
        assert!(gh.favorite);
        assert_eq!(gh.tags, vec!["dev"]);
        assert_eq!(gh.fields.len(), 2);
        assert!(gh.fields.iter().any(|f| f.name == "PIN" && f.protected));
        assert!(gh.has_totp());
        let router = reopened.items().into_iter().find(|i| i.title == "Router").unwrap();
        assert!(router.deleted);

        assert!(Vault::open(&bytes, &Credentials::password("wrong")).is_err());
    }

    #[test]
    fn kdbx_fields_follow_the_mapping_table() {
        let (v, _, _) = sample_vault();
        let gh = v.items().into_iter().find(|i| i.title == "GitHub").unwrap();
        let e = v.database().entry(EntryId::from(gh.id)).unwrap();
        assert_eq!(e.get("URL"), Some("https://github.com/login"));
        assert_eq!(e.get("KP2A_URL_1"), Some("gist.github.com"));
        assert_eq!(e.get("_vaultlet_kind"), Some("login"));
        assert!(e.fields.get("otp").unwrap().is_protected());
        assert!(e.fields.get("Password").unwrap().is_protected());
        assert!(e.tags.contains(&"Favorite".to_string()));
    }

    #[test]
    fn update_pushes_history_and_bumps_modified() {
        let (mut v, _, _) = sample_vault();
        let mut gh = v.items().into_iter().find(|i| i.title == "GitHub").unwrap();
        let first_mod = gh.modified;
        gh.password = "new-password".into();
        gh.urls = vec!["https://github.com".into()];
        let later = first_mod + chrono::Duration::seconds(5);
        let updated = v.upsert_item_at(gh.clone(), Some(later)).unwrap();
        assert_eq!(updated.password, "new-password");
        assert_eq!(updated.urls, vec!["https://github.com"]);
        assert_eq!(updated.modified, later);
        let e = v.database().entry(EntryId::from(gh.id)).unwrap();
        let hist = e.history.as_ref().unwrap().get_entries();
        assert_eq!(hist.len(), 1);
        assert_eq!(hist[0].get("Password"), Some("hunter2"));
        assert!(e.get("KP2A_URL_1").is_none());
    }

    #[test]
    fn trash_restore_purge() {
        let (mut v, work, _) = sample_vault();
        let me = v.items().into_iter().find(|i| i.title == "Me").unwrap();
        v.delete_item(me.id).unwrap();
        let t = v.item(me.id).unwrap();
        assert!(t.deleted);
        assert_eq!(t.folder, Some(work.id), "folder is remembered while in the bin");
        v.restore_item(me.id).unwrap();
        let r = v.item(me.id).unwrap();
        assert!(!r.deleted);
        assert_eq!(r.folder, Some(work.id));
        v.purge_item(me.id).unwrap();
        assert!(v.item(me.id).is_none());
        assert!(v.deleted_objects().contains_key(&me.id));
        // The recycle bin is never reported as a folder.
        assert!(v.folders().iter().all(|f| f.name != RECYCLE_BIN_NAME));
    }

    #[test]
    fn delete_folder_moves_items_to_bin() {
        let (mut v, work, infra) = sample_vault();
        v.delete_folder(work.id).unwrap();
        assert!(v.folder(work.id).is_none());
        assert!(v.folder(infra.id).is_none());
        let gh = v.items().into_iter().find(|i| i.title == "GitHub").unwrap();
        assert!(gh.deleted);
        assert_eq!(gh.folder, None);
        assert!(v.deleted_objects().contains_key(&infra.id));
    }

    #[test]
    fn custom_field_names_never_collide_with_reserved_ones() {
        let mut v = Vault::create_with_kdf("T", KdfParams::fast());
        let mut it = Item::new(ItemKind::Login, "x");
        it.fields = vec![Field::new("Password", "a"), Field::new("Dup", "1"), Field::new("Dup", "2")];
        let saved = v.upsert_item(it).unwrap();
        let names: Vec<&str> = saved.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["Dup", "Dup (2)", "Password (2)"]);
    }

    #[test]
    fn touch_used_sets_last_used() {
        let (mut v, _, _) = sample_vault();
        let gh = v.items().into_iter().find(|i| i.title == "GitHub").unwrap();
        assert!(gh.last_used.is_none());
        v.touch_used(gh.id);
        assert!(v.item(gh.id).unwrap().last_used.is_some());
    }
}
