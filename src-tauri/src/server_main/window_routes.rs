// window.ts — só as rotas SEM risco/dependência de PTY portadas por enquanto:
// resource_metrics e job_guard_status são leitura pura, sem AppHandle.
//
// De propósito FORA: reset_app_data/wipe_all_app_data (destrutivas — e como
// perfis agora são compartilhados entre Desktop e Web, uma chamada web
// acidental apagaria dados do Desktop também; portar isso merece confirmação
// explícita, não uma rota aberta) e runtime_snapshot/suspend_pty (dependem
// de PtySessions, bloqueadas até PTY ser portado).

use alethe_lib::crash_watch;
use alethe_lib::resource_manager;
use alethe_lib::resources;
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
    Json(resources::get_runtime_snapshot_core(crate::pty_routes::alethe_server_pty_sessions()))
}
