// Filesystem (arquivos/pastas de projeto) + CLI shim — tudo função pura,
// sem `AppHandle`.

use alethe_lib::cli_shim;
use alethe_lib::filesystem;
use axum::extract::Query;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::collections::HashMap;

use crate::AppError;

fn q(params: &HashMap<String, String>, key: &str) -> Result<String, AppError> {
    params
        .get(key)
        .cloned()
        .ok_or_else(|| AppError::bad_request(format!("missing_query_param:{key}")))
}

pub fn router() -> Router {
    Router::new()
        .route("/api/fs/list", get(list))
        .route("/api/fs/read", get(read))
        .route("/api/fs/write", post(write))
        .route("/api/fs/todo_template", post(todo_template))
        .route("/api/fs/write_marker", post(write_marker))
        .route("/api/fs/read_marker", get(read_marker))
        .route("/api/cli/shim_status", get(shim_status))
        .route("/api/cli/shim_install", post(shim_install))
        .route("/api/cli/shim_uninstall", post(shim_uninstall))
        .route("/api/cli/find_cli_launcher", get(find_cli_launcher_route))
}

async fn find_cli_launcher_route(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let agent = match q(&p, "agent") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    Json(alethe_lib::cli_resolver::find_cli_launcher(agent).await).into_response()
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

#[derive(Deserialize)]
struct WriteBody {
    path: String,
    content: String,
}
async fn write(Json(b): Json<WriteBody>) -> impl IntoResponse {
    respond(filesystem::write_text_file(b.path, b.content))
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

fn respond<T: serde::Serialize>(result: Result<T, String>) -> axum::response::Response {
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}
