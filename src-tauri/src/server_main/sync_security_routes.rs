use axum::extract::Extension;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{respond, AppError, ServerRuntime};

pub fn router() -> Router {
    Router::new()
        .route("/api/sync/security", get(snapshot))
        .route("/api/sync/security/devices/approve", post(approve_device))
        .route("/api/sync/security/devices/reject", post(reject_device))
        .route("/api/sync/security/devices/rename", post(rename_device))
        .route("/api/sync/security/devices/revoke", post(revoke_device))
        .route("/api/sync/security/devices/remove", post(remove_device))
}

async fn snapshot(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    match crate::sync_security::snapshot_at(runtime.data_root()) {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => {
            AppError(axum::http::StatusCode::INTERNAL_SERVER_ERROR, error).into_response()
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn local_device_id(data_root: &std::path::Path) -> Result<String, String> {
    crate::sync_security::load_at(data_root)?
        .local_device_id
        .ok_or_else(|| "local_device_unknown".to_string())
}

#[derive(Deserialize)]
struct TargetDeviceBody {
    #[serde(rename = "targetDeviceId")]
    target_device_id: String,
}

async fn approve_device(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<TargetDeviceBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let actor = local_device_id(&data_root)?;
            crate::sync_security::approve_device_at(
                &data_root,
                &actor,
                &body.target_device_id,
                now_ms(),
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn reject_device(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<TargetDeviceBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let actor = local_device_id(&data_root)?;
            crate::sync_security::reject_device_at(
                &data_root,
                &crate::sync_security::PlatformDeviceSecretStore,
                &actor,
                &body.target_device_id,
                now_ms(),
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
struct RenameDeviceBody {
    #[serde(rename = "displayName")]
    display_name: String,
}

async fn rename_device(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<RenameDeviceBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let actor = local_device_id(&data_root)?;
            crate::sync_security::rename_device_at(&data_root, &actor, &body.display_name, now_ms())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn revoke_device(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<TargetDeviceBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let actor = local_device_id(&data_root)?;
            crate::sync_security::revoke_device_at(
                &data_root,
                &crate::sync_security::PlatformDeviceSecretStore,
                &actor,
                &body.target_device_id,
                now_ms(),
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn remove_device(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<TargetDeviceBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let actor = local_device_id(&data_root)?;
            crate::sync_security::remove_device_at(&data_root, &actor, &body.target_device_id, now_ms())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}
