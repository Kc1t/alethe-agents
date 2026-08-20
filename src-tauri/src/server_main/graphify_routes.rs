// Graphify (grafo de conhecimento do codebase) + AI Memory (MCP) — todas as
// funções de `graphify.rs`/`ai_memory.rs` são livres de `AppHandle`.

use crate::ai_memory;
use crate::graphify;
use axum::extract::Query;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::collections::HashMap;

use super::{query_param as q, respond};

pub fn router() -> Router {
    Router::new()
        .route("/api/graphify/detect", get(detect))
        .route("/api/graphify/ensure_graph", post(ensure_graph))
        .route("/api/graphify/mcp_config_path", get(mcp_config_path))
        .route(
            "/api/graphify/opencode_config_write",
            post(opencode_config_write),
        )
        .route("/api/graphify/codex_config_write", post(codex_config_write))
        .route("/api/graphify/read_graph", get(read_graph))
        .route("/api/graphify/snapshot", post(snapshot))
        .route("/api/graphify/snapshots", get(list_snapshots))
        .route("/api/graphify/diff_snapshot", get(diff_snapshot))
        .route("/api/graphify/rollback", post(rollback))
        .route("/api/graphify/prune_snapshots", post(prune_snapshots))
        .route("/api/ai_memory/detect", get(ai_detect))
        .route("/api/ai_memory/mcp_config_path", get(ai_mcp_config_path))
        .route(
            "/api/ai_memory/opencode_config_write",
            post(ai_opencode_config_write),
        )
        .route(
            "/api/ai_memory/codex_config_write",
            post(ai_codex_config_write),
        )
}

async fn detect(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    respond(graphify::graphify_detect(p.get("command").cloned()).await)
}

#[derive(Deserialize)]
struct RepoCommandBody {
    repo: String,
    command: Option<String>,
}
async fn ensure_graph(Json(b): Json<RepoCommandBody>) -> impl IntoResponse {
    respond(graphify::graphify_ensure_graph(b.repo, b.command).await)
}

async fn mcp_config_path(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo = match q(&p, "repo") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(graphify::graphify_mcp_config_path(repo, p.get("command").cloned()).await)
}
async fn opencode_config_write(Json(b): Json<RepoCommandBody>) -> impl IntoResponse {
    respond(graphify::graphify_opencode_config_write(b.repo, b.command).await)
}
async fn codex_config_write(Json(b): Json<RepoCommandBody>) -> impl IntoResponse {
    respond(graphify::graphify_codex_config_write(b.repo, b.command).await)
}

async fn read_graph(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo = match q(&p, "repo") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(graphify::graphify_read_graph(repo).await)
}

#[derive(Deserialize)]
struct SnapshotBody {
    repo: String,
    #[serde(rename = "projectId")]
    project_id: Option<String>,
}
async fn snapshot(Json(b): Json<SnapshotBody>) -> impl IntoResponse {
    respond(graphify::graphify_snapshot(b.repo, b.project_id).await)
}

async fn list_snapshots(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo = match q(&p, "repo") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(graphify::graphify_list_snapshots(repo).await)
}

#[derive(Deserialize)]
struct DiffSnapshotQuery {
    repo: String,
    #[serde(rename = "baseId")]
    base_id: String,
    #[serde(rename = "targetId")]
    target_id: String,
}
async fn diff_snapshot(Query(p): Query<DiffSnapshotQuery>) -> impl IntoResponse {
    respond(graphify::graphify_diff_snapshot(p.repo, p.base_id, Some(p.target_id)).await)
}

#[derive(Deserialize)]
struct RollbackBody {
    repo: String,
    #[serde(rename = "snapshotId")]
    snapshot_id: String,
    #[serde(rename = "projectId")]
    project_id: Option<String>,
}
async fn rollback(Json(b): Json<RollbackBody>) -> impl IntoResponse {
    respond(graphify::graphify_rollback(b.repo, b.snapshot_id, b.project_id).await)
}

#[derive(Deserialize)]
struct PruneBody {
    repo: String,
    #[serde(rename = "keepLast")]
    keep_last: usize,
    #[serde(rename = "maxAgeDays")]
    max_age_days: Option<u64>,
    #[serde(rename = "projectId")]
    project_id: Option<String>,
}
async fn prune_snapshots(Json(b): Json<PruneBody>) -> impl IntoResponse {
    respond(
        graphify::graphify_prune_snapshots(b.repo, b.keep_last, b.max_age_days, b.project_id).await,
    )
}

async fn ai_detect(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    respond(ai_memory::ai_memory_detect(p.get("command").cloned()))
}
async fn ai_mcp_config_path(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo = match q(&p, "repo") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(ai_memory::ai_memory_mcp_config_path(
        repo,
        p.get("command").cloned(),
    ))
}
async fn ai_opencode_config_write(Json(b): Json<RepoCommandBody>) -> impl IntoResponse {
    respond(ai_memory::ai_memory_opencode_config_write(
        b.repo, b.command,
    ))
}
async fn ai_codex_config_write(Json(b): Json<RepoCommandBody>) -> impl IntoResponse {
    respond(ai_memory::ai_memory_codex_config_write(b.repo, b.command))
}
