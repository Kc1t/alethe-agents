//! Tauri commands for the local voice server list. Store changes run under one lock so two saves
//! never interleave their read-modify-write.

use serde::Serialize;
use tauri::AppHandle;

use super::error::ServerErrorKind;
use super::id::ServerId;
use super::store::{self, ServerInput, VoiceServer};
use super::{active_dir, client, netpolicy, server_key};
use crate::secure_store::SecretKind;
use crate::voice_providers::keys;

static STORE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedServer {
    pub server: VoiceServer,
    pub loopback: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerTest {
    pub ok: bool,
    pub reason: Option<ServerErrorKind>,
    pub voices: Vec<String>,
    pub loopback: bool,
}

#[tauri::command]
pub fn voice_servers_list(app: AppHandle) -> Result<Vec<VoiceServer>, String> {
    let (_, dir) = active_dir(&app)?;
    Ok(store::load(&dir))
}

/// Saves a server. `key`: absent keeps the current key, `""` removes it, anything else replaces it.
#[tauri::command]
pub async fn voice_servers_save(
    app: AppHandle,
    input: ServerInput,
    key: Option<String>,
) -> Result<SavedServer, String> {
    let key = match key.as_deref().map(str::trim) {
        None => None,
        Some("") => Some(None),
        Some(raw) => Some(Some(
            keys::validate_key(raw).map_err(|_| "voice_server_invalidKey".to_string())?,
        )),
    };
    let _guard = STORE_LOCK.lock().await;
    let (_, dir) = active_dir(&app)?;
    let mut servers = store::load(&dir);
    let is_new = input.id.is_none();
    let mut server = store::upsert(&mut servers, input)?;
    let url = netpolicy::parse_base(&server.base_url).map_err(|kind| kind.to_string())?;
    let target = netpolicy::resolve(&url)
        .await
        .map_err(|kind| kind.to_string())?;
    let kind = SecretKind::VoiceServerKey(server.id);
    let wrote_new_key = is_new && matches!(key, Some(Some(_)));
    match key {
        None => {}
        Some(None) => {
            keys::delete_secret_async(&app, kind).await?;
            server.has_key = false;
        }
        Some(Some(value)) => {
            keys::write_secret_async(&app, kind, value).await?;
            server.has_key = true;
        }
    }
    if let Some(entry) = servers.iter_mut().find(|entry| entry.id == server.id) {
        entry.has_key = server.has_key;
    }
    if let Err(error) = store::save(&dir, &servers) {
        // A key written for a server that never reached the list would be orphaned.
        if wrote_new_key {
            let _ = keys::delete_secret_async(&app, kind).await;
        }
        return Err(error);
    }
    Ok(SavedServer {
        server,
        loopback: target.loopback,
    })
}

#[tauri::command]
pub async fn voice_servers_delete(app: AppHandle, id: String) -> Result<(), String> {
    let id = ServerId::parse(&id).ok_or_else(|| ServerErrorKind::Missing.to_string())?;
    let _guard = STORE_LOCK.lock().await;
    let (_, dir) = active_dir(&app)?;
    let mut servers = store::load(&dir);
    if servers.iter().any(|server| server.id == id) {
        keys::delete_secret_async(&app, SecretKind::VoiceServerKey(id)).await?;
    }
    if store::remove(&mut servers, id) {
        store::save(&dir, &servers)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn voice_servers_test(app: AppHandle, id: String) -> Result<ServerTest, String> {
    let failed = |reason, loopback| ServerTest {
        ok: false,
        reason: Some(reason),
        voices: Vec::new(),
        loopback,
    };
    let Some(server) = super::find_active(&app, &id) else {
        return Ok(failed(ServerErrorKind::Missing, true));
    };
    let loopback = match netpolicy::parse_base(&server.base_url) {
        Ok(url) => match netpolicy::resolve(&url).await {
            Ok(target) => target.loopback,
            Err(kind) => return Ok(failed(kind, true)),
        },
        Err(kind) => return Ok(failed(kind, true)),
    };
    let key = match server_key(&app, &server).await {
        Ok(key) => key,
        Err(kind) => return Ok(failed(kind, loopback)),
    };
    if let Err(kind) = client::health(&server, key.as_deref()).await {
        return Ok(failed(kind, loopback));
    }
    let voices = client::voices(&server, key.as_deref())
        .await
        .unwrap_or_default();
    Ok(ServerTest {
        ok: true,
        reason: None,
        voices,
        loopback,
    })
}
