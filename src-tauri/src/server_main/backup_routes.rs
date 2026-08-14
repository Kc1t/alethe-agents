// Backup/restore de perfil — `backup.rs` já tinha os núcleos
// `export_backup_from_dir`/`import_backup_from_dir` livres de `AppHandle`
// (só os wrappers `#[tauri::command]` resolviam caminho via `AppHandle`);
// aqui resolve os mesmos caminhos à mão via `profile_routes`.

use crate::backup;
use axum::extract::Extension;
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;

use super::profile_routes::{active_profile_dir_at, profile_dir_validated_at};
use super::{AppError, ServerRuntime};

pub fn router() -> Router {
    Router::new()
        .route("/api/backup/export", post(export))
        .route("/api/backup/export_profile", post(export_profile))
        .route("/api/backup/import", post(import))
}

#[derive(Deserialize)]
struct ExportBody {
    #[serde(rename = "targetPath")]
    target_path: String,
}
async fn export(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(b): Json<ExportBody>,
) -> impl IntoResponse {
    let dir = match active_profile_dir_at(runtime.data_root()) {
        Ok(dir) => dir,
        Err(error) => return AppError::from(error).into_response(),
    };
    respond(
        tokio::task::spawn_blocking(move || backup::export_backup_from_dir(dir, b.target_path))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r),
    )
}

#[derive(Deserialize)]
struct ExportProfileBody {
    #[serde(rename = "profileId")]
    profile_id: String,
    #[serde(rename = "targetPath")]
    target_path: String,
}
async fn export_profile(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(b): Json<ExportProfileBody>,
) -> impl IntoResponse {
    let dir = match profile_dir_validated_at(runtime.data_root(), &b.profile_id) {
        Ok(d) => d,
        Err(e) => return AppError::from(e).into_response(),
    };
    respond(
        tokio::task::spawn_blocking(move || backup::export_backup_from_dir(dir, b.target_path))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r),
    )
}

#[derive(Deserialize)]
struct ImportBody {
    #[serde(rename = "sourcePath")]
    source_path: String,
}
async fn import(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(b): Json<ImportBody>,
) -> impl IntoResponse {
    let dir = match active_profile_dir_at(runtime.data_root()) {
        Ok(dir) => dir,
        Err(error) => return AppError::from(error).into_response(),
    };
    let activity_stats = dir.join("activity-stats.json");
    respond(
        tokio::task::spawn_blocking(move || {
            backup::import_backup_from_dir(dir, activity_stats, b.source_path)
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r),
    )
}

fn respond<T: serde::Serialize>(result: Result<T, String>) -> axum::response::Response {
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}
