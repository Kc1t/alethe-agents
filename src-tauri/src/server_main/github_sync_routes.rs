// GitHub Sync (backup via Gist privado) — github_sync.rs foi refatorado
// pra separar resolução de caminho (AppHandle) da lógica de verdade
// (`*_core`, que recebe `&Path` direto), mesmo padrão de `backup.rs`.

use alethe_lib::github_sync;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

use crate::profile_routes::active_profile_dir;
use crate::AppError;

pub fn router() -> Router {
    Router::new()
        .route("/api/github_sync/status", get(status))
        .route("/api/github_sync/token", post(set_token))
        .route("/api/github_sync/logout", post(logout))
        .route("/api/github_sync/push", post(push))
        .route("/api/github_sync/pull", post(pull))
}

async fn status() -> impl IntoResponse {
    Json(github_sync::github_sync_status_core(&active_profile_dir()))
}

#[derive(Deserialize)]
struct TokenBody {
    token: String,
}
async fn set_token(Json(b): Json<TokenBody>) -> impl IntoResponse {
    respond(github_sync::github_sync_set_token_core(&active_profile_dir(), b.token).await)
}

async fn logout() -> impl IntoResponse {
    respond(github_sync::github_sync_logout_core(&active_profile_dir()))
}

async fn push() -> impl IntoResponse {
    respond(github_sync::github_sync_push_core(&active_profile_dir()).await)
}

async fn pull() -> impl IntoResponse {
    respond(github_sync::github_sync_pull_core(&active_profile_dir()).await)
}

fn respond<T: serde::Serialize>(result: Result<T, String>) -> axum::response::Response {
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}
