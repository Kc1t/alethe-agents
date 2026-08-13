// Sincronização dos dados do usuário via GitHub Gist privado.
//
// Sobe `projects.json` (estrutura/localização dos projetos + preferências) e
// `activity-stats.json` (horas) como arquivos de um único Gist privado da conta
// do próprio usuário. Sem servidor de OAuth: o usuário cola um Personal Access
// Token (escopo `gist`) uma vez.
//
// Config (token + id do gist + timestamps + login) persiste em
// `app_data_dir/github_sync.json`. Esse arquivo NÃO entra no conjunto
// sincronizado — só `projects.json` e `activity-stats.json` sobem pro gist —
// então o token nunca vaza pro Gist.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::AppHandle;

use crate::paths::app_data_dir;
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

fn config_path(dir: &Path) -> PathBuf {
    dir.join("github_sync.json")
}

fn load_config(dir: &Path) -> SyncConfig {
    let path = config_path(dir);
    let Ok(raw) = fs::read_to_string(&path) else {
        return SyncConfig::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_config(dir: &Path, cfg: &SyncConfig) -> Result<(), String> {
    let path = config_path(dir);
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

/// Lê os arquivos locais que devem ser sincronizados. `projects.json` é
/// obrigatório; `activity-stats.json` é opcional. Pula arquivos vazios — o
/// Gist rejeita conteúdo vazio com 422.
fn collect_files(dir: &Path) -> Result<Vec<(String, String)>, String> {
    let mut files = Vec::new();
    let projects = dir.join("projects.json");
    if projects.is_file() {
        let content = fs::read_to_string(&projects).map_err(|e| e.to_string())?;
        if !content.trim().is_empty() {
            files.push(("projects.json".to_string(), content));
        }
    }
    let activity = dir.join("activity-stats.json");
    if activity.is_file() {
        let content = fs::read_to_string(&activity).map_err(|e| e.to_string())?;
        if !content.trim().is_empty() {
            files.push(("activity-stats.json".to_string(), content));
        }
    }
    Ok(files)
}

/// Escrita atômica (tmp → rename), preservando o padrão do `projects.json`.
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

/// Resolve o conteúdo de um arquivo do gist, buscando o `raw_url` se o GitHub
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

/// Status atual (offline — não bate na rede). Usado ao abrir o modal.
#[tauri::command]
pub fn github_sync_status(app: AppHandle) -> Result<GithubSyncStatus, String> {
    Ok(github_sync_status_core(&app_data_dir(&app)?))
}

pub fn github_sync_status_core(dir: &Path) -> GithubSyncStatus {
    status_from(&load_config(dir))
}

/// Valida o PAT contra `/user` e guarda token + login. Retorna o status novo.
#[tauri::command]
pub async fn github_sync_set_token(
    app: AppHandle,
    token: String,
) -> Result<GithubSyncStatus, String> {
    github_sync_set_token_core(&app_data_dir(&app)?, token).await
}

pub async fn github_sync_set_token_core(
    dir: &Path,
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

    let mut cfg = load_config(dir);
    cfg.token = token;
    cfg.login = login;
    save_config(dir, &cfg)?;
    Ok(status_from(&cfg))
}

/// Desconecta: limpa token e login. Mantém o `gist_id` pra reconectar e
/// reaproveitar o mesmo gist depois.
#[tauri::command]
pub fn github_sync_logout(app: AppHandle) -> Result<GithubSyncStatus, String> {
    github_sync_logout_core(&app_data_dir(&app)?)
}

pub fn github_sync_logout_core(dir: &Path) -> Result<GithubSyncStatus, String> {
    let mut cfg = load_config(dir);
    cfg.token = String::new();
    cfg.login = None;
    save_config(dir, &cfg)?;
    Ok(status_from(&cfg))
}

/// Sobe os JSONs locais pro gist (cria na 1ª vez, depois `PATCH`). Se o gist
/// guardado sumiu (404/422), recria.
#[tauri::command]
pub async fn github_sync_push(app: AppHandle) -> Result<GithubSyncStatus, String> {
    github_sync_push_core(&app_data_dir(&app)?).await
}

pub async fn github_sync_push_core(dir: &Path) -> Result<GithubSyncStatus, String> {
    let mut cfg = load_config(dir);
    if cfg.token.trim().is_empty() {
        return Err("not_connected".to_string());
    }
    let files = collect_files(dir)?;
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
                // gist removido ou inválido → recria
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
    save_config(dir, &cfg)?;
    Ok(status_from(&cfg))
}

/// Baixa o gist e regrava os JSONs locais (escrita atômica). O frontend deve
/// re-hidratar o store depois.
#[tauri::command]
pub async fn github_sync_pull(app: AppHandle) -> Result<GithubSyncStatus, String> {
    github_sync_pull_core(&app_data_dir(&app)?).await
}

pub async fn github_sync_pull_core(dir: &Path) -> Result<GithubSyncStatus, String> {
    let mut cfg = load_config(dir);
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
        write_atomic(&dir.join("projects.json"), &content)?;
    } else {
        return Err("remote_missing_projects".to_string());
    }
    if let Some(content) =
        gist_file_content(&client, &cfg.token, files, "activity-stats.json").await?
    {
        write_atomic(&dir.join("activity-stats.json"), &content)?;
    }

    cfg.last_pull_ms = Some(now_ms());
    save_config(dir, &cfg)?;
    Ok(status_from(&cfg))
}
