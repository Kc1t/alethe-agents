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
        .route("/api/sync/security/local-identity", get(local_identity))
        .route("/api/sync/security/devices/approve", post(approve_device))
        .route("/api/sync/security/devices/reject", post(reject_device))
        .route("/api/sync/security/devices/rename", post(rename_device))
        .route("/api/sync/security/devices/revoke", post(revoke_device))
        .route("/api/sync/security/devices/remove", post(remove_device))
        .route("/api/sync/security/invitations/issue", post(issue_invitation))
        .route("/api/sync/security/invitations/revoke", post(revoke_invitation))
        .route("/api/sync/security/invitations/redeem", post(redeem_invitation))
        .route("/api/sync/security/grants/revoke", post(revoke_grant))
        .route("/api/sync/security/devices/rotate-keys", post(rotate_device_keys))
        .route("/api/sync/security/account/export", get(export_account_data))
        .route("/api/sync/security/projects/delete-access", post(delete_project_access))
        .route("/api/sync/security/capabilities", get(capabilities))
}

async fn snapshot(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    match crate::sync_security::snapshot_at(runtime.data_root()) {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => {
            AppError(axum::http::StatusCode::INTERNAL_SERVER_ERROR, error).into_response()
        }
    }
}

async fn local_identity(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    match crate::sync_security::local_identity_at(runtime.data_root()) {
        Ok(identity) => Json(identity).into_response(),
        Err(error) => {
            AppError(axum::http::StatusCode::INTERNAL_SERVER_ERROR, error).into_response()
        }
    }
}

async fn capabilities(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    respond(crate::sync_security::resolve_capabilities_at(
        runtime.data_root(),
    ))
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

fn to_summary(
    invitation: crate::sync_security::InvitationRecord,
) -> crate::sync_security::InvitationSummary {
    crate::sync_security::InvitationSummary {
        invitation_id: invitation.invitation_id,
        project_id: invitation.project_id,
        issuer_device_id: invitation.issuer_device_id,
        recipient_account_id: invitation.recipient_account_id,
        recipient_device_id: invitation.recipient_device_id,
        permissions: invitation.permissions,
        path_scopes: invitation.path_scopes,
        state: invitation.state,
        created_at_ms: invitation.created_at_ms,
        expires_at_ms: invitation.expires_at_ms,
        redeemed_at_ms: invitation.redeemed_at_ms,
        revoked_at_ms: invitation.revoked_at_ms,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueInvitationBody {
    project_id: String,
    recipient_account_id: String,
    recipient_device_id: Option<String>,
    permissions: Vec<crate::sync_security::SyncPermission>,
    path_scopes: Vec<crate::sync_security::PathScope>,
    expires_at_ms: u64,
}

async fn issue_invitation(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<IssueInvitationBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let issuer = local_device_id(&data_root)?;
            let issued = crate::sync_security::issue_invitation(
                &data_root,
                &issuer,
                &body.project_id,
                &body.recipient_account_id,
                body.recipient_device_id,
                crate::sync_security::normalize_permissions(body.permissions),
                body.path_scopes,
                now_ms(),
                body.expires_at_ms,
            )?;
            Ok(crate::sync_security::IssuedInvitationResponse {
                invitation: to_summary(issued.invitation),
                bearer_token: issued.bearer_token,
            })
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvitationIdBody {
    invitation_id: String,
}

async fn revoke_invitation(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<InvitationIdBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let actor = local_device_id(&data_root)?;
            crate::sync_security::revoke_invitation_at(
                &data_root,
                &actor,
                &body.invitation_id,
                now_ms(),
            )
            .map(to_summary)
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RedeemInvitationBody {
    invitation_id: String,
    bearer_token: String,
}

async fn redeem_invitation(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<RedeemInvitationBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let document = crate::sync_security::load_at(&data_root)?;
            let account_id = document
                .account
                .ok_or_else(|| "security_account_invalid".to_string())?
                .account_id;
            let recipient_device_id = document
                .local_device_id
                .ok_or_else(|| "local_device_unknown".to_string())?;
            crate::sync_security::redeem_invitation(
                &data_root,
                &body.invitation_id,
                &body.bearer_token,
                &account_id,
                &recipient_device_id,
                now_ms(),
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantIdBody {
    grant_id: String,
}

async fn revoke_grant(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<GrantIdBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let actor = local_device_id(&data_root)?;
            crate::sync_security::revoke_grant_at(&data_root, &actor, &body.grant_id, now_ms())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn rotate_device_keys(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let device_id = local_device_id(&data_root)?;
            crate::sync_security::rotate_device_keys_at(
                &data_root,
                &crate::sync_security::PlatformDeviceSecretStore,
                &device_id,
                now_ms(),
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn export_account_data(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || crate::sync_security::export_account_data_at(&data_root, now_ms()))
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectIdBody {
    project_id: String,
}

async fn delete_project_access(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<ProjectIdBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let actor = local_device_id(&data_root)?;
            crate::sync_security::delete_project_access_at(&data_root, &actor, &body.project_id, now_ms())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}
