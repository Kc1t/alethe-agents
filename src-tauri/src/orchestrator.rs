//! Tauri glue for the delegation core in `orchestrator_core`.
//!
//! The MCP server is hosted in-process over HTTP on the `agent_events` listener, so worker state
//! lives next to the UI instead of in a sidecar.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::cli_resolver;
use crate::orchestrator_core::{Core, Launcher, OrchestrationSettings, Planner};

const JOBS_EVENT: &str = "orchestrator://jobs";
// The skill reads these names (`default_policy_path` in its orchestrate.py); keep them in step.
#[cfg(windows)]
const SKILL_POLICY_FILE: &str = "alethe-orchestrate.json";
#[cfg(not(windows))]
const SKILL_POLICY_FILE: &str = "orchestrate.json";
const SKILL_POLICY_ENV: &str = "ALETHE_ORCHESTRATE_POLICY";
// `user_playbooks_path` in the skill's orchestrate.py reads the same name and variable.
const SKILL_PLAYBOOKS_FILE: &str = "alethe-playbooks.yaml";
const SKILL_PLAYBOOKS_ENV: &str = "ALETHE_ORCHESTRATE_PLAYBOOKS";
const BUNDLED_PLAYBOOKS: &str = include_str!("../assets/skills/alethe/playbooks.yaml");
const MAX_PLAYBOOKS_BYTES: usize = 1 << 20;

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
        launcher.env.push((
            "Path".to_string(),
            crate::orchestrator_core::path_without_store_aliases(&cli_resolver::rebuilt_path()),
        ));
        core.set_launcher(launcher);
    }
    if let Some(program) = cli_resolver::find_windows_cli_launcher("claude") {
        core.set_launcher(Launcher::claude_headless(PathBuf::from(program)));
    }
    core.set_shell_host(Arc::new(crate::orchestrator_shell_host::PtyShellHost::new(
        app.clone(),
    )));
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

impl OrchestratorState {
    /// The board as `orchestrator_jobs` returns it, for the remote control view.
    pub(crate) fn board(&self) -> Value {
        self.core.snapshot()
    }
}

#[tauri::command]
pub fn orchestrator_jobs(state: tauri::State<'_, OrchestratorState>) -> Value {
    state.core.snapshot()
}

#[tauri::command]
pub fn orchestrator_set_concurrency(state: tauri::State<'_, OrchestratorState>, limit: usize) {
    state.core.set_concurrency_limit(limit);
}

fn skill_policy_path() -> Result<PathBuf, String> {
    if let Some(configured) = std::env::var_os(SKILL_POLICY_ENV).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(configured));
    }
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .map(|path| path.join("AppData").join("Roaming"))
        })
        .ok_or_else(|| "orchestrator_skill_policy_home_missing".to_string())?
        .join("Alethe");

    #[cfg(not(windows))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|path| path.join(".config"))
        })
        .ok_or_else(|| "orchestrator_skill_policy_home_missing".to_string())?
        .join("alethe");

    Ok(base.join(SKILL_POLICY_FILE))
}

const SKILL_PROVIDERS: [&str; 4] = ["codex", "claude", "agy", "kimi"];

// The skill's `policy set` writes this file too, so keys the app does not show must survive.
fn skill_policy_value(settings: &OrchestrationSettings, saved: &Value) -> Value {
    let mut provider_order: Vec<&str> = Vec::new();
    for provider in saved
        .get("providerOrder")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if SKILL_PROVIDERS.contains(&provider) && !provider_order.contains(&provider) {
            provider_order.push(provider);
        }
    }
    if provider_order.is_empty() {
        provider_order = SKILL_PROVIDERS.to_vec();
    }
    if let Some(preferred) = settings.skill.preferred_provider.as_deref() {
        provider_order.retain(|provider| *provider != preferred);
        provider_order.insert(0, preferred);
    }
    let conserve = settings
        .skill
        .conserve_provider
        .as_ref()
        .map(|provider| vec![provider.as_str()])
        .unwrap_or_default();
    let max_workers = saved
        .get("maxWorkers")
        .and_then(Value::as_u64)
        .filter(|count| (1..=16).contains(count))
        .unwrap_or(16);
    let mut policy = match saved {
        Value::Object(fields) => fields.clone(),
        _ => serde_json::Map::new(),
    };
    policy.extend([
        ("version".to_string(), json!(1)),
        (
            "onboarded".to_string(),
            json!(saved
                .get("onboarded")
                .and_then(Value::as_bool)
                .unwrap_or(false)),
        ),
        ("backend".to_string(), json!(settings.skill.backend)),
        (
            "defaultStrategy".to_string(),
            json!(settings.skill.default_strategy),
        ),
        (
            "providerSwitch".to_string(),
            json!(settings.skill.provider_switch),
        ),
        ("providerOrder".to_string(), json!(provider_order)),
        ("conserveProviders".to_string(), json!(conserve)),
        ("maxWorkers".to_string(), json!(max_workers)),
        (
            "maxConcurrent".to_string(),
            json!(settings.max_concurrent.clamp(1, 16)),
        ),
    ]);
    Value::Object(policy)
}

fn write_skill_policy(settings: &OrchestrationSettings) -> Result<(), String> {
    if !matches!(settings.skill.backend.as_str(), "auto" | "skill" | "mcp")
        || !matches!(
            settings.skill.default_strategy.as_str(),
            "auto" | "economy" | "balanced" | "quality" | "research" | "parallel" | "rescue"
        )
        || !matches!(
            settings.skill.provider_switch.as_str(),
            "ask" | "automatic" | "never"
        )
        || settings
            .skill
            .conserve_provider
            .as_deref()
            .is_some_and(|provider| !matches!(provider, "codex" | "claude" | "agy" | "kimi"))
        || settings
            .skill
            .preferred_provider
            .as_deref()
            .is_some_and(|provider| !matches!(provider, "codex" | "claude" | "agy" | "kimi"))
    {
        return Err("invalid_orchestrator_skill_policy".to_string());
    }
    let path = skill_policy_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "orchestrator_skill_policy_parent_missing".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("mkdir_failed:{error}"))?;

    let saved = std::fs::read(&path)
        .ok()
        .and_then(|body| serde_json::from_slice::<Value>(&body).ok())
        .unwrap_or(Value::Null);
    let policy = skill_policy_value(settings, &saved);
    let body = serde_json::to_vec_pretty(&policy).map_err(|error| error.to_string())?;
    std::fs::write(path, body).map_err(|error| format!("write_failed:{error}"))
}

/// The Orchestration settings from Preferences, sent when the app loads and whenever they change.
#[tauri::command]
pub fn orchestrator_apply_settings(
    state: tauri::State<'_, OrchestratorState>,
    settings: OrchestrationSettings,
) -> Result<(), String> {
    write_skill_policy(&settings)?;
    state.core.apply_settings(settings);
    Ok(())
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPlaybooks {
    text: String,
    path: String,
    custom: bool,
}

fn skill_playbooks_path() -> Result<PathBuf, String> {
    if let Some(configured) =
        std::env::var_os(SKILL_PLAYBOOKS_ENV).filter(|value| !value.is_empty())
    {
        return Ok(PathBuf::from(configured));
    }
    Ok(skill_policy_path()?.with_file_name(SKILL_PLAYBOOKS_FILE))
}

fn read_playbooks(path: &Path) -> Result<SkillPlaybooks, String> {
    let shown = path.display().to_string();
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(SkillPlaybooks {
            text,
            path: shown,
            custom: true,
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(SkillPlaybooks {
            text: BUNDLED_PLAYBOOKS.to_string(),
            path: shown,
            custom: false,
        }),
        Err(error) => Err(format!("read_failed:{error}")),
    }
}

fn write_playbooks(path: &Path, text: &str) -> Result<SkillPlaybooks, String> {
    if text.trim().is_empty() || text.len() > MAX_PLAYBOOKS_BYTES {
        return Err("invalid_playbooks".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "orchestrator_playbooks_parent_missing".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("mkdir_failed:{error}"))?;
    let staging = path.with_extension("yaml.tmp");
    std::fs::write(&staging, text).map_err(|error| format!("write_failed:{error}"))?;
    if let Err(error) = std::fs::rename(&staging, path) {
        let _ = std::fs::remove_file(&staging);
        return Err(format!("write_failed:{error}"));
    }
    read_playbooks(path)
}

/// The playbooks the skill plans with: the person's copy, or the bundled file until they save one.
#[tauri::command]
pub fn orchestrator_playbooks() -> Result<SkillPlaybooks, String> {
    read_playbooks(&skill_playbooks_path()?)
}

#[tauri::command]
pub fn orchestrator_save_playbooks(text: String) -> Result<SkillPlaybooks, String> {
    write_playbooks(&skill_playbooks_path()?, &text)
}

/// The Codex models and efforts the Orchestration settings offer for a role.
#[tauri::command]
pub async fn orchestrator_codex_models(
    app: AppHandle,
    state: tauri::State<'_, OrchestratorState>,
) -> Result<Value, String> {
    prepare(&app, &state);
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || core.list_codex_models())
        .await
        .map_err(|error| error.to_string())?
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSetInput {
    pub id: String,
    pub name: String,
    pub text: String,
}

/// The person's sets, pushed from the frontend whenever they change. An empty list is a real
/// choice ("I removed them all") and is stored as such.
#[tauri::command]
pub fn orchestrator_set_rule_sets(
    state: tauri::State<'_, OrchestratorState>,
    sets: Vec<RuleSetInput>,
) {
    state.core.set_rule_sets(
        sets.into_iter()
            .map(|set| crate::orchestrator_core::RuleSet {
                id: set.id,
                name: set.name,
                text: set.text,
            })
            .collect(),
    );
}

/// What ships with Alethe, so the editor can show ours and restore one.
#[tauri::command]
pub fn orchestrator_default_rule_sets() -> Value {
    json!(crate::orchestrator_core::default_rule_sets()
        .into_iter()
        .map(|set| json!({ "id": set.id, "name": set.name, "text": set.text }))
        .collect::<Vec<_>>())
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

/// Interrupts a running worker and settles it as cancelled — the same path `alethe_cancel` takes.
#[tauri::command]
pub fn orchestrator_cancel_job(
    state: tauri::State<'_, OrchestratorState>,
    job_id: String,
) -> Value {
    json!({ "cancelled": state.core.cancel_jobs(&[job_id]) })
}

/// The label of the detached board window for one orchestration pane. The frontend reads the pane
/// back from it, and `capabilities/orchestration-window.json` covers exactly `orchestration-*`.
fn orchestration_window_label(terminal_id: &str) -> String {
    let safe: String = terminal_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("orchestration-{safe}")
}

/// Opens an orchestration pane's board in its own window, or brings back the one already open.
/// Async on purpose: building a window from a synchronous command can deadlock on Windows.
#[tauri::command]
pub async fn open_orchestration_window(app: AppHandle, terminal_id: String) -> Result<(), String> {
    let label = orchestration_window_label(&terminal_id);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        return window.set_focus().map_err(|error| error.to_string());
    }
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title("Alethe")
        .inner_size(1180.0, 780.0)
        .min_inner_size(640.0, 420.0)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
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

/// The board's shell controls. Stopping waits up to five seconds for Ctrl+C to land, so the work
/// runs off the thread that received the command.
async fn on_shells<F>(app: AppHandle, work: F) -> Result<Value, String>
where
    F: FnOnce(&Core) -> Result<Value, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<OrchestratorState>();
        prepare(&app, &state);
        work(state.core())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn orchestrator_shell_output(
    app: AppHandle,
    shell_id: String,
    lines: usize,
) -> Result<Value, String> {
    on_shells(app, move |core| core.shell_output(&shell_id, lines)).await
}

#[tauri::command]
pub async fn orchestrator_shell_stop(app: AppHandle, shell_id: String) -> Result<Value, String> {
    on_shells(app, move |core| core.stop_shell(&shell_id)).await
}

#[tauri::command]
pub async fn orchestrator_shell_restart(app: AppHandle, shell_id: String) -> Result<Value, String> {
    on_shells(app, move |core| core.restart_shell(&shell_id)).await
}

#[tauri::command]
pub async fn orchestrator_shell_remove(app: AppHandle, shell_id: String) -> Result<Value, String> {
    on_shells(app, move |core| core.remove_shell(&shell_id)).await
}

/// The board's Restart: the same request again as a new worker under the same planner.
#[tauri::command]
pub fn orchestrator_restart(
    state: tauri::State<'_, OrchestratorState>,
    job_id: String,
) -> Result<Value, String> {
    crate::orchestrator_core::restart_job(&state.core, &job_id)
}

#[cfg(test)]
mod tests {
    use super::{
        orchestration_window_label, read_playbooks, skill_policy_value, write_playbooks,
        write_skill_policy, OrchestrationSettings, BUNDLED_PLAYBOOKS,
    };
    use serde_json::{json, Value};

    // One detached board window per orchestration pane, with a label the capability matches (#247).
    #[test]
    fn a_board_window_label_is_safe_and_matches_its_capability() {
        assert_eq!(
            orchestration_window_label("orchestrator-mWHJe7AX_ilh-tn"),
            "orchestration-orchestrator-mWHJe7AX_ilh-tn"
        );
        assert_eq!(
            orchestration_window_label("../pane id?"),
            "orchestration-___pane_id_"
        );
    }

    #[test]
    fn the_local_skill_policy_carries_preferences_without_mcp() {
        let settings: OrchestrationSettings = serde_json::from_value(json!({
            "maxConcurrent": 3,
            "defaultTimeoutSeconds": 900,
            "skill": {
                "backend": "skill",
                "defaultStrategy": "economy",
                "providerSwitch": "automatic",
                "conserveProvider": "claude",
                "preferredProvider": "kimi"
            }
        }))
        .expect("settings");

        let policy = skill_policy_value(&settings, &Value::Null);
        assert_eq!(policy["backend"], json!("skill"));
        assert_eq!(policy["defaultStrategy"], json!("economy"));
        assert_eq!(policy["conserveProviders"], json!(["claude"]));
        assert_eq!(
            policy["providerOrder"],
            json!(["kimi", "codex", "claude", "agy"])
        );
        assert_eq!(policy["maxConcurrent"], json!(3));
        assert_eq!(policy["onboarded"], json!(false));
    }

    #[test]
    fn the_app_keeps_the_skill_settings_it_does_not_show() {
        let settings: OrchestrationSettings = serde_json::from_value(json!({
            "maxConcurrent": 3,
            "defaultTimeoutSeconds": 900,
            "skill": {
                "backend": "auto",
                "defaultStrategy": "auto",
                "providerSwitch": "ask",
                "preferredProvider": "claude"
            }
        }))
        .expect("settings");
        let saved = json!({
            "version": 1,
            "onboarded": true,
            "backend": "skill",
            "providerOrder": ["agy", "kimi", "claude", "antigravity"],
            "maxWorkers": 6,
            "budget": { "maxCalls": 4 },
            "modelTiers": { "cheap": { "codex": { "effort": "low" } } }
        });

        let policy = skill_policy_value(&settings, &saved);
        assert_eq!(policy["providerOrder"], json!(["claude", "agy", "kimi"]));
        assert_eq!(policy["budget"], json!({ "maxCalls": 4 }));
        assert_eq!(policy["modelTiers"], saved["modelTiers"]);
        assert_eq!(policy["maxWorkers"], json!(6));
        assert_eq!(policy["onboarded"], json!(true));
        assert_eq!(policy["backend"], json!("auto"));
        assert_eq!(policy["maxConcurrent"], json!(3));
    }

    #[test]
    fn an_invalid_local_skill_policy_is_refused_before_writing() {
        let settings: OrchestrationSettings = serde_json::from_value(json!({
            "maxConcurrent": 3,
            "defaultTimeoutSeconds": 900,
            "skill": { "backend": "remote" }
        }))
        .expect("settings");

        assert_eq!(
            write_skill_policy(&settings).unwrap_err(),
            "invalid_orchestrator_skill_policy"
        );
    }
    fn scratch_playbooks() -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("alethe-playbooks-{}", nanoid::nanoid!(8)))
            .join("alethe-playbooks.yaml")
    }

    #[test]
    fn the_bundled_playbooks_stand_in_until_the_person_saves_a_copy() {
        let path = scratch_playbooks();
        let read = read_playbooks(&path).expect("read");
        assert!(!read.custom);
        assert_eq!(read.text, BUNDLED_PLAYBOOKS);

        let saved = write_playbooks(&path, "version: 1\nplaybooks: {}\n").expect("save");
        assert!(saved.custom);
        assert_eq!(saved.text, "version: 1\nplaybooks: {}\n");
        assert!(!path.with_extension("yaml.tmp").exists());

        let again = write_playbooks(&path, "version: 1\nplaybooks: { a: {} }\n").expect("save");
        assert_eq!(again.text, "version: 1\nplaybooks: { a: {} }\n");
        let _ = std::fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn empty_or_oversized_playbooks_are_refused() {
        let path = scratch_playbooks();
        assert_eq!(
            write_playbooks(&path, "  \n").unwrap_err(),
            "invalid_playbooks"
        );
        assert_eq!(
            write_playbooks(&path, &"a".repeat((1 << 20) + 1)).unwrap_err(),
            "invalid_playbooks"
        );
        assert!(!path.exists());
    }
}
