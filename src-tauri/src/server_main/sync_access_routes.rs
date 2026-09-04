use axum::extract::Extension;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;

use super::{respond, ServerRuntime};

pub fn router() -> Router {
    Router::new()
        .route("/api/sync/access", get(list))
        .route("/api/sync/access/update", post(update))
        .route("/api/sync/access/update-many", post(update_many))
        .route("/api/sync/access/action", post(resolve_action))
}

async fn list(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    respond(crate::sync_access::list_at(
        runtime.data_root(),
        crate::provider_common::now_ms(),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBody {
    id: String,
    operation: String,
    defer_until_ms: Option<u64>,
}

async fn update(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<UpdateBody>,
) -> Response {
    respond(crate::sync_access::update_at(
        runtime.data_root(),
        &body.id,
        &body.operation,
        body.defer_until_ms,
        crate::provider_common::now_ms(),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateManyBody {
    ids: Vec<String>,
    operation: String,
    defer_until_ms: Option<u64>,
}

async fn update_many(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<UpdateManyBody>,
) -> Response {
    respond(crate::sync_access::update_many_at(
        runtime.data_root(),
        &body.ids,
        &body.operation,
        body.defer_until_ms,
        crate::provider_common::now_ms(),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActionBody {
    action_handle: String,
}

async fn resolve_action(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<ActionBody>,
) -> Response {
    respond(crate::sync_access::resolve_action_at(
        runtime.data_root(),
        &body.action_handle,
        crate::provider_common::now_ms(),
    ))
}
