//! The active profile's voice servers in `{profile dir}/voice-servers.json`, written atomically.
//! Keys live in the keychain; the file only records whether a server has one.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::adapter::ServerKind;
use super::error::ServerErrorKind;
use super::id::ServerId;
use super::netpolicy;

pub const FILE_NAME: &str = "voice-servers.json";
const VERSION: u32 = 1;
pub const MAX_SERVERS: usize = 32;
const MAX_NAME: usize = 64;
const MAX_MODEL: usize = 128;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceServer {
    pub id: ServerId,
    pub name: String,
    pub kind: ServerKind,
    pub base_url: String,
    #[serde(default)]
    pub model: Option<String>,
    /// Whether a key is in the keychain, so listing never reads the keychain.
    #[serde(default)]
    pub has_key: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInput {
    pub id: Option<String>,
    pub name: String,
    pub kind: ServerKind,
    pub base_url: String,
    pub model: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    servers: Vec<VoiceServer>,
}

fn path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// The saved servers. A missing file is an empty list; an unreadable or newer one is logged and
/// read as empty, and left on disk until the next save.
pub fn load(dir: &Path) -> Vec<VoiceServer> {
    let Ok(text) = std::fs::read_to_string(path(dir)) else {
        return Vec::new();
    };
    match serde_json::from_str::<StoreFile>(&text) {
        Ok(file) if file.version == VERSION => file.servers,
        _ => {
            eprintln!("[voice_servers] {FILE_NAME} unreadable; using an empty list");
            Vec::new()
        }
    }
}

pub fn save(dir: &Path, servers: &[VoiceServer]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&StoreFile {
        version: VERSION,
        servers: servers.to_vec(),
    })
    .map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{FILE_NAME}.tmp"));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path(dir)).map_err(|e| e.to_string())
}

fn code(kind: &str) -> String {
    format!("voice_server_{kind}")
}

/// Creates (no id) or edits (id) a server after checking its fields; the address is checked for
/// shape only here; its resolution is checked by the caller.
pub fn upsert(servers: &mut Vec<VoiceServer>, input: ServerInput) -> Result<VoiceServer, String> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME || name.chars().any(char::is_control) {
        return Err(code("invalidName"));
    }
    if !input.base_url.trim().contains("://") {
        return Err(code("invalidUrl"));
    }
    let url =
        netpolicy::parse_base(&input.base_url).map_err(|_| ServerErrorKind::Policy.to_string())?;
    let model = match input.model.as_deref().map(str::trim) {
        Some(model) if model.chars().count() > MAX_MODEL => return Err(code("invalidModel")),
        Some(model) if !model.is_empty() && input.kind == ServerKind::Openai => {
            Some(model.to_string())
        }
        _ => None,
    };
    let base_url = netpolicy::base_string(&url);
    match input.id {
        Some(raw) => {
            let id = ServerId::parse(&raw).ok_or_else(|| code("missing"))?;
            let entry = servers
                .iter_mut()
                .find(|server| server.id == id)
                .ok_or_else(|| code("missing"))?;
            entry.name = name.to_string();
            entry.kind = input.kind;
            entry.base_url = base_url;
            entry.model = model;
            Ok(entry.clone())
        }
        None => {
            if servers.len() >= MAX_SERVERS {
                return Err(code("limit"));
            }
            let server = VoiceServer {
                id: ServerId::new(),
                name: name.to_string(),
                kind: input.kind,
                base_url,
                model,
                has_key: false,
            };
            servers.push(server.clone());
            Ok(server)
        }
    }
}

pub fn remove(servers: &mut Vec<VoiceServer>, id: ServerId) -> bool {
    let before = servers.len();
    servers.retain(|server| server.id != id);
    servers.len() != before
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("alethe-voice-servers-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn input(name: &str, url: &str) -> ServerInput {
        ServerInput {
            id: None,
            name: name.into(),
            kind: ServerKind::Openai,
            base_url: url.into(),
            model: None,
        }
    }

    #[test]
    fn missing_file_is_an_empty_list() {
        assert!(load(&temp_dir("missing")).is_empty());
    }

    #[test]
    fn saved_servers_load_back() {
        let dir = temp_dir("roundtrip");
        let mut servers = Vec::new();
        let saved = upsert(&mut servers, input("Chatterbox", "http://localhost:4123/")).unwrap();
        assert_eq!(saved.base_url, "http://localhost:4123");
        save(&dir, &servers).unwrap();
        assert_eq!(load(&dir), servers);
        assert!(!dir.join(format!("{FILE_NAME}.tmp")).exists());
    }

    #[test]
    fn corrupt_or_newer_files_read_as_empty_and_stay_on_disk() {
        let dir = temp_dir("corrupt");
        std::fs::write(dir.join(FILE_NAME), "{not json").unwrap();
        assert!(load(&dir).is_empty());
        assert_eq!(
            std::fs::read_to_string(dir.join(FILE_NAME)).unwrap(),
            "{not json"
        );
        std::fs::write(dir.join(FILE_NAME), r#"{"version":99,"servers":[]}"#).unwrap();
        assert!(load(&dir).is_empty());
    }

    #[test]
    fn upsert_validates_name_url_and_model() {
        let mut servers = Vec::new();
        assert_eq!(
            upsert(&mut servers, input("  ", "http://localhost")).unwrap_err(),
            "voice_server_invalidName"
        );
        assert_eq!(
            upsert(&mut servers, input(&"n".repeat(65), "http://localhost")).unwrap_err(),
            "voice_server_invalidName"
        );
        assert_eq!(
            upsert(&mut servers, input("x", "ftp://localhost")).unwrap_err(),
            "voice_server_policy"
        );
        for bare in ["localhost:4123", "192.168.1.10:8080"] {
            assert_eq!(
                upsert(&mut servers, input("x", bare)).unwrap_err(),
                "voice_server_invalidUrl"
            );
        }
        let mut long_model = input("x", "http://localhost");
        long_model.model = Some("m".repeat(129));
        assert_eq!(
            upsert(&mut servers, long_model).unwrap_err(),
            "voice_server_invalidModel"
        );
        assert!(servers.is_empty());
    }

    #[test]
    fn fish_servers_drop_the_model_and_blank_models_are_none() {
        let mut servers = Vec::new();
        let mut fish = input("Fish", "http://127.0.0.1:8080");
        fish.kind = ServerKind::Fish;
        fish.model = Some("x".into());
        assert_eq!(upsert(&mut servers, fish).unwrap().model, None);
        let mut blank = input("Kokoro", "http://127.0.0.1:8880");
        blank.model = Some("  ".into());
        assert_eq!(upsert(&mut servers, blank).unwrap().model, None);
    }

    #[test]
    fn upsert_edits_by_id_and_keeps_has_key() {
        let mut servers = Vec::new();
        let first = upsert(&mut servers, input("A", "http://localhost:1")).unwrap();
        servers[0].has_key = true;
        let mut edit = input("B", "http://localhost:2");
        edit.id = Some(first.id.to_string());
        let edited = upsert(&mut servers, edit).unwrap();
        assert_eq!(
            (edited.id, edited.name.as_str(), edited.has_key),
            (first.id, "B", true)
        );
        assert_eq!(servers.len(), 1);
        let mut unknown = input("C", "http://localhost:3");
        unknown.id = Some("V1StGXR8_Z5jdHi6B-myT".into());
        assert_eq!(
            upsert(&mut servers, unknown).unwrap_err(),
            "voice_server_missing"
        );
    }

    #[test]
    fn the_list_is_capped() {
        let mut servers = Vec::new();
        for index in 0..MAX_SERVERS {
            upsert(
                &mut servers,
                input(&format!("s{index}"), "http://localhost"),
            )
            .unwrap();
        }
        assert_eq!(
            upsert(&mut servers, input("one more", "http://localhost")).unwrap_err(),
            "voice_server_limit"
        );
    }

    #[test]
    fn remove_reports_whether_it_found_the_server() {
        let mut servers = Vec::new();
        let saved = upsert(&mut servers, input("A", "http://localhost")).unwrap();
        assert!(remove(&mut servers, saved.id));
        assert!(!remove(&mut servers, saved.id));
    }
}
