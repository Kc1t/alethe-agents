//! Standalone stdio build of Alethe's orchestrator MCP server.
//!
//! Runs the same core the desktop app hosts over HTTP, so any MCP client can delegate to Codex
//! workers without Alethe being open. The core is compiled in directly rather than linked from
//! `alethe_lib`, which keeps this binary free of the GUI stack.
//!
//! Environment:
//!   ALETHE_CODEX   path to the codex launcher, otherwise resolved from PATH
//!   ALETHE_MAX_WORKERS  how many workers may run at once, default 4

#[path = "../orchestrator_core.rs"]
mod orchestrator_core;

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::Command;

use orchestrator_core::{handle_mcp_body, Core, Launcher};

fn resolve_codex() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("ALETHE_CODEX") {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return Some(path);
        }
    }
    let finder = if cfg!(windows) { "where" } else { "which" };
    let output = Command::new(finder).arg("codex").output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut candidates = text.lines().map(str::trim).filter(|line| !line.is_empty());
    if cfg!(windows) {
        candidates
            .clone()
            .find(|line| line.to_ascii_lowercase().ends_with(".cmd"))
            .or_else(|| candidates.next())
            .map(PathBuf::from)
    } else {
        candidates.next().map(PathBuf::from)
    }
}

fn main() {
    let core = Core::default();

    match resolve_codex() {
        Some(program) => core.set_launcher(Launcher::codex_app_server(program)),
        None => eprintln!("[alethe-orchestrator] codex not found on PATH; delegation will fail"),
    }

    if let Some(limit) = std::env::var("ALETHE_MAX_WORKERS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
    {
        core.set_concurrency_limit(limit);
    }

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_mcp_body(&core, &line) {
            if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
                break;
            }
        }
    }
}
