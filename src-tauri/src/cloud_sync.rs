use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::paths::app_data_dir;
use crate::profiles::{ProfileMeta, DEFAULT_PROFILE_ID};
use crate::provider_common::now_ms;
use crate::secure_store::{OsSecretStore, SecretKind, SecretStore};

const USER_AGENT: &str = "Alethe";
const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const DEV_SERVER_URL: &str = "http://127.0.0.1:8790";
const PRODUCTION_SERVER_URL: &str = "https://cloud.kc1t.com";
const DEFAULT_GITHUB_CLIENT_ID: &str = "Ov23liE8HEZvJ3LGIbIp";
const CONFIG_FILE: &str = "cloud_sync.json";
const STATE_FILE: &str = "sync-state.json";
const MACHINE_ID_FILE: &str = "machine-id";
const SCOPES: &[&str] = &["settings", "projects", "tooling", "workspace", "stats", "vault"];

fn compiled_server_url() -> &'static str {
    match option_env!("ALETHE_SYNC_SERVER_URL") {
        Some(url) if !url.trim().is_empty() => url,
        _ if cfg!(debug_assertions) => DEV_SERVER_URL,
        _ => PRODUCTION_SERVER_URL,
    }
}

fn server_url() -> String {
    std::env::var("ALETHE_SYNC_SERVER")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| compiled_server_url().to_string())
        .trim_end_matches('/')
        .to_string()
}

fn github_client_id() -> String {
    std::env::var("ALETHE_SYNC_GITHUB_CLIENT_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_GITHUB_CLIENT_ID.to_string())
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

#[derive(Default, Clone, Serialize, Deserialize)]
struct CloudConfig {
    #[serde(default)]
    login: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde(default)]
    plan: Option<String>,
    #[serde(default)]
    device_id: Option<String>,
}

#[derive(Default, Deserialize)]
struct StoredCloudConfig {
    #[serde(default)]
    token: String,
    #[serde(flatten)]
    metadata: CloudConfig,
}

#[derive(Serialize)]
pub struct CloudSyncStatus {
    pub connected: bool,
    pub login: Option<String>,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub plan: Option<String>,
    pub device_id: Option<String>,
}

#[derive(Serialize)]
pub struct CloudDeviceStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CloudPutOutcome {
    Ok { version: u64 },
    Conflict { remote: Value },
}

struct Session {
    profile_id: String,
    dir: PathBuf,
    cfg: CloudConfig,
    token: Option<String>,
}

fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", nanoid::nanoid!(8)));
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    if let Err(error) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(error.to_string());
    }
    Ok(())
}

fn save_config_at(dir: &Path, cfg: &CloudConfig) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(CONFIG_FILE), &raw)
}

fn load_session_at(
    dir: &Path,
    profile_id: &str,
    store: &impl SecretStore,
) -> Result<(CloudConfig, Option<String>), String> {
    let stored = match fs::read_to_string(dir.join(CONFIG_FILE)) {
        Ok(raw) => serde_json::from_str::<StoredCloudConfig>(&raw).unwrap_or_default(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => StoredCloudConfig::default(),
        Err(error) => return Err(error.to_string()),
    };
    let mut token = store
        .get(profile_id, SecretKind::CloudSyncToken)
        .map_err(|e| e.to_string())?
        .filter(|value| !value.trim().is_empty());

    if !stored.token.trim().is_empty() {
        if token.is_none() {
            store
                .set(profile_id, SecretKind::CloudSyncToken, &stored.token)
                .map_err(|e| e.to_string())?;
            let verified = store
                .get(profile_id, SecretKind::CloudSyncToken)
                .map_err(|e| e.to_string())?;
            if verified.as_deref() != Some(stored.token.as_str()) {
                return Err("secure_store_verification_failed".to_string());
            }
            token = verified;
        }
        save_config_at(dir, &stored.metadata)?;
    }
    Ok((stored.metadata, token))
}

fn active_profile_id(app: &AppHandle) -> Result<String, String> {
    Ok(crate::profiles::ensure_profiles_index(app)?.active_profile_id)
}

fn load_session(app: &AppHandle) -> Result<Session, String> {
    let profile_id = active_profile_id(app)?;
    let dir = app_data_dir(app)?;
    let (cfg, token) = load_session_at(&dir, &profile_id, &OsSecretStore)?;
    Ok(Session {
        profile_id,
        dir,
        cfg,
        token,
    })
}

fn status_from(session: &Session) -> CloudSyncStatus {
    CloudSyncStatus {
        connected: session.token.is_some(),
        login: session.cfg.login.clone(),
        name: session.cfg.name.clone(),
        avatar_url: session.cfg.avatar_url.clone(),
        plan: session.cfg.plan.clone(),
        device_id: session.cfg.device_id.clone(),
    }
}

fn clear_session(session: &mut Session) -> Result<(), String> {
    OsSecretStore
        .delete(&session.profile_id, SecretKind::CloudSyncToken)
        .map_err(|e| e.to_string())?;
    session.token = None;
    session.cfg = CloudConfig::default();
    save_config_at(&session.dir, &session.cfg)?;
    let state = session.dir.join(STATE_FILE);
    if state.exists() {
        fs::remove_file(state).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn require_token(session: &Session) -> Result<String, String> {
    session
        .token
        .clone()
        .ok_or_else(|| "not_connected".to_string())
}

fn validate_scope(scope: &str) -> Result<(), String> {
    if SCOPES.contains(&scope) {
        Ok(())
    } else {
        Err("unknown_scope".to_string())
    }
}

fn error_code(status: u16, code: Option<&str>) -> String {
    match (status, code) {
        (401, _) => "session_expired".to_string(),
        (402, Some("profile_limit")) => "profile_limit".to_string(),
        (402, _) => "plan_required".to_string(),
        (404, Some("no_customer")) => "no_customer".to_string(),
        (413, _) => "payload_too_large".to_string(),
        (429, _) => "rate_limited".to_string(),
        (503, Some("billing_unavailable")) => "billing_unavailable".to_string(),
        (_, Some(code)) => format!("server_error:{code}"),
        _ => format!("server returned {status}"),
    }
}

async fn send(
    session: &mut Session,
    request: reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    let token = require_token(session)?;
    let resp = request
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if resp.status().as_u16() == 401 {
        clear_session(session)?;
    }
    Ok(resp)
}

async fn into_json(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if (200..300).contains(&status) {
        return Ok(body);
    }
    Err(error_code(
        status,
        body.get("error").and_then(|value| value.as_str()),
    ))
}

fn user_field(user: &Value, name: &str) -> Option<String> {
    user.get(name)
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

fn device_name() -> String {
    sysinfo::System::host_name()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Unknown device".to_string())
}

#[tauri::command]
pub fn cloud_sync_status(app: AppHandle) -> Result<CloudSyncStatus, String> {
    Ok(status_from(&load_session(&app)?))
}

#[tauri::command]
pub async fn cloud_sync_device_start() -> Result<CloudDeviceStart, String> {
    let resp = http()
        .post(GITHUB_DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .json(&json!({ "client_id": github_client_id() }))
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

async fn poll_github_token(device_code: &str, interval: u64, expires_in: u64) -> Result<String, String> {
    let mut wait = interval.max(5);
    let deadline = now_ms() + expires_in.min(900) * 1000;
    loop {
        if now_ms() > deadline {
            return Err("code_expired".to_string());
        }
        tokio::time::sleep(Duration::from_secs(wait)).await;
        let resp = http()
            .post(GITHUB_ACCESS_TOKEN_URL)
            .header("Accept", "application/json")
            .json(&json!({
                "client_id": github_client_id(),
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
            return Ok(token.to_string());
        }
        match body.get("error").and_then(|v| v.as_str()) {
            Some("authorization_pending") => continue,
            Some("slow_down") => wait += 5,
            Some("access_denied") => return Err("access_denied".to_string()),
            Some("expired_token") => return Err("code_expired".to_string()),
            Some(other) => return Err(format!("github oauth error: {other}")),
            None => return Err("malformed oauth response".to_string()),
        }
    }
}

#[tauri::command]
pub async fn cloud_sync_device_finish(
    app: AppHandle,
    device_code: String,
    interval: u64,
    expires_in: u64,
) -> Result<CloudSyncStatus, String> {
    let access_token = poll_github_token(&device_code, interval, expires_in).await?;
    let resp = http()
        .post(format!("{}/v1/auth/github", server_url()))
        .json(&json!({
            "access_token": access_token,
            "device": {
                "name": device_name(),
                "platform": std::env::consts::OS,
                "appVersion": app.package_info().version.to_string(),
            },
        }))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let body = into_json(resp).await?;
    let token = body
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "server response missing token".to_string())?;
    let user = body.get("user").cloned().unwrap_or(Value::Null);

    let mut session = load_session(&app)?;
    if session.token.is_some() {
        clear_session(&mut session)?;
    }
    OsSecretStore
        .set(&session.profile_id, SecretKind::CloudSyncToken, token)
        .map_err(|e| e.to_string())?;
    session.token = Some(token.to_string());
    session.cfg = CloudConfig {
        login: user_field(&user, "login"),
        name: user_field(&user, "name"),
        avatar_url: user_field(&user, "avatarUrl"),
        plan: body
            .get("plan")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        device_id: body
            .get("deviceId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    };
    save_config_at(&session.dir, &session.cfg)?;
    Ok(status_from(&session))
}

#[tauri::command]
pub async fn cloud_sync_logout(app: AppHandle) -> Result<CloudSyncStatus, String> {
    let mut session = load_session(&app)?;
    if let Some(token) = session.token.clone() {
        let _ = http()
            .delete(format!("{}/v1/devices/self", server_url()))
            .header("Authorization", format!("Bearer {token}"))
            .timeout(Duration::from_secs(5))
            .send()
            .await;
    }
    clear_session(&mut session)?;
    Ok(status_from(&session))
}

#[tauri::command]
pub async fn cloud_sync_me(app: AppHandle) -> Result<Value, String> {
    let mut session = load_session(&app)?;
    let request = http().get(format!("{}/v1/me", server_url()));
    let resp = send(&mut session, request).await?;
    let mut body = into_json(resp).await?;
    if let Some(token) = body.get("token").and_then(|v| v.as_str()) {
        OsSecretStore
            .set(&session.profile_id, SecretKind::CloudSyncToken, token)
            .map_err(|e| e.to_string())?;
    }
    if let Some(map) = body.as_object_mut() {
        map.remove("token");
    }
    let user = body.get("user").cloned().unwrap_or(Value::Null);
    session.cfg.login = user_field(&user, "login").or(session.cfg.login.take());
    session.cfg.name = user_field(&user, "name");
    session.cfg.avatar_url = user_field(&user, "avatarUrl");
    session.cfg.plan = body
        .get("plan")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    save_config_at(&session.dir, &session.cfg)?;
    Ok(body)
}

#[tauri::command]
pub async fn cloud_sync_manifest(app: AppHandle) -> Result<Value, String> {
    let mut session = load_session(&app)?;
    let request = http().get(format!("{}/v1/sync", server_url()));
    let resp = send(&mut session, request).await?;
    into_json(resp).await
}

#[tauri::command]
pub async fn cloud_sync_get(app: AppHandle, scope: String) -> Result<Option<Value>, String> {
    validate_scope(&scope)?;
    let mut session = load_session(&app)?;
    let request = http().get(format!("{}/v1/sync/{scope}", server_url()));
    let resp = send(&mut session, request).await?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    into_json(resp).await.map(Some)
}

#[tauri::command]
pub async fn cloud_sync_put(
    app: AppHandle,
    scope: String,
    payload: Value,
    base_version: u64,
) -> Result<CloudPutOutcome, String> {
    validate_scope(&scope)?;
    let mut session = load_session(&app)?;
    let request = http()
        .put(format!("{}/v1/sync/{scope}", server_url()))
        .header("If-Match", base_version.to_string())
        .json(&json!({ "payload": payload }));
    let resp = send(&mut session, request).await?;
    if resp.status().as_u16() == 409 {
        let remote: Value = resp.json().await.map_err(|e| format!("json parse: {e}"))?;
        return Ok(CloudPutOutcome::Conflict { remote });
    }
    let body = into_json(resp).await?;
    let version = body
        .get("version")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "server response missing version".to_string())?;
    Ok(CloudPutOutcome::Ok { version })
}

#[tauri::command]
pub async fn cloud_sync_revisions(app: AppHandle, scope: String) -> Result<Value, String> {
    validate_scope(&scope)?;
    let mut session = load_session(&app)?;
    let request = http().get(format!("{}/v1/sync/{scope}/revisions", server_url()));
    let resp = send(&mut session, request).await?;
    into_json(resp).await
}

#[tauri::command]
pub async fn cloud_sync_revision(app: AppHandle, scope: String, version: u64) -> Result<Value, String> {
    validate_scope(&scope)?;
    let mut session = load_session(&app)?;
    let request = http().get(format!("{}/v1/sync/{scope}/revisions/{version}", server_url()));
    let resp = send(&mut session, request).await?;
    into_json(resp).await
}

#[tauri::command]
pub async fn cloud_sync_devices(app: AppHandle) -> Result<Value, String> {
    let mut session = load_session(&app)?;
    let request = http().get(format!("{}/v1/devices", server_url()));
    let resp = send(&mut session, request).await?;
    into_json(resp).await
}

#[tauri::command]
pub async fn cloud_sync_revoke_device(app: AppHandle, device_id: String) -> Result<(), String> {
    if device_id.is_empty() || !device_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("invalid_device".to_string());
    }
    let mut session = load_session(&app)?;
    let request = http().delete(format!("{}/v1/devices/{device_id}", server_url()));
    let resp = send(&mut session, request).await?;
    into_json(resp).await.map(|_| ())
}

#[tauri::command]
pub async fn cloud_sync_delete_account(app: AppHandle) -> Result<CloudSyncStatus, String> {
    let mut session = load_session(&app)?;
    let request = http().delete(format!("{}/v1/account", server_url()));
    let resp = send(&mut session, request).await?;
    into_json(resp).await?;
    clear_session(&mut session)?;
    Ok(status_from(&session))
}

#[tauri::command]
pub async fn cloud_sync_export_account(app: AppHandle, target_path: String) -> Result<(), String> {
    let mut session = load_session(&app)?;
    let request = http().get(format!("{}/v1/export", server_url()));
    let resp = send(&mut session, request).await?;
    let body = into_json(resp).await?;
    let raw = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
    fs::write(target_path, raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cloud_billing_checkout(app: AppHandle, interval: String) -> Result<String, String> {
    let interval = if interval == "month" { "month" } else { "year" };
    let mut session = load_session(&app)?;
    let request = http()
        .post(format!("{}/v1/billing/checkout", server_url()))
        .json(&json!({ "interval": interval }));
    let resp = send(&mut session, request).await?;
    let body = into_json(resp).await?;
    body.get("url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "server response missing url".to_string())
}

#[tauri::command]
pub async fn cloud_billing_portal(app: AppHandle) -> Result<String, String> {
    let mut session = load_session(&app)?;
    let request = http().post(format!("{}/v1/billing/portal", server_url()));
    let resp = send(&mut session, request).await?;
    let body = into_json(resp).await?;
    body.get("url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "server response missing url".to_string())
}

#[tauri::command]
pub async fn cloud_billing_refresh(app: AppHandle) -> Result<Value, String> {
    let mut session = load_session(&app)?;
    let request = http().post(format!("{}/v1/billing/refresh", server_url()));
    let resp = send(&mut session, request).await?;
    let body = into_json(resp).await?;
    if let Some(plan) = body.get("plan").and_then(|v| v.as_str()) {
        session.cfg.plan = Some(plan.to_string());
        save_config_at(&session.dir, &session.cfg)?;
    }
    Ok(body)
}

#[tauri::command]
pub fn cloud_sync_state_read(app: AppHandle) -> Result<Value, String> {
    match fs::read_to_string(app_data_dir(&app)?.join(STATE_FILE)) {
        Ok(raw) => Ok(serde_json::from_str(&raw).unwrap_or(Value::Null)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn cloud_sync_state_write(app: AppHandle, state: Value) -> Result<(), String> {
    let raw = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    write_atomic(&app_data_dir(&app)?.join(STATE_FILE), &raw)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct CloudMachine {
    id: String,
    name: String,
}

fn load_or_create_machine_id(root: &Path) -> Result<String, String> {
    let path = root.join(MACHINE_ID_FILE);
    if let Ok(raw) = fs::read_to_string(&path) {
        let id = raw.trim();
        if !id.is_empty() {
            return Ok(id.to_string());
        }
    }
    let id = nanoid::nanoid!();
    write_atomic(&path, &id)?;
    Ok(id)
}

fn machine_for_profile(
    machine_id: &str,
    host: &str,
    profile: Option<&ProfileMeta>,
) -> CloudMachine {
    match profile {
        Some(profile) if profile.id != DEFAULT_PROFILE_ID => CloudMachine {
            id: format!("{machine_id}:{}", profile.id),
            name: format!("{host} · {}", profile.name),
        },
        _ => CloudMachine {
            id: machine_id.to_string(),
            name: host.to_string(),
        },
    }
}

#[tauri::command]
pub fn cloud_sync_machine(app: AppHandle) -> Result<CloudMachine, String> {
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let machine_id = load_or_create_machine_id(&root)?;
    let index = crate::profiles::ensure_profiles_index(&app)?;
    let profile = index
        .profiles
        .iter()
        .find(|profile| profile.id == index.active_profile_id);
    Ok(machine_for_profile(&machine_id, &device_name(), profile))
}

pub fn delete_profile_session(profile_id: &str) -> Result<(), String> {
    OsSecretStore
        .delete(profile_id, SecretKind::CloudSyncToken)
        .map_err(|e| e.to_string())
}

pub fn reset_sync_state(dir: &Path) -> Result<(), String> {
    let state = dir.join(STATE_FILE);
    if state.exists() {
        fs::remove_file(state).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_store::SecureStoreError;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryStore(RefCell<HashMap<String, String>>);

    impl SecretStore for MemoryStore {
        fn get(&self, profile_id: &str, kind: SecretKind) -> Result<Option<String>, SecureStoreError> {
            Ok(self.0.borrow().get(&format!("{profile_id}:{kind:?}")).cloned())
        }
        fn set(&self, profile_id: &str, kind: SecretKind, value: &str) -> Result<(), SecureStoreError> {
            self.0
                .borrow_mut()
                .insert(format!("{profile_id}:{kind:?}"), value.to_string());
            Ok(())
        }
        fn delete(&self, profile_id: &str, kind: SecretKind) -> Result<(), SecureStoreError> {
            self.0.borrow_mut().remove(&format!("{profile_id}:{kind:?}"));
            Ok(())
        }
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-cloud-sync-{}", nanoid::nanoid!(8)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn plaintext_tokens_move_to_the_keyring_and_leave_the_file() {
        let dir = temp_dir();
        fs::write(
            dir.join(CONFIG_FILE),
            r#"{"token":"jwt-123","login":"kc1t","plan":"free","last_push_ms":1}"#,
        )
        .unwrap();
        let store = MemoryStore::default();

        let (cfg, token) = load_session_at(&dir, "default", &store).unwrap();
        assert_eq!(token.as_deref(), Some("jwt-123"));
        assert_eq!(cfg.login.as_deref(), Some("kc1t"));
        assert_eq!(
            store.get("default", SecretKind::CloudSyncToken).unwrap().as_deref(),
            Some("jwt-123")
        );
        let rewritten = fs::read_to_string(dir.join(CONFIG_FILE)).unwrap();
        assert!(!rewritten.contains("jwt-123"));
        assert!(rewritten.contains("kc1t"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_keyring_token_wins_over_a_stale_plaintext_copy() {
        let dir = temp_dir();
        fs::write(dir.join(CONFIG_FILE), r#"{"token":"old"}"#).unwrap();
        let store = MemoryStore::default();
        store.set("p1", SecretKind::CloudSyncToken, "new").unwrap();

        let (_, token) = load_session_at(&dir, "p1", &store).unwrap();
        assert_eq!(token.as_deref(), Some("new"));
        assert!(!fs::read_to_string(dir.join(CONFIG_FILE)).unwrap().contains("old"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_missing_config_means_signed_out() {
        let dir = temp_dir();
        let (cfg, token) = load_session_at(&dir, "default", &MemoryStore::default()).unwrap();
        assert!(token.is_none());
        assert!(cfg.login.is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_machine_id_is_created_once_and_reused() {
        let dir = temp_dir();
        let first = load_or_create_machine_id(&dir).unwrap();
        assert!(!first.is_empty());
        assert_eq!(load_or_create_machine_id(&dir).unwrap(), first);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn each_extra_profile_is_its_own_machine() {
        let profile = |id: &str, name: &str| ProfileMeta {
            id: id.to_string(),
            name: name.to_string(),
            created_at_ms: 0,
            last_used_at_ms: 0,
        };
        let default = profile(DEFAULT_PROFILE_ID, "Default");
        let work = profile("work", "Work");
        assert_eq!(
            machine_for_profile("abc", "DESKTOP", Some(&default)),
            CloudMachine { id: "abc".into(), name: "DESKTOP".into() }
        );
        assert_eq!(
            machine_for_profile("abc", "DESKTOP", Some(&work)),
            CloudMachine { id: "abc:work".into(), name: "DESKTOP · Work".into() }
        );
    }

    #[test]
    fn only_known_scopes_reach_the_url() {
        assert!(validate_scope("settings").is_ok());
        assert!(validate_scope("vault").is_ok());
        assert_eq!(validate_scope("../account").unwrap_err(), "unknown_scope");
    }

    #[test]
    fn server_errors_map_to_stable_codes() {
        assert_eq!(error_code(401, None), "session_expired");
        assert_eq!(error_code(402, Some("plan_required")), "plan_required");
        assert_eq!(error_code(402, Some("profile_limit")), "profile_limit");
        assert_eq!(error_code(413, None), "payload_too_large");
        assert_eq!(error_code(429, Some("rate_limited")), "rate_limited");
        assert_eq!(error_code(500, Some("internal_error")), "server_error:internal_error");
        assert_eq!(error_code(502, None), "server returned 502");
    }

    #[test]
    fn debug_builds_talk_to_the_local_worker() {
        if option_env!("ALETHE_SYNC_SERVER_URL").is_none() {
            assert_eq!(compiled_server_url(), DEV_SERVER_URL);
        }
    }
}
