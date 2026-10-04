//! Tauri glue for the delegation core in `orchestrator_core`.
//!
//! The MCP server is hosted in-process over HTTP on the `agent_events` listener, so worker state
//! lives next to the UI instead of in a sidecar.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::cli_resolver;
use crate::orchestrator_core::{Core, Launcher, Planner, WorkerDefaults, WorkerPolicy};

const JOBS_EVENT: &str = "orchestrator://jobs";

/// The CLIs a worker can run on, as `Launcher::kind`.
const WORKER_AGENTS: [&str; 2] = ["codex", "claude"];

#[derive(Default)]
pub struct OrchestratorState {
    core: Core,
    prepared: AtomicBool,
    /// CLI paths the person set in Preferences, which win over what PATH resolves to.
    cli_overrides: Mutex<HashMap<String, PathBuf>>,
    /// Held across a whole lookup, so a PATH lookup that started before a CLI path was set cannot
    /// finish after it and put the PATH binary back.
    resolving: Mutex<()>,
}

impl OrchestratorState {
    pub fn core(&self) -> &Core {
        &self.core
    }
}

fn launcher_for(agent: &str, program: PathBuf) -> Option<Launcher> {
    #[cfg(not(windows))]
    let path = cli_resolver::path_with_launcher_dir(&program, std::env::var_os("PATH").as_deref());
    #[allow(unused_mut)]
    let mut launcher = match agent {
        "codex" => Launcher::codex_app_server(program),
        "claude" => Launcher::claude_headless(program),
        _ => return None,
    };
    #[cfg(windows)]
    if agent == "codex" {
        launcher.env.push((
            "Path".to_string(),
            crate::orchestrator_core::path_without_store_aliases(&cli_resolver::rebuilt_path()),
        ));
    }
    #[cfg(not(windows))]
    if let Some(path) = path {
        launcher
            .env
            .push(("PATH".to_string(), path.to_string_lossy().into_owned()));
    }
    Some(launcher)
}

/// Points the core at this agent's CLI: the person's own path when one is set and still exists,
/// otherwise whatever PATH resolves to. Without either the launcher is dropped, so a job fails
/// cleanly instead of starting a path that is gone.
fn resolve_launcher(state: &OrchestratorState, agent: &str) {
    let _resolving = state.resolving.lock();
    resolve_launcher_locked(state, agent);
}

fn resolve_launcher_locked(state: &OrchestratorState, agent: &str) {
    let configured = state
        .cli_overrides
        .lock()
        .ok()
        .and_then(|overrides| overrides.get(agent).cloned())
        .filter(|path| path.is_file());
    let program = configured.or_else(|| cli_resolver::find_windows_cli_launcher(agent));
    match program.and_then(|program| launcher_for(agent, program)) {
        Some(launcher) => state.core.set_launcher(launcher),
        None => state.core.remove_launcher(agent),
    }
}

/// A CLI installed after the first delegation would otherwise stay unusable until a restart. Only
/// missing launchers are looked up again: a found path is cached, and a miss costs one PATH scan.
fn resolve_missing_launchers(state: &OrchestratorState) {
    if WORKER_AGENTS
        .iter()
        .all(|agent| state.core.has_launcher(agent))
    {
        return;
    }
    let _resolving = state.resolving.lock();
    for agent in WORKER_AGENTS {
        if !state.core.has_launcher(agent) {
            resolve_launcher_locked(state, agent);
        }
    }
}

/// Resolving the launcher lazily keeps a missing Codex install from blocking app start; the
/// failure then surfaces as a delivery on the job that needed it.
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
    resolve_missing_launchers(state);
    crate::orchestrator_core::handle_mcp_body(&state.core, body, planner)
}

#[tauri::command]
pub fn orchestrator_mcp_config_path(
    app: AppHandle,
    planner_id: String,
    planner_label: String,
    planner_agent: String,
    planner_cwd: Option<String>,
) -> Result<String, String> {
    let state = app.state::<OrchestratorState>();
    prepare(&app, &state);
    state.core.register_planner(Planner {
        id: planner_id.clone(),
        label: planner_label,
        agent: planner_agent,
        cwd: planner_cwd,
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
    let path = crate::paths::private_runtime_dir()
        .map_err(|error| format!("write_failed:{error}"))?
        .join(format!("alethe-orchestrator-mcp-{port}-{safe}.json"));
    let body = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    crate::paths::write_private_file(&path, body)
        .map_err(|error| format!("write_failed:{error}"))?;
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

/// The CLI path the person set for a worker agent in Preferences, or None to go back to PATH.
#[tauri::command]
pub fn orchestrator_set_cli_path(
    state: tauri::State<'_, OrchestratorState>,
    agent: String,
    path: Option<String>,
) {
    if !WORKER_AGENTS.contains(&agent.as_str()) {
        return;
    }
    if let Ok(mut overrides) = state.cli_overrides.lock() {
        match path
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty())
        {
            Some(path) => overrides.insert(agent.clone(), PathBuf::from(path)),
            None => overrides.remove(&agent),
        };
    }
    resolve_launcher(&state, &agent);
}

/// The model and effort workers of one CLI start with. Preferences live in the webview, so they
/// are pushed here whenever they change instead of being read from disk by the core.
#[tauri::command]
pub fn orchestrator_set_worker_defaults(
    state: tauri::State<'_, OrchestratorState>,
    agent: String,
    model: Option<String>,
    effort: Option<String>,
) {
    state
        .core
        .set_worker_defaults(&agent, WorkerDefaults { model, effort });
}

/// The person's rules for workers from Preferences. Pushed like the worker defaults, and applied to
/// delegations from then on.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn orchestrator_set_policy(
    state: tauri::State<'_, OrchestratorState>,
    default_agent: String,
    timeout_seconds: Option<u64>,
    approvals: String,
    isolation: String,
    web_search: String,
    parked_limit: usize,
    codex_sandbox: String,
    routing: Value,
) {
    state.core.set_policy(WorkerPolicy {
        default_agent,
        // Zero means no budget, the same as `timeoutSeconds: 0` on a delegation.
        timeout_ms: timeout_seconds
            .filter(|seconds| *seconds > 0)
            .map(|seconds| seconds.saturating_mul(1000)),
        approvals,
        isolation,
        web_search,
        parked_limit,
        codex_sandbox,
    });
    state.core.set_routing_policy(routing);
}

/// Stops workers from the board, through the same path a planner's `alethe_cancel` takes.
#[tauri::command]
pub fn orchestrator_cancel(
    state: tauri::State<'_, OrchestratorState>,
    job_ids: Vec<String>,
) -> Result<Value, String> {
    let mut arguments = serde_json::Map::new();
    arguments.insert("jobIds".into(), json!(job_ids));
    crate::orchestrator_core::call_tool(&state.core, "alethe_cancel", &arguments, None)
}

/// Lets go of finished workers' processes from the board, like a planner's `alethe_release`.
#[tauri::command]
pub fn orchestrator_release(
    state: tauri::State<'_, OrchestratorState>,
    job_ids: Vec<String>,
) -> Result<Value, String> {
    let mut arguments = serde_json::Map::new();
    arguments.insert("jobIds".into(), json!(job_ids));
    crate::orchestrator_core::call_tool(&state.core, "alethe_release", &arguments, None)
}

/// Gives the planners of a project with its own routing profile that profile, or takes one back to
/// the shared routing with `null`.
#[tauri::command]
pub fn orchestrator_set_planner_routing(
    state: tauri::State<'_, OrchestratorState>,
    planner_id: String,
    routing: Option<Value>,
) {
    state.core.set_planner_routing(&planner_id, routing);
}

/// Removes finished workers from the board; anything still in flight is left where it is.
#[tauri::command]
pub fn orchestrator_clear(
    state: tauri::State<'_, OrchestratorState>,
    job_ids: Vec<String>,
) -> Value {
    state.core.clear_finished(&job_ids)
}

/// Reorders the work waiting for a slot, as dragged on the board or in the Workers tab.
#[tauri::command]
pub fn orchestrator_reorder_queue(
    state: tauri::State<'_, OrchestratorState>,
    job_ids: Vec<String>,
) -> Value {
    state.core.reorder_queue(&job_ids)
}

/// Fed by the same usage poll that drives the warning chip, so the planner and the person read the
/// same numbers at the same cadence.
#[tauri::command]
pub fn orchestrator_set_agent_fitness(
    state: tauri::State<'_, OrchestratorState>,
    agent: String,
    snapshot: Value,
) {
    state.core.set_agent_fitness(&agent, snapshot);
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

#[tauri::command]
pub fn orchestrator_job_diff(
    state: tauri::State<'_, OrchestratorState>,
    job_id: String,
) -> Result<String, String> {
    state.core.job_diff(&job_id)
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
