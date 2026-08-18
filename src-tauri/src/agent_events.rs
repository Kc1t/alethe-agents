// Listener da POC do canvas de subagents (Fase 1).
//
// O Claude Code dispara hooks `SubagentStart`/`SubagentStop` como POST HTTP

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 9123;
const MAX_PORT: u16 = 9143;
const BODY_LIMIT: u64 = 1024 * 1024; // 1 MB
static LISTENER_PORT: AtomicU16 = AtomicU16::new(0);
static LISTENER_TOKEN: OnceLock<String> = OnceLock::new();
static SETTINGS_FILE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn init_token() -> &'static str {
    LISTENER_TOKEN.get_or_init(|| nanoid::nanoid!(32))
}

fn check_token(request: &tiny_http::Request) -> bool {
    let expected = init_token();
    request
        .headers()
        .iter()
        .any(|h| h.field.as_str() == "X-Alethe-Token" && h.value.as_str() == expected)
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

fn settings_file_state() -> &'static Mutex<Option<PathBuf>> {
    SETTINGS_FILE.get_or_init(|| Mutex::new(None))
}

fn hook_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(unix)]
    if let Some(runtime_dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        let runtime_dir = PathBuf::from(runtime_dir);
        if runtime_dir.is_absolute() {
            return Ok(runtime_dir.join("alethe"));
        }
    }

    app.path()
        .app_cache_dir()
        .map(|path| path.join("runtime"))
        .map_err(|error| error.to_string())
}

fn ensure_private_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|error| error.to_string())?;
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("agent hook runtime path is not a private directory".to_string());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn new_settings_path(directory: &Path) -> PathBuf {
    directory.join(format!("alethe-agent-hooks-{}.json", nanoid::nanoid!(12)))
}

fn is_private_settings_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return false;
        }
    }

    true
}

fn write_private_file(path: &Path, body: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "agent hook settings path has no parent".to_string())?;
    ensure_private_dir(parent)?;
    let temporary = parent.join(format!(".alethe-agent-hooks-{}.tmp", nanoid::nanoid!(12)));

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let write_result = (|| -> Result<(), String> {
        let mut file = options
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(body).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    write_result
}

pub fn cleanup_settings_file() {
    let Ok(mut current) = settings_file_state().lock() else {
        return;
    };
    let Some(path) = current.take() else {
        return;
    };
    let _ = std::fs::remove_file(&path);
    if let Some(parent) = path.parent() {
        let _ = std::fs::remove_dir(parent);
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
pub fn agent_hooks_settings_path(app: AppHandle) -> Result<String, String> {
    let port = wait_for_listener_port()
        .ok_or_else(|| "listener de agents ainda nao esta disponivel".to_string())?;
    let endpoint = listener_endpoint(port);
    let token = init_token();
    let hook = serde_json::json!([
        { "hooks": [ {
            "type": "http",
            "url": format!("{endpoint}/hook"),
            "timeout": 5,
            "headers": { "X-Alethe-Token": token }
        } ] }
    ]);
    let settings = serde_json::json!({


        "teammateMode": "in-process",
        "hooks": {
            "SubagentStart": hook.clone(),
            "SubagentStop": hook.clone(),
            // Fase 2: tool calls em tempo real. PreToolUse dentro de subagent

            "PreToolUse": hook.clone(),
            "PostToolUse": hook.clone(),


            "TeammateIdle": hook.clone(),
            "TaskCreated": hook.clone(),
            "TaskCompleted": hook
        }
    });
    let body = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;

    let mut current = settings_file_state()
        .lock()
        .map_err(|_| "agent hook settings lock poisoned".to_string())?;
    if let Some(path) = current.as_ref() {
        if is_private_settings_file(path) {
            return Ok(path.to_string_lossy().into_owned());
        }
        let _ = std::fs::remove_file(path);
        *current = None;
    }

    let directory = hook_runtime_dir(&app)?;
    let path = new_settings_path(&directory);
    write_private_file(&path, body.as_bytes())?;
    *current = Some(path.clone());
    Ok(path.to_string_lossy().into_owned())
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

            if request.method() != &tiny_http::Method::Post {
                let _ = request.respond(tiny_http::Response::empty(405));
                continue;
            }

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

            if url == "/spawn" {
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
            if url == "/codex" {
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
            if url == "/opencode-status" {
                match serde_json::from_str::<serde_json::Value>(&body) {
                    Ok(payload) => {
                        let _ = app.emit("opencode-bridge-status", &payload);
                    }
                    Err(e) => eprintln!("[agent_events] /opencode-status payload inválido: {e}"),
                }
                let _ = request.respond(tiny_http::Response::empty(200));
                continue;
            }

            if url != "/hook" {
                let _ = request.respond(tiny_http::Response::empty(404));
                continue;
            }

            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(payload) => {
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
    use super::*;

    fn test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("alethe-agent-hooks-{label}-{}", nanoid::nanoid!(8)))
    }

    #[test]
    fn settings_paths_are_session_specific() {
        let directory = test_dir("paths");
        assert_ne!(new_settings_path(&directory), new_settings_path(&directory));
    }

    #[test]
    fn writes_private_settings() {
        let directory = test_dir("permissions");
        let path = new_settings_path(&directory);
        write_private_file(&path, br#"{"hooks":{}}"#).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), br#"{"hooks":{}}"#);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&directory).unwrap();
    }
}
