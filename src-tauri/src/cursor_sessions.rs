use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::cli_resolver::{find_windows_cli_launcher, rebuilt_path};

/// A pane waits on this before it can spawn, so a CLI that never answers has to lose the race
/// rather than hold the terminal open forever.
const CREATE_TIMEOUT: Duration = Duration::from_secs(15);

/// Only ever set to true: a session that starts signed out keeps asking, while one that has
/// already seen credentials never pays for the check again.
static SIGNED_IN: AtomicBool = AtomicBool::new(false);

/// A chat ID as `create-chat` prints it: an opaque hex token, with or without UUID dashes. Loose
/// on length and strict on the alphabet on purpose — the value ends up as a spawn argument, so a
/// banner line, a flag, or an error message must never pass for one.
fn is_chat_id(value: &str) -> bool {
    (16..=64).contains(&value.len())
        && value.starts_with(|c: char| c.is_ascii_hexdigit())
        && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Last line the CLI printed, which is where `create-chat` puts the ID it just made.
fn extract_chat_id(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| is_chat_id(line))
        .map(str::to_string)
}

/// Creates an empty Cursor chat and returns its ID, so the pane can attach to the same
/// conversation on every relaunch through `cursor-agent --resume <id>`.
#[tauri::command]
pub async fn create_cursor_chat(cwd: String) -> Result<String, String> {
    let task = tokio::task::spawn_blocking(move || create_cursor_chat_inner(cwd));
    match tokio::time::timeout(CREATE_TIMEOUT, task).await {
        Ok(joined) => joined.map_err(|error| format!("create_cursor_chat:{error}"))?,
        Err(_) => Err("cursor-agent create-chat timed out".to_string()),
    }
}

/// A `cursor-agent` process with the app's rebuilt PATH, run from `cwd` when there is one.
fn cursor_command(launcher: &Path, arg: &str, cwd: &str) -> Command {
    let mut command = Command::new(launcher);
    command.arg(arg);
    command.env("PATH", rebuilt_path());
    if !cwd.is_empty() && Path::new(cwd).is_dir() {
        command.current_dir(crate::worktrees::git_arg(Path::new(cwd)));
    }
    crate::git_control::hide_console(&mut command);
    command
}

/// Whether the CLI has credentials. Worth a whole extra process because `create-chat` does not
/// fail without them — it sits there waiting for a login that will never come on a piped stdin,
/// and a pane cannot wait that out. `status` answers in about a second either way.
fn signed_in(launcher: &Path, cwd: &str) -> bool {
    if SIGNED_IN.load(Ordering::Relaxed) {
        return true;
    }
    let Ok(output) = cursor_command(launcher, "status", cwd).output() else {
        return false;
    };
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
    .to_lowercase();
    // "✓ Logged in as <email>" against "Not logged in".
    let ok = !text.contains("not logged in") && !text.contains("not signed in");
    if ok {
        SIGNED_IN.store(true, Ordering::Relaxed);
    }
    ok
}

fn create_cursor_chat_inner(cwd: String) -> Result<String, String> {
    let launcher = find_windows_cli_launcher("cursor-agent")
        .ok_or_else(|| "cursor-agent not found".to_string())?;

    if !signed_in(&launcher, &cwd) {
        return Err("cursor-agent is not signed in".to_string());
    }

    let output = cursor_command(&launcher, "create-chat", &cwd)
        .output()
        .map_err(|error| format!("cursor-agent create-chat failed to run: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("cursor-agent create-chat failed: {}", stderr.trim()));
    }

    extract_chat_id(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| "cursor-agent create-chat returned no chat id".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_id_out_of_a_noisy_stdout() {
        let stdout = "Creating chat...\n\n8f1d4c2a-6b7e-4a19-9c30-2f5ab8d17e04\n";
        assert_eq!(
            extract_chat_id(stdout).as_deref(),
            Some("8f1d4c2a-6b7e-4a19-9c30-2f5ab8d17e04")
        );
    }

    #[test]
    fn accepts_a_dashless_hex_id() {
        assert_eq!(
            extract_chat_id("0a0009211687cf0429b1d3e8f7c25a61\n").as_deref(),
            Some("0a0009211687cf0429b1d3e8f7c25a61")
        );
    }

    #[test]
    fn refuses_anything_that_is_not_a_chat_id() {
        assert!(extract_chat_id("not logged in\n").is_none());
        assert!(extract_chat_id("").is_none());
        // A flag must never be mistaken for an ID: it would end up as a spawn argument.
        assert!(extract_chat_id("--resume\n").is_none());
        assert!(extract_chat_id("abc123\n").is_none());
    }
}
