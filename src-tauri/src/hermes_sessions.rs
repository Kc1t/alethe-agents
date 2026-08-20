use crate::provider_common::normalize_cwd;

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_ACTIVE_SESSION_FILE_BYTES: u64 = 4 * 1024;

#[derive(Debug, PartialEq, Serialize)]
pub struct HermesSessionSnapshot {
    pub id: String,
    pub cwd: String,
    pub started_at_ms: u64,
    pub modified_at_ms: u64,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct HermesChildActiveSession {
    pub kind: String,
    pub session_id: String,
    pub changed_at_ms: u64,
}

#[derive(Deserialize)]
struct HermesActiveSessionFile {
    session_id: String,
}

fn valid_session_id(value: &str) -> bool {
    let mut parts = value.split('_');
    let Some(date) = parts.next() else {
        return false;
    };
    let Some(time) = parts.next() else {
        return false;
    };
    let Some(suffix) = parts.next() else {
        return false;
    };
    parts.next().is_none()
        && date.len() == 8
        && date.bytes().all(|byte| byte.is_ascii_digit())
        && time.len() == 6
        && time.bytes().all(|byte| byte.is_ascii_digit())
        && !suffix.is_empty()
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn parse_child_active_session_file(contents: &str) -> Result<HermesChildActiveSession, String> {
    let payload: HermesActiveSessionFile =
        serde_json::from_str(contents).map_err(|error| error.to_string())?;
    if valid_session_id(&payload.session_id) {
        return Ok(HermesChildActiveSession {
            kind: "durable".to_string(),
            session_id: payload.session_id,
            changed_at_ms: 0,
        });
    }
    if payload.session_id.len() == 8
        && payload
            .session_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Ok(HermesChildActiveSession {
            kind: "live".to_string(),
            session_id: payload.session_id,
            changed_at_ms: 0,
        });
    }
    Err("invalid Hermes child active session id".to_string())
}

#[cfg(target_os = "linux")]
fn read_linux_child_active_session_file(path: &Path) -> Result<HermesChildActiveSession, String> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "invalid Hermes child active-session filename".to_string())?;
    if !filename.starts_with("hermes-tui-active-session-") || !filename.ends_with(".json") {
        return Err("invalid Hermes child active-session filename".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "invalid Hermes child active-session path".to_string())?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let temp = env::temp_dir()
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if parent != temp {
        return Err("Hermes child active-session file is outside the temp directory".to_string());
    }

    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.len() > MAX_ACTIVE_SESSION_FILE_BYTES
    {
        return Err("unsafe Hermes child active-session file".to_string());
    }
    let mut contents = String::new();
    file.take(MAX_ACTIVE_SESSION_FILE_BYTES + 1)
        .read_to_string(&mut contents)
        .map_err(|error| error.to_string())?;
    if contents.len() as u64 > MAX_ACTIVE_SESSION_FILE_BYTES {
        return Err("Hermes child active-session file is too large".to_string());
    }
    let mut observation = parse_child_active_session_file(&contents)?;
    observation.changed_at_ms = metadata
        .modified()
        .ok()
        .and_then(|changed| changed.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    Ok(observation)
}

#[cfg(target_os = "linux")]
fn active_session_path_from_environ(contents: &[u8]) -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    const PREFIX: &[u8] = b"HERMES_TUI_ACTIVE_SESSION_FILE=";
    contents
        .split(|byte| *byte == 0)
        .find_map(|entry| entry.strip_prefix(PREFIX))
        .filter(|value| !value.is_empty())
        .map(|value| PathBuf::from(OsString::from_vec(value.to_vec())))
}

#[cfg(target_os = "linux")]
fn is_hermes_tui_cmdline(contents: &[u8]) -> bool {
    const TUI_ENTRYPOINT_SUFFIX: &[u8] = b"/ui-tui/dist/index.js";
    contents
        .split(|byte| *byte == 0)
        .any(|argument| argument.ends_with(TUI_ENTRYPOINT_SUFFIX))
}

#[cfg(target_os = "linux")]
fn read_linux_child_active_session(
    pty_id: &str,
) -> Result<Option<HermesChildActiveSession>, String> {
    let Some(tree) = crate::process_tree::get_pty_tree(pty_id) else {
        return Ok(None);
    };
    let mut pids = tree.descendants;
    if let Some(root) = tree.root_pid {
        pids.push(root);
    }
    for pid in pids {
        let Ok(cmdline) = fs::read(format!("/proc/{pid}/cmdline")) else {
            continue;
        };
        if !is_hermes_tui_cmdline(&cmdline) {
            continue;
        }
        let Ok(environ) = fs::read(format!("/proc/{pid}/environ")) else {
            continue;
        };
        let Some(path) = active_session_path_from_environ(&environ) else {
            continue;
        };
        if let Ok(observation) = read_linux_child_active_session_file(&path) {
            return Ok(Some(observation));
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn read_hermes_child_active_session(
    pty_id: String,
) -> Result<Option<HermesChildActiveSession>, String> {
    #[cfg(target_os = "linux")]
    {
        read_linux_child_active_session(&pty_id)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pty_id;
        Ok(None)
    }
}

fn default_hermes_home() -> Option<PathBuf> {
    if let Some(home) = env::var_os("HERMES_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(home));
    }

    #[cfg(windows)]
    {
        if let Some(home) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .open_subkey("Environment")
            .ok()
            .and_then(|key| key.get_value::<String, _>("HERMES_HOME").ok())
            .filter(|value| !value.trim().is_empty())
        {
            return Some(PathBuf::from(home));
        }
        return env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| {
                env::var_os("USERPROFILE")
                    .map(PathBuf::from)
                    .map(|home| home.join("AppData").join("Local"))
            })
            .map(|home| home.join("hermes"));
    }

    #[cfg(not(windows))]
    {
        env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(".hermes"))
    }
}

fn hermes_state_db(override_home: Option<&str>) -> Option<PathBuf> {
    let home = override_home
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(default_hermes_home)?;
    Some(home.join("state.db"))
}

fn table_columns(connection: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    Ok(columns)
}

fn snapshot_hermes_sessions_from_db(
    database: &Path,
    cwd: &str,
) -> Result<Vec<HermesSessionSnapshot>, String> {
    let target_cwd = normalize_cwd(cwd);
    if target_cwd.is_empty() || !database.is_file() {
        return Ok(Vec::new());
    }

    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("open Hermes state database: {error}"))?;
    connection
        .busy_timeout(Duration::from_millis(500))
        .map_err(|error| format!("configure Hermes state database timeout: {error}"))?;

    let columns = table_columns(&connection, "sessions")?;
    if !columns.iter().any(|column| column == "id")
        || !columns.iter().any(|column| column == "source")
        || !columns.iter().any(|column| column == "started_at")
    {
        return Ok(Vec::new());
    }

    let has_cwd = columns.iter().any(|column| column == "cwd");
    let has_repo_root = columns.iter().any(|column| column == "git_repo_root");
    if !has_cwd && !has_repo_root {
        return Ok(Vec::new());
    }

    let cwd_expr = if has_cwd { "COALESCE(cwd, '')" } else { "''" };
    let repo_expr = if has_repo_root {
        "COALESCE(git_repo_root, '')"
    } else {
        "''"
    };
    let mut modified_columns = Vec::new();
    if columns.iter().any(|column| column == "last_activity_at") {
        modified_columns.push("last_activity_at");
    }
    if columns.iter().any(|column| column == "ended_at") {
        modified_columns.push("ended_at");
    }
    modified_columns.push("started_at");
    let modified_expr = if modified_columns.len() == 1 {
        modified_columns[0].to_string()
    } else {
        format!("COALESCE({})", modified_columns.join(", "))
    };
    let archive_filter = if columns.iter().any(|column| column == "archived") {
        " AND COALESCE(archived, 0) = 0"
    } else {
        ""
    };
    let query = format!(
        "SELECT id, {cwd_expr}, {repo_expr}, {modified_expr}, started_at \
         FROM sessions WHERE source IN ('cli', 'tui'){archive_filter}"
    );

    let mut statement = connection
        .prepare(&query)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, f64>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut sessions = Vec::new();
    for row in rows {
        let Ok((id, session_cwd, repo_root, modified_at, started_at)) = row else {
            continue;
        };
        if !valid_session_id(&id) {
            continue;
        }
        let matched_cwd = if normalize_cwd(&session_cwd) == target_cwd {
            session_cwd
        } else if normalize_cwd(&repo_root) == target_cwd {
            repo_root
        } else {
            continue;
        };
        sessions.push(HermesSessionSnapshot {
            id,
            cwd: matched_cwd,
            started_at_ms: (started_at.max(0.0) * 1000.0) as u64,
            modified_at_ms: (modified_at.max(0.0) * 1000.0) as u64,
        });
    }

    sessions.sort_by(|left, right| right.modified_at_ms.cmp(&left.modified_at_ms));
    Ok(sessions)
}

#[tauri::command]
pub async fn snapshot_hermes_sessions(
    cwd: String,
    hermes_home: Option<String>,
) -> Result<Vec<HermesSessionSnapshot>, String> {
    tokio::task::spawn_blocking(move || {
        let Some(database) = hermes_state_db(hermes_home.as_deref()) else {
            return Ok(Vec::new());
        };
        snapshot_hermes_sessions_from_db(&database, &cwd)
    })
    .await
    .map_err(|error| format!("snapshot_hermes_sessions task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_database() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = env::temp_dir().join(format!("alethe-hermes-sessions-{suffix}"));
        fs::create_dir_all(&directory).unwrap();
        directory.join("state.db")
    }

    #[test]
    fn snapshots_only_matching_interactive_workspace_and_sorts_most_recent_first() {
        let database = temp_database();
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    source TEXT NOT NULL,
                    started_at REAL NOT NULL,
                    ended_at REAL,
                    cwd TEXT,
                    git_repo_root TEXT,
                    archived INTEGER NOT NULL DEFAULT 0,
                    last_activity_at REAL
                );
                INSERT INTO sessions VALUES
                    ('20260820_010201_older1', 'cli', 10, NULL, '/work/project', NULL, 0, 12),
                    ('20260820_010202_newer1', 'cli', 20, NULL, '/work/project/', NULL, 0, 25),
                    ('20260820_010203_repo01', 'tui', 30, NULL, '/work/project/subdir', '/work/project', 0, 30),
                    ('20260820_010204_other1', 'cli', 40, NULL, '/work/other', NULL, 0, 40),
                    ('20260820_010205_gate01', 'subagent', 50, NULL, '/work/project', NULL, 0, 50),
                    ('20260820_010206_arch01', 'cli', 60, NULL, '/work/project', NULL, 1, 60),
                    ('not-a-hermes-session', 'cli', 70, NULL, '/work/project', NULL, 0, 70);",
            )
            .unwrap();
        drop(connection);

        let sessions = snapshot_hermes_sessions_from_db(&database, "/work/project").unwrap();
        assert_eq!(
            sessions
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "20260820_010203_repo01",
                "20260820_010202_newer1",
                "20260820_010201_older1"
            ]
        );
        assert_eq!(sessions[0].modified_at_ms, 30_000);
        assert_eq!(sessions[0].started_at_ms, 30_000);

        fs::remove_dir_all(database.parent().unwrap()).unwrap();
    }

    #[test]
    fn missing_database_or_workspace_is_an_empty_snapshot() {
        let missing = env::temp_dir().join("alethe-hermes-state-does-not-exist.db");
        assert!(snapshot_hermes_sessions_from_db(&missing, "/work/project")
            .unwrap()
            .is_empty());
        assert!(snapshot_hermes_sessions_from_db(&missing, "")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn child_active_session_payload_distinguishes_durable_and_live_ids() {
        assert_eq!(
            parse_child_active_session_file(r#"{"session_id":"20260819_201222_94fcb1"}"#).unwrap(),
            HermesChildActiveSession {
                kind: "durable".to_string(),
                session_id: "20260819_201222_94fcb1".to_string(),
                changed_at_ms: 0,
            }
        );
        assert_eq!(
            parse_child_active_session_file(r#"{"session_id":"657e406b"}"#).unwrap(),
            HermesChildActiveSession {
                kind: "live".to_string(),
                session_id: "657e406b".to_string(),
                changed_at_ms: 0,
            }
        );
        for invalid in [
            r#"{"session_id":"657e406"}"#,
            r#"{"session_id":"not-live"}"#,
            r#"{"session_id":"20260819_201222_../../escape"}"#,
        ] {
            assert!(parse_child_active_session_file(invalid).is_err());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn child_active_session_discovery_accepts_only_private_direct_temp_files() {
        use std::os::unix::fs::PermissionsExt;

        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!("hermes-tui-active-session-alethe-{suffix}.json"));
        fs::write(&path, r#"{"session_id":"657e406b"}"#).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let observation = read_linux_child_active_session_file(&path).unwrap();
        assert_eq!(observation.kind, "live");
        assert_eq!(observation.session_id, "657e406b");
        assert!(observation.changed_at_ms > 0);

        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_linux_child_active_session_file(&path).is_err());
        fs::remove_file(&path).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn child_active_session_path_is_read_without_decoding_other_environment_values() {
        let path = active_session_path_from_environ(
            b"SECRET=do-not-decode-or-return\0HERMES_TUI_ACTIVE_SESSION_FILE=/tmp/hermes-tui-active-session-safe.json\0",
        )
        .unwrap();
        assert_eq!(
            path,
            PathBuf::from("/tmp/hermes-tui-active-session-safe.json")
        );
        assert!(is_hermes_tui_cmdline(
            b"/usr/bin/node\0/home/user/hermes-agent/ui-tui/dist/index.js\0"
        ));
        assert!(!is_hermes_tui_cmdline(
            b"/usr/bin/python\0/work/ui-tui/dist/not-index.js\0"
        ));
    }
}
