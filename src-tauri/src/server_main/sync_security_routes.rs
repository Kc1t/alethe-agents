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
        .route("/api/sync/project-invite/seal", post(seal_project_invite))
        .route("/api/sync/project-invite/open", post(open_project_invite))
        .route("/api/sync/project-invite/seal-response", post(seal_project_invite_response))
        .route("/api/sync/project-invite/open-response", post(open_project_invite_response))
        .route("/api/sync/project-invite/grant", post(grant_project_to_invitee))
        .route("/api/sync/project-invite/remember", post(remember_sent_project_invite))
        .route("/api/sync/project-invite/take", post(take_sent_project_invite))
        .route("/api/sync/security/devices/approve", post(approve_device))
        .route("/api/sync/security/devices/reject", post(reject_device))
        .route("/api/sync/security/devices/rename", post(rename_device))
        .route("/api/sync/security/devices/revoke", post(revoke_device))
        .route("/api/sync/security/devices/remove", post(remove_device))
        .route("/api/sync/security/grants/revoke", post(revoke_grant))
        .route("/api/sync/security/devices/rotate-keys", post(rotate_device_keys))
        .route("/api/sync/security/account/export", get(export_account_data))
        .route("/api/sync/security/projects/delete-access", post(delete_project_access))
        .route("/api/sync/security/capabilities", get(capabilities))
        .route("/api/sync/security/chat-contacts/add", post(add_chat_contact))
        .route("/api/sync/security/chat-contacts/list", get(list_chat_contacts))
        .route("/api/sync/security/chat-contacts/remove", post(remove_chat_contact))
        .route("/api/sync/security/chat-contacts/rename", post(rename_chat_contact))
        .route(
            "/api/sync/security/collaborator-suggestion/prepare",
            post(prepare_collaborator_suggestion),
        )
        .route(
            "/api/sync/security/collaborator-suggestion/open",
            post(open_collaborator_suggestion),
        )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddChatContactBody {
    account_route: String,
    device_id: String,
    agreement_public_key: String,
    display_label: String,
}

async fn add_chat_contact(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<AddChatContactBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_security::add_chat_contact_at(
                &data_root,
                crate::sync_security::ChatContactRecord {
                    account_route: body.account_route,
                    device_id: body.device_id,
                    agreement_public_key: body.agreement_public_key,
                    display_label: body.display_label,
                    added_at_ms: now_ms(),
                    // Avatar/bio sync (pairing-time snapshot + live `avatar_update`/`bio_update`
                    // envelopes) is Desktop-only for now, same reasoning as the rest of the P2P/
                    // relay chat stack — the Web route has nothing to carry yet for either.
                    avatar_thumbnail: None,
                    bio: None,
                },
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveChatContactBody {
    account_route: String,
}

async fn remove_chat_contact(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<RemoveChatContactBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_security::remove_chat_contact_at(&data_root, &body.account_route)
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameChatContactBody {
    account_route: String,
    display_label: String,
}

async fn rename_chat_contact(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<RenameChatContactBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_security::rename_chat_contact_at(&data_root, &body.account_route, &body.display_label)
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn list_chat_contacts(Extension(runtime): Extension<Arc<ServerRuntime>>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || crate::sync_security::list_chat_contacts_at(&data_root))
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareCollaboratorSuggestionBody {
    project_id: String,
    suggested_account_id: String,
    note: String,
}

async fn prepare_collaborator_suggestion(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<PrepareCollaboratorSuggestionBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_security::prepare_collaborator_suggestion_at(
                &data_root,
                &body.project_id,
                &body.suggested_account_id,
                &body.note,
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
struct OpenCollaboratorSuggestionBody {
    ciphertext: String,
}

async fn open_collaborator_suggestion(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<OpenCollaboratorSuggestionBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || crate::sync_security::open_collaborator_suggestion_at(&data_root, &body.ciphertext))
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result),
    )
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

// ---------------------------------------------------------------------------------------------
// Project invites. Every handler is a thin shell over the same `*_at(data_root, ...)` function the
// Tauri command calls — the flow has to work identically in Web mode, and duplicating the logic
// here is how the two transports drift apart.
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealProjectInviteBody {
    invite_id: String,
    project_id: String,
    project_name: String,
    from_account_route: String,
    recipient_agreement_public_key: String,
    sent_at_ms: u64,
}

async fn seal_project_invite(Json(body): Json<SealProjectInviteBody>) -> Response {
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_project_invite::seal_project_invite(
                body.invite_id,
                body.project_id,
                body.project_name,
                body.from_account_route,
                body.recipient_agreement_public_key,
                body.sent_at_ms,
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CiphertextBody {
    ciphertext: String,
}

async fn open_project_invite(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<CiphertextBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_project_invite::open_project_invite_at(&data_root, &body.ciphertext)
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealProjectInviteResponseBody {
    invite_id: String,
    accepted: bool,
    recipient_agreement_public_key: String,
}

async fn seal_project_invite_response(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<SealProjectInviteResponseBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_project_invite::seal_project_invite_response_at(
                &data_root,
                body.invite_id,
                body.accepted,
                &body.recipient_agreement_public_key,
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn open_project_invite_response(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<CiphertextBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_project_invite::open_project_invite_response_at(
                &data_root,
                &body.ciphertext,
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantProjectBody {
    project_id: String,
    account_id: String,
    device_id: String,
    agreement_public_key: String,
    permissions: Vec<crate::sync_security::SyncPermission>,
    path_scopes: Vec<crate::sync_security::PathScope>,
    expires_at_ms: u64,
}

async fn grant_project_to_invitee(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<GrantProjectBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_project_invite::grant_project_to_invitee_at(
                &data_root,
                body.project_id,
                body.account_id,
                body.device_id,
                body.agreement_public_key,
                body.permissions,
                body.path_scopes,
                body.expires_at_ms,
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RememberSentInviteBody {
    invite_id: String,
    project_id: String,
    recipient_account_route: String,
}

async fn remember_sent_project_invite(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<RememberSentInviteBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_security::remember_sent_project_invite_at(
                &data_root,
                body.invite_id,
                body.project_id,
                body.recipient_account_route,
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TakeSentInviteBody {
    invite_id: String,
}

async fn take_sent_project_invite(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<TakeSentInviteBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_security::take_sent_project_invite_at(&data_root, &body.invite_id)
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
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
