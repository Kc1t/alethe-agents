use axum::extract::Extension;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

use super::{respond, ServerRuntime};

pub fn router() -> Router {
    Router::new()
        .route("/api/sync/rendezvous/connect", post(connect))
        .route("/api/sync/rendezvous/status", get(status))
        .route("/api/sync/rendezvous/disconnect", post(disconnect))
        .route("/api/sync/rendezvous/send", post(send))
        .route("/api/sync/rendezvous/events", get(events))
        .route("/api/sync/rendezvous/validate", post(validate))
}

async fn connect(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    respond(
        crate::sync_rendezvous::start_at(
            runtime.data_root().to_path_buf(),
            runtime.rendezvous_runtime(),
        )
        .await,
    )
}

async fn status(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    let settings = crate::sync_activation::load_settings_at(
        runtime.data_root(),
        crate::provider_common::now_ms(),
    );
    respond(settings.map_err(|error| error.to_string()).map(|settings| {
        let endpoint_configured = match settings.mode {
            crate::sync_activation::ServiceMode::LocalOnly => false,
            crate::sync_activation::ServiceMode::AletheManaged => {
                option_env!("ALETHE_RENDEZVOUS_ENDPOINT").is_some()
            }
            crate::sync_activation::ServiceMode::AdvancedCustom => {
                settings.validated_endpoint.is_some()
            }
        };
        crate::sync_rendezvous::status_snapshot(&runtime.rendezvous_runtime(), endpoint_configured)
    }))
}

async fn disconnect(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    crate::sync_rendezvous::disconnect_at(&runtime.rendezvous_runtime());
    respond(Ok::<_, String>(()))
}

#[derive(Deserialize)]
struct SendBody {
    frame: Value,
}

async fn send(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<SendBody>,
) -> Response {
    respond(crate::sync_rendezvous::send_at(&runtime.rendezvous_runtime(), body.frame).await)
}

async fn events(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    respond(Ok::<_, String>(crate::sync_rendezvous::drain_events_at(
        &runtime.rendezvous_runtime(),
    )))
}

#[derive(Deserialize)]
struct ValidateBody {
    endpoint: String,
}

async fn validate(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<ValidateBody>,
) -> Response {
    respond(
        crate::sync_rendezvous::validate_endpoint_network_at(runtime.data_root(), body.endpoint)
            .await,
    )
}
