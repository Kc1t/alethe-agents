// GitHub Sync (backup via Gist privado) — github_sync.rs foi refatorado
// pra separar resolução de caminho (AppHandle) da lógica de verdade
// (`*_core`, que recebe `&Path` direto), mesmo padrão de `backup.rs`.

use crate::github_sync;
use axum::extract::Extension;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;

use super::profile_routes::active_profile_dir_at;
use super::{AppError, ServerRuntime};

pub fn router() -> Router {
    Router::new()
        .route("/api/github_sync/status", get(status))
        .route("/api/github_sync/token", post(set_token))
        .route("/api/github_sync/logout", post(logout))
        .route("/api/github_sync/push", post(push))
        .route("/api/github_sync/pull", post(pull))
}

async fn status(Extension(runtime): Extension<Arc<ServerRuntime>>) -> impl IntoResponse {
    match active_profile_dir_at(runtime.data_root()) {
        Ok(root) => Json(github_sync::github_sync_status_core(&root)).into_response(),
        Err(error) => AppError::from(error).into_response(),
    }
}

#[derive(Deserialize)]
struct TokenBody {
    token: String,
}
async fn set_token(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(b): Json<TokenBody>,
) -> impl IntoResponse {
    let root = match active_profile_dir_at(runtime.data_root()) {
        Ok(root) => root,
        Err(error) => return AppError::from(error).into_response(),
    };
    respond(github_sync::github_sync_set_token_core(&root, b.token).await)
}

async fn logout(Extension(runtime): Extension<Arc<ServerRuntime>>) -> impl IntoResponse {
    match active_profile_dir_at(runtime.data_root()) {
        Ok(root) => respond(github_sync::github_sync_logout_core(&root)),
        Err(error) => AppError::from(error).into_response(),
    }
}

async fn push(Extension(runtime): Extension<Arc<ServerRuntime>>) -> impl IntoResponse {
    let root = match active_profile_dir_at(runtime.data_root()) {
        Ok(root) => root,
        Err(error) => return AppError::from(error).into_response(),
    };
    respond(github_sync::github_sync_push_core(&root).await)
}

async fn pull(Extension(runtime): Extension<Arc<ServerRuntime>>) -> impl IntoResponse {
    let root = match active_profile_dir_at(runtime.data_root()) {
        Ok(root) => root,
        Err(error) => return AppError::from(error).into_response(),
    };
    respond(github_sync::github_sync_pull_core(&root).await)
}

fn respond<T: serde::Serialize>(result: Result<T, String>) -> axum::response::Response {
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}
