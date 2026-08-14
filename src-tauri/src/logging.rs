// Logging de crash (Rust) e de erros do frontend.
//
// Grava na RAIZ dos dados do app (`app_local_data_dir()/logs/`), NÃO no diretório
// do perfil — um panic pode ocorrer antes de o perfil ser resolvido. Crash logs do
// Rust saem do panic hook, que não tem `AppHandle`, então o diretório é guardado
// num `OnceLock` populado no `.setup()`. O hook é instalado cedo (antes do builder):
// se um panic ocorrer antes do setup, o `OnceLock` está vazio e o hook só repassa
// pro hook anterior (stderr), sem gravar.

use std::fs;
use std::io::Write;
use std::panic;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use crate::diagnostics::timestamp_ms;

/// Quantos arquivos manter por prefixo (`crash-`, `frontend-`) — retenção simples.
const MAX_FILES_PER_PREFIX: usize = 20;

static LOGS_DIR: OnceLock<PathBuf> = OnceLock::new();

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `app_local_data_dir()/logs` — raiz, compartilhada por todos os perfis.
pub fn logs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(root.join("logs"))
}

/// Resolve e memoiza o diretório de logs pro panic hook. Chamar no `.setup()`.
pub fn set_logs_dir(app: &AppHandle) {
    if let Ok(dir) = logs_dir(app) {
        let _ = fs::create_dir_all(&dir);
        let _ = LOGS_DIR.set(dir);
    }
}

/// Append com timestamp, criando o dir se preciso. Reusa o padrão de
/// `diagnostics::append_spawn_log` (append-only, sem rewrite).
fn append_log(path: &Path, message: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{}] {message}", timestamp_ms());
    }
}

/// Mantém só os `MAX_FILES_PER_PREFIX` arquivos mais novos com o prefixo dado.
/// Os nomes incluem unix secs, então a ordem lexicográfica acompanha a cronológica.
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

/// Instala o panic hook global. Chamar uma vez, cedo no `run()`, antes do builder.
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
        // Preserva o comportamento padrão (stderr) encadeando o hook anterior.
        previous(info);
    }));
}

/// Persiste um erro vindo do frontend (window.onerror / unhandledrejection /
/// ErrorBoundary). Fire-and-forget — nunca falha de um jeito que quebre a UI.
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
