use axum::extract::Extension;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;

use super::{respond, ServerRuntime};

pub fn router() -> Router {
    Router::new()
        .route("/api/sync/staging/begin", post(begin))
        .route("/api/sync/staging/chunk", post(chunk))
        .route("/api/sync/staging/verify", post(verify))
        .route("/api/sync/staging/publish", post(publish))
        .route("/api/sync/staging/:subscription_id", get(load))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BeginBody {
    subscription_id: String,
    manifest: crate::sync_manifest::ProjectManifest,
    destination: String,
}

async fn begin(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(body): Json<BeginBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_staging::begin_staging_at(
                &data_root,
                &body.subscription_id,
                body.manifest,
                &body.destination,
                crate::provider_common::now_ms(),
            )
            .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChunkBody {
    subscription_id: String,
    chunk_id: String,
    #[serde(with = "base64_bytes")]
    bytes: Vec<u8>,
}

mod base64_bytes {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(deserializer)?;
        STANDARD.decode(text).map_err(serde::de::Error::custom)
    }
}

async fn chunk(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(body): Json<ChunkBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_staging::receive_chunk_at(
                &data_root,
                &body.subscription_id,
                &body.chunk_id,
                &body.bytes,
                crate::provider_common::now_ms(),
            )
            .map_err(|error| error.to_string())
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

async fn verify(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(body): Json<SubscriptionIdBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_staging::verify_staged_at(&data_root, &body.subscription_id, crate::provider_common::now_ms())
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn publish(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(body): Json<SubscriptionIdBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_staging::publish_atomically_at(&data_root, &body.subscription_id, crate::provider_common::now_ms())
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
        crate::sync_staging::load_staging_at(runtime.data_root(), &subscription_id)
            .map_err(|error| error.to_string()),
    )
}
