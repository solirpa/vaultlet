//! Two-way merge with KeePass "Synchronize" semantics (architecture doc section 4).
//!
//! Both vaults are compared by uuid. The newer modification time wins; the loser is kept in the
//! entry's history. An object missing on one side is treated as deleted only if the other side
//! recorded its deletion *after* the surviving copy was last modified.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::{Folder, Item};
use crate::vault::Vault;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeReport {
    pub added: usize,
    pub updated: usize,
    pub deleted: usize,
    /// Objects that differed on both sides and were resolved by timestamp.
    pub conflicts_resolved: usize,
}

impl MergeReport {
    pub fn is_empty(&self) -> bool {
        self.added == 0 && self.updated == 0 && self.deleted == 0
    }
}

fn deleted_after(del: &HashMap<Uuid, Option<DateTime<Utc>>>, id: Uuid, modified: DateTime<Utc>) -> bool {
    match del.get(&id) {
        Some(Some(t)) => *t > modified,
        Some(None) => true,
        None => false,
    }
}

/// Merge `other` into `local`.
pub fn merge(local: &mut Vault, other: &Vault) -> MergeReport {
    let mut report = MergeReport::default();
    let local_del = local.deleted_objects();
    let other_del = other.deleted_objects();

    // 1. Union of deletion records (newest time wins).
    for (id, t) in &other_del {
        local.record_deleted(*id, *t);
    }

    // 2. Folders from the other side, parents first.
    let other_folders: Vec<Folder> = other.folders();
    for f in &other_folders {
        let om = other.folder_modified(f.id).unwrap_or_default();
        match local.folder(f.id) {
            Some(lf) => {
                let lm = local.folder_modified(f.id).unwrap_or_default();
                let differs = lf.name != f.name || lf.parent != f.parent;
                if differs {
                    report.conflicts_resolved += 1;
                    if om > lm {
                        let mut nf = f.clone();
                        if nf.parent.is_some_and(|p| local.folder(p).is_none()) {
                            nf.parent = None;
                        }
                        if local.upsert_folder_at(&mut nf, Some(om)).is_ok() {
                            report.updated += 1;
                        }
                    }
                }
            }
            None => {
                if deleted_after(&local_del, f.id, om) {
                    continue;
                }
                let mut nf = f.clone();
                if nf.parent.is_some_and(|p| local.folder(p).is_none()) {
                    nf.parent = None;
                }
                if local.upsert_folder_at(&mut nf, Some(om)).is_ok() {
                    report.added += 1;
                }
            }
        }
    }

    // 3. Local folders the other side purged after our last change.
    let local_folders = local.folders();
    for f in &local_folders {
        if other.folder(f.id).is_some() {
            continue;
        }
        let lm = local.folder_modified(f.id).unwrap_or_default();
        if deleted_after(&other_del, f.id, lm) {
            // Items inside go to the recycle bin (same as a local delete), then drop the group.
            let _ = local.delete_folder(f.id);
            report.deleted += 1;
        }
    }

    // 4. Items from the other side.
    for oi in other.items() {
        match local.item(oi.id) {
            Some(li) => {
                if items_equal(&li, &oi) {
                    continue;
                }
                report.conflicts_resolved += 1;
                if oi.modified > li.modified {
                    let mut ni = oi.clone();
                    if ni.folder.is_some_and(|f| local.folder(f).is_none()) {
                        ni.folder = None;
                    }
                    if local.upsert_item_at(ni, Some(oi.modified)).is_ok() {
                        report.updated += 1;
                    }
                }
            }
            None => {
                if deleted_after(&local_del, oi.id, oi.modified) {
                    continue;
                }
                let mut ni = oi.clone();
                if ni.folder.is_some_and(|f| local.folder(f).is_none()) {
                    ni.folder = None;
                }
                if local.upsert_item_at(ni, Some(oi.modified)).is_ok() {
                    report.added += 1;
                }
            }
        }
    }

    // 5. Local items the other side purged after our last change.
    for li in local.items() {
        if other.item(li.id).is_some() {
            continue;
        }
        if deleted_after(&other_del, li.id, li.modified) {
            local.remove_item_raw(li.id);
            report.deleted += 1;
        }
    }

    report
}

/// Equality ignoring `last_used` (usage bookkeeping is not worth a conflict).
fn items_equal(a: &Item, b: &Item) -> bool {
    let mut a = a.clone();
    let mut b = b.clone();
    a.last_used = None;
    b.last_used = None;
    a == b
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ItemKind, Item};
    use crate::vault::{Credentials, KdfParams};
    use chrono::Duration;

    fn base() -> Vault {
        let mut v = Vault::create_with_kdf("Base", KdfParams::fast());
        let f = v.upsert_folder(Folder::new("Work")).unwrap();
        let mut a = Item::new(ItemKind::Login, "A");
        a.username = "a".into();
        a.folder = Some(f.id);
        v.upsert_item(a).unwrap();
        let b = Item::new(ItemKind::Note, "B");
        v.upsert_item(b).unwrap();
        v
    }

    /// Two devices start from the same saved file.
    fn two_copies() -> (Vault, Vault) {
        let mut v = base();
        let bytes = v.save(&Credentials::password("p")).unwrap();
        let c1 = Vault::open(&bytes, &Credentials::password("p")).unwrap();
        let c2 = Vault::open(&bytes, &Credentials::password("p")).unwrap();
        (c1, c2)
    }

    fn by_title(v: &Vault, t: &str) -> Item {
        v.items().into_iter().find(|i| i.title == t).unwrap()
    }

    #[test]
    fn newer_edit_wins_and_loser_goes_to_history() {
        let (mut c1, mut c2) = two_copies();
        let t0 = by_title(&c1, "A").modified;
        let mut a1 = by_title(&c1, "A");
        a1.password = "from-c1".into();
        c1.upsert_item_at(a1, Some(t0 + Duration::seconds(10))).unwrap();
        let mut a2 = by_title(&c2, "A");
        a2.password = "from-c2".into();
        c2.upsert_item_at(a2, Some(t0 + Duration::seconds(20))).unwrap();

        let r = c1.merge_from(&c2);
        assert_eq!(r.updated, 1);
        assert_eq!(r.conflicts_resolved, 1);
        assert_eq!(by_title(&c1, "A").password, "from-c2");
        // Merging the other way keeps c2's version (it is newer).
        let r2 = c2.merge_from(&c1);
        assert_eq!(r2.updated, 0);
        assert_eq!(by_title(&c2, "A").password, "from-c2");
        // Idempotent.
        assert!(c1.merge_from(&c2).is_empty());
    }

    #[test]
    fn new_items_on_both_sides_are_combined() {
        let (mut c1, mut c2) = two_copies();
        c1.upsert_item(Item::new(ItemKind::Login, "only-c1")).unwrap();
        c2.upsert_item(Item::new(ItemKind::Login, "only-c2")).unwrap();
        let r = c1.merge_from(&c2);
        assert_eq!(r.added, 1);
        assert_eq!(c1.items().len(), 4);
        let r = c2.merge_from(&c1);
        assert_eq!(r.added, 1);
        assert_eq!(c2.items().len(), 4);
    }

    #[test]
    fn purge_on_one_side_vs_edit_on_other() {
        // Purge is newer than the edit → the item disappears.
        let (mut c1, mut c2) = two_copies();
        let t0 = by_title(&c1, "B").modified;
        let mut b = by_title(&c1, "B");
        b.notes = "edited".into();
        c1.upsert_item_at(b.clone(), Some(t0)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        c2.purge_item(b.id).unwrap(); // deletion time = now, at least a second after the edit
        let r = c1.merge_from(&c2);
        assert_eq!(r.deleted, 1);
        assert!(c1.item(b.id).is_none());

        // Edit is newer than the purge → the item survives (and comes back on the purging side).
        let (mut c1, mut c2) = two_copies();
        let b = by_title(&c1, "B");
        c2.purge_item(b.id).unwrap();
        let mut b2 = b.clone();
        b2.notes = "edited later".into();
        c1.upsert_item_at(b2, Some(Utc::now() + Duration::seconds(30))).unwrap();
        let r = c1.merge_from(&c2);
        assert_eq!(r.deleted, 0);
        assert!(c1.item(b.id).is_some());
        let r = c2.merge_from(&c1);
        assert_eq!(r.added, 1);
        assert_eq!(by_title(&c2, "B").notes, "edited later");
    }

    #[test]
    fn trash_state_follows_the_winner() {
        let (mut c1, mut c2) = two_copies();
        let b = by_title(&c2, "B");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        c2.delete_item(b.id).unwrap();
        let r = c1.merge_from(&c2);
        assert_eq!(r.updated, 1);
        assert!(by_title(&c1, "B").deleted);
    }

    #[test]
    fn folder_rename_and_new_folder() {
        let (mut c1, mut c2) = two_copies();
        let mut f = c2.folders()[0].clone();
        f.name = "Renamed".into();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        c2.upsert_folder(f.clone()).unwrap();
        let sub = c2
            .upsert_folder(Folder { id: Uuid::nil(), name: "Sub".into(), parent: Some(f.id) })
            .unwrap();
        let r = c1.merge_from(&c2);
        assert_eq!(r.updated, 1);
        assert_eq!(r.added, 1);
        assert_eq!(c1.folder(f.id).unwrap().name, "Renamed");
        assert_eq!(c1.folder(sub.id).unwrap().parent, Some(f.id));
        assert!(c1.merge_from(&c2).is_empty());
    }

    #[test]
    fn merge_survives_save_and_reopen() {
        let (mut c1, mut c2) = two_copies();
        c2.upsert_item(Item::new(ItemKind::Card, "card")).unwrap();
        c1.merge_from(&c2);
        let bytes = c1.save(&Credentials::password("p")).unwrap();
        let re = Vault::open(&bytes, &Credentials::password("p")).unwrap();
        assert_eq!(re.items().len(), 3);
    }
}
