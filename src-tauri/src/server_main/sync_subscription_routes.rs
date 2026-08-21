use axum::extract::Extension;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;

use super::{respond, ServerRuntime};

pub fn router() -> Router {
    Router::new()
        .route("/api/sync/subscriptions", get(list))
        .route("/api/sync/subscriptions/offer", post(offer))
        .route("/api/sync/subscriptions/destination", post(configure_destination))
        .route("/api/sync/subscriptions/mode", post(select_mode))
        .route("/api/sync/subscriptions/confirm", post(confirm))
        .route("/api/sync/subscriptions/defer", post(defer))
        .route("/api/sync/subscriptions/decline", post(decline))
}

async fn list(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    match crate::sync_subscription::list_subscriptions_at(runtime.data_root()) {
        Ok(subscriptions) => Json(subscriptions).into_response(),
        Err(error) => {
            super::AppError(axum::http::StatusCode::INTERNAL_SERVER_ERROR, error).into_response()
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfferBody {
    project_id: String,
    grant_id: String,
    device_id: String,
}

async fn offer(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<OfferBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_subscription::offer_subscription_at(
                &data_root,
                &body.project_id,
                &body.grant_id,
                &body.device_id,
                crate::provider_common::now_ms(),
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DestinationBody {
    subscription_id: String,
    destination: String,
}

async fn configure_destination(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<DestinationBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_subscription::configure_destination_at(
                &data_root,
                &body.subscription_id,
                &body.destination,
                crate::provider_common::now_ms(),
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModeBody {
    subscription_id: String,
    mode: crate::sync_subscription::SubscriptionMode,
}

async fn select_mode(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<ModeBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_subscription::select_mode_at(
                &data_root,
                &body.subscription_id,
                body.mode,
                crate::provider_common::now_ms(),
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionIdBody {
    subscription_id: String,
}

async fn confirm(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<SubscriptionIdBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_subscription::confirm_subscription_at(
                &data_root,
                &body.subscription_id,
                crate::provider_common::now_ms(),
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn defer(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<SubscriptionIdBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_subscription::defer_subscription_at(
                &data_root,
                &body.subscription_id,
                crate::provider_common::now_ms(),
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn decline(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<SubscriptionIdBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_subscription::decline_subscription_at(
                &data_root,
                &body.subscription_id,
                crate::provider_common::now_ms(),
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}
