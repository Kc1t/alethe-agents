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
use crate::orchestrator_core::{Core, Launcher};

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
    let handle = app.clone();
    core.set_observer(Arc::new(move |snapshot: Value| {
        let _ = handle.emit(JOBS_EVENT, snapshot);
    }));

    if let Some(program) = cli_resolver::find_windows_cli_launcher("codex") {
        let mut launcher = Launcher::codex_app_server(PathBuf::from(program));
        #[cfg(windows)]
        launcher
            .env
            .push(("Path".to_string(), worker_path(&cli_resolver::rebuilt_path())));
        core.set_launcher(launcher);
    }
}

/// A worker runs its commands inside Codex's sandbox, which uses a lowered token that cannot start
/// anything installed from the Microsoft Store: the launch fails with access denied before the
/// command runs, so the worker can write files but never run a build or a test. Dropping the Store
/// aliases from its PATH leaves it on the system shell, which the sandbox can start. This narrows
/// only what the worker sees, and changes nothing about what it is allowed to touch.
#[cfg(windows)]
fn worker_path(path: &str) -> String {
    let kept: Vec<&str> = path
        .split(';')
        .filter(|entry| {
            !entry.is_empty() && !entry.to_ascii_lowercase().contains("\\windowsapps")
        })
        .collect();
    kept.join(";")
}

pub fn handle_mcp_body(app: Option<&AppHandle>, state: &OrchestratorState, body: &str) -> Option<String> {
    if let Some(app) = app {
        prepare(app, state);
    }
    crate::orchestrator_core::handle_mcp_body(&state.core, body)
}

#[tauri::command]
pub fn orchestrator_mcp_config_path(app: AppHandle) -> Result<String, String> {
    prepare(&app, &app.state::<OrchestratorState>());
    let endpoint = crate::agent_events::agent_hooks_endpoint()?;
    let token = crate::agent_events::agent_hooks_token();
    let config = json!({
        "mcpServers": {
            "alethe": {
                "type": "http",
                "url": format!("{endpoint}/mcp"),
                "headers": { "X-Alethe-Token": token }
            }
        }
    });
    let path = std::env::temp_dir().join("alethe-orchestrator-mcp.json");
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
    crate::orchestrator_core::call_tool(&state.core, tool, &arguments)
}
