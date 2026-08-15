use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use crate::cli_resolver;

#[derive(Debug, Serialize, Clone)]
pub struct CodexUsageWindow {
    pub used_percent: f64,
    pub window_minutes: u64,
    /// Epoch em **milissegundos** (0 = desconhecido). O front faz `resets_at_ms - Date.now()`.
    pub resets_at_ms: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct CodexUsage {
    pub primary: CodexUsageWindow,

    pub secondary: CodexUsageWindow,
    /// Plano da conta ("plus", "pro", ...). Vazio se desconhecido.
    pub plan: String,

    pub rate_limited: bool,

    pub reset_credits: u64,
}

fn resolve_codex() -> Option<std::path::PathBuf> {
    let path = cli_resolver::rebuilt_path();
    let cwd = std::env::current_dir().unwrap_or_default();
    which::which_in("codex", Some(&path), &cwd).ok()
}

fn parse_window(value: Option<&serde_json::Value>) -> CodexUsageWindow {
    let default = CodexUsageWindow {
        used_percent: 0.0,
        window_minutes: 0,
        resets_at_ms: 0.0,
    };
    let Some(obj) = value else {
        return default;
    };
    if obj.is_null() {
        return default;
    }
    let used_percent = obj
        .get("usedPercent")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let window_minutes = obj
        .get("windowDurationMins")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let resets_at_ms = obj
        .get("resetsAt")
        .and_then(|v| v.as_f64())
        .map(|secs| secs * 1000.0)
        .unwrap_or(0.0);
    CodexUsageWindow {
        used_percent,
        window_minutes,
        resets_at_ms,
    }
}

/// Bloqueante — chamado via `spawn_blocking`.
fn fetch_usage() -> Result<CodexUsage, String> {
    let exe = resolve_codex().ok_or_else(|| "codex_not_found".to_string())?;

    let mut command = Command::new(exe);
    command
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    crate::git_control::hide_console(&mut command);

    let mut child = command.spawn().map_err(|e| format!("spawn failed: {e}"))?;

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    let requests = concat!(
        r#"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"alethe","version":"1.2.0"}}}"#,
        "\n",
        r#"{"method":"initialized"}"#,
        "\n",
        r#"{"id":2,"method":"account/rateLimits/read"}"#,
        "\n",
    );
    stdin
        .write_all(requests.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("flush failed: {e}"))?;

    let (tx, rx) = mpsc::channel();
    let reader_handle = thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if value.get("id").and_then(|v| v.as_i64()) == Some(2) {
                let _ = tx.send(value);
                break;
            }
        }
    });

    let received = rx.recv_timeout(Duration::from_secs(12));

    let _ = child.kill();
    let _ = child.wait();
    drop(stdin);
    let _ = reader_handle.join();

    let message = received.map_err(|_| "timeout".to_string())?;

    if let Some(err) = message.get("error") {
        return Err(format!("rpc error: {err}"));
    }

    let result = message.get("result").ok_or("no result")?;
    let rate_limits = result
        .get("rateLimits")
        .filter(|v| !v.is_null())
        .ok_or("no rate limits")?;

    let plan = rate_limits
        .get("planType")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let rate_limited = rate_limits
        .get("rateLimitReachedType")
        .map(|v| !v.is_null())
        .unwrap_or(false);
    let reset_credits = result
        .get("rateLimitResetCredits")
        .and_then(|v| v.get("availableCount"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    Ok(CodexUsage {
        primary: parse_window(rate_limits.get("primary")),
        secondary: parse_window(rate_limits.get("secondary")),
        plan,
        rate_limited,
        reset_credits,
    })
}

#[tauri::command]
pub async fn get_codex_usage() -> Result<CodexUsage, String> {
    tokio::task::spawn_blocking(fetch_usage)
        .await
        .map_err(|e| format!("join error: {e}"))?
}
