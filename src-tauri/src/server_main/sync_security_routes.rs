use axum::extract::Extension;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::sync::Arc;

use super::{AppError, ServerRuntime};

pub fn router() -> Router {
    Router::new().route("/api/sync/security", get(snapshot))
}

async fn snapshot(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    match crate::sync_security::snapshot_at(runtime.data_root()) {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => {
            AppError(axum::http::StatusCode::INTERNAL_SERVER_ERROR, error).into_response()
        }
    }
}
