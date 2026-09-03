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

/// The log directory for an already-resolved data root.
///
/// Split out from [`logs_dir`] because the standalone `alethe-server` binary has no `AppHandle` at
/// all, and every logging entry point used to require one — so the Web runtime could not write a
/// single diagnostic line. Both runtimes now resolve their own root and call this.
pub fn logs_dir_at(data_root: &Path) -> PathBuf {
    data_root.join("logs")
}

pub fn logs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(logs_dir_at(&root))
}

/// Registers the log directory and reports whether it is actually usable.
///
/// The old version discarded both the resolution error and the `create_dir_all` failure, so a
/// profile directory that could not be created produced an app with **no diagnostics at all**, and
/// the resulting empty log read exactly like "that code path never ran". Every other fix in this
/// area depends on this one: without it, no other logging change can be confirmed.
pub fn set_logs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = logs_dir(app)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create {}: {error}", dir.display()))?;
    let _ = LOGS_DIR.set(dir.clone());
    Ok(dir)
}

/// Same, for a runtime that resolved its data root itself (the standalone server).
pub fn set_logs_dir_at(data_root: &Path) -> Result<PathBuf, String> {
    let dir = logs_dir_at(data_root);
    fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create {}: {error}", dir.display()))?;
    let _ = LOGS_DIR.set(dir.clone());
    Ok(dir)
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

static TRACE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// `logs/` at the process working directory (repo root under `tauri dev`), kept
/// separate from the per-profile `LOGS_DIR` so it stays trivial to `tail -f`
/// alongside the terminal during a live cross-device debugging session.
fn trace_dir() -> &'static PathBuf {
    TRACE_DIR.get_or_init(|| {
        // Under `tauri dev` the Rust process runs with its working directory at `src-tauri/`, so
        // resolving `logs/` naively puts it beside the crate instead of at the repo root next to
        // the terminal log that `npm run app:logs` writes. Step out one level in that case so both
        // logs always land in the same folder.
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let root = if cwd.file_name().is_some_and(|name| name == "src-tauri") {
            cwd.parent().map(PathBuf::from).unwrap_or(cwd)
        } else {
            cwd
        };
        let dir = root.join("logs");
        let _ = fs::create_dir_all(&dir);
        dir
    })
}

/// Mirrors a devtools console call (log/info/warn/error/debug) to `logs/frontend.log` and into the
/// unified decision stream. Installed by `src/lib/debugTrace.ts` on every console call without
/// replacing the original devtools output.
///
/// `corr` is the correlation id of the UI gesture the line belongs to. It is what lets a frontend
/// line and the backend records it caused end up on **one** timeline: previously the two lived in
/// separate files written by separate processes with no shared key, so "the UI says it sent it, did
/// the socket ever see it?" could not be answered by reading either one.
#[tauri::command]
pub fn record_console_log(
    level: String,
    message: String,
    corr: Option<String>,
) -> Result<(), String> {
    append_log(
        &trace_dir().join("frontend.log"),
        &format!("[{level}] {message}"),
    );
    record_ui_line(&level, &message, corr.as_deref());
    Ok(())
}

/// Feeds one frontend console line into the same stream the backend writes to.
pub fn record_ui_line(level: &str, message: &str, corr: Option<&str>) {
    let corr = corr.unwrap_or("");
    // The console level decides severity, so an `ALETHE_LOG=warn` run still shows frontend errors.
    match level {
        "error" => tracing::warn!(target: "alethe.ui", corr, message),
        "warn" => tracing::info!(target: "alethe.ui", corr, message),
        _ => tracing::debug!(target: "alethe.ui", corr, message),
    }
}

/// Reports, once at startup, whether the platform services this app depends on are actually
/// reachable here. These differ per OS and previously failed *silently*: on Linux the credential
/// store is a D-Bus Secret Service (gnome-keyring/KWallet) that simply is not there in some
/// sessions, and every device key read then fails with an opaque error far away from the cause.
/// Writing the verdict at startup means a later failure can be explained by a line that was already
/// captured, instead of needing the whole session reproduced.
pub fn record_platform_readiness() {
    let credential_store = match keyring::Entry::new("com.kc1t.alethe.probe", "startup-probe") {
        // `NoEntry` is the expected, healthy answer: the store answered, it just holds nothing
        // under this name. Anything else means the store itself could not be reached.
        Ok(entry) => match entry.get_secret() {
            Ok(_) => "reachable".to_string(),
            Err(keyring::Error::NoEntry) => "reachable".to_string(),
            Err(cause) => format!("UNAVAILABLE ({cause})"),
        },
        Err(cause) => format!("UNAVAILABLE ({cause})"),
    };
    let message = format!(
        "os={} arch={} credential_store={credential_store}",
        std::env::consts::OS,
        std::env::consts::ARCH,
    );
    eprintln!("[platform] {message}");
    append_log(&trace_dir().join("frontend.log"), &format!("[platform] {message}"));
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
