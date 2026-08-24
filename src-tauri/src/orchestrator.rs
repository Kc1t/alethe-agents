//! Tauri glue for the delegation core in `orchestrator_core`.
//!
//! The MCP server is hosted in-process over HTTP on the `agent_events` listener, so worker state
//! lives next to the UI instead of in a sidecar.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::cli_resolver;
use crate::orchestrator_core::{Core, Launcher, Planner};

const JOBS_EVENT: &str = "orchestrator://jobs";

#[derive(Default)]
pub struct OrchestratorState {
    core: Core,
    prepared: AtomicBool,
}

impl OrchestratorState {
    pub fn core(&self) -> &Core {
        &self.core
    }
}

/// Resolving the launcher lazily keeps a missing Codex install from blocking app start; the
/// failure then surfaces as a delivery on the job that needed it. Resolving it scans PATH, so it
/// happens once rather than on every request.
fn prepare(app: &AppHandle, state: &OrchestratorState) {
    if state.prepared.swap(true, Ordering::SeqCst) {
        return;
    }
    let core = state.core.clone();
    // History outlives the app: what each worker was asked and reported is kept, and Codex keeps
    // the thread itself, so a worker can be started again with its context intact.
    if let Ok(path) = crate::paths::orchestrator_store_path(app) {
        core.set_store(path);
        core.restore();
    }
    let handle = app.clone();
    core.set_observer(Arc::new(move |snapshot: Value| {
        let _ = handle.emit(JOBS_EVENT, snapshot);
    }));

    if let Some(program) = cli_resolver::find_windows_cli_launcher("codex") {
        let mut launcher = Launcher::codex_app_server(PathBuf::from(program));
        #[cfg(windows)]
        launcher
            .env
            .push(("Path".to_string(), crate::orchestrator_core::path_without_store_aliases(&cli_resolver::rebuilt_path())));
        core.set_launcher(launcher);
    }
}

pub fn handle_mcp_body(
    app: Option<&AppHandle>,
    state: &OrchestratorState,
    body: &str,
    planner: Option<&str>,
) -> Option<String> {
    if let Some(app) = app {
        prepare(app, state);
    }
    crate::orchestrator_core::handle_mcp_body(&state.core, body, planner)
}

#[tauri::command]
pub fn orchestrator_mcp_config_path(
    app: AppHandle,
    planner_id: String,
    planner_label: String,
    planner_agent: String,
) -> Result<String, String> {
    let state = app.state::<OrchestratorState>();
    prepare(&app, &state);
    state.core.register_planner(Planner {
        id: planner_id.clone(),
        label: planner_label,
        agent: planner_agent,
    });
    let endpoint = crate::agent_events::agent_hooks_endpoint()?;
    let token = crate::agent_events::agent_hooks_token();
    let config = json!({
        "mcpServers": {
            "alethe": {
                "type": "http",
                "url": format!("{endpoint}/mcp"),
                "headers": {
                    "X-Alethe-Token": token,
                    // One config per terminal, so a request says which session it came from.
                    "X-Alethe-Planner": planner_id
                }
            }
        }
    });
    // Namespaced by port, like the agent hooks file: two instances writing one shared path would
    // leave whichever started last owning it, pointing the other one's terminals at the wrong app.
    let port = endpoint.rsplit(':').next().unwrap_or("0");
    let safe: String = planner_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let path = std::env::temp_dir().join(format!("alethe-orchestrator-mcp-{port}-{safe}.json"));
    let body = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    std::fs::write(&path, body).map_err(|error| format!("write_failed:{error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn orchestrator_jobs(state: tauri::State<'_, OrchestratorState>) -> Value {
    state.core.snapshot()
}

#[tauri::command]
pub fn orchestrator_set_concurrency(state: tauri::State<'_, OrchestratorState>, limit: usize) {
    state.core.set_concurrency_limit(limit);
}

/// The pane answers a blocked worker directly: the person is already looking at the question.
#[tauri::command]
pub fn orchestrator_answer(
    state: tauri::State<'_, OrchestratorState>,
    job_id: String,
    decision: String,
) -> Result<Value, String> {
    state.core.answer(&job_id, &decision)
}

/// Lets the pane talk to one worker without going through the lead. A worker mid-turn is steered so
/// the correction lands on what it is doing now; an idle one gets the message as a new turn.
#[tauri::command]
pub fn orchestrator_message(
    state: tauri::State<'_, OrchestratorState>,
    job_id: String,
    message: String,
    steer: bool,
) -> Result<Value, String> {
    let mut arguments = serde_json::Map::new();
    arguments.insert("jobId".into(), Value::String(job_id));
    arguments.insert("message".into(), Value::String(message));
    let tool = if steer { "alethe_steer" } else { "alethe_send" };
    crate::orchestrator_core::call_tool(&state.core, tool, &arguments, None)
}
