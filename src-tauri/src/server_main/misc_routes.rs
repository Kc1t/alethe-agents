// GSD (watchers + leitura de sentinelas), Planning (status/auditoria/
// autocommit), Scheduler (tarefas), Validation Pipeline, Event Bus e
// Telemetria — todos livres de `AppHandle`.
//
// `start_gsd_watcher`/`stop_gsd_watcher` usavam `tauri::State<PlanningWatchers>`
// (registro de `notify::Watcher` por projeto) — o `_app: AppHandle` do
// comando original nunca era usado dentro da função mesmo no Tauri, então o
// núcleo (`*_core`, ver `planning.rs`) já era livre de `AppHandle`. Só falta
// um `PlanningWatchers` PRÓPRIO pro `alethe-server` (`OnceLock` estático em
// vez do gerenciado pelo Tauri) — mesmo tipo, só uma instância paralela.

use alethe_lib::event_bus::{self, EventBusPayload};
use alethe_lib::opencode_gsd_plugin;
use alethe_lib::planning::{self, PlanningWatchers};
use alethe_lib::planning_gate;
use alethe_lib::scheduler;
use alethe_lib::telemetry;
use alethe_lib::validation;
use alethe_lib::worktrees::WorktreeMode;
use axum::extract::Query;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::AppError;

fn planning_watchers() -> &'static PlanningWatchers {
    static WATCHERS: OnceLock<PlanningWatchers> = OnceLock::new();
    WATCHERS.get_or_init(PlanningWatchers::default)
}

fn q(params: &HashMap<String, String>, key: &str) -> Result<String, AppError> {
    params
        .get(key)
        .cloned()
        .ok_or_else(|| AppError::bad_request(format!("missing_query_param:{key}")))
}

pub fn router() -> Router {
    Router::new()
        .route("/api/planning/status", get(planning_status))
        .route("/api/gsd/start_watcher", post(gsd_start_watcher))
        .route("/api/gsd/stop_watcher", post(gsd_stop_watcher))
        .route("/api/gsd/opencode_plugin_write", post(gsd_plugin_write))
        .route("/api/gsd/child_session", get(gsd_child_session))
        .route("/api/gsd/child_busy", get(gsd_child_busy))
        .route("/api/gsd/child_error", get(gsd_child_error))
        .route("/api/gsd/procedure", get(gsd_procedure))
        .route("/api/scheduler/tasks", get(scheduler_tasks))
        .route("/api/scheduler/tick", post(scheduler_tick))
        .route("/api/scheduler/cancel_task", post(scheduler_cancel))
        .route("/api/planning/audit_record", post(audit_record))
        .route("/api/planning/audit_history", get(audit_history))
        .route("/api/planning/set_autocommit", post(set_autocommit))
        .route("/api/planning/autocommit", get(get_autocommit))
        .route("/api/validation/run", post(validation_run))
        .route("/api/event_bus/publish", post(event_publish))
        .route("/api/telemetry/metrics", get(telemetry_metrics))
        .route("/api/telemetry/traces", get(telemetry_traces))
        .route("/api/remote/set_enabled", post(remote_set_enabled))
        .route("/api/remote_control/set_enabled", post(remote_set_enabled))
}

async fn planning_status(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo_path = match q(&p, "repoPath") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(planning_gate::read_planning_status(repo_path))
}

#[derive(Deserialize)]
struct GsdWatcherBody {
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(rename = "repoPath")]
    repo_path: String,
}
async fn gsd_start_watcher(Json(b): Json<GsdWatcherBody>) -> impl IntoResponse {
    respond(planning::start_gsd_watcher_core(
        planning_watchers(),
        b.project_id,
        b.repo_path,
    ))
}
async fn gsd_stop_watcher(Json(b): Json<GsdWatcherBody>) -> impl IntoResponse {
    respond(planning::stop_gsd_watcher_core(
        planning_watchers(),
        b.project_id,
        b.repo_path,
    ))
}

#[derive(Deserialize)]
struct GsdPluginWriteBody {
    repo: String,
    #[serde(rename = "modelChain")]
    model_chain: Vec<String>,
}
async fn gsd_plugin_write(Json(b): Json<GsdPluginWriteBody>) -> impl IntoResponse {
    respond(opencode_gsd_plugin::gsd_opencode_plugin_write(b.repo, b.model_chain).await)
}

async fn gsd_child_session(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo_path = match q(&p, "repoPath") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(planning_gate::read_gsd_child_session(repo_path))
}
async fn gsd_child_busy(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo_path = match q(&p, "repoPath") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(planning_gate::read_gsd_child_busy(repo_path))
}
async fn gsd_child_error(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo_path = match q(&p, "repoPath") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(planning_gate::read_gsd_child_error(repo_path))
}
async fn gsd_procedure(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo_path = match q(&p, "repoPath") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(planning_gate::read_gsd_procedure(repo_path))
}

async fn scheduler_tasks(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let project_id = match q(&p, "projectId") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(scheduler::get_scheduler_tasks(project_id))
}

#[derive(Deserialize)]
struct SchedulerTickBody {
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(rename = "repoPath")]
    repo_path: String,
    #[serde(rename = "worktreeMode")]
    worktree_mode: Option<WorktreeMode>,
}
async fn scheduler_tick(Json(b): Json<SchedulerTickBody>) -> impl IntoResponse {
    respond(scheduler::trigger_scheduler_tick(
        b.project_id,
        b.repo_path,
        b.worktree_mode,
    ))
}

#[derive(Deserialize)]
struct CancelTaskBody {
    #[serde(rename = "taskId")]
    task_id: String,
}
async fn scheduler_cancel(Json(b): Json<CancelTaskBody>) -> impl IntoResponse {
    respond(scheduler::cancel_task(b.task_id))
}

#[derive(Deserialize)]
struct AuditRecordBody {
    #[serde(rename = "repoPath")]
    repo_path: String,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    reason: Option<String>,
    #[serde(rename = "projectId")]
    project_id: Option<String>,
}
async fn audit_record(Json(b): Json<AuditRecordBody>) -> impl IntoResponse {
    respond(planning::planning_audit_record(
        b.repo_path,
        b.agent_id,
        b.reason,
        b.project_id,
    ))
}

#[derive(Deserialize)]
struct AuditHistoryQuery {
    #[serde(rename = "repoPath")]
    repo_path: String,
    limit: Option<u32>,
}
async fn audit_history(Query(p): Query<AuditHistoryQuery>) -> impl IntoResponse {
    respond(planning::planning_audit_history(p.repo_path, p.limit))
}

#[derive(Deserialize)]
struct SetAutocommitBody {
    enabled: bool,
}
async fn set_autocommit(Json(b): Json<SetAutocommitBody>) -> impl IntoResponse {
    respond(planning::set_planning_autocommit(b.enabled))
}
async fn get_autocommit() -> impl IntoResponse {
    respond(planning::get_planning_autocommit())
}

#[derive(Deserialize)]
struct ValidationRunBody {
    cwd: String,
    commands: Vec<String>,
}
async fn validation_run(Json(b): Json<ValidationRunBody>) -> impl IntoResponse {
    respond(validation::run_validation(b.cwd, b.commands))
}

#[derive(Deserialize)]
struct PublishEventBody {
    event: EventBusPayload,
}
async fn event_publish(Json(b): Json<PublishEventBody>) -> impl IntoResponse {
    respond(event_bus::publish_event(b.event))
}

async fn telemetry_metrics() -> impl IntoResponse {
    respond(telemetry::get_telemetry_metrics())
}
async fn telemetry_traces(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    respond(telemetry::get_telemetry_traces(
        p.get("correlationId").cloned(),
    ))
}

#[derive(Deserialize)]
struct RemoteSetEnabledBody {
    enabled: bool,
}
async fn remote_set_enabled(Json(b): Json<RemoteSetEnabledBody>) -> Result<Json<alethe_lib::remote::RemoteInfo>, AppError> {
    let projects_path = crate::profile_routes::active_profile_dir().join("projects.json");
    let info = alethe_lib::remote::remote_control_set_enabled_core(
        &projects_path,
        crate::pty_routes::alethe_server_pty_sessions(),
        b.enabled,
    );
    Ok(Json(info))
}

fn respond<T: serde::Serialize>(result: Result<T, String>) -> axum::response::Response {
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}
