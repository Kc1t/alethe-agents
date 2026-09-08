use axum::extract::Extension;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;

use super::{respond, ServerRuntime};

pub fn router() -> Router {
    Router::new()
        .route("/api/sync/engine/pause", post(pause))
        .route("/api/sync/engine/resume", post(resume))
        .route("/api/sync/engine/rescan", post(mark_needs_rescan))
        .route("/api/sync/engine/resolve", post(resolve_conflict))
        .route("/api/sync/engine/:subscription_id", get(load))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionIdBody {
    subscription_id: String,
}

async fn pause(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(body): Json<SubscriptionIdBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_engine::pause_sync_at(&data_root, &body.subscription_id, crate::provider_common::now_ms())
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn resume(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(body): Json<SubscriptionIdBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_engine::resume_sync_at(&data_root, &body.subscription_id, crate::provider_common::now_ms())
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn mark_needs_rescan(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<SubscriptionIdBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_engine::mark_needs_rescan_at(&data_root, &body.subscription_id, crate::provider_common::now_ms())
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveBody {
    subscription_id: String,
    conflict_id: String,
    resolution: crate::sync_engine::ConflictResolution,
}

async fn resolve_conflict(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<ResolveBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_engine::resolve_conflict_at(
                &data_root,
                &body.subscription_id,
                &body.conflict_id,
                body.resolution,
                crate::provider_common::now_ms(),
            )
            .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn load(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    axum::extract::Path(subscription_id): axum::extract::Path<String>,
) -> Response {
    respond(
        crate::sync_engine::load_engine_at(runtime.data_root(), &subscription_id)
            .map_err(|error| error.to_string()),
    )
}
