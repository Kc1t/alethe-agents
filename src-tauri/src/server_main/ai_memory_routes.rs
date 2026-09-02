use axum::extract::Query;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::collections::HashMap;

use super::respond;
use crate::ai_memory;

pub fn router() -> Router {
    Router::new()
        .route("/api/ai_memory/detect", get(detect))
        .route("/api/ai_memory/mcp_config_path", get(mcp_config_path))
        .route("/api/ai_memory/opencode_config_write", post(opencode_config_write))
        .route("/api/ai_memory/codex_config_write", post(codex_config_write))
}

async fn detect(Query(params): Query<HashMap<String, String>>) -> Response {
    let command = params.get("command").cloned();
    respond(
        tokio::task::spawn_blocking(move || ai_memory::ai_memory_detect(command))
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result),
    )
}

async fn mcp_config_path(Query(params): Query<HashMap<String, String>>) -> Response {
    let Some(repo) = params.get("repo").cloned() else {
        return respond::<String>(Err("Missing required repo parameter".to_string()));
    };
    let command = params.get("command").cloned();
    respond(
        tokio::task::spawn_blocking(move || ai_memory::ai_memory_mcp_config_path(repo, command))
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result),
    )
}

#[derive(Deserialize)]
struct ConfigWriteBody {
    repo: String,
    command: Option<String>,
}

async fn opencode_config_write(Json(body): Json<ConfigWriteBody>) -> Response {
    respond(
        tokio::task::spawn_blocking(move || {
            ai_memory::ai_memory_opencode_config_write(body.repo, body.command)
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn codex_config_write(Json(body): Json<ConfigWriteBody>) -> Response {
    respond(
        tokio::task::spawn_blocking(move || {
            ai_memory::ai_memory_codex_config_write(body.repo, body.command)
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}
