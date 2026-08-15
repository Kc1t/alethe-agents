use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use tauri::{AppHandle, Emitter, State};

use crate::cli_resolver;

pub struct CodexAppServerState {
    sessions: Mutex<HashMap<String, CodexAppServerProcess>>,
}

impl Default for CodexAppServerState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

struct CodexAppServerProcess {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
}

fn event_name(id: &str) -> String {
    format!("agent-sandbox-app-server://event/{id}")
}

fn send_value(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) -> Result<(), String> {
    let mut stdin = stdin.lock().map_err(|_| "app-server stdin lock poisoned")?;
    serde_json::to_writer(&mut *stdin, value).map_err(|error| error.to_string())?;
    stdin.write_all(b"\n").map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

fn stop_process(
    sessions: &Mutex<HashMap<String, CodexAppServerProcess>>,
    id: &str,
) -> Result<(), String> {
    let session = sessions
        .lock()
        .map_err(|_| "app-server state lock poisoned")?
        .remove(id);
    if let Some(session) = session {
        let mut child = session
            .child
            .lock()
            .map_err(|_| "app-server child lock poisoned")?;
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn codex_app_server_start(
    app: AppHandle,
    state: State<'_, CodexAppServerState>,
    id: String,
    cwd: String,
) -> Result<(), String> {
    stop_process(&state.sessions, &id)?;

    let launcher = cli_resolver::find_windows_cli_launcher("codex")
        .ok_or_else(|| "codex_not_found".to_string())?;
    let mut command = std::process::Command::new(&launcher);
    command
        .arg("app-server")
        .arg("--stdio")
        .current_dir(PathBuf::from(&cwd))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    command.env("Path", cli_resolver::rebuilt_path());

    crate::git_control::hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("codex app-server spawn failed: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "codex app-server stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "codex app-server stdout unavailable".to_string())?;
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    let stdin = Arc::new(Mutex::new(stdin));

    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "app-server state lock poisoned")?;
        sessions.insert(
            id.clone(),
            CodexAppServerProcess {
                child: Arc::clone(&child),
                stdin: Arc::clone(&stdin),
            },
        );
    }

    let event = event_name(&id);
    let reader_app = app.clone();
    let reader_event = event.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) if !line.trim().is_empty() => {
                    let payload = serde_json::from_str::<Value>(&line)
                        .unwrap_or_else(|_| json!({ "type": "raw", "data": line }));
                    let _ = reader_app.emit(&reader_event, payload);
                }
                Ok(_) => {}
                Err(error) => {
                    let _ = reader_app.emit(
                        &reader_event,
                        json!({ "type": "transport_error", "message": error.to_string() }),
                    );
                    break;
                }
            }
        }
        let _ = reader_app.emit(&reader_event, json!({ "type": "transport_closed" }));
    });

    if let Some(stderr) = stderr {
        let stderr_app = app.clone();
        let stderr_event = event.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    let _ = stderr_app
                        .emit(&stderr_event, json!({ "type": "stderr", "message": line }));
                }
            }
        });
    }

    send_value(
        &stdin,
        &json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "alethe-agent-sandbox",
                    "title": "Alethe Agent Sandbox",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
    )?;
    send_value(&stdin, &json!({ "method": "initialized" }))
}

#[tauri::command]
pub fn codex_app_server_send(
    state: State<'_, CodexAppServerState>,
    id: String,
    request: Value,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "app-server state lock poisoned")?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| "codex app-server session not found".to_string())?;
    send_value(&session.stdin, &request)
}

#[tauri::command]
pub fn codex_app_server_stop(
    state: State<'_, CodexAppServerState>,
    id: String,
) -> Result<(), String> {
    stop_process(&state.sessions, &id)
}
