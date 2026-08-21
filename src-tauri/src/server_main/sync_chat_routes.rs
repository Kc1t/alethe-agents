use axum::extract::{Extension, Query};
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
