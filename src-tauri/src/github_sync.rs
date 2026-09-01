//

//
// Config (token + id do gist + timestamps + login) persiste em

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::AppHandle;

use crate::paths::{activity_stats_file_path, app_data_dir, projects_file_path};
use crate::provider_common::now_ms;

const GIST_DESCRIPTION: &str = "Alethe sync — projects & activity (managed by the app)";
const USER_AGENT: &str = "Alethe";
const GITHUB_API: &str = "https://api.github.com";

#[derive(Default, Serialize, Deserialize)]
struct SyncConfig {
    #[serde(default)]
    token: String,
    #[serde(default)]
    login: Option<String>,
    #[serde(default)]
    gist_id: Option<String>,
    #[serde(default)]
    last_push_ms: Option<u64>,
    #[serde(default)]
    last_pull_ms: Option<u64>,
}

/// Snapshot enviado pro frontend. Nunca inclui o token.
#[derive(Serialize)]
pub struct GithubSyncStatus {
    pub connected: bool,
    pub login: Option<String>,
    pub gist_id: Option<String>,
    pub gist_url: Option<String>,
    pub last_push_ms: Option<u64>,
    pub last_pull_ms: Option<u64>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("github_sync.json"))
}

fn load_config(app: &AppHandle) -> SyncConfig {
    let Ok(path) = config_path(app) else {
        return SyncConfig::default();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return SyncConfig::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_config(app: &AppHandle, cfg: &SyncConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}

fn status_from(cfg: &SyncConfig) -> GithubSyncStatus {
    GithubSyncStatus {
        connected: !cfg.token.trim().is_empty(),
        login: cfg.login.clone(),
        gist_id: cfg.gist_id.clone(),
        gist_url: cfg
            .gist_id
            .as_ref()
            .map(|id| format!("https://gist.github.com/{id}")),
        last_push_ms: cfg.last_push_ms,
        last_pull_ms: cfg.last_pull_ms,
    }
}

fn collect_files(app: &AppHandle) -> Result<Vec<(String, String)>, String> {
    let mut files = Vec::new();
    let projects = projects_file_path(app)?;
    if projects.is_file() {
        let content = fs::read_to_string(&projects).map_err(|e| e.to_string())?;
        if !content.trim().is_empty() {
            files.push(("projects.json".to_string(), content));
        }
    }
    let activity = activity_stats_file_path(app)?;
    if activity.is_file() {
        let content = fs::read_to_string(&activity).map_err(|e| e.to_string())?;
        if !content.trim().is_empty() {
            files.push(("activity-stats.json".to_string(), content));
        }
    }
    Ok(files)
}

fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn auth(req: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    req.header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
}

fn gist_payload(files: &[(String, String)]) -> Value {
    let mut files_json = Map::new();
    for (name, content) in files {
        files_json.insert(name.clone(), json!({ "content": content }));
    }
    json!({
        "description": GIST_DESCRIPTION,
        "public": false,
        "files": Value::Object(files_json),
    })
}

async fn create_gist(
    client: &reqwest::Client,
    token: &str,
    body: &Value,
) -> Result<String, String> {
    let resp = auth(client.post(format!("{GITHUB_API}/gists")), token)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("github returned {}", resp.status()));
    }
    let value: Value = resp.json().await.map_err(|e| format!("json parse: {e}"))?;
    value
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "gist response missing id".to_string())
}

/// truncou o inline (arquivos > 1MB).
async fn gist_file_content(
    client: &reqwest::Client,
    token: &str,
    files: &Map<String, Value>,
    name: &str,
) -> Result<Option<String>, String> {
    let Some(file) = files.get(name) else {
        return Ok(None);
    };
    let truncated = file
        .get("truncated")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !truncated {
        return Ok(file
            .get("content")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()));
    }
    let Some(raw_url) = file.get("raw_url").and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    let resp = auth(client.get(raw_url), token)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("github returned {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(Some(text))
}

#[tauri::command]
pub fn github_sync_status(app: AppHandle) -> Result<GithubSyncStatus, String> {
    Ok(status_from(&load_config(&app)))
}

#[tauri::command]
pub async fn github_sync_set_token(
    app: AppHandle,
    token: String,
) -> Result<GithubSyncStatus, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("empty_token".to_string());
    }
    let client = reqwest::Client::new();
    let resp = auth(client.get(format!("{GITHUB_API}/user")), &token)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if resp.status().as_u16() == 401 {
        return Err("invalid_token".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("github returned {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("json parse: {e}"))?;
    let login = body
        .get("login")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut cfg = load_config(&app);
    cfg.token = token;
    cfg.login = login;
    save_config(&app, &cfg)?;
    Ok(status_from(&cfg))
}

#[tauri::command]
pub fn github_sync_logout(app: AppHandle) -> Result<GithubSyncStatus, String> {
    let mut cfg = load_config(&app);
    cfg.token = String::new();
    cfg.login = None;
    save_config(&app, &cfg)?;
    Ok(status_from(&cfg))
}

/// guardado sumiu (404/422), recria.
#[tauri::command]
pub async fn github_sync_push(app: AppHandle) -> Result<GithubSyncStatus, String> {
    let mut cfg = load_config(&app);
    if cfg.token.trim().is_empty() {
        return Err("not_connected".to_string());
    }
    let files = collect_files(&app)?;
    if files.is_empty() {
        return Err("nothing_to_sync".to_string());
    }
    let body = gist_payload(&files);
    let client = reqwest::Client::new();

    let mut new_id: Option<String> = None;
    if let Some(id) = cfg.gist_id.clone() {
        let resp = auth(client.patch(format!("{GITHUB_API}/gists/{id}")), &cfg.token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        let code = resp.status().as_u16();
        if !resp.status().is_success() {
            if code == 404 || code == 422 {
                new_id = Some(create_gist(&client, &cfg.token, &body).await?);
            } else {
                return Err(format!("github returned {}", resp.status()));
            }
        }
    } else {
        new_id = Some(create_gist(&client, &cfg.token, &body).await?);
    }

    if let Some(id) = new_id {
        cfg.gist_id = Some(id);
    }
    cfg.last_push_ms = Some(now_ms());
    save_config(&app, &cfg)?;
    Ok(status_from(&cfg))
}

#[tauri::command]
pub async fn github_sync_pull(app: AppHandle) -> Result<GithubSyncStatus, String> {
    let mut cfg = load_config(&app);
    if cfg.token.trim().is_empty() {
        return Err("not_connected".to_string());
    }
    let Some(id) = cfg.gist_id.clone() else {
        return Err("no_remote".to_string());
    };
    let client = reqwest::Client::new();
    let resp = auth(client.get(format!("{GITHUB_API}/gists/{id}")), &cfg.token)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if resp.status().as_u16() == 404 {
        return Err("no_remote".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("github returned {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("json parse: {e}"))?;
    let files = body
        .get("files")
        .and_then(|f| f.as_object())
        .ok_or_else(|| "malformed gist".to_string())?;

    if let Some(content) = gist_file_content(&client, &cfg.token, files, "projects.json").await? {
        write_atomic(&projects_file_path(&app)?, &content)?;
    } else {
        return Err("remote_missing_projects".to_string());
    }
    if let Some(content) =
        gist_file_content(&client, &cfg.token, files, "activity-stats.json").await?
    {
        write_atomic(&activity_stats_file_path(&app)?, &content)?;
    }

    cfg.last_pull_ms = Some(now_ms());
    save_config(&app, &cfg)?;
    Ok(status_from(&cfg))
}
