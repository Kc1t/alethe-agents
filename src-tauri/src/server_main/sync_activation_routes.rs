use axum::extract::Extension;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;

use super::{respond, ServerRuntime};

pub fn router() -> Router {
    Router::new()
        .route("/api/sync/activation", get(get_settings))
        .route("/api/sync/activation/mode", post(set_mode))
        .route("/api/sync/activation/enable", post(enable))
        .route("/api/sync/activation/disable", post(disable))
        .route("/api/sync/activation/state", get(state))
}

async fn get_settings(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_activation::load_settings_at(&data_root, crate::provider_common::now_ms())
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetModeBody {
    mode: crate::sync_activation::ServiceMode,
    #[serde(default)]
    custom_endpoint: Option<String>,
}

async fn set_mode(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<SetModeBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_activation::set_mode_at(
                &data_root,
                body.mode,
                body.custom_endpoint,
                crate::provider_common::now_ms(),
            )
            .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn enable(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_activation::enable_service_at(&data_root, crate::provider_common::now_ms())
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn disable(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    let rendezvous = runtime.rendezvous_runtime();
    let response = tokio::task::spawn_blocking(move || {
        crate::sync_activation::disable_service_at(&data_root, crate::provider_common::now_ms())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    if response.is_ok() {
        crate::sync_rendezvous::disconnect_at(&rendezvous);
    }
    respond(response)
}

async fn state(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    let rendezvous = runtime.rendezvous_runtime();
    respond(
        tokio::task::spawn_blocking(move || {
            let settings = crate::sync_activation::load_settings_at(
                &data_root,
                crate::provider_common::now_ms(),
            )
            .map_err(|error| error.to_string())?;
            let identity = crate::sync_activation::SecurityBackedIdentityOracle {
                data_root: &data_root,
            };
            Ok::<_, String>(crate::sync_activation::resolve_activation_state(
                &settings,
                &identity,
                rendezvous.status(),
            ))
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}
