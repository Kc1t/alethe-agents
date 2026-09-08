// Project filesystem operations and the CLI shim are pure functions without
// an `AppHandle` dependency.

use crate::cli_shim;
use crate::filesystem;
use axum::extract::Query;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::collections::HashMap;

use super::{query_param as q, respond};

pub fn router() -> Router {
    Router::new()
        .route("/api/fs/list", get(list))
        .route("/api/fs/read", get(read))
        .route("/api/fs/read_binary", get(read_binary))
        .route("/api/fs/write", post(write))
        .route("/api/fs/rename", post(rename))
        .route("/api/fs/delete", post(delete))
        .route("/api/fs/todo_template", post(todo_template))
        .route("/api/fs/write_marker", post(write_marker))
        .route("/api/fs/read_marker", get(read_marker))
        .route("/api/cli/shim_status", get(shim_status))
        .route("/api/cli/shim_install", post(shim_install))
        .route("/api/cli/shim_uninstall", post(shim_uninstall))
        .route("/api/cli/find_cli_launcher", get(find_cli_launcher_route))
        .route("/api/cli/probe_install_toolchain", get(probe_install_toolchain))
        .route("/api/cli/agent_cli_version", get(agent_cli_version))
        .route(
            "/api/agents/find_cli_launcher",
            get(find_cli_launcher_route),
        )
}

async fn probe_install_toolchain() -> impl IntoResponse {
    Json(crate::cli_resolver::probe_install_toolchain().await)
}

async fn agent_cli_version(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let agent = match q(&p, "agent") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    Json(crate::cli_resolver::agent_cli_version(agent).await).into_response()
}

async fn find_cli_launcher_route(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let agent = match q(&p, "agent") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    Json(crate::cli_resolver::find_cli_launcher(agent).await).into_response()
}

async fn list(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let path = match q(&p, "path") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(filesystem::list_directory(path))
}

async fn read(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let path = match q(&p, "path") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(filesystem::read_text_file(path))
}

async fn read_binary(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let path = match q(&p, "path") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(filesystem::read_binary_file(path))
}

#[derive(Deserialize)]
struct WriteBody {
    path: String,
    content: String,
}
async fn write(Json(b): Json<WriteBody>) -> impl IntoResponse {
    respond(filesystem::write_text_file(b.path, b.content))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameBody {
    path: String,
    new_name: String,
}
async fn rename(Json(body): Json<RenameBody>) -> impl IntoResponse {
    respond(filesystem::rename_filesystem_entry(body.path, body.new_name))
}

#[derive(Deserialize)]
struct DeleteBody {
    path: String,
}
async fn delete(Json(body): Json<DeleteBody>) -> impl IntoResponse {
    respond(filesystem::delete_filesystem_entry(body.path))
}

#[derive(Deserialize)]
struct TodoTemplateBody {
    directory: String,
}
async fn todo_template(Json(b): Json<TodoTemplateBody>) -> impl IntoResponse {
    respond(filesystem::ensure_todo_template(b.directory))
}

#[derive(Deserialize)]
struct WriteMarkerBody {
    #[serde(rename = "projectDir")]
    project_dir: String,
    content: String,
}
async fn write_marker(Json(b): Json<WriteMarkerBody>) -> impl IntoResponse {
    respond(filesystem::write_project_marker(b.project_dir, b.content))
}

async fn read_marker(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let project_dir = match q(&p, "projectDir") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    Json(filesystem::read_project_marker(project_dir)).into_response()
}

async fn shim_status() -> impl IntoResponse {
    respond(cli_shim::cli_shim_status())
}
async fn shim_install() -> impl IntoResponse {
    respond(cli_shim::cli_shim_install())
}
async fn shim_uninstall() -> impl IntoResponse {
    respond(cli_shim::cli_shim_uninstall())
}
