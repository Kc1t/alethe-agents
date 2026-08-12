// Perfis e projects.json — não dá pra reaproveitar `profiles.rs`/`projects.rs`
// direto (toda função de lá recebe `tauri::AppHandle` pra resolver
// `app_data_dir()`, e `alethe-server` não tem runtime do Tauri nenhum
// rodando). Resolve o mesmo diretório manualmente, do mesmo jeito que o
// Tauri resolveria no Windows (`%LOCALAPPDATA%\<identifier>`), e lê/escreve
// os MESMOS arquivos em disco — por isso fica sincronizado com o Desktop sem
// precisar reimplementar toda a lógica de `AppHandle`.

use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

use crate::AppError;

/// `npm run app` roda com `src-tauri/tauri.dev.json`, que troca o identifier
/// pra `com.kc1t.alethe.dev` (não `com.kc1t.alethe`, o de produção) — sem
/// essa mesma troca aqui, `alethe-server` e o Desktop em dev liam
/// `%LOCALAPPDATA%` de pastas DIFERENTES, cada um enxergando um conjunto de
/// perfis distinto (confirmado ao vivo: web via o perfil certo, Desktop dev
/// achava que não tinha perfil nenhum e oferecia criar um novo). Variável de
/// ambiente `ALETHE_APP_IDENTIFIER` permite apontar pra produção
/// (`com.kc1t.alethe`) quando não for mais um `npm run app` de dev.
const DEFAULT_APP_IDENTIFIER: &str = "com.kc1t.alethe.dev";

fn app_identifier() -> String {
    std::env::var("ALETHE_APP_IDENTIFIER").unwrap_or_else(|_| DEFAULT_APP_IDENTIFIER.to_string())
}

fn app_local_data_dir() -> PathBuf {
    let identifier = app_identifier();
    if let Ok(v) = std::env::var("LOCALAPPDATA") {
        PathBuf::from(v).join(&identifier)
    } else if let Ok(v) = std::env::var("APPDATA") {
        PathBuf::from(v).join(&identifier)
    } else if let Ok(v) = std::env::var("USERPROFILE") {
        PathBuf::from(v).join(".alethe")
    } else {
        PathBuf::from("./alethe_data")
    }
}

fn profiles_json_path() -> PathBuf {
    app_local_data_dir().join("profiles.json")
}

fn default_profiles_index() -> Value {
    json!({
        "version": 1,
        "active_profile_id": "default",
        "profiles": [{
            "id": "default",
            "name": "Default",
            "created_at_ms": now_ms(),
            "last_used_at_ms": now_ms(),
        }],
    })
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn read_or_create_profiles_index() -> Value {
    let path = profiles_json_path();
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<Value>(&content) {
            return v;
        }
    }
    let default_val = default_profiles_index();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(
        &path,
        serde_json::to_string_pretty(&default_val).unwrap_or_default(),
    );
    default_val
}

fn write_profiles_index(index: &Value) -> Result<(), String> {
    let path = profiles_json_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    fs::write(&path, body).map_err(|e| e.to_string())
}

fn active_profile_id(index: &Value) -> String {
    index
        .get("active_profile_id")
        .and_then(|v| v.as_str())
        .unwrap_or("default")
        .to_string()
}

fn profile_dir(profile_id: &str) -> PathBuf {
    app_local_data_dir().join("profiles").join(profile_id)
}

fn projects_json_path(profile_id: &str) -> PathBuf {
    profile_dir(profile_id).join("projects.json")
}

/// Diretório de dados do perfil ATIVO (`profiles/<id>/`) — mesmo caminho que
/// `paths::profile_data_dir(app)` resolveria no desktop via `AppHandle`, só
/// que sem precisar de `AppHandle` nenhum. Usado por outras rotas
/// (`session_routes.rs`, Time Analytics) que guardam arquivo no mesmo lugar
/// que `projects.json`.
pub fn active_profile_dir() -> PathBuf {
    let index = read_or_create_profiles_index();
    profile_dir(&active_profile_id(&index))
}

/// Devolve só `{active_profile_id, profiles}` — o formato que `ProfilesState`
/// (frontend) espera, sem o campo `version` interno.
fn to_profiles_state(index: &Value) -> Value {
    json!({
        "active_profile_id": active_profile_id(index),
        "profiles": index.get("profiles").cloned().unwrap_or(json!([])),
    })
}

pub fn router() -> Router {
    Router::new()
        .route("/api/profiles/list", get(list))
        .route("/api/profiles/summaries", get(summaries))
        .route("/api/profiles/active", get(active))
        .route("/api/profiles/set_active", post(set_active))
        .route("/api/profiles/create", post(create))
        .route("/api/profiles/rename", post(rename))
        .route("/api/profiles/delete", post(delete))
        .route("/api/projects", get(load_projects))
        .route("/api/projects/load", get(load_projects))
        .route("/api/projects/save", post(save_projects))
}

async fn list() -> impl IntoResponse {
    Json(to_profiles_state(&read_or_create_profiles_index()))
}

async fn active() -> impl IntoResponse {
    let index = read_or_create_profiles_index();
    let id = active_profile_id(&index);
    let profiles = index
        .get("profiles")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let meta = profiles
        .iter()
        .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
        .cloned()
        .unwrap_or_else(|| json!({ "id": id, "name": "Default", "created_at_ms": now_ms(), "last_used_at_ms": now_ms() }));
    Json(meta)
}

/// Conta projetos/terminais lendo o `projects.json` de cada perfil — best
/// effort via `serde_json::Value` (sem struct tipada): se o arquivo não
/// existir ou tiver um shape inesperado, conta 0 em vez de falhar a rota
/// inteira por causa de UM perfil corrompido/vazio.
async fn summaries() -> impl IntoResponse {
    let index = read_or_create_profiles_index();
    let active_id = active_profile_id(&index);
    let profiles = index
        .get("profiles")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let result: Vec<Value> = profiles
        .iter()
        .map(|p| {
            let id = p.get("id").and_then(|v| v.as_str()).unwrap_or("default").to_string();
            let (project_count, terminal_count) = count_projects_and_terminals(&id);
            json!({
                "id": id,
                "name": p.get("name").and_then(|v| v.as_str()).unwrap_or("Default"),
                "profile_image_url": p.get("profile_image_url").and_then(|v| v.as_str()).unwrap_or(""),
                "created_at_ms": p.get("created_at_ms").cloned().unwrap_or(json!(0)),
                "last_used_at_ms": p.get("last_used_at_ms").cloned().unwrap_or(json!(0)),
                "project_count": project_count,
                "terminal_count": terminal_count,
                "is_active": id == active_id,
            })
        })
        .collect();
    Json(result)
}

fn count_projects_and_terminals(profile_id: &str) -> (usize, usize) {
    let path = projects_json_path(profile_id);
    let Ok(content) = fs::read_to_string(&path) else {
        return (0, 0);
    };
    let Ok(root) = serde_json::from_str::<Value>(&content) else {
        return (0, 0);
    };
    let projects = root
        .get("projects")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let project_count = projects.len();
    let terminal_count = projects
        .iter()
        .filter_map(|p| {
            p.get("terminals")
                .and_then(|t| t.as_array())
                .map(|t| t.len())
        })
        .sum();
    (project_count, terminal_count)
}

#[derive(Deserialize)]
struct SetActiveBody {
    #[serde(rename = "profileId")]
    profile_id: String,
}
async fn set_active(Json(b): Json<SetActiveBody>) -> impl IntoResponse {
    let mut index = read_or_create_profiles_index();
    index["active_profile_id"] = json!(b.profile_id);
    match write_profiles_index(&index) {
        Ok(()) => Json(to_profiles_state(&index)).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

#[derive(Deserialize)]
struct CreateBody {
    name: Option<String>,
}
async fn create(Json(b): Json<CreateBody>) -> impl IntoResponse {
    let mut index = read_or_create_profiles_index();
    let id = nanoid::nanoid!(10);
    let entry = json!({
        "id": id,
        "name": b.name.unwrap_or_else(|| "New Profile".to_string()),
        "created_at_ms": now_ms(),
        "last_used_at_ms": now_ms(),
    });
    match index.get_mut("profiles").and_then(|v| v.as_array_mut()) {
        Some(arr) => arr.push(entry),
        None => index["profiles"] = json!([entry]),
    }
    match write_profiles_index(&index) {
        Ok(()) => Json(to_profiles_state(&index)).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

#[derive(Deserialize)]
struct RenameBody {
    #[serde(rename = "profileId")]
    profile_id: String,
    name: String,
}
async fn rename(Json(b): Json<RenameBody>) -> impl IntoResponse {
    let mut index = read_or_create_profiles_index();
    if let Some(arr) = index.get_mut("profiles").and_then(|v| v.as_array_mut()) {
        for entry in arr.iter_mut() {
            if entry.get("id").and_then(|v| v.as_str()) == Some(b.profile_id.as_str()) {
                entry["name"] = json!(b.name);
            }
        }
    }
    match write_profiles_index(&index) {
        Ok(()) => Json(to_profiles_state(&index)).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

#[derive(Deserialize)]
struct DeleteBody {
    #[serde(rename = "profileId")]
    profile_id: String,
}
async fn delete(Json(b): Json<DeleteBody>) -> impl IntoResponse {
    let mut index = read_or_create_profiles_index();
    if let Some(arr) = index.get_mut("profiles").and_then(|v| v.as_array_mut()) {
        arr.retain(|entry| entry.get("id").and_then(|v| v.as_str()) != Some(b.profile_id.as_str()));
    }
    // Se o perfil ativo foi apagado, cai pro primeiro que sobrou (ou "default").
    if active_profile_id(&index) == b.profile_id {
        let fallback = index
            .get("profiles")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
            .and_then(|p| p.get("id"))
            .and_then(|v| v.as_str())
            .unwrap_or("default")
            .to_string();
        index["active_profile_id"] = json!(fallback);
    }
    match write_profiles_index(&index) {
        Ok(()) => Json(to_profiles_state(&index)).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

async fn load_projects() -> impl IntoResponse {
    let index = read_or_create_profiles_index();
    let id = active_profile_id(&index);
    let path = projects_json_path(&id);
    match fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<Value>(&content) {
            Ok(v) => Json(v).into_response(),
            Err(_) => {
                Json(json!({ "groups": [], "projects": [], "preferences": {} })).into_response()
            }
        },
        Err(_) => Json(json!({ "groups": [], "projects": [], "preferences": {} })).into_response(),
    }
}

#[derive(Deserialize)]
struct SaveProjectsBody {
    content: String,
}
async fn save_projects(Json(b): Json<SaveProjectsBody>) -> impl IntoResponse {
    let index = read_or_create_profiles_index();
    let id = active_profile_id(&index);
    let path = projects_json_path(&id);
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return AppError::from(e.to_string()).into_response();
        }
    }
    match fs::write(&path, &b.content) {
        Ok(()) => Json(json!({ "status": "saved" })).into_response(),
        Err(e) => AppError::from(e.to_string()).into_response(),
    }
}
