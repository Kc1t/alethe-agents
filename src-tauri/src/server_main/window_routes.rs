// Keep destructive data-reset commands native-only. Resource metrics, the job
// guard, and the runtime snapshot are safe read-only views of shared state.
// PTY suspension lives in `pty_routes` beside the shared session registry.

use crate::crash_watch;
use crate::resource_manager;
use crate::resources;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};

pub fn router() -> Router {
    Router::new()
        .route("/api/window/resource_metrics", get(resource_metrics))
        .route("/api/window/job_guard_status", get(job_guard_status))
        .route("/api/window/runtime_snapshot", get(runtime_snapshot))
}

async fn resource_metrics() -> impl IntoResponse {
    Json(resource_manager::get_resource_metrics())
}

async fn job_guard_status() -> impl IntoResponse {
    Json(crash_watch::get_job_guard_status())
}

async fn runtime_snapshot() -> impl IntoResponse {
    Json(resources::get_runtime_snapshot_core(
        super::pty_routes::alethe_server_pty_sessions(),
    ))
}
