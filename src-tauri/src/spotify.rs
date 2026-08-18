// Spotify integration — OAuth Authorization Code flow and currently-playing polling.
// Client secrets and OAuth tokens are profile-scoped in the operating system credential store.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::paths::app_data_dir;
use crate::secure_store::{OsSecretStore, SecretKind, SecretStore};

const REDIRECT_URI: &str = "http://127.0.0.1:8888/callback";
const SCOPES: &str =
    "user-read-currently-playing user-read-playback-state user-read-recently-played";
const AUTHORIZE_URL: &str = "https://accounts.spotify.com/authorize";
const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
const NOW_PLAYING_URL: &str = "https://api.spotify.com/v1/me/player/currently-playing";
const RECENTLY_PLAYED_URL: &str = "https://api.spotify.com/v1/me/player/recently-played?limit=1";

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

static LOGIN_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

struct LoginGuard;
impl Drop for LoginGuard {
    fn drop(&mut self) {
        LOGIN_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

#[derive(Clone, Debug)]
struct SpotifyCredentials {
    client_id: String,
    client_secret: String,
}

fn active_profile_id(app: &AppHandle) -> Result<String, String> {
    Ok(crate::profiles::ensure_profiles_index(app)?.active_profile_id)
}

fn resolve_credentials(
    profile_id: &str,
    client_id: Option<String>,
    client_secret: Option<String>,
    store: &impl SecretStore,
) -> Result<SpotifyCredentials, String> {
    let client_id = client_id
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("SPOTIFY_CLIENT_ID").ok())
        .unwrap_or_default()
        .trim()
        .to_string();
    let supplied_secret = client_secret.filter(|value| !value.trim().is_empty());
    let stored_secret = if supplied_secret.is_none() {
        store
            .get(profile_id, SecretKind::SpotifyClientSecret)
            .map_err(|error| error.to_string())?
            .filter(|value| !value.trim().is_empty())
    } else {
        None
    };
    let client_secret = supplied_secret
        .or(stored_secret)
        .or_else(|| std::env::var("SPOTIFY_CLIENT_SECRET").ok())
        .unwrap_or_default()
        .trim()
        .to_string();
    if client_id.is_empty() || client_secret.is_empty() {
        return Err(
            "spotify credentials not configured — set Client ID/Secret in Preferences".to_string(),
        );
    }
    Ok(SpotifyCredentials {
        client_id,
        client_secret,
    })
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn rand_state() -> String {
    nanoid::nanoid!(24)
}

fn tokens_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("spotify_tokens.json"))
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct StoredTokenFile {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    expires_at: u64,
}

#[derive(Serialize, Clone, Debug)]
struct TokenMetadata {
    expires_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StoredTokens {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
}

type SecretSnapshot = Vec<(SecretKind, Option<String>)>;

fn write_raw_atomic(path: &Path, raw: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "spotify_metadata_write_failed".to_string())?;
    }
    let temporary = path.with_extension(format!("json.{}.tmp", nanoid::nanoid!(10)));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "spotify_metadata_write_failed".to_string())?;
    if file
        .write_all(raw.as_bytes())
        .and_then(|_| file.sync_all())
        .is_err()
    {
        let _ = fs::remove_file(&temporary);
        return Err("spotify_metadata_write_failed".to_string());
    }
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|_| "spotify_metadata_write_failed".to_string())?;
    }
    if fs::rename(&temporary, path).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("spotify_metadata_write_failed".to_string());
    }
    Ok(())
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(value)
        .map_err(|_| "spotify_metadata_write_failed".to_string())?;
    write_raw_atomic(path, &raw)
}

fn restore_secrets(
    store: &impl SecretStore,
    profile_id: &str,
    snapshot: &SecretSnapshot,
) -> Result<(), String> {
    for (kind, previous) in snapshot {
        match previous {
            Some(value) => store.set(profile_id, *kind, value),
            None => store.delete(profile_id, *kind),
        }
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn replace_secrets(
    store: &impl SecretStore,
    profile_id: &str,
    replacements: &[(SecretKind, &str)],
) -> Result<SecretSnapshot, String> {
    let mut snapshot = Vec::with_capacity(replacements.len());
    for (kind, _) in replacements {
        snapshot.push((
            *kind,
            store
                .get(profile_id, *kind)
                .map_err(|error| error.to_string())?,
        ));
    }

    for (kind, value) in replacements {
        let result = store
            .set(profile_id, *kind, value)
            .map_err(|error| error.to_string())
            .and_then(|()| {
                let verified = store
                    .get(profile_id, *kind)
                    .map_err(|error| error.to_string())?;
                if verified.as_deref() == Some(*value) {
                    Ok(())
                } else {
                    Err("secure_store_verification_failed".to_string())
                }
            });
        if let Err(error) = result {
            if restore_secrets(store, profile_id, &snapshot).is_err() {
                return Err("secure_store_rollback_failed".to_string());
            }
            return Err(error);
        }
    }
    Ok(snapshot)
}

fn delete_spotify_secrets(store: &impl SecretStore, profile_id: &str) -> Result<(), String> {
    let kinds = [
        SecretKind::SpotifyClientSecret,
        SecretKind::SpotifyAccessToken,
        SecretKind::SpotifyRefreshToken,
    ];
    let mut snapshot = Vec::with_capacity(kinds.len());
    for kind in kinds {
        snapshot.push((
            kind,
            store
                .get(profile_id, kind)
                .map_err(|error| error.to_string())?,
        ));
    }
    for kind in kinds {
        if let Err(error) = store
            .delete(profile_id, kind)
            .map_err(|error| error.to_string())
        {
            if restore_secrets(store, profile_id, &snapshot).is_err() {
                return Err("secure_store_rollback_failed".to_string());
            }
            return Err(error);
        }
    }
    Ok(())
}

pub(crate) fn migrate_client_secret_content(
    content: &str,
    profile_id: &str,
    store: &impl SecretStore,
) -> Result<String, String> {
    let mut value: serde_json::Value =
        serde_json::from_str(content).map_err(|_| "invalid_projects_file".to_string())?;
    let Some(preferences) = value
        .get_mut("preferences")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return Ok(content.to_string());
    };
    let Some(legacy_value) = preferences.get("spotifyClientSecret") else {
        return Ok(content.to_string());
    };
    let plaintext = legacy_value.as_str().unwrap_or_default().trim().to_string();
    if !plaintext.is_empty() {
        let existing = store
            .get(profile_id, SecretKind::SpotifyClientSecret)
            .map_err(|error| error.to_string())?
            .filter(|secret| !secret.trim().is_empty());
        if existing.is_none() {
            replace_secrets(
                store,
                profile_id,
                &[(SecretKind::SpotifyClientSecret, plaintext.as_str())],
            )?;
        }
    }
    preferences.remove("spotifyClientSecret");
    serde_json::to_string_pretty(&value).map_err(|_| "invalid_projects_file".to_string())
}

pub(crate) fn sanitize_client_secret_content(content: &str) -> Result<String, String> {
    let mut value: serde_json::Value =
        serde_json::from_str(content).map_err(|_| "invalid_projects_file".to_string())?;
    let removed = value
        .get_mut("preferences")
        .and_then(serde_json::Value::as_object_mut)
        .and_then(|preferences| preferences.remove("spotifyClientSecret"))
        .is_some();
    if !removed {
        return Ok(content.to_string());
    }
    serde_json::to_string_pretty(&value).map_err(|_| "invalid_projects_file".to_string())
}

fn load_tokens_from(
    path: &Path,
    profile_id: &str,
    store: &impl SecretStore,
) -> Result<Option<StoredTokens>, String> {
    let (stored, had_plaintext_fields) = match fs::read_to_string(path) {
        Ok(raw) => {
            let value: serde_json::Value =
                serde_json::from_str(&raw).map_err(|_| "invalid_spotify_metadata".to_string())?;
            let had_fields =
                value.get("access_token").is_some() || value.get("refresh_token").is_some();
            let stored = serde_json::from_value::<StoredTokenFile>(value)
                .map_err(|_| "invalid_spotify_metadata".to_string())?;
            (stored, had_fields)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            (StoredTokenFile::default(), false)
        }
        Err(_) => return Err("spotify_metadata_read_failed".to_string()),
    };

    let mut access = store
        .get(profile_id, SecretKind::SpotifyAccessToken)
        .map_err(|error| error.to_string())?
        .filter(|secret| !secret.trim().is_empty());
    let mut refresh = store
        .get(profile_id, SecretKind::SpotifyRefreshToken)
        .map_err(|error| error.to_string())?
        .filter(|secret| !secret.trim().is_empty());
    let mut replacements = Vec::new();
    if access.is_none() && !stored.access_token.trim().is_empty() {
        replacements.push((SecretKind::SpotifyAccessToken, stored.access_token.as_str()));
    }
    if refresh.is_none() && !stored.refresh_token.trim().is_empty() {
        replacements.push((
            SecretKind::SpotifyRefreshToken,
            stored.refresh_token.as_str(),
        ));
    }
    if !replacements.is_empty() {
        replace_secrets(store, profile_id, &replacements)?;
        access = store
            .get(profile_id, SecretKind::SpotifyAccessToken)
            .map_err(|error| error.to_string())?
            .filter(|secret| !secret.trim().is_empty());
        refresh = store
            .get(profile_id, SecretKind::SpotifyRefreshToken)
            .map_err(|error| error.to_string())?
            .filter(|secret| !secret.trim().is_empty());
    }
    if had_plaintext_fields {
        write_json_atomic(
            path,
            &TokenMetadata {
                expires_at: stored.expires_at,
            },
        )?;
    }

    match (access, refresh) {
        (None, None) => Ok(None),
        (Some(access_token), Some(refresh_token)) => Ok(Some(StoredTokens {
            access_token,
            refresh_token,
            expires_at: stored.expires_at,
        })),
        _ => Err("spotify_secure_credentials_incomplete".to_string()),
    }
}

pub(crate) fn migrate_profile_plaintext_files(
    profile_dir: &Path,
    profile_id: &str,
    store: &impl SecretStore,
) -> Result<(), String> {
    let projects_path = profile_dir.join("projects.json");
    if projects_path.exists() {
        let content = fs::read_to_string(&projects_path)
            .map_err(|_| "spotify_projects_read_failed".to_string())?;
        let migrated = migrate_client_secret_content(&content, profile_id, store)?;
        if migrated != content {
            write_raw_atomic(&projects_path, &migrated)?;
        }
    }
    let _ = load_tokens_from(&profile_dir.join("spotify_tokens.json"), profile_id, store)?;
    Ok(())
}

fn load_tokens(app: &AppHandle) -> Result<Option<StoredTokens>, String> {
    let profile_id = active_profile_id(app)?;
    load_tokens_from(&tokens_path(app)?, &profile_id, &OsSecretStore)
}

fn save_tokens_from(
    path: &Path,
    profile_id: &str,
    store: &impl SecretStore,
    tokens: &StoredTokens,
    client_secret: Option<&str>,
) -> Result<(), String> {
    let mut replacements = vec![
        (SecretKind::SpotifyAccessToken, tokens.access_token.as_str()),
        (
            SecretKind::SpotifyRefreshToken,
            tokens.refresh_token.as_str(),
        ),
    ];
    if let Some(secret) = client_secret.filter(|secret| !secret.trim().is_empty()) {
        replacements.push((SecretKind::SpotifyClientSecret, secret));
    }
    let snapshot = replace_secrets(store, profile_id, &replacements)?;
    if let Err(error) = write_json_atomic(
        path,
        &TokenMetadata {
            expires_at: tokens.expires_at,
        },
    ) {
        if restore_secrets(store, profile_id, &snapshot).is_err() {
            return Err("secure_store_rollback_failed".to_string());
        }
        return Err(error);
    }
    Ok(())
}

fn save_tokens(
    app: &AppHandle,
    tokens: &StoredTokens,
    client_secret: Option<&str>,
) -> Result<(), String> {
    let profile_id = active_profile_id(app)?;
    save_tokens_from(
        &tokens_path(app)?,
        &profile_id,
        &OsSecretStore,
        tokens,
        client_secret,
    )
}

fn delete_tokens(app: &AppHandle) -> Result<(), String> {
    let profile_id = active_profile_id(app)?;
    delete_spotify_secrets(&OsSecretStore, &profile_id)?;
    let path = tokens_path(app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|_| "spotify_metadata_delete_failed".to_string())?;
    }
    Ok(())
}

pub(crate) fn delete_profile_secrets(profile_id: &str) -> Result<(), String> {
    delete_spotify_secrets(&OsSecretStore, profile_id)
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    /// segundos
    expires_in: u64,

    refresh_token: Option<String>,
}

async fn exchange_code(
    code: &str,
    credentials: &SpotifyCredentials,
) -> Result<TokenResponse, String> {
    let basic = base64::engine::general_purpose::STANDARD.encode(format!(
        "{}:{}",
        credentials.client_id, credentials.client_secret
    ));
    let resp = http_client()
        .post(TOKEN_URL)
        .header("Authorization", format!("Basic {}", basic))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!(
            "grant_type=authorization_code&code={}&redirect_uri={}&client_id={}",
            urlencoding::encode(code),
            urlencoding::encode(REDIRECT_URI),
            urlencoding::encode(&credentials.client_id),
        ))
        .send()
        .await
        .map_err(|e| format!("token request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("token exchange failed ({})", resp.status()));
    }
    resp.json::<TokenResponse>()
        .await
        .map_err(|e| format!("token parse: {e}"))
}

async fn refresh_token(
    refresh_token: &str,
    credentials: &SpotifyCredentials,
) -> Result<TokenResponse, String> {
    let basic = base64::engine::general_purpose::STANDARD.encode(format!(
        "{}:{}",
        credentials.client_id, credentials.client_secret
    ));
    let resp = http_client()
        .post(TOKEN_URL)
        .header("Authorization", format!("Basic {}", basic))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!(
            "grant_type=refresh_token&refresh_token={}&client_id={}",
            urlencoding::encode(refresh_token),
            urlencoding::encode(&credentials.client_id),
        ))
        .send()
        .await
        .map_err(|e| format!("refresh request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("refresh failed ({})", resp.status()));
    }
    resp.json::<TokenResponse>()
        .await
        .map_err(|e| format!("refresh parse: {e}"))
}

fn rotated_refresh_token(previous: String, replacement: Option<String>) -> String {
    replacement
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(previous)
}

async fn ensure_fresh_access_token(
    app: &AppHandle,
    credentials: &SpotifyCredentials,
) -> Result<String, String> {
    let tokens = load_tokens(app)?.ok_or_else(|| "not connected".to_string())?;
    if tokens.expires_at > now_secs() + 30 {
        return Ok(tokens.access_token);
    }
    let refreshed = refresh_token(&tokens.refresh_token, credentials).await?;
    let new_tokens = StoredTokens {
        access_token: refreshed.access_token.clone(),
        refresh_token: rotated_refresh_token(tokens.refresh_token, refreshed.refresh_token),
        expires_at: now_secs() + refreshed.expires_in,
    };
    save_tokens(app, &new_tokens, None)?;
    Ok(new_tokens.access_token)
}

fn wait_for_oauth_callback(expected_state: &str) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:8888").map_err(|e| format!("bind 8888: {e}"))?;
    listener.set_nonblocking(false).map_err(|e| e.to_string())?;

    loop {
        let (mut stream, _) = listener.accept().map_err(|e| e.to_string())?;
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
        let req = String::from_utf8_lossy(&buf[..n]);

        // GET /callback?code=...&state=... HTTP/1.1
        let first_line = req.lines().next().unwrap_or("");
        let parts: Vec<&str> = first_line.split_whitespace().collect();
        let path_and_query = parts.get(1).copied().unwrap_or("/");

        if !path_and_query.starts_with("/callback") {
            // ignora favicon etc
            let body = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
            let _ = stream.write_all(body);
            continue;
        }

        let query = path_and_query.split_once('?').map(|x| x.1).unwrap_or("");
        let mut code: Option<String> = None;
        let mut state: Option<String> = None;
        let mut error: Option<String> = None;
        for pair in query.split('&') {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            let decoded = urlencoding::decode(v).map(|s| s.into_owned()).ok();
            match k {
                "code" => code = decoded,
                "state" => state = decoded,
                "error" => error = decoded,
                _ => {}
            }
        }

        let success_html = b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body style='background:#0d0d0d;color:#e8e8e8;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0'><div style='text-align:center'><h1 style='font-weight:500'>Conectado ao Spotify</h1><p style='color:#888'>Pode fechar essa aba e voltar pro Alethe.</p></div></body></html>";
        let _ = stream.write_all(success_html);
        let _ = stream.flush();

        if let Some(err) = error {
            return Err(format!("authorize error: {err}"));
        }
        if state.as_deref() != Some(expected_state) {
            return Err("state mismatch — possível CSRF".to_string());
        }
        return code.ok_or_else(|| "no code in callback".to_string());
    }
}

/* ----------------- commands ----------------- */

#[tauri::command]
pub async fn spotify_login(
    app: AppHandle,
    client_id: Option<String>,
    client_secret: Option<String>,
) -> Result<(), String> {
    let profile_id = active_profile_id(&app)?;
    let credentials = resolve_credentials(&profile_id, client_id, client_secret, &OsSecretStore)?;

    if LOGIN_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("login already in progress".to_string());
    }
    let _guard = LoginGuard;

    let state = rand_state();
    let auth_url = format!(
        "{AUTHORIZE_URL}?response_type=code&client_id={}&scope={}&redirect_uri={}&state={}",
        urlencoding::encode(&credentials.client_id),
        urlencoding::encode(SCOPES),
        urlencoding::encode(REDIRECT_URI),
        urlencoding::encode(&state),
    );

    // interpreta os `&` da URL como separadores de comando.
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &auth_url])
            .spawn()
            .map_err(|e| format!("open browser: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&auth_url)
            .spawn()
            .map_err(|e| format!("open browser: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&auth_url)
            .spawn()
            .map_err(|e| format!("open browser: {e}"))?;
    }

    let expected_state = state.clone();
    let code =
        tauri::async_runtime::spawn_blocking(move || wait_for_oauth_callback(&expected_state))
            .await
            .map_err(|e| format!("blocking task: {e}"))??;

    let token_resp = exchange_code(&code, &credentials).await?;
    let tokens = StoredTokens {
        access_token: token_resp.access_token,
        refresh_token: token_resp
            .refresh_token
            .ok_or_else(|| "spotify did not return a refresh token".to_string())?,
        expires_at: now_secs() + token_resp.expires_in,
    };
    save_tokens(&app, &tokens, Some(&credentials.client_secret))?;
    Ok(())
}

#[tauri::command]
pub fn spotify_logout(app: AppHandle) -> Result<(), String> {
    delete_tokens(&app)
}

#[tauri::command]
pub fn spotify_status(app: AppHandle) -> Result<bool, String> {
    Ok(load_tokens(&app)?.is_some())
}

#[derive(Serialize, Default)]
pub struct NowPlaying {
    pub playing: bool,
    pub track: String,
    pub artist: String,
    pub album: String,
    pub cover_url: Option<String>,
    pub duration_ms: u64,
    pub progress_ms: u64,
    pub track_url: Option<String>,
}

fn parse_track(item: &serde_json::Value, playing: bool, progress_ms: u64) -> Option<NowPlaying> {
    if item.is_null() {
        return None;
    }
    let track = item.get("name")?.as_str()?.to_string();
    let artist = item
        .get("artists")
        .and_then(|value| value.as_array())
        .map(|artists| {
            artists
                .iter()
                .filter_map(|artist| artist.get("name").and_then(|name| name.as_str()))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let album = item
        .get("album")
        .and_then(|value| value.get("name"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let cover_url = item
        .get("album")
        .and_then(|value| value.get("images"))
        .and_then(|value| value.as_array())
        .and_then(|images| images.last())
        .and_then(|image| image.get("url"))
        .and_then(|value| value.as_str())
        .map(String::from);
    let track_url = item
        .get("external_urls")
        .and_then(|value| value.get("spotify"))
        .and_then(|value| value.as_str())
        .map(String::from);
    let duration_ms = item
        .get("duration_ms")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);

    Some(NowPlaying {
        playing,
        track,
        artist,
        album,
        cover_url,
        duration_ms,
        progress_ms,
        track_url,
    })
}

async fn fetch_recently_played(access: &str) -> Result<Option<NowPlaying>, String> {
    let response = http_client()
        .get(RECENTLY_PLAYED_URL)
        .header("Authorization", format!("Bearer {access}"))
        .send()
        .await
        .map_err(|error| format!("recently played request: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("recently played failed ({status})"));
    }
    let json: serde_json::Value = response.json().await.map_err(|error| error.to_string())?;
    let track = json
        .get("items")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("track"));
    Ok(track.and_then(|item| parse_track(item, false, 0)))
}

#[tauri::command]
pub async fn spotify_get_current(
    app: AppHandle,
    client_id: Option<String>,
    client_secret: Option<String>,
) -> Result<Option<NowPlaying>, String> {
    let profile_id = active_profile_id(&app)?;
    let credentials =
        match resolve_credentials(&profile_id, client_id, client_secret, &OsSecretStore) {
            Ok(credentials) => credentials,
            Err(error) if error.starts_with("secure_store_") => return Err(error),
            Err(_) => return Ok(None),
        };
    let access = match ensure_fresh_access_token(&app, &credentials).await {
        Ok(t) => t,
        Err(e) if e == "not connected" => return Ok(None),
        Err(e) => return Err(e),
    };
    let resp = http_client()
        .get(NOW_PLAYING_URL)
        .header("Authorization", format!("Bearer {}", access))
        .send()
        .await
        .map_err(|e| format!("now playing request: {e}"))?;

    let status = resp.status();
    if status.as_u16() == 204 {
        return fetch_recently_played(&access).await;
    }
    if !status.is_success() {
        return Err(format!("now playing failed ({status})"));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let playing = json
        .get("is_playing")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let progress_ms = json
        .get("progress_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if let Some(now_playing) = json
        .get("item")
        .and_then(|item| parse_track(item, playing, progress_ms))
    {
        return Ok(Some(now_playing));
    }
    fetch_recently_played(&access).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MockStore {
        values: Mutex<HashMap<(String, SecretKind), String>>,
        fail_set: Mutex<Option<SecretKind>>,
        fail_delete: Mutex<Option<SecretKind>>,
    }

    impl MockStore {
        fn put(&self, profile_id: &str, kind: SecretKind, value: &str) {
            self.values
                .lock()
                .expect("values")
                .insert((profile_id.to_string(), kind), value.to_string());
        }

        fn value(&self, profile_id: &str, kind: SecretKind) -> Option<String> {
            self.values
                .lock()
                .expect("values")
                .get(&(profile_id.to_string(), kind))
                .cloned()
        }

        fn fail_next_set(&self, kind: SecretKind) {
            *self.fail_set.lock().expect("fail set") = Some(kind);
        }

        fn fail_next_delete(&self, kind: SecretKind) {
            *self.fail_delete.lock().expect("fail delete") = Some(kind);
        }
    }

    impl SecretStore for MockStore {
        fn get(
            &self,
            profile_id: &str,
            kind: SecretKind,
        ) -> Result<Option<String>, crate::secure_store::SecureStoreError> {
            Ok(self.value(profile_id, kind))
        }

        fn set(
            &self,
            profile_id: &str,
            kind: SecretKind,
            value: &str,
        ) -> Result<(), crate::secure_store::SecureStoreError> {
            let mut fail_set = self.fail_set.lock().expect("fail set");
            if *fail_set == Some(kind) {
                *fail_set = None;
                return Err(crate::secure_store::SecureStoreError::Unavailable("write"));
            }
            drop(fail_set);
            self.put(profile_id, kind, value);
            Ok(())
        }

        fn delete(
            &self,
            profile_id: &str,
            kind: SecretKind,
        ) -> Result<(), crate::secure_store::SecureStoreError> {
            let mut fail_delete = self.fail_delete.lock().expect("fail delete");
            if *fail_delete == Some(kind) {
                *fail_delete = None;
                return Err(crate::secure_store::SecureStoreError::Unavailable("delete"));
            }
            drop(fail_delete);
            self.values
                .lock()
                .expect("values")
                .remove(&(profile_id.to_string(), kind));
            Ok(())
        }
    }

    fn temp_path(label: &str, file_name: &str) -> (PathBuf, PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "alethe-spotify-{label}-{}-{}",
            std::process::id(),
            nanoid::nanoid!(8)
        ));
        fs::create_dir_all(&directory).expect("temp directory");
        let path = directory.join(file_name);
        (directory, path)
    }

    #[test]
    fn migrates_legacy_tokens_only_after_verified_keyring_writes() {
        let (directory, path) = temp_path("migration", "spotify_tokens.json");
        let legacy =
            r#"{"access_token":"legacy-access","refresh_token":"legacy-refresh","expires_at":42}"#;
        fs::write(&path, legacy).expect("legacy tokens");
        let store = MockStore::default();

        let loaded = load_tokens_from(&path, "profile-a", &store)
            .expect("migration")
            .expect("tokens");
        assert_eq!(loaded.access_token, "legacy-access");
        assert_eq!(loaded.refresh_token, "legacy-refresh");
        assert_eq!(loaded.expires_at, 42);
        assert_eq!(
            store.value("profile-a", SecretKind::SpotifyAccessToken),
            Some("legacy-access".to_string())
        );
        let scrubbed = fs::read_to_string(&path).expect("scrubbed metadata");
        assert!(!scrubbed.contains("legacy-access"));
        assert!(!scrubbed.contains("legacy-refresh"));
        assert!(scrubbed.contains("42"));

        fs::remove_dir_all(directory).expect("cleanup");
    }

    #[test]
    fn keyring_failure_preserves_the_legacy_token_file_and_rolls_back() {
        let (directory, path) = temp_path("failure", "spotify_tokens.json");
        let legacy = r#"{"access_token":"only-copy-access","refresh_token":"only-copy-refresh","expires_at":42}"#;
        fs::write(&path, legacy).expect("legacy tokens");
        let store = MockStore::default();
        store.fail_next_set(SecretKind::SpotifyRefreshToken);

        let error = load_tokens_from(&path, "profile-a", &store).expect_err("must fail");
        assert_eq!(error, "secure_store_unavailable: write");
        assert_eq!(fs::read_to_string(&path).expect("legacy file"), legacy);
        assert_eq!(
            store.value("profile-a", SecretKind::SpotifyAccessToken),
            None
        );
        assert_eq!(
            store.value("profile-a", SecretKind::SpotifyRefreshToken),
            None
        );

        fs::remove_dir_all(directory).expect("cleanup");
    }

    #[test]
    fn existing_secure_tokens_win_over_stale_plaintext() {
        let (directory, path) = temp_path("precedence", "spotify_tokens.json");
        fs::write(
            &path,
            r#"{"access_token":"stale-access","refresh_token":"stale-refresh","expires_at":99}"#,
        )
        .expect("legacy tokens");
        let store = MockStore::default();
        store.put("profile-a", SecretKind::SpotifyAccessToken, "secure-access");
        store.put(
            "profile-a",
            SecretKind::SpotifyRefreshToken,
            "secure-refresh",
        );

        let loaded = load_tokens_from(&path, "profile-a", &store)
            .expect("migration")
            .expect("tokens");
        assert_eq!(loaded.access_token, "secure-access");
        assert_eq!(loaded.refresh_token, "secure-refresh");
        let scrubbed = fs::read_to_string(&path).expect("scrubbed metadata");
        assert!(!scrubbed.contains("stale-access"));
        assert!(!scrubbed.contains("stale-refresh"));

        fs::remove_dir_all(directory).expect("cleanup");
    }

    #[test]
    fn existing_secure_client_secret_wins_and_plaintext_is_scrubbed() {
        let store = MockStore::default();
        store.put(
            "profile-a",
            SecretKind::SpotifyClientSecret,
            "secure-client-secret",
        );
        let legacy = r#"{"preferences":{"spotifyClientId":"public-id","spotifyClientSecret":"stale-client-secret"}}"#;

        let migrated = migrate_client_secret_content(legacy, "profile-a", &store)
            .expect("client secret migration");
        assert!(!migrated.contains("stale-client-secret"));
        assert!(migrated.contains("public-id"));
        assert_eq!(
            store.value("profile-a", SecretKind::SpotifyClientSecret),
            Some("secure-client-secret".to_string())
        );
    }

    #[test]
    fn client_secret_keyring_failure_preserves_projects_plaintext() {
        let (directory, path) = temp_path("client-secret-failure", "projects.json");
        let legacy = r#"{"preferences":{"spotifyClientId":"public-id","spotifyClientSecret":"only-copy-client-secret"}}"#;
        fs::write(&path, legacy).expect("legacy projects");
        let store = MockStore::default();
        store.fail_next_set(SecretKind::SpotifyClientSecret);

        let error = migrate_profile_plaintext_files(&directory, "profile-a", &store)
            .expect_err("migration must fail");
        assert_eq!(error, "secure_store_unavailable: write");
        assert_eq!(fs::read_to_string(&path).expect("projects"), legacy);
        assert_eq!(
            store.value("profile-a", SecretKind::SpotifyClientSecret),
            None
        );

        fs::remove_dir_all(directory).expect("cleanup");
    }

    #[test]
    fn token_rotation_is_verified_and_rolls_back_on_partial_failure() {
        let (directory, path) = temp_path("rotation", "spotify_tokens.json");
        let store = MockStore::default();
        store.put("profile-a", SecretKind::SpotifyAccessToken, "old-access");
        store.put("profile-a", SecretKind::SpotifyRefreshToken, "old-refresh");
        store.put(
            "profile-a",
            SecretKind::SpotifyClientSecret,
            "old-client-secret",
        );
        let first = StoredTokens {
            access_token: "new-access".to_string(),
            refresh_token: "new-refresh".to_string(),
            expires_at: 100,
        };
        save_tokens_from(
            &path,
            "profile-a",
            &store,
            &first,
            Some("new-client-secret"),
        )
        .expect("rotation");
        assert_eq!(
            store.value("profile-a", SecretKind::SpotifyRefreshToken),
            Some("new-refresh".to_string())
        );

        store.fail_next_set(SecretKind::SpotifyRefreshToken);
        let failed = StoredTokens {
            access_token: "failed-access".to_string(),
            refresh_token: "failed-refresh".to_string(),
            expires_at: 200,
        };
        assert!(save_tokens_from(&path, "profile-a", &store, &failed, None).is_err());
        assert_eq!(
            store.value("profile-a", SecretKind::SpotifyAccessToken),
            Some("new-access".to_string())
        );
        assert_eq!(
            store.value("profile-a", SecretKind::SpotifyRefreshToken),
            Some("new-refresh".to_string())
        );
        assert_eq!(
            store.value("profile-a", SecretKind::SpotifyClientSecret),
            Some("new-client-secret".to_string())
        );

        fs::remove_dir_all(directory).expect("cleanup");
    }

    #[test]
    fn refresh_preserves_the_previous_token_when_spotify_omits_a_replacement() {
        assert_eq!(
            rotated_refresh_token("existing-refresh".to_string(), None),
            "existing-refresh"
        );
        assert_eq!(
            rotated_refresh_token("existing-refresh".to_string(), Some(String::new())),
            "existing-refresh"
        );
        assert_eq!(
            rotated_refresh_token(
                "existing-refresh".to_string(),
                Some("rotated-refresh".to_string())
            ),
            "rotated-refresh"
        );
    }

    #[test]
    fn cleanup_deletes_all_spotify_secrets_and_rolls_back_on_failure() {
        let store = MockStore::default();
        for (kind, value) in [
            (SecretKind::SpotifyClientSecret, "client"),
            (SecretKind::SpotifyAccessToken, "access"),
            (SecretKind::SpotifyRefreshToken, "refresh"),
        ] {
            store.put("profile-a", kind, value);
        }
        store.fail_next_delete(SecretKind::SpotifyRefreshToken);
        assert!(delete_spotify_secrets(&store, "profile-a").is_err());
        assert_eq!(
            store.value("profile-a", SecretKind::SpotifyClientSecret),
            Some("client".to_string())
        );
        assert_eq!(
            store.value("profile-a", SecretKind::SpotifyAccessToken),
            Some("access".to_string())
        );
        assert_eq!(
            store.value("profile-a", SecretKind::SpotifyRefreshToken),
            Some("refresh".to_string())
        );

        delete_spotify_secrets(&store, "profile-a").expect("cleanup");
        assert_eq!(
            store.value("profile-a", SecretKind::SpotifyClientSecret),
            None
        );
        assert_eq!(
            store.value("profile-a", SecretKind::SpotifyAccessToken),
            None
        );
        assert_eq!(
            store.value("profile-a", SecretKind::SpotifyRefreshToken),
            None
        );
    }

    #[test]
    fn parses_recent_track_as_paused_now_playing() {
        let item = serde_json::json!({
            "name": "A Track",
            "artists": [{ "name": "An Artist" }],
            "album": {
                "name": "An Album",
                "images": [{ "url": "https://example.com/large.jpg" }, { "url": "https://example.com/small.jpg" }]
            },
            "duration_ms": 123_000,
            "external_urls": { "spotify": "https://open.spotify.com/track/example" }
        });

        let parsed = parse_track(&item, false, 0).expect("track should parse");
        assert!(!parsed.playing);
        assert_eq!(parsed.track, "A Track");
        assert_eq!(parsed.artist, "An Artist");
        assert_eq!(
            parsed.cover_url.as_deref(),
            Some("https://example.com/small.jpg")
        );
    }
}
