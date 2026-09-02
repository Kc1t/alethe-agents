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
        .route("/api/sync/tasks", get(list))
        .route("/api/sync/tasks/create", post(create))
        .route("/api/sync/tasks/complete", post(complete))
        .route("/api/sync/tasks/reopen", post(reopen))
        .route("/api/sync/tasks/comment", post(comment))
        .route("/api/sync/tasks/update", post(update))
        .route("/api/sync/tasks/assign", post(assign))
        .route("/api/sync/tasks/delete", post(delete))
        .route("/api/sync/tasks/project/delete", post(delete_project_tasks))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBody {
    project_id: String,
    device_id: String,
    title: String,
    body: String,
    visibility: crate::sync_tasks::TaskVisibility,
    #[serde(default)]
    restricted_members: Vec<String>,
}

async fn create(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(body): Json<CreateBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let authorizer = crate::sync_tasks::SecurityBackedMembership { data_root: &data_root };
            crate::sync_tasks::create_task_at(
                &data_root,
                &body.project_id,
                &body.device_id,
                &body.title,
                &body.body,
                body.visibility,
                body.restricted_members,
                &authorizer,
                crate::provider_common::now_ms(),
            )
            .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn list(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let project_id = match super::query_param(&params, "projectId") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let viewer_device_id = match super::query_param(&params, "viewerDeviceId") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let viewer_account_route = match super::query_param(&params, "viewerAccountRoute") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let authorizer = crate::sync_tasks::SecurityBackedMembership { data_root: &data_root };
            crate::sync_tasks::list_visible_tasks_at(
                &data_root,
                &project_id,
                &viewer_device_id,
                &viewer_account_route,
                &authorizer,
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
struct CompleteBody {
    project_id: String,
    task_id: String,
    device_id: String,
    expected_base_revision: u64,
}

async fn complete(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(body): Json<CompleteBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let authorizer = crate::sync_tasks::SecurityBackedMembership { data_root: &data_root };
            crate::sync_tasks::complete_task_at(
                &data_root,
                &body.project_id,
                &body.task_id,
                &body.device_id,
                body.expected_base_revision,
                &authorizer,
                crate::provider_common::now_ms(),
            )
            .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

async fn reopen(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(body): Json<CompleteBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let authorizer = crate::sync_tasks::SecurityBackedMembership { data_root: &data_root };
            crate::sync_tasks::reopen_task_at(
                &data_root,
                &body.project_id,
                &body.task_id,
                &body.device_id,
                body.expected_base_revision,
                &authorizer,
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
struct CommentBody {
    project_id: String,
    task_id: String,
    device_id: String,
    expected_base_revision: u64,
    body: String,
}

async fn comment(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(payload): Json<CommentBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let authorizer = crate::sync_tasks::SecurityBackedMembership { data_root: &data_root };
            crate::sync_tasks::add_comment_at(
                &data_root,
                &payload.project_id,
                &payload.task_id,
                &payload.device_id,
                payload.expected_base_revision,
                &payload.body,
                &authorizer,
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
struct UpdateBody {
    project_id: String,
    task_id: String,
    device_id: String,
    expected_base_revision: u64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    labels: Option<Vec<String>>,
    #[serde(default)]
    due_at_ms: Option<Option<u64>>,
}

async fn update(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(payload): Json<UpdateBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let authorizer = crate::sync_tasks::SecurityBackedMembership { data_root: &data_root };
            crate::sync_tasks::update_task_at(
                &data_root,
                &payload.project_id,
                &payload.task_id,
                &payload.device_id,
                payload.expected_base_revision,
                payload.title,
                payload.body,
                payload.labels,
                payload.due_at_ms,
                &authorizer,
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
struct AssignBody {
    project_id: String,
    task_id: String,
    device_id: String,
    expected_base_revision: u64,
    assignees: Vec<String>,
}

async fn assign(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(payload): Json<AssignBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let authorizer = crate::sync_tasks::SecurityBackedMembership { data_root: &data_root };
            crate::sync_tasks::assign_task_at(
                &data_root,
                &payload.project_id,
                &payload.task_id,
                &payload.device_id,
                payload.expected_base_revision,
                payload.assignees,
                &authorizer,
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
struct DeleteBody {
    project_id: String,
    task_id: String,
    device_id: String,
    expected_base_revision: u64,
}

async fn delete(Extension(runtime): Extension<Arc<ServerRuntime>>, Json(payload): Json<DeleteBody>) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            let authorizer = crate::sync_tasks::SecurityBackedMembership { data_root: &data_root };
            crate::sync_tasks::delete_task_at(
                &data_root,
                &payload.project_id,
                &payload.task_id,
                &payload.device_id,
                payload.expected_base_revision,
                &authorizer,
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
struct DeleteProjectTasksBody {
    project_id: String,
}

async fn delete_project_tasks(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(payload): Json<DeleteProjectTasksBody>,
) -> Response {
    let data_root = runtime.data_root().to_path_buf();
    respond(
        tokio::task::spawn_blocking(move || {
            crate::sync_tasks::delete_project_tasks_at(&data_root, &payload.project_id)
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result),
    )
}

