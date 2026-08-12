// Sessões (Claude/Codex/OpenCode/Antigravity) e uso/custo — quase tudo aqui é
// leitura de arquivo local (histórico de sessão de cada CLI), sem
// `tauri::AppHandle` nenhum, então reaproveita direto. Só
// `get_activity_summary`/`clear_activity_stats` (Time Analytics) precisam de
// `app_data_dir()` — resolvido à mão, igual `profile_routes.rs`, já que
// moram no MESMO diretório de perfil (`profiles/<id>/activity-stats.json`).

use alethe_lib::activity_stats;
use alethe_lib::agent_cost;
use alethe_lib::antigravity_sessions;
use alethe_lib::antigravity_usage;
use alethe_lib::claude_sessions;
use alethe_lib::claude_usage;
use alethe_lib::codex_sessions;
use alethe_lib::codex_usage;
use alethe_lib::opencode_sessions;
use axum::extract::Query;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::collections::HashMap;

use crate::profile_routes::active_profile_dir;
use crate::AppError;

fn q(params: &HashMap<String, String>, key: &str) -> Result<String, AppError> {
    params
        .get(key)
        .cloned()
        .ok_or_else(|| AppError::bad_request(format!("missing_query_param:{key}")))
}

pub fn router() -> Router {
    Router::new()
        .route(
            "/api/sessions/antigravity/snapshot",
            get(antigravity_snapshot),
        )
        .route("/api/sessions/cost", get(session_cost))
        .route("/api/sessions/transcript_cost", get(transcript_cost))
        .route("/api/sessions/claude/snapshot", get(claude_snapshot))
        .route("/api/sessions/codex/snapshot", get(codex_snapshot))
        .route("/api/sessions/claude/list", get(claude_list))
        .route("/api/sessions/opencode/snapshot", get(opencode_snapshot))
        .route("/api/sessions/opencode/export", get(opencode_export))
        .route("/api/usage/claude", get(claude_usage_route))
        .route("/api/usage/codex", get(codex_usage_route))
        .route("/api/usage/antigravity", get(antigravity_usage_route))
        .route("/api/usage/pricing", get(pricing))
        .route("/api/usage/opencode_summary", get(opencode_summary))
        .route("/api/usage/claude_activity", get(claude_activity))
        .route("/api/usage/multi_agent_activity", get(multi_agent_activity))
        .route("/api/usage/summary", post(activity_summary))
        .route("/api/usage/clear_stats", post(clear_stats))
}

async fn antigravity_snapshot(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let cwd = match q(&p, "cwd") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(antigravity_sessions::snapshot_antigravity_sessions(cwd).await)
}

async fn session_cost(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let agent = match q(&p, "agent") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let cwd = match q(&p, "cwd") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let session_id = match q(&p, "sessionId") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(agent_cost::get_session_cost(agent, cwd, session_id).await)
}

async fn transcript_cost(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let path = match q(&p, "path") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(agent_cost::get_transcript_cost(path).await)
}

async fn claude_snapshot(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let cwd = match q(&p, "cwd") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(claude_sessions::snapshot_claude_sessions(cwd).await)
}

async fn codex_snapshot(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let cwd = match q(&p, "cwd") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(codex_sessions::snapshot_codex_sessions(cwd).await)
}

async fn claude_list(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let cwd = match q(&p, "cwd") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(claude_sessions::list_claude_sessions(cwd))
}

async fn opencode_snapshot(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let cwd = match q(&p, "cwd") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(opencode_sessions::snapshot_opencode_sessions(cwd).await)
}

async fn opencode_export(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let cwd = match q(&p, "cwd") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let session_id = match q(&p, "sessionId") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(opencode_sessions::opencode_export_session(cwd, session_id).await)
}

async fn claude_usage_route() -> impl IntoResponse {
    respond(claude_usage::get_claude_usage().await)
}
async fn codex_usage_route() -> impl IntoResponse {
    respond(codex_usage::get_codex_usage().await)
}
async fn antigravity_usage_route() -> impl IntoResponse {
    respond(antigravity_usage::get_antigravity_usage().await)
}
async fn pricing() -> impl IntoResponse {
    Json(agent_cost::get_model_pricing())
}

#[derive(Deserialize)]
struct HoursQuery {
    hours: u32,
}
async fn opencode_summary(Query(p): Query<HoursQuery>) -> impl IntoResponse {
    respond(agent_cost::get_opencode_usage_summary(p.hours).await)
}

#[derive(Deserialize)]
struct DaysQuery {
    days: usize,
}
async fn claude_activity(Query(p): Query<DaysQuery>) -> impl IntoResponse {
    respond(claude_sessions::get_claude_activity(p.days).await)
}
async fn multi_agent_activity(Query(p): Query<DaysQuery>) -> impl IntoResponse {
    respond(claude_sessions::get_multi_agent_activity(p.days).await)
}

#[derive(Deserialize)]
struct SummaryBody {
    dates: Vec<String>,
}
async fn activity_summary(Json(b): Json<SummaryBody>) -> impl IntoResponse {
    let path = active_profile_dir().join("activity-stats.json");
    match tokio::task::spawn_blocking(move || {
        activity_stats::get_activity_summary_inner(path, b.dates)
    })
    .await
    {
        Ok(result) => respond(result),
        Err(e) => AppError::from(e.to_string()).into_response(),
    }
}

async fn clear_stats() -> impl IntoResponse {
    let path = active_profile_dir().join("activity-stats.json");
    if path.exists() {
        if let Err(e) = std::fs::remove_file(&path) {
            return AppError::from(e.to_string()).into_response();
        }
    }
    Json(serde_json::json!({ "status": "cleared" })).into_response()
}

fn respond<T: serde::Serialize>(result: Result<T, String>) -> axum::response::Response {
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}
