// polling do XTermView continua resolvendo — nada quebra.

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::sync::mpsc::channel;
use tauri::{AppHandle, Emitter};

pub fn start_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let (tx, rx) = channel();
        let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[session_watcher] falha criando watcher: {e}");
                return;
            }
        };

        let claude = crate::claude_sessions::claude_projects_dir();
        let codex = crate::codex_sessions::codex_sessions_dir();

        let mut watching = false;
        if let Some(p) = &claude {
            if p.is_dir() && watcher.watch(p, RecursiveMode::Recursive).is_ok() {
                watching = true;
            }
        }
        if let Some(p) = &codex {
            if p.is_dir() && watcher.watch(p, RecursiveMode::Recursive).is_ok() {
                watching = true;
            }
        }
        if !watching {
            eprintln!("[session_watcher] nenhum dir de sessão pra observar (fallback: polling)");
            return;
        }
        eprintln!("[session_watcher] observando sessões");

        for res in rx {
            let Ok(event) = res else { continue };
            if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                continue;
            }
            for path in event.paths {
                if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                    continue;
                }
                let agent = if claude.as_ref().is_some_and(|c| path.starts_with(c)) {
                    "claude"
                } else if codex.as_ref().is_some_and(|c| path.starts_with(c)) {
                    "codex"
                } else {
                    continue;
                };
                let _ = app.emit("session://new", serde_json::json!({ "agent": agent }));
            }
        }
    });
}
