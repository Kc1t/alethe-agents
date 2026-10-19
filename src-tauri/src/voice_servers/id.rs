//! Server ids: nanoid strings (21 characters of `A-Za-z0-9_-`), stored inline so the id is `Copy`
//! and can live inside `SecretKind`.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub const ID_LEN: usize = 21;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct ServerId([u8; ID_LEN]);

impl ServerId {
    pub fn new() -> Self {
        Self::parse(&nanoid::nanoid!()).expect("nanoid uses the id alphabet")
    }

    pub fn parse(raw: &str) -> Option<Self> {
        let bytes = raw.as_bytes();
        let valid = bytes.len() == ID_LEN
            && bytes
                .iter()
                .all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-');
        if !valid {
            return None;
        }
        let mut id = [0u8; ID_LEN];
        id.copy_from_slice(bytes);
        Some(Self(id))
    }

    pub fn as_str(&self) -> &str {
        std::str::from_utf8(&self.0).expect("ids are ASCII")
    }
}

impl Default for ServerId {
    /// A fresh random id (same as [`ServerId::new`]).
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for ServerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl fmt::Display for ServerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for ServerId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ServerId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::parse(&raw).ok_or_else(|| serde::de::Error::custom("invalid server id"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_ids_parse_back() {
        let id = ServerId::new();
        assert_eq!(ServerId::parse(id.as_str()), Some(id));
        assert_ne!(ServerId::new(), id);
    }

    #[test]
    fn only_nanoid_shaped_strings_parse() {
        assert!(ServerId::parse("V1StGXR8_Z5jdHi6B-myT").is_some());
        for bad in [
            "",
            "short",
            "V1StGXR8_Z5jdHi6B-myT1",
            "V1StGXR8/Z5jdHi6B-myT",
            "../../../../../../../..",
        ] {
            assert!(ServerId::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn serde_round_trips_as_a_string() {
        let id = ServerId::parse("V1StGXR8_Z5jdHi6B-myT").unwrap();
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, "\"V1StGXR8_Z5jdHi6B-myT\"");
        assert_eq!(serde_json::from_str::<ServerId>(&json).unwrap(), id);
        assert!(serde_json::from_str::<ServerId>("\"nope\"").is_err());
    }
}
