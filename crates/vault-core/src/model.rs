//! Vaultlet's own data model (architecture doc section 1).
//!
//! These types cross the Tauri boundary as JSON, so every struct serializes
//! with camelCase keys.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use uuid::Uuid;

/// What kind of record an [`Item`] is. Stored in the `_vaultlet_kind` field of the KDBX entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    #[default]
    Login,
    Note,
    Card,
    Identity,
}

impl ItemKind {
    /// The value written to the `_vaultlet_kind` custom field.
    pub fn as_str(self) -> &'static str {
        match self {
            ItemKind::Login => "login",
            ItemKind::Note => "note",
            ItemKind::Card => "card",
            ItemKind::Identity => "identity",
        }
    }

    /// Parse the `_vaultlet_kind` value; unknown or missing values default to `Login`.
    pub fn parse(s: &str) -> ItemKind {
        match s.trim().to_ascii_lowercase().as_str() {
            "note" => ItemKind::Note,
            "card" => ItemKind::Card,
            "identity" => ItemKind::Identity,
            _ => ItemKind::Login,
        }
    }
}

/// A custom field. Card/Identity structured data also lives here.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub name: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub protected: bool,
}

impl Field {
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Field {
        Field {
            name: name.into(),
            value: value.into(),
            protected: false,
        }
    }

    pub fn protected(name: impl Into<String>, value: impl Into<String>) -> Field {
        Field {
            name: name.into(),
            value: value.into(),
            protected: true,
        }
    }
}

fn de_uuid_or_nil<'de, D: Deserializer<'de>>(d: D) -> Result<Uuid, D::Error> {
    let s: Option<String> = Option::deserialize(d)?;
    match s.as_deref().map(str::trim) {
        None | Some("") => Ok(Uuid::nil()),
        Some(s) => Uuid::parse_str(s).map_err(serde::de::Error::custom),
    }
}

fn de_opt_uuid<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Uuid>, D::Error> {
    let s: Option<String> = Option::deserialize(d)?;
    match s.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(s) => Uuid::parse_str(s)
            .map(Some)
            .map_err(serde::de::Error::custom),
    }
}

/// A vault record. Maps 1:1 onto a KDBX entry (see the mapping table in the architecture doc).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// Nil (or `""` in JSON) means "new item, allocate an id on upsert".
    #[serde(default, deserialize_with = "de_uuid_or_nil")]
    pub id: Uuid,
    #[serde(default)]
    pub kind: ItemKind,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// First entry is the primary URL.
    #[serde(default)]
    pub urls: Vec<String>,
    /// `otpauth://totp/...` URI or a bare base32 secret.
    #[serde(default)]
    pub totp: Option<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub fields: Vec<Field>,
    /// Folder (KDBX group) id; `None` = root.
    #[serde(default, deserialize_with = "de_opt_uuid")]
    pub folder: Option<Uuid>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "Utc::now")]
    pub created: DateTime<Utc>,
    #[serde(default = "Utc::now")]
    pub modified: DateTime<Utc>,
    #[serde(default)]
    pub last_used: Option<DateTime<Utc>>,
    /// True when the entry sits in the recycle bin.
    #[serde(default)]
    pub deleted: bool,
}

impl Default for Item {
    fn default() -> Self {
        let now = Utc::now();
        Item {
            id: Uuid::nil(),
            kind: ItemKind::Login,
            title: String::new(),
            username: String::new(),
            password: String::new(),
            urls: Vec::new(),
            totp: None,
            notes: String::new(),
            fields: Vec::new(),
            folder: None,
            favorite: false,
            tags: Vec::new(),
            created: now,
            modified: now,
            last_used: None,
            deleted: false,
        }
    }
}

impl Item {
    /// A fresh item with a random id.
    pub fn new(kind: ItemKind, title: impl Into<String>) -> Item {
        Item {
            id: Uuid::new_v4(),
            kind,
            title: title.into(),
            ..Item::default()
        }
    }

    pub fn has_totp(&self) -> bool {
        self.totp.as_deref().is_some_and(|t| !t.trim().is_empty())
    }

    /// Look up a custom field by name.
    pub fn field(&self, name: &str) -> Option<&Field> {
        self.fields.iter().find(|f| f.name == name)
    }
}

/// Listing view of an [`Item`]: no password, TOTP secret, custom fields or notes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSummary {
    pub id: Uuid,
    pub kind: ItemKind,
    pub title: String,
    pub username: String,
    pub urls: Vec<String>,
    pub folder: Option<Uuid>,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub created: DateTime<Utc>,
    pub modified: DateTime<Utc>,
    pub last_used: Option<DateTime<Utc>>,
    pub deleted: bool,
    pub has_totp: bool,
}

impl From<&Item> for ItemSummary {
    fn from(item: &Item) -> Self {
        ItemSummary {
            id: item.id,
            kind: item.kind,
            title: item.title.clone(),
            username: item.username.clone(),
            urls: item.urls.clone(),
            folder: item.folder,
            favorite: item.favorite,
            tags: item.tags.clone(),
            created: item.created,
            modified: item.modified,
            last_used: item.last_used,
            deleted: item.deleted,
            has_totp: item.has_totp(),
        }
    }
}

/// A folder (KDBX group). `parent == None` means directly under the root group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    #[serde(default, deserialize_with = "de_uuid_or_nil")]
    pub id: Uuid,
    pub name: String,
    #[serde(default, deserialize_with = "de_opt_uuid")]
    pub parent: Option<Uuid>,
}

impl Folder {
    pub fn new(name: impl Into<String>) -> Folder {
        Folder {
            id: Uuid::new_v4(),
            name: name.into(),
            parent: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_json_is_camel_case_and_accepts_empty_id() {
        let json = r#"{"id":"","kind":"card","title":"Visa","fields":[{"name":"number","value":"4111","protected":true}],"folder":""}"#;
        let item: Item = serde_json::from_str(json).unwrap();
        assert!(item.id.is_nil());
        assert_eq!(item.kind, ItemKind::Card);
        assert_eq!(item.folder, None);
        assert!(item.fields[0].protected);

        let out = serde_json::to_value(&item).unwrap();
        assert!(out.get("lastUsed").is_some());
        assert!(out.get("last_used").is_none());
        assert_eq!(out["kind"], "card");
    }

    #[test]
    fn summary_drops_secrets() {
        let mut item = Item::new(ItemKind::Login, "x");
        item.password = "p".into();
        item.totp = Some("JBSWY3DPEHPK3PXP".into());
        let s = ItemSummary::from(&item);
        assert!(s.has_totp);
        let v = serde_json::to_value(&s).unwrap();
        assert!(v.get("password").is_none());
        assert!(v.get("totp").is_none());
        assert_eq!(v["hasTotp"], true);
    }
}
