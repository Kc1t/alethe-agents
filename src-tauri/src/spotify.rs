// Spotify integration — OAuth Authorization Code flow + currently-playing polling.
//
// Fluxo:

// 2. Trocamos `code` por `access_token`/`refresh_token` no /api/token.
// 3. Tokens persistem em `app_local_data_dir/spotify_tokens.json`.
// 4. `spotify_get_current` chama /me/player/currently-playing, refrescando

//

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::paths::app_data_dir;

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

fn resolve_credentials(
    client_id: Option<String>,
    client_secret: Option<String>,
) -> Result<SpotifyCredentials, String> {
    let cid = client_id
        .filter(|v| !v.trim().is_empty())
        .or_else(|| std::env::var("SPOTIFY_CLIENT_ID").ok())
        .unwrap_or_default()
        .trim()
        .to_string();
    let secret = client_secret
        .filter(|v| !v.trim().is_empty())
        .or_else(|| std::env::var("SPOTIFY_CLIENT_SECRET").ok())
        .unwrap_or_default()
        .trim()
        .to_string();
    if cid.is_empty() || secret.is_empty() {
        return Err(
            "spotify credentials not configured — set Client ID/Secret in Preferences".to_string(),
        );
    }
    Ok(SpotifyCredentials {
        client_id: cid,
        client_secret: secret,
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

fn tokens_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app_data_dir(app)?.join("spotify_tokens.json"))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct StoredTokens {
    access_token: String,
    refresh_token: String,
    /// epoch seconds when access_token expires
    expires_at: u64,
}

fn load_tokens(app: &AppHandle) -> Option<StoredTokens> {
    let path = tokens_path(app).ok()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_tokens(app: &AppHandle, tokens: &StoredTokens) -> Result<(), String> {
    let path = tokens_path(app).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(tokens).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

fn delete_tokens(app: &AppHandle) -> Result<(), String> {
    let path = tokens_path(app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
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
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("token exchange failed: {body}"));
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
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("refresh failed: {body}"));
    }
    resp.json::<TokenResponse>()
        .await
        .map_err(|e| format!("refresh parse: {e}"))
}

async fn ensure_fresh_access_token(
    app: &AppHandle,
    credentials: &SpotifyCredentials,
) -> Result<String, String> {
    let tokens = load_tokens(app).ok_or_else(|| "not connected".to_string())?;
    if tokens.expires_at > now_secs() + 30 {
        return Ok(tokens.access_token);
    }
    let refreshed = refresh_token(&tokens.refresh_token, credentials).await?;
    let new_tokens = StoredTokens {
        access_token: refreshed.access_token.clone(),
        refresh_token: refreshed
            .refresh_token
            .unwrap_or(tokens.refresh_token.clone()),
        expires_at: now_secs() + refreshed.expires_in,
    };
    save_tokens(app, &new_tokens)?;
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
    let credentials = resolve_credentials(client_id, client_secret)?;

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
    save_tokens(&app, &tokens)?;
    Ok(())
}

#[tauri::command]
pub fn spotify_logout(app: AppHandle) -> Result<(), String> {
    delete_tokens(&app)
}

#[tauri::command]
pub fn spotify_status(app: AppHandle) -> bool {
    load_tokens(&app).is_some()
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
        let body = response.text().await.unwrap_or_default();
        return Err(format!("recently played failed ({status}): {body}"));
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
    let credentials = match resolve_credentials(client_id, client_secret) {
        Ok(credentials) => credentials,
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
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("now playing failed ({status}): {body}"));
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
    use super::parse_track;

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
