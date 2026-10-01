use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::paths::app_data_dir;
use crate::provider_common::now_ms;

const USER_AGENT: &str = "Alethe";
const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_SERVER_URL: &str = "http://127.0.0.1:8787";
const DEFAULT_GITHUB_CLIENT_ID: &str = "Ov23liE8HEZvJ3LGIbIp";

fn server_url() -> String {
    std::env::var("ALETHE_SYNC_SERVER").unwrap_or_else(|_| DEFAULT_SERVER_URL.to_string())
}

fn github_client_id() -> String {
    std::env::var("ALETHE_SYNC_GITHUB_CLIENT_ID")
        .unwrap_or_else(|_| DEFAULT_GITHUB_CLIENT_ID.to_string())
}

#[derive(Default, Serialize, Deserialize)]
struct CloudConfig {
    #[serde(default)]
    token: String,
    #[serde(default)]
    login: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde(default)]
    plan: Option<String>,
    #[serde(default)]
    last_push_ms: Option<u64>,
    #[serde(default)]
    last_pull_ms: Option<u64>,
}

/// Snapshot sent to the frontend. Never includes the session token.
#[derive(Serialize)]
pub struct CloudSyncStatus {
    pub configured: bool,
    pub connected: bool,
    pub login: Option<String>,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub plan: Option<String>,
    pub last_push_ms: Option<u64>,
    pub last_pull_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct CloudDeviceStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("cloud_sync.json"))
}

fn load_config(app: &AppHandle) -> CloudConfig {
    let Ok(path) = config_path(app) else {
        return CloudConfig::default();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return CloudConfig::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_config(app: &AppHandle, cfg: &CloudConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}

fn status_from(cfg: &CloudConfig) -> CloudSyncStatus {
    CloudSyncStatus {
        configured: !github_client_id().is_empty(),
        connected: !cfg.token.trim().is_empty(),
        login: cfg.login.clone(),
        name: cfg.name.clone(),
        avatar_url: cfg.avatar_url.clone(),
        plan: cfg.plan.clone(),
        last_push_ms: cfg.last_push_ms,
        last_pull_ms: cfg.last_pull_ms,
    }
}

fn bearer(req: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    req.header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", USER_AGENT)
}

async fn server_error(resp: reqwest::Response) -> String {
    let status = resp.status();
    if status.as_u16() == 401 {
        return "session_expired".to_string();
    }
    format!("server returned {status}")
}

#[tauri::command]
pub fn cloud_sync_status(app: AppHandle) -> Result<CloudSyncStatus, String> {
    Ok(status_from(&load_config(&app)))
}

#[tauri::command]
pub async fn cloud_sync_device_start() -> Result<CloudDeviceStart, String> {
    let client_id = github_client_id();
    if client_id.is_empty() {
        return Err("not_configured".to_string());
    }
    let client = reqwest::Client::new();
    let resp = client
        .post(GITHUB_DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .header("User-Agent", USER_AGENT)
        .json(&json!({ "client_id": client_id }))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("github returned {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("json parse: {e}"))?;
    let field = |name: &str| -> Result<String, String> {
        body.get(name)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("device response missing {name}"))
    };
    Ok(CloudDeviceStart {
        device_code: field("device_code")?,
        user_code: field("user_code")?,
        verification_uri: field("verification_uri")?,
        interval: body.get("interval").and_then(|v| v.as_u64()).unwrap_or(5),
        expires_in: body
            .get("expires_in")
            .and_then(|v| v.as_u64())
            .unwrap_or(900),
    })
}

#[tauri::command]
pub async fn cloud_sync_device_finish(
    app: AppHandle,
    device_code: String,
    interval: u64,
    expires_in: u64,
) -> Result<CloudSyncStatus, String> {
    let client_id = github_client_id();
    if client_id.is_empty() {
        return Err("not_configured".to_string());
    }
    let client = reqwest::Client::new();
    let mut wait = interval.max(5);
    let deadline = now_ms() + expires_in.min(900) * 1000;

    let access_token = loop {
        if now_ms() > deadline {
            return Err("code_expired".to_string());
        }
        tokio::time::sleep(Duration::from_secs(wait)).await;

        let resp = client
            .post(GITHUB_ACCESS_TOKEN_URL)
            .header("Accept", "application/json")
            .header("User-Agent", USER_AGENT)
            .json(&json!({
                "client_id": client_id,
                "device_code": device_code,
                "grant_type": DEVICE_GRANT_TYPE,
            }))
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("github returned {}", resp.status()));
        }
        let body: Value = resp.json().await.map_err(|e| format!("json parse: {e}"))?;
        if let Some(token) = body.get("access_token").and_then(|v| v.as_str()) {
            break token.to_string();
        }
        match body.get("error").and_then(|v| v.as_str()) {
            Some("authorization_pending") => continue,
            Some("slow_down") => {
                wait += 5;
                continue;
            }
            Some("access_denied") => return Err("access_denied".to_string()),
            Some("expired_token") => return Err("code_expired".to_string()),
            Some(other) => return Err(format!("github oauth error: {other}")),
            None => return Err("malformed oauth response".to_string()),
        }
    };

    let resp = client
        .post(format!("{}/auth/github", server_url()))
        .header("User-Agent", USER_AGENT)
        .json(&json!({ "access_token": access_token }))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("server returned {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("json parse: {e}"))?;
    let token = body
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "server response missing token".to_string())?;
    let user = body.get("user").cloned().unwrap_or(Value::Null);
    let user_str = |name: &str| -> Option<String> {
        user.get(name)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };

    let mut cfg = load_config(&app);
    cfg.token = token.to_string();
    cfg.login = user_str("login");
    cfg.name = user_str("name");
    cfg.avatar_url = user_str("avatarUrl");
    cfg.plan = user_str("plan");
    save_config(&app, &cfg)?;
    Ok(status_from(&cfg))
}

#[tauri::command]
pub fn cloud_sync_logout(app: AppHandle) -> Result<CloudSyncStatus, String> {
    let mut cfg = load_config(&app);
    cfg.token = String::new();
    cfg.login = None;
    cfg.name = None;
    cfg.avatar_url = None;
    cfg.plan = None;
    save_config(&app, &cfg)?;
    Ok(status_from(&cfg))
}

#[tauri::command]
pub async fn cloud_sync_push(app: AppHandle, payload: Value) -> Result<CloudSyncStatus, String> {
    let mut cfg = load_config(&app);
    if cfg.token.trim().is_empty() {
        return Err("not_connected".to_string());
    }
    let client = reqwest::Client::new();
    let resp = bearer(
        client.put(format!("{}/sync/preferences", server_url())),
        &cfg.token,
    )
    .json(&json!({ "payload": payload }))
    .send()
    .await
    .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(server_error(resp).await);
    }
    cfg.last_push_ms = Some(now_ms());
    save_config(&app, &cfg)?;
    Ok(status_from(&cfg))
}

#[tauri::command]
pub async fn cloud_sync_pull(app: AppHandle) -> Result<Value, String> {
    let mut cfg = load_config(&app);
    if cfg.token.trim().is_empty() {
        return Err("not_connected".to_string());
    }
    let client = reqwest::Client::new();
    let resp = bearer(
        client.get(format!("{}/sync/preferences", server_url())),
        &cfg.token,
    )
    .send()
    .await
    .map_err(|e| format!("request failed: {e}"))?;
    if resp.status().as_u16() == 404 {
        return Err("no_remote".to_string());
    }
    if !resp.status().is_success() {
        return Err(server_error(resp).await);
    }
    let body: Value = resp.json().await.map_err(|e| format!("json parse: {e}"))?;
    let payload = body
        .get("payload")
        .cloned()
        .ok_or_else(|| "server response missing payload".to_string())?;
    cfg.last_pull_ms = Some(now_ms());
    save_config(&app, &cfg)?;
    Ok(payload)
}
