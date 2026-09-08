use axum::extract::Extension;
use axum::response::Response;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;

use super::{respond, ServerRuntime};

pub fn router() -> Router {
    Router::new()
        .route("/api/sync/invitations/bridge/verify-device", post(verify_device))
        .route("/api/sync/invitations/bridge/prepare", post(prepare))
        .route("/api/sync/invitations/bridge/consume", post(consume))
}

async fn verify_device(
    Extension(_runtime): Extension<Arc<ServerRuntime>>,
    Json(device): Json<crate::sync_invitation_bridge::DiscoveredDevice>,
) -> Response {
    respond(
        tokio::task::spawn_blocking(move || {
            use base64::engine::general_purpose::URL_SAFE_NO_PAD;
            use base64::Engine;
            crate::sync_invitation_bridge::verify_discovered_device_agreement_key(&device)
                .map(|key| URL_SAFE_NO_PAD.encode(key))
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareBody {
    invitation_id: String,
    bearer_token: String,
    project_id: String,
    permissions: Vec<crate::sync_security::SyncPermission>,
    path_scopes: Vec<crate::sync_security::PathScope>,
    expires_at_ms: u64,
    created_at_ms: u64,
    recipient_account_route: String,
    #[serde(default)]
    recipient_device_id: Option<String>,
    recipient_agreement_public_key: String,
    #[serde(default)]
    issuer_account_id: Option<String>,
    #[serde(default)]
    issuer_agreement_public_key: Option<String>,
}

async fn prepare(Extension(_runtime): Extension<Arc<ServerRuntime>>, Json(body): Json<PrepareBody>) -> Response {
    respond(
        tokio::task::spawn_blocking(move || {
            use base64::engine::general_purpose::URL_SAFE_NO_PAD;
            use base64::Engine;
            let public_key = URL_SAFE_NO_PAD
                .decode(&body.recipient_agreement_public_key)
                .map_err(|_| "invitation_bridge_invalid_recipient_key".to_string())?;
            let issued = crate::sync_invitation_bridge::LocalIssuedInvitation {
                invitation_id: body.invitation_id,
                bearer_token: body.bearer_token,
                project_id: body.project_id,
                permissions: body.permissions,
                path_scopes: body.path_scopes,
                expires_at_ms: body.expires_at_ms,
                created_at_ms: body.created_at_ms,
                issuer_account_id: body.issuer_account_id.unwrap_or_default(),
                issuer_agreement_public_key: body.issuer_agreement_public_key.unwrap_or_default(),
            };
            let message_id = format!("inv_{}", nanoid::nanoid!(24));
            crate::sync_invitation_bridge::prepare_remote_invitation_envelope(
                &issued,
                &body.recipient_account_route,
                body.recipient_device_id,
                &public_key,
                message_id,
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
struct ConsumeBody {
    ciphertext: String,
    invitation_id: String,
}

async fn consume(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(body): Json<ConsumeBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let document = crate::sync_security::load_at(&data_root)?;
            let local_device_id =
                document.local_device_id.ok_or_else(|| "security_device_missing".to_string())?;
            let account_id =
                document.account.ok_or_else(|| "security_account_missing".to_string())?.account_id;
            let recipient_secret = crate::sync_security::load_device_agreement_secret(&local_device_id)?;
            crate::sync_invitation_bridge::consume_remote_invitation_delivery(
                &data_root,
                &body.ciphertext,
                &body.invitation_id,
                &recipient_secret,
                &account_id,
                &local_device_id,
                crate::provider_common::now_ms(),
            )
            .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}
