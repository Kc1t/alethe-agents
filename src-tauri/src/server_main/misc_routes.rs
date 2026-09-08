// Planning watcher, Scheduler, Validation, Event Bus,
// and Telemetry are independent of `AppHandle`.
//
// The Tauri watcher commands use managed `PlanningWatchers`, but their core
// functions never need the app handle. The standalone Core owns a separate
// static registry of the same type.

use crate::change_trigger::{self, ChangeTriggerConfig, ChangeTriggerRegistry};
use crate::event_bus::{self, EventBusPayload};
use crate::planning::{self, PlanningWatchers};
use crate::planning_gate;
use crate::scheduler;
use crate::telemetry;
use crate::validation;
use crate::worktrees::WorktreeMode;
use axum::extract::{Extension, Query};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use super::{query_param as q, respond, AppError, ServerRuntime};

fn planning_watchers() -> &'static PlanningWatchers {
    static WATCHERS: OnceLock<PlanningWatchers> = OnceLock::new();
    WATCHERS.get_or_init(PlanningWatchers::default)
}

fn change_triggers() -> Arc<ChangeTriggerRegistry> {
    static REGISTRY: OnceLock<Arc<ChangeTriggerRegistry>> = OnceLock::new();
    REGISTRY
        .get_or_init(|| Arc::new(ChangeTriggerRegistry::default()))
        .clone()
}

pub fn router() -> Router {
    Router::new()
        .route("/api/agent_config/root", get(agent_config_root))
        .route("/api/change_trigger/start", post(change_trigger_start))
        .route("/api/change_trigger/stop", post(change_trigger_stop))
        .route("/api/change_trigger/acknowledge", post(change_trigger_acknowledge))
        .route("/api/planning/status", get(planning_status))
        .route("/api/planning/start_watcher", post(planning_start_watcher))
        .route("/api/planning/stop_watcher", post(planning_stop_watcher))
        .route("/api/scheduler/tasks", get(scheduler_tasks))
        .route("/api/scheduler/tick", post(scheduler_tick))
        .route("/api/scheduler/cancel_task", post(scheduler_cancel))
        .route("/api/planning/audit_record", post(audit_record))
        .route("/api/planning/audit_history", get(audit_history))
        .route("/api/planning/list_plans", get(list_plans))
        .route("/api/planning/save_plan", post(save_plan))
        .route("/api/planning/patch_plan", post(patch_plan))
        .route("/api/planning/append_diagram", post(append_diagram))
        .route("/api/planning/set_autocommit", post(set_autocommit))
        .route("/api/planning/autocommit", get(get_autocommit))
        .route("/api/validation/run", post(validation_run))
        .route("/api/event_bus/publish", post(event_publish))
        .route("/api/telemetry/metrics", get(telemetry_metrics))
        .route("/api/telemetry/traces", get(telemetry_traces))
        .route("/api/remote/set_enabled", post(remote_set_enabled))
        .route("/api/remote_control/set_enabled", post(remote_set_enabled))
        .route("/api/remote_control/info", get(remote_info))
        .route("/api/remote_control/open_pairing", post(remote_open_pairing))
        .route("/api/remote_control/close_pairing", post(remote_close_pairing))
        .route("/api/remote_control/revoke", post(remote_revoke))
        .route("/api/remote_control/set_read_only", post(remote_set_read_only))
        .route("/api/remote_control/set_shell_input", post(remote_set_shell_input))
        .route("/api/remote_control/set_max_devices", post(remote_set_max_devices))
        .route(
            "/api/remote_control/set_session_expiry",
            post(remote_set_session_expiry),
        )
        .route("/api/remote_control/revoke_device", post(remote_revoke_device))
}

async fn remote_info() -> impl IntoResponse {
    Json(crate::remote::remote_control_info())
}

async fn remote_open_pairing() -> impl IntoResponse {
    Json(crate::remote::remote_control_open_pairing())
}

async fn remote_close_pairing() -> impl IntoResponse {
    Json(crate::remote::remote_control_close_pairing())
}

async fn remote_revoke() -> impl IntoResponse {
    Json(crate::remote::remote_control_revoke())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteReadOnlyBody {
    read_only: bool,
}
async fn remote_set_read_only(Json(body): Json<RemoteReadOnlyBody>) -> impl IntoResponse {
    Json(crate::remote::remote_control_set_read_only(body.read_only))
}

#[derive(Deserialize)]
struct RemoteShellInputBody {
    allowed: bool,
}
async fn remote_set_shell_input(Json(body): Json<RemoteShellInputBody>) -> impl IntoResponse {
    Json(crate::remote::remote_control_set_shell_input(body.allowed))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteMaxDevicesBody {
    max_devices: usize,
}
async fn remote_set_max_devices(Json(body): Json<RemoteMaxDevicesBody>) -> impl IntoResponse {
    Json(crate::remote::remote_control_set_max_devices(body.max_devices))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSessionExpiryBody {
    session_expiry_secs: u64,
}
async fn remote_set_session_expiry(Json(body): Json<RemoteSessionExpiryBody>) -> impl IntoResponse {
    Json(crate::remote::remote_control_set_session_expiry(
        body.session_expiry_secs,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteDeviceBody {
    device_id: usize,
}
async fn remote_revoke_device(Json(body): Json<RemoteDeviceBody>) -> impl IntoResponse {
    Json(crate::remote::remote_control_revoke_device(body.device_id))
}

async fn planning_status(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo_path = match q(&p, "repoPath") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(planning_gate::read_planning_status(repo_path))
}

#[derive(Deserialize)]
struct PlanningWatcherBody {
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(rename = "repoPath")]
    repo_path: String,
}
async fn planning_start_watcher(Json(b): Json<PlanningWatcherBody>) -> impl IntoResponse {
    respond(planning::start_planning_watcher_core(
        planning_watchers(),
        b.project_id,
        b.repo_path,
    ))
}
async fn planning_stop_watcher(Json(b): Json<PlanningWatcherBody>) -> impl IntoResponse {
    respond(planning::stop_planning_watcher_core(
        planning_watchers(),
        b.project_id,
        b.repo_path,
    ))
}

async fn agent_config_root(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
) -> impl IntoResponse {
    let profile_dir = match super::profile_routes::active_profile_dir_at(runtime.data_root()) {
        Ok(dir) => dir,
        Err(error) => return AppError::from(error.to_string()).into_response(),
    };
    match crate::agent_config::ensure_agent_config_at(&profile_dir) {
        Ok(root) => Json(root.to_string_lossy().into_owned()).into_response(),
        Err(error) => AppError::from(error).into_response(),
    }
}

#[derive(Deserialize)]
struct ChangeTriggerStartBody {
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(rename = "projectRoot")]
    project_root: String,
    config: Option<ChangeTriggerConfig>,
}
async fn change_trigger_start(Json(b): Json<ChangeTriggerStartBody>) -> impl IntoResponse {
    respond(change_trigger::change_trigger_start_core(
        change_triggers(),
        b.project_id,
        b.project_root,
        b.config,
    ))
}

#[derive(Deserialize)]
struct ChangeTriggerProjectBody {
    #[serde(rename = "projectId")]
    project_id: String,
}
async fn change_trigger_stop(Json(b): Json<ChangeTriggerProjectBody>) -> impl IntoResponse {
    change_trigger::change_trigger_stop_core(&change_triggers(), &b.project_id);
    respond(Ok::<(), String>(()))
}

async fn change_trigger_acknowledge(
    Json(b): Json<ChangeTriggerProjectBody>,
) -> impl IntoResponse {
    change_trigger::change_trigger_acknowledge_core(&change_triggers(), &b.project_id);
    respond(Ok::<(), String>(()))
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

async fn list_plans(Query(p): Query<HashMap<String, String>>) -> impl IntoResponse {
    let repo_path = match q(&p, "repoPath") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let project_id = match q(&p, "projectId") {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    respond(planning::list_project_plans_core(&repo_path, &project_id))
}

#[derive(Deserialize)]
struct SavePlanBody {
    #[serde(rename = "repoPath")]
    repo_path: String,
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(rename = "terminalId")]
    terminal_id: Option<String>,
    filename: String,
    content: String,
}

async fn save_plan(Json(b): Json<SavePlanBody>) -> impl IntoResponse {
    respond(planning::save_project_plan(
        b.repo_path,
        b.project_id,
        b.terminal_id,
        b.filename,
        b.content,
    ))
}

#[derive(Deserialize)]
struct PatchPlanBody {
    #[serde(rename = "filePath")]
    file_path: String,
    #[serde(rename = "targetContent")]
    target_content: String,
    #[serde(rename = "replacementContent")]
    replacement_content: String,
}

async fn patch_plan(Json(b): Json<PatchPlanBody>) -> impl IntoResponse {
    respond(planning::patch_project_plan(
        b.file_path,
        b.target_content,
        b.replacement_content,
    ))
}

#[derive(Deserialize)]
struct AppendDiagramBody {
    #[serde(rename = "filePath")]
    file_path: String,
    title: String,
    #[serde(rename = "mermaidCode")]
    mermaid_code: String,
}

async fn append_diagram(Json(b): Json<AppendDiagramBody>) -> impl IntoResponse {
    respond(planning::append_plan_diagram(
        b.file_path,
        b.title,
        b.mermaid_code,
    ))
}

#[derive(Deserialize)]
struct RemoteSetEnabledBody {
    enabled: bool,
}
async fn remote_set_enabled(
    Extension(runtime): Extension<Arc<ServerRuntime>>,
    Json(b): Json<RemoteSetEnabledBody>,
) -> Result<Json<crate::remote::RemoteInfo>, AppError> {
    let projects_path =
        super::profile_routes::active_profile_dir_at(runtime.data_root())?.join("projects.json");
    let info = crate::remote::remote_control_set_enabled_core(
        &projects_path,
        super::pty_routes::alethe_server_pty_sessions(),
        b.enabled,
    );
    Ok(Json(info))
}
