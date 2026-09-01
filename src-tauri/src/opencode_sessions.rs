use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Serialize)]
pub struct OpenCodeSessionSnapshot {
    pub id: String,
    pub modified_at_ms: u128,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OpencodeInvocation {
    Windows {
        program: String,
        args: Vec<String>,
        cwd: String,
    },
    Wsl {
        distro: String,
        argv: Vec<String>,
    },
}

#[cfg(windows)]
const WSL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

struct OpencodeOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// `None` when the CLI is not installed inside the distro of a WSL cwd.
fn opencode_binary(cwd: &str) -> Option<String> {
    match crate::wsl::wsl_target(cwd) {
        Some(target) => crate::wsl::find_cli_in_distro(&target.distro, "opencode"),
        None => Some("opencode".to_string()),
    }
}

#[cfg(windows)]
fn run_in_distro(distro: &str, argv: &[String]) -> std::io::Result<OpencodeOutput> {
    let output = crate::wsl::wsl_output(distro, argv, WSL_TIMEOUT).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::Other, format!("wsl.exe -d {distro}"))
    })?;
    Ok(OpencodeOutput {
        success: output.success,
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

#[cfg(not(windows))]
fn run_in_distro(distro: &str, _argv: &[String]) -> std::io::Result<OpencodeOutput> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        format!("wsl.exe -d {distro}"),
    ))
}

fn run_opencode(cwd: &str, binary: &str, args: &[&str]) -> std::io::Result<OpencodeOutput> {
    match opencode_command_plan(cwd, binary, args) {
        OpencodeInvocation::Windows { program, args, cwd } => {
            let mut command = Command::new(program);
            command.args(&args);
            if !cwd.is_empty() && Path::new(&cwd).is_dir() {
                command.current_dir(crate::worktrees::git_arg(Path::new(&cwd)));
            }
            let output = command.output()?;
            Ok(OpencodeOutput {
                success: output.status.success(),
                stdout: output.stdout,
                stderr: output.stderr,
            })
        }
        OpencodeInvocation::Wsl { distro, argv } => run_in_distro(&distro, &argv),
    }
}

fn session_directory_target(cwd: &str) -> String {
    match crate::wsl::wsl_target(cwd) {
        Some(target) => target.linux_path,
        None => normalize_path(cwd),
    }
}

fn session_directory_matches(cwd: &str, directory: &str) -> bool {
    let target = session_directory_target(cwd);
    if target.is_empty() {
        return true;
    }
    match crate::wsl::wsl_target(cwd) {
        Some(_) => {
            let reported = directory.trim();
            reported.trim_end_matches('/') == target.trim_end_matches('/')
        }
        None => normalize_path(directory) == target,
    }
}

const WSL_CD_SCRIPT: &str = r#"cd "$1" || exit 1; shift; exec "$@""#;

fn wsl_launch_argv(shell: &str, linux_path: &str, binary: &str, args: &[&str]) -> Vec<String> {
    let (program, flags) = crate::wsl::posix_login_shell(shell);
    let mut argv = vec![
        "-e".to_string(),
        program,
        flags.to_string(),
        WSL_CD_SCRIPT.to_string(),
        "sh".to_string(),
        linux_path.to_string(),
        binary.to_string(),
    ];
    argv.extend(args.iter().map(|arg| arg.to_string()));
    argv
}

pub(crate) fn opencode_command_plan(cwd: &str, binary: &str, args: &[&str]) -> OpencodeInvocation {
    if let Some(target) = crate::wsl::wsl_target(cwd) {
        let shell = crate::wsl::distro_login_shell(&target.distro);
        let argv = wsl_launch_argv(&shell, &target.linux_path, binary, args);
        return OpencodeInvocation::Wsl {
            distro: target.distro,
            argv,
        };
    }

    OpencodeInvocation::Windows {
        program: binary.to_string(),
        args: args.iter().map(|arg| arg.to_string()).collect(),
        cwd: cwd.to_string(),
    }
}

fn normalize_path(path: &str) -> String {
    let trimmed = path
        .trim()
        .trim_end_matches(|c: char| c == '\\' || c == '/');
    let unprefixed = trimmed
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .unwrap_or_else(|| trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed).to_string());
    if cfg!(windows) {
        unprefixed.replace('/', "\\").to_ascii_lowercase()
    } else {
        unprefixed
    }
}

/// `async` + `spawn_blocking`: runs a real subprocess, which cannot sit on Tauri's dispatch thread.
#[tauri::command]
pub async fn snapshot_opencode_sessions(
    cwd: String,
) -> Result<Vec<OpenCodeSessionSnapshot>, String> {
    tokio::task::spawn_blocking(move || snapshot_opencode_sessions_inner(cwd))
        .await
        .map_err(|error| format!("snapshot_opencode_sessions: falha na task bloqueante: {error}"))?
}

fn snapshot_opencode_sessions_inner(cwd: String) -> Result<Vec<OpenCodeSessionSnapshot>, String> {
    let Some(binary) = opencode_binary(&cwd) else {
        return Ok(Vec::new());
    };
    let output = run_opencode(
        &cwd,
        &binary,
        &["session", "list", "--format", "json", "--max-count", "50"],
    )
    .map_err(|e| format!("failed to run opencode: {e}"))?;

    if !output.success {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("opencode session list failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }
    let entries: Vec<serde_json::Value> =
        serde_json::from_str(&stdout).map_err(|e| format!("failed to parse JSON: {e}"))?;

    let mut sessions: Vec<OpenCodeSessionSnapshot> = entries
        .into_iter()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?.to_string();
            let updated = entry.get("updated")?.as_f64()? as u128;

            if let Some(directory) = entry.get("directory").and_then(|d| d.as_str()) {
                if !session_directory_matches(&cwd, directory) {
                    return None;
                }
            }
            Some(OpenCodeSessionSnapshot {
                id,
                modified_at_ms: updated,
            })
        })
        .collect();

    sessions.sort_by(|a, b| b.modified_at_ms.cmp(&a.modified_at_ms));
    Ok(sessions)
}

/// Exports a session's structured history (messages, tool calls, file
/// patches) via `opencode export <sessionID>` — returned as opaque JSON for
/// the frontend to interpret, without trying to model every possible `part`
/// in Rust (the schema currently has several `type`s — `text`, `reasoning`,
/// `tool`, `patch`, `step-start`, `step-finish` — and will likely gain more
/// over time; a passthrough tolerates that without breaking).
///
/// Used to render the GSD Sync child session as a read-only activity feed
/// (no PTY terminal in the path) — see `useGsdSyncSessionsWatcher` in the
/// frontend.
///
/// `async` + `spawn_blocking`: same reason as `snapshot_opencode_sessions`
/// (a real subprocess, can't run on Tauri's dispatch thread).
#[tauri::command]
pub async fn opencode_export_session(
    cwd: String,
    session_id: String,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || opencode_export_session_inner(cwd, session_id))
        .await
        .map_err(|error| format!("opencode_export_session: blocking task failed: {error}"))?
}

fn opencode_export_session_inner(
    cwd: String,
    session_id: String,
) -> Result<serde_json::Value, String> {
    if session_id.is_empty() {
        return Err("session_id empty".to_string());
    }
    let binary = opencode_binary(&cwd)
        .ok_or_else(|| "failed to run opencode: not installed in the distro".to_string())?;
    let output = run_opencode(&cwd, &binary, &["export", &session_id])
        .map_err(|e| format!("failed to run opencode: {e}"))?;

    if !output.success {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("opencode export failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // The CLI prints a status line ("Exporting session: <id>") BEFORE the
    // actual JSON on stdout — confirmed live by running the command. Skip to
    // the first `{` instead of assuming the whole stdout is JSON.
    let json_start = stdout
        .find('{')
        .ok_or_else(|| "opencode export did not return JSON".to_string())?;
    serde_json::from_str(&stdout[json_start..]).map_err(|e| format!("failed to parse JSON: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_windows_cwd_runs_the_binary_directly_in_that_directory() {
        let plan = opencode_command_plan(
            r"C:\projects\app",
            "opencode",
            &["session", "list", "--format", "json"],
        );
        assert_eq!(
            plan,
            OpencodeInvocation::Windows {
                program: "opencode".to_string(),
                args: vec![
                    "session".to_string(),
                    "list".to_string(),
                    "--format".to_string(),
                    "json".to_string(),
                ],
                cwd: r"C:\projects\app".to_string(),
            }
        );
    }

    #[test]
    fn a_wsl_cwd_runs_the_guest_binary_through_wsl_exe_with_the_guest_directory() {
        let plan = opencode_command_plan(
            r"\\wsl.localhost\Ubuntu\home\dev\projects\app",
            "/home/dev/.opencode/bin/opencode",
            &["export", "ses one"],
        );
        let OpencodeInvocation::Wsl { distro, argv } = plan else {
            panic!("a WSL cwd must not produce a Windows invocation");
        };
        assert_eq!(distro, "Ubuntu");
        assert_eq!(argv[0], "-e");
        assert_eq!(argv[1], "/bin/sh");
        assert!(!argv.iter().any(|arg| arg == "-d"));
        for element in [
            "/home/dev/projects/app",
            "/home/dev/.opencode/bin/opencode",
            "export",
            "ses one",
        ] {
            assert!(
                argv.iter().any(|arg| arg == element),
                "{element} must survive as one argv element"
            );
        }
    }

    #[test]
    fn the_guest_binary_runs_through_the_login_shell_like_the_terminal_does() {
        assert_eq!(
            wsl_launch_argv(
                "/usr/bin/zsh",
                "/home/dev/projects/app",
                "/home/dev/.npm-global/bin/opencode",
                &["export", "ses one"],
            ),
            vec![
                "-e",
                "/usr/bin/zsh",
                "-lic",
                r#"cd "$1" || exit 1; shift; exec "$@""#,
                "sh",
                "/home/dev/projects/app",
                "/home/dev/.npm-global/bin/opencode",
                "export",
                "ses one",
            ]
        );
        let fish = wsl_launch_argv("/usr/bin/fish", "/home/dev", "/usr/bin/opencode", &[]);
        assert_eq!(fish[1], "/bin/sh");
        assert_eq!(fish[2], "-lc");
    }

    #[test]
    fn a_wsl_cwd_is_matched_against_the_guest_directory_the_cli_reports() {
        assert_eq!(
            session_directory_target(r"\\wsl.localhost\Ubuntu\home\dev\projects\app\"),
            "/home/dev/projects/app"
        );
        assert_eq!(
            session_directory_target(r"c:\projects\app\"),
            r"c:\projects\app"
        );
        assert_eq!(session_directory_target(""), "");
    }

    #[test]
    fn a_wsl_session_matches_only_the_guest_directory_it_was_started_in() {
        let cwd = r"\\wsl.localhost\Ubuntu\home\dev\projects\app";
        assert!(session_directory_matches(cwd, "/home/dev/projects/app"));
        assert!(session_directory_matches(cwd, "/home/dev/projects/app/"));
        assert!(!session_directory_matches(cwd, "/home/dev/projects/acme"));
        assert!(session_directory_matches(
            r"c:\projects\app",
            r"c:\projects\app"
        ));
        assert!(session_directory_matches("", "/home/dev/projects/acme"));
    }
}
