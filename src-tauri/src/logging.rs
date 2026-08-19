// Logging de crash (Rust) e de erros do frontend.
//

use std::fs;
use std::io::Write;
use std::panic;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use crate::diagnostics::timestamp_ms;
use crate::resources::RuntimeSnapshot;

const MAX_FILES_PER_PREFIX: usize = 20;

static LOGS_DIR: OnceLock<PathBuf> = OnceLock::new();

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn logs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(root.join("logs"))
}

pub fn set_logs_dir(app: &AppHandle) {
    if let Ok(dir) = logs_dir(app) {
        let _ = fs::create_dir_all(&dir);
        let _ = LOGS_DIR.set(dir);
    }
}

fn append_log(path: &Path, message: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{}] {message}", timestamp_ms());
    }
}

/// Records periodic resource health without changing runtime state. This log is
/// intentionally concise so freezes can be compared with Windows availability
/// and the exact PTY count after the next launch.
pub fn record_resource_snapshot(
    app: &AppHandle,
    level: &str,
    snapshot: &RuntimeSnapshot,
    idle_candidates: usize,
    action: &str,
) {
    let Ok(dir) = logs_dir(app) else {
        return;
    };
    let memory = &snapshot.memory;
    append_log(
        &dir.join("resource.log"),
        &format!(
            "level={level} action={action} app_total_mb={:.0} app_mb={:.0} webview_mb={:.0} ptys_mb={:.0} windows_available_mb={:.0} windows_total_mb={:.0} processes={} live_ptys={} idle_recommendations={idle_candidates}",
            snapshot.effective_total_mb,
            memory.app_mb,
            memory.webview_mb,
            memory.ptys_mb,
            memory.system_available_mb,
            memory.system_total_mb,
            memory.process_count,
            snapshot.ptys.len(),
        ),
    );
}

fn prune(dir: &Path, prefix: &str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(prefix))
                .unwrap_or(false)
        })
        .collect();
    if files.len() <= MAX_FILES_PER_PREFIX {
        return;
    }
    files.sort();
    let remove_count = files.len() - MAX_FILES_PER_PREFIX;
    for path in files.into_iter().take(remove_count) {
        let _ = fs::remove_file(path);
    }
}

pub fn install_panic_hook() {
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        if let Some(dir) = LOGS_DIR.get() {
            let path = dir.join(format!("crash-{}.log", unix_secs()));
            let location = info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_else(|| "<unknown>".to_string());
            let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
                (*s).to_string()
            } else if let Some(s) = info.payload().downcast_ref::<String>() {
                s.clone()
            } else {
                "<non-string panic payload>".to_string()
            };
            let thread = std::thread::current()
                .name()
                .unwrap_or("<unnamed>")
                .to_string();
            let backtrace = std::backtrace::Backtrace::force_capture();
            let msg = format!(
                "PANIC v{} thread={thread} at {location}\n{payload}\nbacktrace:\n{backtrace}",
                env!("CARGO_PKG_VERSION"),
            );
            append_log(&path, &msg);
            prune(dir, "crash-");
        }

        previous(info);
    }));
}

/// Persiste um erro vindo do frontend (window.onerror / unhandledrejection /

#[tauri::command]
pub fn record_frontend_error(
    message: String,
    stack: Option<String>,
    kind: String,
) -> Result<(), String> {
    let Some(dir) = LOGS_DIR.get() else {
        return Ok(());
    };
    let path = dir.join(format!("frontend-{}.log", unix_secs()));
    let body = match stack {
        Some(s) if !s.trim().is_empty() => format!("[{kind}] {message}\n{s}"),
        _ => format!("[{kind}] {message}"),
    };
    append_log(&path, &body);
    prune(dir, "frontend-");
    Ok(())
}

/// Records non-sensitive lifecycle facts used to diagnose persistence and UI
/// restoration. Callers must send counts/flags only, never project names or paths.
#[tauri::command]
pub fn record_app_event(kind: String, message: String) -> Result<(), String> {
    let Some(dir) = LOGS_DIR.get() else {
        return Ok(());
    };
    let safe_kind: String = kind
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
        .take(64)
        .collect();
    let safe_message = message.replace('\r', " ").replace('\n', " ");
    append_log(
        &dir.join("app-events.log"),
        &format!(
            "[{}] {}",
            safe_kind,
            safe_message.chars().take(512).collect::<String>()
        ),
    );
    Ok(())
}
