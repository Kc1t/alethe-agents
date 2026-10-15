// Listener da POC do canvas de subagents (Fase 1).
//
// O Claude Code dispara hooks `SubagentStart`/`SubagentStop` como POST HTTP

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 9123;
const MAX_PORT: u16 = 9143;
const BODY_LIMIT: u64 = 1024 * 1024; // 1 MB
static LISTENER_PORT: AtomicU16 = AtomicU16::new(0);
static LISTENER_TOKEN: OnceLock<String> = OnceLock::new();

fn init_token() -> &'static str {
    LISTENER_TOKEN.get_or_init(|| nanoid::nanoid!(32))
}

fn check_token(request: &tiny_http::Request) -> bool {
    let expected = init_token();
    // Header names are case-insensitive, and clients do send them lowercased.
    request
        .headers()
        .iter()
        .any(|h| h.field.equiv("X-Alethe-Token") && h.value.as_str() == expected)
}

fn listener_addr(port: u16) -> String {
    format!("{HOST}:{port}")
}

fn listener_endpoint(port: u16) -> String {
    format!("http://{HOST}:{port}")
}

fn current_listener_port() -> Option<u16> {
    let port = LISTENER_PORT.load(Ordering::SeqCst);
    (port != 0).then_some(port)
}

fn wait_for_listener_port() -> Option<u16> {
    let start = Instant::now();
    loop {
        if let Some(port) = current_listener_port() {
            return Some(port);
        }
        if start.elapsed() >= Duration::from_secs(2) {
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[tauri::command]
pub fn agent_hooks_endpoint() -> Result<String, String> {
    let port = wait_for_listener_port()
        .ok_or_else(|| "the agent listener is not available yet".to_string())?;
    Ok(listener_endpoint(port))
}

#[tauri::command]
pub fn agent_hooks_token() -> String {
    init_token().to_string()
}

/// The main window's subagent canvas, as it last published it. A detached orchestration board has
/// its own, empty store and only sees hook events from the moment it opens, so it shows this
/// instead (#247).
static CANVAS_MIRROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
const CANVAS_MIRROR_EVENT: &str = "agent-canvas://mirror";

#[tauri::command]
pub fn set_agent_canvas_mirror(app: AppHandle, snapshot: String) {
    if let Ok(mut slot) = CANVAS_MIRROR.lock() {
        *slot = Some(snapshot.clone());
    }
    let _ = app.emit(CANVAS_MIRROR_EVENT, snapshot);
}

#[tauri::command]
pub fn agent_canvas_mirror() -> Option<String> {
    CANVAS_MIRROR.lock().ok().and_then(|slot| slot.clone())
}

const HOOK_TIMEOUT_SECS: u64 = 5;
/// Claude waits on this hook while a voice conversation decides; Alethe answers it itself at
/// `PERMISSION_HOLD` (290 s), before this timeout, because what Claude does on a hook timeout is
/// undocumented.
const PERMISSION_HOOK_TIMEOUT_SECS: u64 = 300;

const ORCHESTRATOR_EVENTS: [&str; 8] = [
    "SubagentStart",
    "SubagentStop",
    "PreToolUse",
    "PostToolUse",
    "TeammateIdle",
    "TaskCreated",
    "TaskCompleted",
    // Lists what is still running when a turn ends, which is how the board notices a background
    // worker whose own end event never came. `/hook` answers with an empty body, so this never
    // blocks the agent from stopping.
    "Stop",
];

const VOICE_EVENTS: [&str; 4] = ["PreToolUse", "PostToolUse", "Stop", "PermissionRequest"];

/// The hook entries for one Claude terminal. Events present only because of `voice` carry
/// `X-Alethe-Voice-Only`, so the orchestrator board can ignore them.
fn build_hooks(
    endpoint: &str,
    token: &str,
    planner_id: &str,
    orchestrator: bool,
    voice: bool,
) -> serde_json::Map<String, serde_json::Value> {
    let entry = |timeout: u64, voice_only: bool| {
        let mut headers = serde_json::json!({
            "X-Alethe-Token": token,
            "X-Alethe-Planner": planner_id,
        });
        if voice_only {
            headers["X-Alethe-Voice-Only"] = serde_json::Value::String("1".to_string());
        }
        serde_json::json!([
            { "hooks": [ {
                "type": "http",
                "url": format!("{endpoint}/hook"),
                "timeout": timeout,
                "headers": headers
            } ] }
        ])
    };

    // Both carry `session_id`, the only authoritative answer to which conversation a pane sits on
    // once `/clear` or an in-CLI `/resume` moves it off the id it was launched with.
    let mut hooks = serde_json::Map::new();
    hooks.insert("SessionStart".to_string(), entry(HOOK_TIMEOUT_SECS, false));
    hooks.insert("UserPromptSubmit".to_string(), entry(HOOK_TIMEOUT_SECS, false));
    if orchestrator {
        for event in ORCHESTRATOR_EVENTS {
            hooks.insert(event.to_string(), entry(HOOK_TIMEOUT_SECS, false));
        }
    }
    if voice {
        for event in VOICE_EVENTS {
            if hooks.contains_key(event) {
                continue;
            }
            let timeout = if event == "PermissionRequest" {
                PERMISSION_HOOK_TIMEOUT_SECS
            } else {
                HOOK_TIMEOUT_SECS
            };
            hooks.insert(event.to_string(), entry(timeout, true));
        }
    }
    hooks
}

/// These payloads carry commands and file contents, so only their names reach the log.
const CONTENT_BEARING_EVENTS: [&str; 3] = ["PreToolUse", "PostToolUse", "PermissionRequest"];

fn hook_log_line(event: &str, tool: Option<&str>, body: &str) -> String {
    if CONTENT_BEARING_EVENTS.contains(&event) {
        return format!("[agent_events] payload: {event} tool={}", tool.unwrap_or("?"));
    }
    let preview: String = body.chars().take(4000).collect();
    format!("[agent_events] payload: {preview}")
}

/// How long a `PermissionRequest` is held for a voice answer before Alethe answers it with no
/// decision, which makes Claude show its own prompt.
const PERMISSION_HOLD: Duration = Duration::from_secs(290);
const PERMISSION_RELEASED_EVENT: &str = "agent-permission://released";

/// Answers a held hook request. `None` is an empty 200: no decision.
pub(crate) trait PermissionResponder: Send {
    fn answer(self: Box<Self>, body: Option<String>);
}

impl PermissionResponder for tiny_http::Request {
    fn answer(self: Box<Self>, body: Option<String>) {
        let result = match body {
            Some(body) => {
                let header = tiny_http::Header::from_bytes("Content-Type", "application/json")
                    .expect("static header");
                (*self).respond(tiny_http::Response::from_string(body).with_header(header))
            }
            None => (*self).respond(tiny_http::Response::empty(200)),
        };
        if let Err(error) = result {
            eprintln!("[agent_events] permission answer failed: {error}");
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PermissionBehavior {
    Allow,
    Deny,
    Defer,
}

impl PermissionBehavior {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "allow" => Ok(Self::Allow),
            "deny" => Ok(Self::Deny),
            "defer" => Ok(Self::Defer),
            other => Err(format!("unknown permission behavior: {other}")),
        }
    }
}

/// The `PermissionRequest` hook output Claude Code reads (code.claude.com/docs/en/hooks).
fn permission_decision_body(behavior: PermissionBehavior, message: Option<&str>) -> Option<String> {
    let mut decision = match behavior {
        PermissionBehavior::Defer => return None,
        PermissionBehavior::Allow => serde_json::json!({ "behavior": "allow" }),
        PermissionBehavior::Deny => serde_json::json!({ "behavior": "deny" }),
    };
    if behavior == PermissionBehavior::Deny {
        if let Some(message) = message.map(str::trim).filter(|m| !m.is_empty()) {
            decision["message"] = serde_json::Value::String(message.to_string());
        }
    }
    Some(
        serde_json::json!({
            "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision }
        })
        .to_string(),
    )
}

struct HeldPermission {
    planner: String,
    deadline: Instant,
    responder: Box<dyn PermissionResponder>,
}

/// Permission requests waiting for a voice or panel answer. The listener loop is serial, so a
/// request is parked here instead of blocking every other hook while the person decides.
#[derive(Default)]
pub(crate) struct PendingPermissions {
    held: std::sync::Mutex<std::collections::HashMap<String, HeldPermission>>,
    targets: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl PendingPermissions {
    pub(crate) fn is_target(&self, planner: &str) -> bool {
        self.targets
            .lock()
            .map(|targets| targets.contains(planner))
            .unwrap_or(false)
    }

    /// Replaces the voice targets and releases what was held for a terminal that left them.
    pub(crate) fn set_targets(&self, planners: Vec<String>) -> Vec<String> {
        let next: std::collections::HashSet<String> = planners.into_iter().collect();
        if let Ok(mut targets) = self.targets.lock() {
            *targets = next.clone();
        }
        self.release_where(|held| !next.contains(&held.planner))
    }

    pub(crate) fn hold(
        &self,
        planner: String,
        responder: Box<dyn PermissionResponder>,
        now: Instant,
    ) -> String {
        let id = nanoid::nanoid!(16);
        let held = HeldPermission {
            planner,
            deadline: now + PERMISSION_HOLD,
            responder,
        };
        match self.held.lock() {
            Ok(mut map) => {
                map.insert(id.clone(), held);
            }
            Err(_) => held.responder.answer(None),
        }
        id
    }

    pub(crate) fn decide(
        &self,
        id: &str,
        behavior: PermissionBehavior,
        message: Option<&str>,
    ) -> Result<(), String> {
        let held = self
            .held
            .lock()
            .map_err(|_| "the permission map is poisoned".to_string())?
            .remove(id)
            .ok_or_else(|| format!("no pending permission request {id}"))?;
        held.responder.answer(permission_decision_body(behavior, message));
        Ok(())
    }

    pub(crate) fn release_expired(&self, now: Instant) -> Vec<String> {
        self.release_where(|held| held.deadline <= now)
    }

    pub(crate) fn release_all(&self) -> Vec<String> {
        self.release_where(|_| true)
    }

    /// Answers outside the lock, so a slow socket never blocks a concurrent decide.
    fn release_where(&self, mut predicate: impl FnMut(&HeldPermission) -> bool) -> Vec<String> {
        let released: Vec<(String, HeldPermission)> = match self.held.lock() {
            Ok(mut map) => {
                let ids: Vec<String> = map
                    .iter()
                    .filter(|(_, held)| predicate(held))
                    .map(|(id, _)| id.clone())
                    .collect();
                ids.into_iter()
                    .filter_map(|id| map.remove(&id).map(|held| (id, held)))
                    .collect()
            }
            Err(_) => Vec::new(),
        };
        released
            .into_iter()
            .map(|(id, held)| {
                held.responder.answer(None);
                id
            })
            .collect()
    }
}

fn pending_permissions() -> &'static PendingPermissions {
    static PENDING: OnceLock<PendingPermissions> = OnceLock::new();
    PENDING.get_or_init(PendingPermissions::default)
}

fn emit_released(app: &AppHandle, ids: &[String], reason: &str) {
    for id in ids {
        let _ = app.emit(
            PERMISSION_RELEASED_EVENT,
            serde_json::json!({ "requestId": id, "reason": reason }),
        );
    }
}

/// Every window can call every custom command (no app manifest in build.rs), so commands that
/// answer for the person check who is calling.
fn require_main_window(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err(format!("window {label} may not answer agent permissions"))
    }
}

#[tauri::command]
pub fn agent_permission_decide(
    webview: tauri::WebviewWindow,
    request_id: String,
    behavior: String,
    message: Option<String>,
) -> Result<(), String> {
    require_main_window(webview.label())?;
    let behavior = PermissionBehavior::parse(&behavior)?;
    pending_permissions().decide(&request_id, behavior, message.as_deref())
}

#[tauri::command]
pub fn voice_set_targets(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    pty_ids: Vec<String>,
) -> Result<(), String> {
    require_main_window(webview.label())?;
    let released = pending_permissions().set_targets(pty_ids);
    emit_released(&app, &released, "untargeted");
    Ok(())
}

/// The PTYs whose last hook settings file carried the voice hooks. A Claude launched before voice
/// was turned on has no PermissionRequest/Stop hooks, so voice must not target it. Lives in Rust so
/// it survives a webview reload.
#[derive(Default)]
pub(crate) struct VoiceHookedPtys {
    planners: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl VoiceHookedPtys {
    pub(crate) fn note(&self, planner: &str, voice: bool) {
        if let Ok(mut planners) = self.planners.lock() {
            if voice {
                planners.insert(planner.to_string());
            } else {
                planners.remove(planner);
            }
        }
    }

    pub(crate) fn list(&self) -> Vec<String> {
        let mut planners: Vec<String> = self
            .planners
            .lock()
            .map(|planners| planners.iter().cloned().collect())
            .unwrap_or_default();
        planners.sort();
        planners
    }
}

fn voice_hooked_ptys() -> &'static VoiceHookedPtys {
    static HOOKED: OnceLock<VoiceHookedPtys> = OnceLock::new();
    HOOKED.get_or_init(VoiceHookedPtys::default)
}

#[tauri::command]
pub fn agent_voice_hooked_ptys() -> Vec<String> {
    voice_hooked_ptys().list()
}

/// Called on exit: Claude shows its own prompt instead of waiting on a closed app.
pub fn release_all_permissions(app: &AppHandle) {
    emit_released(app, &pending_permissions().release_all(), "shutdown");
}

#[tauri::command]
pub fn agent_hooks_settings_path(
    app: AppHandle,
    planner_id: String,
    orchestrator: Option<bool>,
    ai_memory_enabled: Option<bool>,
    ai_memory_port: Option<u16>,
    voice: Option<bool>,
) -> Result<String, String> {
    let orchestrator = orchestrator.unwrap_or(true);
    let port = wait_for_listener_port()
        .ok_or_else(|| "the agent listener is not available yet".to_string())?;
    let endpoint = listener_endpoint(port);
    // Namespaced by port and planner so each Claude terminal gets its own file and its hooks carry
    // the id back, the same way the orchestrator MCP config does per terminal.
    let safe_planner: String = planner_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let voice = voice.unwrap_or(false);
    let variant = match (orchestrator, voice) {
        (true, false) => "full",
        (true, true) => "full-voice",
        (false, false) => "session",
        (false, true) => "session-voice",
    };
    let path = hook_settings_dir()?.join(format!(
        "alethe-agent-hooks-{port}-{variant}-{safe_planner}.json"
    ));
    let mut hooks = build_hooks(&endpoint, init_token(), &planner_id, orchestrator, voice);

    let mut settings = serde_json::Map::new();
    if orchestrator {
        settings.insert(
            "teammateMode".to_string(),
            serde_json::Value::String("in-process".to_string()),
        );
    }
    // Capture rides in the same file, so one writer owns it and the scope is this terminal.
    // `merge_hooks` refuses an unfamiliar shape rather than writing a broken file.
    let ai_port = ai_memory_port.unwrap_or(crate::ai_memory::DEFAULT_PORT);
    let ai_on = ai_memory_enabled.unwrap_or(false);
    if let Some(theirs) = crate::ai_memory::claude_hooks(&app, ai_on, ai_port) {
        if let Err(error) = crate::ai_memory_hooks::merge_hooks(&mut hooks, &theirs) {
            eprintln!("[ai_memory] hooks not merged: {error}");
        }
    }

    settings.insert("hooks".to_string(), serde_json::Value::Object(hooks));

    let body = serde_json::to_string_pretty(&serde_json::Value::Object(settings))
        .map_err(|e| e.to_string())?;
    write_private_file(&path, body.as_bytes())?;
    voice_hooked_ptys().note(&planner_id, voice);
    eprintln!(
        "[agent_events] hooks settings written to {}",
        path.display()
    );
    Ok(path.to_string_lossy().to_string())
}

/// Where the Claude hook settings go. They carry the listener token, so on Unix they live in the
/// user's own runtime folder, or a private cache folder, never in the shared temp folder, where
/// another user could read the token or plant a symlink at the predictable name (#116). Windows'
/// temp folder is already the user's own.
fn hook_settings_dir() -> Result<PathBuf, String> {
    #[cfg(unix)]
    {
        let dir = std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
            .map(|dir| dir.join("alethe"))
            .or_else(|| dirs_next::cache_dir().map(|dir| dir.join("alethe").join("runtime")))
            .ok_or_else(|| "no private folder for the agent hook settings".to_string())?;
        ensure_private_dir(&dir)?;
        Ok(dir)
    }
    #[cfg(not(unix))]
    Ok(std::env::temp_dir())
}

#[cfg(unix)]
fn ensure_private_dir(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{} is not a private folder", path.display()));
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())
}

/// Written next to its final name and moved over it, so the file is never half-written and never
/// readable by anyone else, not even for a moment.
fn write_private_file(path: &Path, body: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no folder", path.display()))?;
    let temporary = parent.join(format!(".alethe-agent-hooks-{}.tmp", nanoid::nanoid!(12)));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = options
        .open(&temporary)
        .and_then(|mut file| {
            file.write_all(body)?;
            file.sync_all()
        })
        .and_then(|()| std::fs::rename(&temporary, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written.map_err(|e| e.to_string())
}

#[cfg(all(test, unix))]
mod private_file_tests {
    use super::{ensure_private_dir, write_private_file};
    use std::os::unix::fs::PermissionsExt;

    fn scratch(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("alethe-hooks-{label}-{}", nanoid::nanoid!(8)))
    }

    // The hook settings carry the listener token: only their owner may read them (#116).
    #[test]
    fn hook_settings_are_readable_only_by_their_owner() {
        let dir = scratch("private");
        ensure_private_dir(&dir).unwrap();
        let path = dir.join("settings.json");
        write_private_file(&path, b"first").unwrap();
        write_private_file(&path, b"second").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&dir), 0o700);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Someone else's symlink at the folder's name must not redirect where the token is written.
    #[test]
    fn a_symlinked_hook_folder_is_refused() {
        let target = scratch("target");
        std::fs::create_dir_all(&target).unwrap();
        let link = scratch("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert!(ensure_private_dir(&link).is_err());
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&target);
    }
}

const CODEX_HOOKS_MARK_START: &str = "# alethe-managed-hooks-start";
const CODEX_HOOKS_MARK_END: &str = "# alethe-managed-hooks-end";

// The listener port moves between runs, so it must not reach the filename: Codex would read a
// changed command and ask to trust the hooks again. The exe path keeps dev and prod apart.
fn install_tag() -> &'static str {
    static TAG: OnceLock<String> = OnceLock::new();
    TAG.get_or_init(|| {
        use sha2::{Digest, Sha256};
        let exe = std::env::current_exe()
            .map(|p| p.to_string_lossy().to_lowercase())
            .unwrap_or_else(|_| "alethe".to_string());
        let digest = Sha256::digest(exe.as_bytes());
        digest.iter().take(4).map(|b| format!("{b:02x}")).collect()
    })
}

fn ps_escape(value: &str) -> String {
    value.replace('\'', "''")
}

fn toml_string(value: &str) -> String {
    toml_edit::Value::from(value).to_string()
}

/// Codex CLI hooks only run `command`/`commandWindows` handlers — there is no built-in http type
/// like Claude Code's, so a PowerShell forwarder is piped Codex's hook JSON on stdin. One script
/// per install, never per terminal or per port: Codex asks to trust .codex/config.toml again
/// whenever it changes, so the endpoint lives inside the script and the terminal identifies itself
/// through ALETHE_PLANNER at run time.
fn write_codex_hook_forwarder(port: u16) -> Result<PathBuf, String> {
    let endpoint = listener_endpoint(port);
    let token = init_token();
    let script = format!(
        "$body = [Console]::In.ReadToEnd()\r\n\
         $planner = $env:ALETHE_PLANNER\r\n\
         try {{\r\n\
         \x20\x20Invoke-RestMethod -Uri '{endpoint}/hook' -Method Post -Body $body -ContentType 'application/json' -Headers @{{ 'X-Alethe-Token' = '{token}'; 'X-Alethe-Planner' = $planner; 'X-Alethe-Agent' = 'codex' }} | Out-Null\r\n\
         }} catch {{}}\r\n",
        endpoint = endpoint,
        token = ps_escape(token),
    );
    let path = std::env::temp_dir().join(format!("alethe-codex-hook-forward-{}.ps1", install_tag()));
    std::fs::write(&path, script).map_err(|e| format!("write_failed:{e}"))?;
    Ok(path)
}

const CODEX_MCP_MARK_START: &str = "# alethe-managed-mcp-start";
const CODEX_MCP_MARK_END: &str = "# alethe-managed-mcp-end";

/// Codex's MCP client only declares servers via `command`/`args` (stdio), unlike Claude Code's
/// remote `http` support — this script bridges stdin/stdout JSON-RPC to Alethe's `/mcp` endpoint.
fn write_codex_mcp_bridge(port: u16) -> Result<PathBuf, String> {
    let endpoint = listener_endpoint(port);
    let token = init_token();
    let script = format!(
        "$planner = $env:ALETHE_PLANNER\r\n\
         while ($line = [Console]::In.ReadLine()) {{\r\n\
         \x20\x20if ([string]::IsNullOrWhiteSpace($line)) {{ continue }}\r\n\
         \x20\x20try {{\r\n\
         \x20\x20\x20\x20$resp = Invoke-WebRequest -UseBasicParsing -ErrorAction Stop -Uri '{endpoint}/mcp' -Method Post -Body $line -ContentType 'application/json' -Headers @{{ 'X-Alethe-Token' = '{token}'; 'X-Alethe-Planner' = $planner }}\r\n\
         \x20\x20\x20\x20if ($resp.Content) {{\r\n\
         \x20\x20\x20\x20\x20\x20[Console]::Out.WriteLine($resp.Content)\r\n\
         \x20\x20\x20\x20\x20\x20[Console]::Out.Flush()\r\n\
         \x20\x20\x20\x20}}\r\n\
         \x20\x20}} catch {{\r\n\
         \x20\x20\x20\x20[Console]::Error.WriteLine('[alethe-mcp] request failed: ' + $_.Exception.Message)\r\n\
         \x20\x20}}\r\n\
         }}\r\n",
        endpoint = endpoint,
        token = ps_escape(token),
    );
    let path = std::env::temp_dir().join(format!("alethe-codex-mcp-bridge-{}.ps1", install_tag()));
    std::fs::write(&path, script).map_err(|e| format!("write_failed:{e}"))?;
    Ok(path)
}

fn codex_mcp_config_write_inner(repo: String, _planner_id: String) -> Result<(), String> {
    let port = wait_for_listener_port()
        .ok_or_else(|| "the agent listener is not available yet".to_string())?;
    let script_path = write_codex_mcp_bridge(port)?;

    let root = crate::git_control::repository_root(&repo)?;
    let codex_dir = root.join(".codex");
    std::fs::create_dir_all(&codex_dir).map_err(|e| format!("mkdir_failed:{e}"))?;
    let path = codex_dir.join("config.toml");

    let existing = if path.is_file() {
        std::fs::read_to_string(&path).map_err(|e| format!("read_failed:{e}"))?
    } else {
        String::new()
    };

    let mut kept_lines: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed == CODEX_MCP_MARK_START {
            skipping = true;
            continue;
        }
        if trimmed == CODEX_MCP_MARK_END {
            skipping = false;
            continue;
        }
        if !skipping {
            kept_lines.push(line);
        }
    }
    let mut body = kept_lines.join("\n");
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }

    let script_toml = toml_string(&script_path.to_string_lossy());
    body.push_str(&format!(
        "\n{CODEX_MCP_MARK_START}\n[mcp_servers.alethe]\ncommand = \"powershell.exe\"\nargs = [\"-NoProfile\", \"-ExecutionPolicy\", \"Bypass\", \"-File\", {script_toml}]\n{CODEX_MCP_MARK_END}\n",
    ));

    std::fs::write(&path, body).map_err(|e| format!("write_failed:{e}"))
}

/// Writes (idempotently, replacing its own prior block) the `[mcp_servers.alethe]` section that
/// registers this Codex terminal as an orchestrator planner — so a Codex-driven session can call
/// `alethe_delegate` too, same as a Claude terminal already can.
#[tauri::command]
pub async fn codex_mcp_config_write(
    app: tauri::AppHandle,
    repo: String,
    planner_id: String,
    planner_label: String,
    planner_agent: String,
) -> Result<(), String> {
    let state = app.state::<crate::orchestrator::OrchestratorState>();
    state.core().register_planner(crate::orchestrator_core::Planner {
        id: planner_id.clone(),
        label: planner_label,
        agent: planner_agent,
    });
    tokio::task::spawn_blocking(move || codex_mcp_config_write_inner(repo, planner_id))
        .await
        .map_err(|error| format!("codex_mcp_config_write: falha na task bloqueante: {error}"))?
}

fn codex_hooks_config_write_inner(repo: String, _planner_id: String) -> Result<(), String> {
    let port = wait_for_listener_port()
        .ok_or_else(|| "the agent listener is not available yet".to_string())?;
    let script_path = write_codex_hook_forwarder(port)?;

    let root = crate::git_control::repository_root(&repo)?;
    let codex_dir = root.join(".codex");
    std::fs::create_dir_all(&codex_dir).map_err(|e| format!("mkdir_failed:{e}"))?;
    let path = codex_dir.join("config.toml");

    let existing = if path.is_file() {
        std::fs::read_to_string(&path).map_err(|e| format!("read_failed:{e}"))?
    } else {
        String::new()
    };

    let mut kept_lines: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed == CODEX_HOOKS_MARK_START {
            skipping = true;
            continue;
        }
        if trimmed == CODEX_HOOKS_MARK_END {
            skipping = false;
            continue;
        }
        if !skipping {
            kept_lines.push(line);
        }
    }
    let mut body = kept_lines.join("\n");
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }

    let command_toml = format!("powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{script_path}\"", script_path = script_path.to_string_lossy());
    let mut block = String::new();
    block.push_str(&format!("\n{CODEX_HOOKS_MARK_START}\n"));
    for event in ["SubagentStart", "SubagentStop"] {
        block.push_str(&format!(
            "[[hooks.{event}]]\nmatcher = \".*\"\n\n[[hooks.{event}.hooks]]\ntype = \"command\"\ncommand = \"true\"\ncommandWindows = '{command_toml}'\ntimeout = 5\n\n",
        ));
    }
    block.push_str(&format!("{CODEX_HOOKS_MARK_END}\n"));
    body.push_str(&block);

    std::fs::write(&path, body).map_err(|e| format!("write_failed:{e}"))
}

/// Writes (idempotently, replacing its own prior block) the `[hooks]` section that reports this
/// Codex terminal's own subagents back to Alethe, tagged with `planner_id` so the orchestrator
/// canvas can hang them off the terminal that spawned them.
#[tauri::command]
pub async fn codex_hooks_config_write(repo: String, planner_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || codex_hooks_config_write_inner(repo, planner_id))
        .await
        .map_err(|error| format!("codex_hooks_config_write: falha na task bloqueante: {error}"))?
}

pub fn start_listener(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_error: Option<String> = None;
        let mut bound: Option<(tiny_http::Server, u16)> = None;

        for port in DEFAULT_PORT..=MAX_PORT {
            let addr = listener_addr(port);
            match tiny_http::Server::http(&addr) {
                Ok(server) => {
                    bound = Some((server, port));
                    break;
                }
                Err(e) => {
                    last_error = Some(format!("{addr}: {e}"));
                }
            }
        }

        let Some((server, port)) = bound else {
            eprintln!(
                "[agent_events] falha ao subir listener em {HOST}:{DEFAULT_PORT}-{MAX_PORT}: {}",
                last_error.unwrap_or_else(|| "sem erro detalhado".to_string())
            );
            return;
        };

        LISTENER_PORT.store(port, Ordering::SeqCst);
        eprintln!("[agent_events] listening on {}", listener_addr(port));

        let sweeper = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            let released = pending_permissions().release_expired(Instant::now());
            emit_released(&sweeper, &released, "timeout");
        });

        for mut request in server.incoming_requests() {
            let url = request.url().to_string();

            if !check_token(&request) {
                let _ = request.respond(tiny_http::Response::empty(401));
                continue;
            }

            let mut body = String::new();
            if let Err(e) = request
                .as_reader()
                .take(BODY_LIMIT)
                .read_to_string(&mut body)
            {
                eprintln!("[agent_events] erro lendo corpo: {e}");
                let _ = request.respond(tiny_http::Response::empty(400));
                continue;
            }

            // processo real (claude/codex/opencode) via
            // `curl -X POST /spawn -d '{"agent":"codex","task":"...","mode":"exec"}'`.
            // O Alethe emite `agent-spawn`; o front sobe um PTY worker. Campos:

            if url.starts_with("/mcp") {
                let planner = request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("X-Alethe-Planner"))
                    .map(|h| h.value.as_str().to_string());
                let app = app.clone();
                std::thread::spawn(move || {
                    let state = app.state::<crate::orchestrator::OrchestratorState>();
                    match crate::orchestrator::handle_mcp_body(
                        Some(&app),
                        &state,
                        &body,
                        planner.as_deref(),
                    ) {
                        Some(payload) => {
                            let header =
                                tiny_http::Header::from_bytes("Content-Type", "application/json")
                                    .expect("static header");
                            let _ = request.respond(
                                tiny_http::Response::from_string(payload).with_header(header),
                            );
                        }
                        None => {
                            let _ = request.respond(tiny_http::Response::empty(202));
                        }
                    }
                });
                continue;
            }

            if url.starts_with("/spawn") {
                match serde_json::from_str::<serde_json::Value>(&body) {
                    Ok(payload) => {
                        let agent = payload
                            .get("agent")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if !matches!(agent.as_str(), "shell" | "claude" | "codex" | "opencode") {
                            let _ = request.respond(
                                tiny_http::Response::from_string(
                                    "agent invalido (use claude|codex|opencode)",
                                )
                                .with_status_code(400),
                            );
                            continue;
                        }
                        let job_id = payload
                            .get("job_id")
                            .and_then(|value| value.as_str())
                            .map(ToOwned::to_owned)
                            .unwrap_or_else(|| format!("sandbox-job-{}", nanoid::nanoid!(10)));
                        let mut event_payload = payload;
                        if let Some(object) = event_payload.as_object_mut() {
                            object.insert(
                                "job_id".to_string(),
                                serde_json::Value::String(job_id.clone()),
                            );
                        }
                        eprintln!("[agent_events] /spawn agent={agent} job_id={job_id}");
                        let _ = app.emit("agent-spawn", &event_payload);
                        let response = serde_json::json!({
                            "accepted": true,
                            "job_id": job_id,
                            "agent": agent,
                            "status": "queued"
                        });
                        let _ = request.respond(
                            tiny_http::Response::from_string(response.to_string()).with_header(
                                tiny_http::Header::from_bytes("Content-Type", "application/json")
                                    .unwrap(),
                            ),
                        );
                    }
                    Err(e) => {
                        let _ = request.respond(
                            tiny_http::Response::from_string(format!("/spawn espera JSON: {e}"))
                                .with_status_code(400),
                        );
                    }
                }
                continue;
            }

            // Alias legado: o control plane antigo despacha texto cru pro codex

            // emitindo agent-spawn com agent=codex.
            if url.starts_with("/codex") {
                let task = body.trim().to_string();
                eprintln!("[agent_events] /codex (legado) task ({} chars)", task.len());
                let payload = serde_json::json!({ "agent": "codex", "task": task });
                let _ = app.emit("agent-spawn", &payload);
                let _ = request.respond(tiny_http::Response::from_string(
                    "queued no terminal codex do Alethe",
                ));
                continue;
            }

            // Bridge do plugin OpenCode (opencode_bridge.rs) — reporta
            // working/idle real de sessoes OpenCode. Campos: directory

            // state ("working" | "idle").
            if url.starts_with("/opencode-status") {
                match serde_json::from_str::<serde_json::Value>(&body) {
                    Ok(payload) => {
                        let _ = app.emit("opencode-bridge-status", &payload);
                    }
                    Err(e) => eprintln!("[agent_events] /opencode-status payload inválido: {e}"),
                }
                let _ = request.respond(tiny_http::Response::empty(200));
                continue;
            }

            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(mut payload) => {
                    let get = |k: &str| {
                        payload
                            .get(k)
                            .and_then(|v| v.as_str())
                            .unwrap_or("?")
                            .to_owned()
                    };
                    eprintln!(
                        "[agent_events] {} agent_id={} agent_type={}",
                        get("hook_event_name"),
                        get("agent_id"),
                        get("agent_type"),
                    );

                    // Which Claude terminal this fired from, so the frontend can hang the subagent
                    // off the same planner tree as its Codex delegations.
                    let planner = request
                        .headers()
                        .iter()
                        .find(|h| h.field.equiv("X-Alethe-Planner"))
                        .map(|h| h.value.as_str().to_string());
                    if let Some(planner) = planner.clone() {
                        if let Some(object) = payload.as_object_mut() {
                            object.insert(
                                "plannerId".to_string(),
                                serde_json::Value::String(planner),
                            );
                        }
                    }

                    // Which CLI's own subagent mechanism fired this — Claude's http hook carries no
                    // such header, so its absence defaults to "claude" for backward compatibility.
                    let source_agent = request
                        .headers()
                        .iter()
                        .find(|h| h.field.equiv("X-Alethe-Agent"))
                        .map(|h| h.value.as_str().to_string())
                        .unwrap_or_else(|| "claude".to_string());
                    if let Some(object) = payload.as_object_mut() {
                        object.insert(
                            "sourceAgent".to_string(),
                            serde_json::Value::String(source_agent),
                        );
                    }

                    if request
                        .headers()
                        .iter()
                        .any(|h| h.field.equiv("X-Alethe-Voice-Only"))
                    {
                        if let Some(object) = payload.as_object_mut() {
                            object.insert("voiceOnly".to_string(), serde_json::Value::Bool(true));
                        }
                    }

                    let event_name = payload
                        .get("hook_event_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let tool_name = payload
                        .get("tool_name")
                        .and_then(|v| v.as_str())
                        .map(ToOwned::to_owned);
                    eprintln!("{}", hook_log_line(&event_name, tool_name.as_deref(), &body));
                    if event_name == "PermissionRequest" {
                        if let Some(planner) =
                            planner.filter(|planner| pending_permissions().is_target(planner))
                        {
                            let id = pending_permissions().hold(
                                planner,
                                Box::new(request),
                                Instant::now(),
                            );
                            if let Some(object) = payload.as_object_mut() {
                                object.insert(
                                    "permissionRequestId".to_string(),
                                    serde_json::Value::String(id),
                                );
                            }
                            if let Err(e) = app.emit("agent-hook", &payload) {
                                eprintln!("[agent_events] could not emit agent-hook: {e}");
                            }
                            continue;
                        }
                    }
                    if let Err(e) = app.emit("agent-hook", &payload) {
                        eprintln!("[agent_events] could not emit agent-hook: {e}");
                    }
                }
                Err(e) => eprintln!("[agent_events] POST não-JSON ignorado: {e}"),
            }

            let _ = request.respond(tiny_http::Response::empty(200));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::toml_string;

    use super::{build_hooks, hook_log_line, PERMISSION_HOOK_TIMEOUT_SECS};

    fn events(hooks: &serde_json::Map<String, serde_json::Value>) -> Vec<String> {
        let mut names: Vec<String> = hooks.keys().cloned().collect();
        names.sort();
        names
    }

    fn entry<'a>(
        hooks: &'a serde_json::Map<String, serde_json::Value>,
        event: &str,
    ) -> &'a serde_json::Value {
        &hooks[event][0]["hooks"][0]
    }

    #[test]
    fn session_variant_without_voice_only_tracks_the_session() {
        let hooks = build_hooks("http://127.0.0.1:9123", "tok", "pty-1", false, false);
        assert_eq!(events(&hooks), vec!["SessionStart", "UserPromptSubmit"]);
    }

    #[test]
    fn voice_adds_tool_stop_and_permission_events_to_the_session_variant() {
        let hooks = build_hooks("http://127.0.0.1:9123", "tok", "pty-1", false, true);
        assert_eq!(
            events(&hooks),
            vec![
                "PermissionRequest",
                "PostToolUse",
                "PreToolUse",
                "SessionStart",
                "Stop",
                "UserPromptSubmit"
            ]
        );
        assert_eq!(entry(&hooks, "PermissionRequest")["timeout"], PERMISSION_HOOK_TIMEOUT_SECS);
        assert_eq!(entry(&hooks, "PreToolUse")["timeout"], 5);
        assert_eq!(entry(&hooks, "PreToolUse")["headers"]["X-Alethe-Voice-Only"], "1");
        assert!(entry(&hooks, "SessionStart")["headers"].get("X-Alethe-Voice-Only").is_none());
    }

    #[test]
    fn voice_on_the_full_variant_registers_no_event_twice() {
        let hooks = build_hooks("http://127.0.0.1:9123", "tok", "pty-1", true, true);
        for event in ["PreToolUse", "PostToolUse", "Stop"] {
            assert_eq!(hooks[event].as_array().unwrap().len(), 1, "{event} registered twice");
            assert!(
                entry(&hooks, event)["headers"].get("X-Alethe-Voice-Only").is_none(),
                "{event} belongs to the orchestrator variant, so it is not voice-only"
            );
        }
        assert_eq!(entry(&hooks, "PermissionRequest")["headers"]["X-Alethe-Voice-Only"], "1");
        assert!(hooks.contains_key("SubagentStart"));
    }

    #[test]
    fn every_hook_carries_the_token_and_the_planner() {
        let hooks = build_hooks("http://127.0.0.1:9123", "tok", "pty-1", true, true);
        for (event, _) in hooks.iter() {
            let headers = &entry(&hooks, event)["headers"];
            assert_eq!(headers["X-Alethe-Token"], "tok", "{event}");
            assert_eq!(headers["X-Alethe-Planner"], "pty-1", "{event}");
            assert_eq!(entry(&hooks, event)["url"], "http://127.0.0.1:9123/hook");
        }
    }

    #[test]
    fn tool_and_permission_payloads_are_logged_without_their_content() {
        let body = r#"{"tool_input":{"command":"export TOKEN=secret"}}"#;
        let line = hook_log_line("PreToolUse", Some("Bash"), body);
        assert!(!line.contains("secret"));
        assert!(line.contains("PreToolUse") && line.contains("Bash"));
        assert!(!hook_log_line("PermissionRequest", Some("Bash"), body).contains("secret"));
        assert!(!hook_log_line("PostToolUse", Some("Read"), body).contains("secret"));
        assert!(hook_log_line("SessionStart", None, body).contains("secret"));
    }

    #[test]
    fn toml_string_escapes_windows_paths() {
        let path = r#"C:\Users\kauam\AppData\Local\Temp\alethe-\"bridge\".ps1"#;
        let document = format!("path = {}", toml_string(path))
            .parse::<toml_edit::DocumentMut>()
            .expect("generated path should be valid TOML");

        assert_eq!(document["path"].as_str(), Some(path));
    }

    #[test]
    fn codex_mcp_bridge_script_requests_with_basic_parsing() {
        // The file name comes from the test binary's own path, so this never touches the bridge
        // a running app uses.
        let path = super::write_codex_mcp_bridge(8123).expect("bridge script should be written");
        let script = std::fs::read_to_string(&path).expect("bridge script should be readable");
        let removed = std::fs::remove_file(&path);

        assert!(
            script.contains("Invoke-WebRequest -UseBasicParsing -ErrorAction Stop -Uri"),
            "bridge script should pass -UseBasicParsing and -ErrorAction Stop to Invoke-WebRequest"
        );
        assert!(
            !script.contains("Invoke-WebRequest -Uri"),
            "bridge script should not call Invoke-WebRequest without -UseBasicParsing"
        );
        // Failures go to stderr; stdout stays reserved for JSON-RPC responses.
        assert!(
            !script.contains("catch {}"),
            "bridge script should not swallow request failures"
        );
        assert!(
            script.contains("[Console]::Error.WriteLine("),
            "bridge script should report request failures on stderr"
        );
        removed.expect("generated bridge script should be removable");
    }
}

#[cfg(test)]
mod voice_hooked_tests {
    use super::VoiceHookedPtys;

    #[test]
    fn a_voice_hook_file_records_its_planner_and_a_plain_one_does_not() {
        let hooked = VoiceHookedPtys::default();
        hooked.note("pty-voice", true);
        hooked.note("pty-plain", false);
        assert_eq!(hooked.list(), vec!["pty-voice".to_string()]);
    }

    #[test]
    fn a_plain_rewrite_for_the_same_planner_forgets_it() {
        let hooked = VoiceHookedPtys::default();
        hooked.note("pty-1", true);
        hooked.note("pty-1", false);
        assert!(hooked.list().is_empty());
    }
}

#[cfg(test)]
mod permission_tests {
    use super::{
        permission_decision_body, require_main_window, PendingPermissions, PermissionBehavior,
        PermissionResponder, PERMISSION_HOLD,
    };
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    type Answers = Arc<Mutex<Vec<Option<String>>>>;

    struct Recorder(Answers);

    impl PermissionResponder for Recorder {
        fn answer(self: Box<Self>, body: Option<String>) {
            self.0.lock().unwrap().push(body);
        }
    }

    fn held(pending: &PendingPermissions, planner: &str, answers: &Answers, now: Instant) -> String {
        pending.hold(planner.to_string(), Box::new(Recorder(answers.clone())), now)
    }

    #[test]
    fn allow_answers_with_the_documented_decision_shape() {
        let body = permission_decision_body(PermissionBehavior::Allow, Some("ignored")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["hookSpecificOutput"]["hookEventName"], "PermissionRequest");
        assert_eq!(value["hookSpecificOutput"]["decision"]["behavior"], "allow");
        assert!(value["hookSpecificOutput"]["decision"].get("message").is_none());
    }

    #[test]
    fn deny_carries_the_spoken_reason() {
        let body = permission_decision_body(PermissionBehavior::Deny, Some(" use pnpm ")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert_eq!(value["hookSpecificOutput"]["decision"]["message"], "use pnpm");
    }

    #[test]
    fn defer_answers_with_no_decision() {
        assert_eq!(permission_decision_body(PermissionBehavior::Defer, None), None);
    }

    #[test]
    fn a_decision_answers_the_held_request_once() {
        let pending = PendingPermissions::default();
        let answers: Answers = Arc::default();
        let id = held(&pending, "pty-1", &answers, Instant::now());

        pending.decide(&id, PermissionBehavior::Allow, None).unwrap();
        assert_eq!(answers.lock().unwrap().len(), 1);
        assert!(answers.lock().unwrap()[0].as_deref().unwrap().contains("allow"));
        assert!(pending.decide(&id, PermissionBehavior::Deny, None).is_err());
        assert_eq!(answers.lock().unwrap().len(), 1);
    }

    #[test]
    fn an_unknown_id_is_refused() {
        let pending = PendingPermissions::default();
        assert!(pending.decide("nope", PermissionBehavior::Allow, None).is_err());
    }

    #[test]
    fn a_request_past_its_deadline_is_released_without_a_decision() {
        let pending = PendingPermissions::default();
        let answers: Answers = Arc::default();
        let start = Instant::now();
        let id = held(&pending, "pty-1", &answers, start);

        assert!(pending.release_expired(start + Duration::from_secs(10)).is_empty());
        let released = pending.release_expired(start + PERMISSION_HOLD);
        assert_eq!(released, vec![id]);
        assert_eq!(*answers.lock().unwrap(), vec![None]);
    }

    #[test]
    fn hold_is_shorter_than_the_hook_timeout() {
        assert!(PERMISSION_HOLD.as_secs() < super::PERMISSION_HOOK_TIMEOUT_SECS);
    }

    #[test]
    fn only_targeted_terminals_are_held_and_leaving_the_targets_releases() {
        let pending = PendingPermissions::default();
        let answers: Answers = Arc::default();
        assert!(!pending.is_target("pty-1"));
        assert!(pending.set_targets(vec!["pty-1".to_string()]).is_empty());
        assert!(pending.is_target("pty-1"));
        assert!(!pending.is_target("pty-2"));

        let id = held(&pending, "pty-1", &answers, Instant::now());
        let released = pending.set_targets(Vec::new());
        assert_eq!(released, vec![id]);
        assert_eq!(*answers.lock().unwrap(), vec![None]);
        assert!(!pending.is_target("pty-1"));
    }

    #[test]
    fn shutdown_releases_everything() {
        let pending = PendingPermissions::default();
        let answers: Answers = Arc::default();
        held(&pending, "a", &answers, Instant::now());
        held(&pending, "b", &answers, Instant::now());
        assert_eq!(pending.release_all().len(), 2);
        assert_eq!(*answers.lock().unwrap(), vec![None, None]);
    }

    #[test]
    fn only_the_main_window_may_decide() {
        assert!(require_main_window("main").is_ok());
        assert!(require_main_window("orchestration-x").is_err());
        assert!(require_main_window("voice-hud").is_err());
    }

    #[test]
    fn behavior_parsing_refuses_unknown_values() {
        assert_eq!(PermissionBehavior::parse("allow").unwrap(), PermissionBehavior::Allow);
        assert_eq!(PermissionBehavior::parse("deny").unwrap(), PermissionBehavior::Deny);
        assert_eq!(PermissionBehavior::parse("defer").unwrap(), PermissionBehavior::Defer);
        assert!(PermissionBehavior::parse("yes").is_err());
    }
}
