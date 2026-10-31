//! Text-to-speech servers the person runs themselves (OpenAI-compatible or Fish Speech), reached
//! over HTTP on this computer or the local network. The list and keys stay on the Rust side; the
//! webview only passes a server id.

pub mod adapter;
pub mod client;
pub mod commands;
pub mod error;
pub mod id;
pub mod netpolicy;
pub mod store;

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use self::error::ServerErrorKind;
use self::store::VoiceServer;
use crate::secure_store::SecretKind;

/// The active profile id and its data folder, where `voice-servers.json` lives.
pub fn active_dir(app: &AppHandle) -> Result<(String, PathBuf), String> {
    let profile = crate::profiles::ensure_profiles_index(app)?.active_profile_id;
    let dir = crate::profiles::profile_data_dir_for_id(app, &profile)?;
    Ok((profile, dir))
}

pub fn find_active(app: &AppHandle, id: &str) -> Option<VoiceServer> {
    let id = id::ServerId::parse(id)?;
    let (_, dir) = active_dir(app).ok()?;
    store::load(&dir).into_iter().find(|server| server.id == id)
}

/// The server's key, read only when it has one (a keychain read can prompt).
pub async fn server_key(
    app: &AppHandle,
    server: &VoiceServer,
) -> Result<Option<String>, ServerErrorKind> {
    if !server.has_key {
        return Ok(None);
    }
    crate::voice_providers::keys::read_secret_async(app, SecretKind::VoiceServerKey(server.id))
        .await
        .map_err(|_| ServerErrorKind::Other)
}

/// The voices of a saved server; empty when it is unknown, unreachable or lists none.
pub async fn voices_for(app: &AppHandle, id: &str) -> Vec<String> {
    let Some(server) = find_active(app, id) else {
        return Vec::new();
    };
    let Ok(key) = server_key(app, &server).await else {
        return Vec::new();
    };
    client::voices(&server, key.as_deref())
        .await
        .unwrap_or_default()
}

/// Runs `delete` for the key of every server saved in `dir`; every key is tried, the first error is
/// reported.
fn server_key_kinds(
    dir: &Path,
    mut delete: impl FnMut(SecretKind) -> Result<(), String>,
) -> Result<(), String> {
    let mut first_error = None;
    for server in store::load(dir) {
        if let Err(error) = delete(SecretKind::VoiceServerKey(server.id)) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Removes the keychain keys of a profile's voice servers (profile deletion).
pub fn delete_profile_keys(profile: &str, dir: &Path) -> Result<(), String> {
    server_key_kinds(dir, |kind| {
        crate::voice_providers::keys::delete_secret(profile, kind)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_profile_keys_removes_every_server_key() {
        let dir = std::env::temp_dir().join(format!(
            "alethe-voice-servers-profile-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let mut servers = Vec::new();
        for name in ["a", "b"] {
            let input = store::ServerInput {
                id: None,
                name: name.into(),
                kind: adapter::ServerKind::Openai,
                base_url: "http://localhost".into(),
                model: None,
            };
            store::upsert(&mut servers, input).unwrap();
        }
        store::save(&dir, &servers).unwrap();
        let mut deleted = Vec::new();
        server_key_kinds(&dir, |kind| {
            deleted.push(kind);
            Ok(())
        })
        .unwrap();
        assert_eq!(
            deleted,
            servers
                .iter()
                .map(|s| crate::secure_store::SecretKind::VoiceServerKey(s.id))
                .collect::<Vec<_>>()
        );
    }
}
