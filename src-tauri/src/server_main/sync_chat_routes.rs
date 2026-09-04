use axum::extract::{Extension, Query};
use base64::Engine;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;

use super::{respond, ServerRuntime};

pub fn router() -> Router {
    Router::new()
        .route("/api/sync/chat/conversations/create", post(create_conversation))
        .route("/api/sync/chat/conversations/get", get(get_conversation))
        .route("/api/sync/chat/conversations/add-member", post(add_member))
        .route("/api/sync/chat/conversations/remove-member", post(remove_member))
        .route("/api/sync/chat/messages", get(list_messages))
        .route("/api/sync/chat/messages/react", post(react_to_message))
        .route("/api/sync/chat/conversations/mark-read", post(mark_read))
        .route(
            "/api/sync/chat/conversations/ensure-project",
            post(ensure_project_conversation),
        )
        .route(
            "/api/sync/chat/conversations/start-direct",
            post(start_direct_conversation),
        )
        .route(
            "/api/sync/chat/conversations/delete-direct",
            post(delete_direct_conversation),
        )
        .route(
            "/api/sync/chat/conversations/delete-project",
            post(delete_project_conversation),
        )
        .route("/api/sync/chat/messages/send", post(send_message))
        .route("/api/sync/chat/messages/decrypted", get(list_decrypted_messages))
        .route("/api/sync/chat/messages/edit", post(edit_message))
        .route("/api/sync/chat/messages/delete", post(delete_message))
        .route("/api/sync/chat/attachments/upload", post(upload_attachment))
        .route("/api/sync/chat/attachments/download", get(download_attachment))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateConversationBody {
    project_id: Option<String>,
    kind: crate::sync_chat::ConversationKind,
    category: Option<String>,
    members: Vec<crate::sync_chat::MemberInfo>,
}

async fn create_conversation(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<CreateConversationBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_chat::create_conversation_at(
                &data_root,
                body.project_id,
                body.kind,
                body.category,
                body.members,
                crate::provider_common::now_ms(),
            )
            .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn get_conversation(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let conversation_id = match super::query_param(&params, "conversationId") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_chat::load_conversation_at(&data_root, &conversation_id).map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddMemberBody {
    conversation_id: String,
    new_member: crate::sync_chat::MemberInfo,
}

async fn add_member(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(body): Json<AddMemberBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_chat::add_member_at(&data_root, &body.conversation_id, body.new_member, crate::provider_common::now_ms())
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveMemberBody {
    conversation_id: String,
    member_account_route: String,
}

async fn remove_member(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<RemoveMemberBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_chat::remove_member_at(
                &data_root,
                &body.conversation_id,
                &body.member_account_route,
                crate::provider_common::now_ms(),
            )
            .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn list_messages(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let conversation_id = match super::query_param(&params, "conversationId") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_chat::list_messages_at(&data_root, &conversation_id).map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReactBody {
    conversation_id: String,
    message_id: String,
    member_account_route: String,
    emoji: String,
}

async fn react_to_message(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(body): Json<ReactBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_chat::react_to_message_at(
                &data_root,
                &body.conversation_id,
                &body.message_id,
                &body.member_account_route,
                &body.emoji,
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
struct MarkReadBody {
    conversation_id: String,
    member_account_route: String,
    up_to_sequence: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnsureProjectConversationBody {
    project_id: String,
}

async fn ensure_project_conversation(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<EnsureProjectConversationBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let (_, account_route) = crate::sync_chat::local_chat_identity(&data_root)?;
            let public_key = crate::sync_security::local_device_agreement_public_key_at(&data_root)?;
            crate::sync_chat::ensure_project_conversation_at(
                &data_root,
                &body.project_id,
                &account_route,
                public_key,
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
struct StartDirectConversationBody {
    contact_account_route: String,
}

async fn start_direct_conversation(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<StartDirectConversationBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let (_, account_route) = crate::sync_chat::local_chat_identity(&data_root)?;
            let local_public_key = crate::sync_security::local_device_agreement_public_key_at(&data_root)?;
            let contacts = crate::sync_security::list_chat_contacts_at(&data_root)?;
            let contact = contacts
                .into_iter()
                .find(|contact| contact.account_route == body.contact_account_route)
                .ok_or_else(|| "chat_contact_not_found".to_string())?;
            let contact_public_key = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(&contact.agreement_public_key)
                .map_err(|_| "chat_contact_key_invalid".to_string())?;
            crate::sync_chat::ensure_direct_conversation_at(
                &data_root,
                &account_route,
                local_public_key,
                &body.contact_account_route,
                contact_public_key,
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
struct SendMessageBody {
    conversation_id: String,
    content_type: crate::sync_chat::MessageContentType,
    text: String,
    #[serde(default)]
    mentions: Vec<String>,
}

async fn send_message(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(body): Json<SendMessageBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let (device_id, account_route) = crate::sync_chat::local_chat_identity(&data_root)?;
            let conversation = crate::sync_chat::load_conversation_at(&data_root, &body.conversation_id)
                .map_err(|error| error.to_string())?;
            let epoch_number = conversation.epochs.len() as u64 - 1;
            let epoch_key =
                crate::sync_chat::resolve_epoch_key(&conversation, epoch_number, &account_route, &device_id)
                    .map_err(|error| error.to_string())?;
            let authorizer = crate::sync_chat::SecurityBackedChatAuthorizer { data_root: &data_root };
            let message = crate::sync_chat::send_message_at(
                &data_root,
                &body.conversation_id,
                &device_id,
                &account_route,
                &epoch_key,
                body.content_type,
                body.text.as_bytes(),
                body.mentions.clone(),
                &authorizer,
                crate::provider_common::now_ms(),
            )
            .map_err(|error| error.to_string())?;
            Ok(crate::sync_chat::DecryptedMessage {
                message_id: message.message_id,
                conversation_id: message.conversation_id,
                sequence: message.sequence,
                sender_device_id: message.sender_device_id,
                sender_account_route: message.sender_account_route,
                content_type: message.content_type,
                text: body.text,
                mentions: body.mentions,
                reactions: message.reactions,
                created_at_ms: message.created_at_ms,
                edited_at_ms: message.edited_at_ms,
            })
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn list_decrypted_messages(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let conversation_id = match super::query_param(&params, "conversationId") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let (device_id, account_route) = crate::sync_chat::local_chat_identity(&data_root)?;
            let conversation = crate::sync_chat::load_conversation_at(&data_root, &conversation_id)
                .map_err(|error| error.to_string())?;
            let messages =
                crate::sync_chat::list_messages_at(&data_root, &conversation_id).map_err(|error| error.to_string())?;
            let mut decrypted = Vec::with_capacity(messages.len());
            // One key resolution per epoch, not per message — see the same cache in
            // `sync_chat::sync_list_decrypted_messages` for why (each resolution is an OS keyring
            // read plus an X25519 exchange).
            let mut epoch_keys: std::collections::HashMap<u64, [u8; 32]> = std::collections::HashMap::new();
            for message in messages {
                let epoch_key = match epoch_keys.get(&message.epoch) {
                    Some(key) => *key,
                    None => {
                        let key = crate::sync_chat::resolve_epoch_key(
                            &conversation,
                            message.epoch,
                            &account_route,
                            &device_id,
                        )
                        .map_err(|error| error.to_string())?;
                        epoch_keys.insert(message.epoch, key);
                        key
                    }
                };
                let plaintext = crate::sync_chat::decrypt_message(&message, &epoch_key)
                    .map_err(|error| error.to_string())?;
                decrypted.push(crate::sync_chat::DecryptedMessage {
                    message_id: message.message_id,
                    conversation_id: message.conversation_id,
                    sequence: message.sequence,
                    sender_device_id: message.sender_device_id,
                    sender_account_route: message.sender_account_route,
                    content_type: message.content_type,
                    text: String::from_utf8_lossy(&plaintext).into_owned(),
                    mentions: message.mentions,
                    reactions: message.reactions,
                    created_at_ms: message.created_at_ms,
                    edited_at_ms: message.edited_at_ms,
                });
            }
            Ok(decrypted)
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditMessageBody {
    conversation_id: String,
    message_id: String,
    new_text: String,
}

async fn edit_message(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(body): Json<EditMessageBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let (device_id, account_route) = crate::sync_chat::local_chat_identity(&data_root)?;
            let conversation = crate::sync_chat::load_conversation_at(&data_root, &body.conversation_id)
                .map_err(|error| error.to_string())?;
            let epoch_number = conversation.epochs.len() as u64 - 1;
            let epoch_key =
                crate::sync_chat::resolve_epoch_key(&conversation, epoch_number, &account_route, &device_id)
                    .map_err(|error| error.to_string())?;
            crate::sync_chat::edit_message_at(
                &data_root,
                &body.conversation_id,
                &body.message_id,
                &epoch_key,
                body.new_text.as_bytes(),
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
struct DeleteMessageBody {
    conversation_id: String,
    message_id: String,
}

async fn delete_message(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(body): Json<DeleteMessageBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_chat::delete_message_at(
                &data_root,
                &body.conversation_id,
                &body.message_id,
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
struct UploadAttachmentBody {
    conversation_id: String,
    declared_content_type: String,
    bytes: Vec<u8>,
}

async fn upload_attachment(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<UploadAttachmentBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let declared_size = body.bytes.len() as u64;
            crate::sync_chat::upload_attachment_at(
                &data_root,
                &body.conversation_id,
                &body.declared_content_type,
                declared_size,
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

async fn download_attachment(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let conversation_id = match super::query_param(&params, "conversationId") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let attachment_id = match super::query_param(&params, "attachmentId") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let (device_id, account_route) = crate::sync_chat::local_chat_identity(&data_root)?;
            crate::sync_chat::download_attachment_plaintext(
                &data_root,
                &conversation_id,
                &attachment_id,
                &device_id,
                &account_route,
            )
            .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn mark_read(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(body): Json<MarkReadBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_chat::mark_read_at(
                &data_root,
                &body.conversation_id,
                &body.member_account_route,
                body.up_to_sequence,
                crate::provider_common::now_ms(),
            )
            .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn delete_direct_conversation(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<StartDirectConversationBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let (_, account_route) = crate::sync_chat::local_chat_identity(&data_root)?;
            crate::sync_chat::delete_direct_conversation_at(
                &data_root,
                &account_route,
                &body.contact_account_route,
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
struct DeleteProjectConversationBody {
    project_id: String,
}

async fn delete_project_conversation(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(body): Json<DeleteProjectConversationBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_chat::delete_project_conversation_at(&data_root, &body.project_id)
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

