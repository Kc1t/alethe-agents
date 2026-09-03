// Listener da POC do canvas de subagents (Fase 1).
//
// O Claude Code dispara hooks `SubagentStart`/`SubagentStop` como POST HTTP

use std::io::Read;
use std::path::PathBuf;
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
        .ok_or_else(|| "listener de agents ainda nao esta disponivel".to_string())?;
    Ok(listener_endpoint(port))
}

#[tauri::command]
pub fn agent_hooks_token() -> String {
    init_token().to_string()
}

#[tauri::command]
pub fn agent_hooks_settings_path(
    planner_id: String,
    orchestrator: Option<bool>,
) -> Result<String, String> {
    let orchestrator = orchestrator.unwrap_or(true);
    let port = wait_for_listener_port()
        .ok_or_else(|| "listener de agents ainda nao esta disponivel".to_string())?;
    let endpoint = listener_endpoint(port);
    // Namespaced by port and planner so each Claude terminal gets its own file and its hooks carry
    // the id back, the same way the orchestrator MCP config does per terminal.
    let safe_planner: String = planner_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let variant = if orchestrator { "full" } else { "session" };
    let path = std::env::temp_dir()
        .join(format!("alethe-agent-hooks-{port}-{variant}-{safe_planner}.json"));
    let token = init_token();
    let hook = serde_json::json!([
        { "hooks": [ {
            "type": "http",
            "url": format!("{endpoint}/hook"),
            "timeout": 5,
            "headers": { "X-Alethe-Token": token, "X-Alethe-Planner": planner_id }
        } ] }
    ]);

    // Both carry `session_id`, the only authoritative answer to which conversation a pane sits on
    // once `/clear` or an in-CLI `/resume` moves it off the id it was launched with.
    let mut hooks = serde_json::Map::new();
    hooks.insert("SessionStart".to_string(), hook.clone());
    hooks.insert("UserPromptSubmit".to_string(), hook.clone());

    let mut settings = serde_json::Map::new();
    if orchestrator {
        settings.insert(
            "teammateMode".to_string(),
            serde_json::Value::String("in-process".to_string()),
        );
        for event in [
            "SubagentStart",
            "SubagentStop",
            "PreToolUse",
            "PostToolUse",
            "TeammateIdle",
            "TaskCreated",
            "TaskCompleted",
        ] {
            hooks.insert(event.to_string(), hook.clone());
        }
    }
    settings.insert("hooks".to_string(), serde_json::Value::Object(hooks));

    let body = serde_json::to_string_pretty(&serde_json::Value::Object(settings))
        .map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    eprintln!(
        "[agent_events] hooks settings escrito em {}",
        path.display()
    );
    Ok(path.to_string_lossy().to_string())
}

const CODEX_HOOKS_MARK_START: &str = "# alethe-managed-hooks-start";
const CODEX_HOOKS_MARK_END: &str = "# alethe-managed-hooks-end";

fn ps_escape(value: &str) -> String {
    value.replace('\'', "''")
}

fn toml_string(value: &str) -> String {
    toml_edit::Value::from(value).to_string()
}

/// Codex CLI hooks only run `command`/`commandWindows` handlers — there is no built-in http type
/// like Claude Code's. So a tiny PowerShell forwarder is generated per terminal, carrying its own
/// endpoint/token/planner baked in, and piped Codex's hook JSON on stdin.
fn write_codex_hook_forwarder(port: u16, planner_id: &str, safe_planner: &str) -> Result<PathBuf, String> {
    let endpoint = listener_endpoint(port);
    let token = init_token();
    let script = format!(
        "$body = [Console]::In.ReadToEnd()\r\n\
         try {{\r\n\
         \x20\x20Invoke-RestMethod -Uri '{endpoint}/hook' -Method Post -Body $body -ContentType 'application/json' -Headers @{{ 'X-Alethe-Token' = '{token}'; 'X-Alethe-Planner' = '{planner}'; 'X-Alethe-Agent' = 'codex' }} | Out-Null\r\n\
         }} catch {{}}\r\n",
        endpoint = endpoint,
        token = ps_escape(token),
        planner = ps_escape(planner_id),
    );
    let path = std::env::temp_dir().join(format!("alethe-codex-hook-forward-{port}-{safe_planner}.ps1"));
    std::fs::write(&path, script).map_err(|e| format!("write_failed:{e}"))?;
    Ok(path)
}

const CODEX_MCP_MARK_START: &str = "# alethe-managed-mcp-start";
const CODEX_MCP_MARK_END: &str = "# alethe-managed-mcp-end";

/// Codex's MCP client only declares servers via `command`/`args` (stdio), unlike Claude Code's
/// remote `http` support — this script bridges stdin/stdout JSON-RPC to Alethe's `/mcp` endpoint.
fn write_codex_mcp_bridge(port: u16, planner_id: &str, safe_planner: &str) -> Result<PathBuf, String> {
    let endpoint = listener_endpoint(port);
    let token = init_token();
    let script = format!(
        "while ($line = [Console]::In.ReadLine()) {{\r\n\
         \x20\x20if ([string]::IsNullOrWhiteSpace($line)) {{ continue }}\r\n\
         \x20\x20try {{\r\n\
         \x20\x20\x20\x20$resp = Invoke-WebRequest -Uri '{endpoint}/mcp' -Method Post -Body $line -ContentType 'application/json' -Headers @{{ 'X-Alethe-Token' = '{token}'; 'X-Alethe-Planner' = '{planner}' }}\r\n\
         \x20\x20\x20\x20if ($resp.Content) {{\r\n\
         \x20\x20\x20\x20\x20\x20[Console]::Out.WriteLine($resp.Content)\r\n\
         \x20\x20\x20\x20\x20\x20[Console]::Out.Flush()\r\n\
         \x20\x20\x20\x20}}\r\n\
         \x20\x20}} catch {{}}\r\n\
         }}\r\n",
        endpoint = endpoint,
        token = ps_escape(token),
        planner = ps_escape(planner_id),
    );
    let path = std::env::temp_dir().join(format!("alethe-codex-mcp-bridge-{port}-{safe_planner}.ps1"));
    std::fs::write(&path, script).map_err(|e| format!("write_failed:{e}"))?;
    Ok(path)
}

fn codex_mcp_config_write_inner(repo: String, planner_id: String) -> Result<(), String> {
    let port = wait_for_listener_port()
        .ok_or_else(|| "listener de agents ainda nao esta disponivel".to_string())?;
    let safe_planner: String = planner_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let script_path = write_codex_mcp_bridge(port, &planner_id, &safe_planner)?;

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

fn codex_hooks_config_write_inner(repo: String, planner_id: String) -> Result<(), String> {
    let port = wait_for_listener_port()
        .ok_or_else(|| "listener de agents ainda nao esta disponivel".to_string())?;
    let safe_planner: String = planner_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let script_path = write_codex_hook_forwarder(port, &planner_id, &safe_planner)?;

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
        eprintln!("[agent_events] ouvindo em {}", listener_addr(port));

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
                    if let Some(planner) = request
                        .headers()
                        .iter()
                        .find(|h| h.field.equiv("X-Alethe-Planner"))
                        .map(|h| h.value.as_str().to_string())
                    {
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

                    let preview: String = body.chars().take(4000).collect();
                    eprintln!("[agent_events] payload: {preview}");
                    if let Err(e) = app.emit("agent-hook", &payload) {
                        eprintln!("[agent_events] falha ao emitir agent-hook: {e}");
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

    #[test]
    fn toml_string_escapes_windows_paths() {
        let path = r#"C:\Users\kauam\AppData\Local\Temp\alethe-\"bridge\".ps1"#;
        let document = format!("path = {}", toml_string(path))
            .parse::<toml_edit::DocumentMut>()
            .expect("generated path should be valid TOML");

        assert_eq!(document["path"].as_str(), Some(path));
    }
}
