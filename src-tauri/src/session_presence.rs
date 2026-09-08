//! Does a stored session actually exist, before the app tries to resume it?
//!
//! Alethe remembers a session id per tab and passes it to the agent on the next launch. For Claude
//! that id is one Alethe *minted itself*: with no session yet, the launch is
//! `claude --session-id <uuid>`, and the uuid is saved as though the session were real. But
//! `--session-id` only asks the CLI to use that id — the conversation file is written when a
//! conversation actually starts. A first launch that stops at the trust prompt writes nothing, and
//! the saved id then refers to a session that never existed.
//!
//! The next launch says `--resume <uuid>` and the agent answers
//! `No conversation found with session ID: …` in red, which is correct of it and useless to the
//! user. Confirmed on this machine: the id in the error existed nowhere under `~/.claude`, and that
//! project had no session directory at all.
//!
//! So the app was recording "I have a session" from an *intention* rather than from evidence — the
//! same mistake `health_probe.rs` already names: only a read that confirms the expected content is
//! proof.
//!
//! # Unknown is a real answer
//!
//! [`SessionPresence::Unknown`] exists so this can be honest. Claude and Codex keep sessions in
//! files this can check. OpenCode and Antigravity do not, or not in a way verified here — and
//! answering `Absent` for those would throw away resumes that are perfectly valid, trading a
//! confusing error for silent data loss. A checker that guesses is worse than one that declines.

use std::path::Path;

use serde::Serialize;

/// Whether a session id can be resumed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionPresence {
    /// Found on disk. Resuming is safe.
    Present,
    /// Checked, and it is not there. Resuming would fail; start a fresh session instead.
    Absent,
    /// This agent's storage cannot be checked here. Resume anyway rather than discard a valid id.
    Unknown,
}

/// Claude writes one JSONL per session, named by id, under the project directory for the cwd.
fn claude_presence(cwd: &str, session_id: &str) -> SessionPresence {
    let Ok(dirs) = crate::claude_sessions::project_dirs_for_cwd(cwd) else {
        return SessionPresence::Unknown;
    };
    // No project directory at all means the agent has never run here. That is genuinely `Absent`,
    // not `Unknown`: the storage was reachable and it holds nothing for this cwd.
    if dirs
        .iter()
        .any(|dir| dir.join(format!("{session_id}.jsonl")).is_file())
    {
        SessionPresence::Present
    } else {
        SessionPresence::Absent
    }
}

/// Codex names files by timestamp and carries the id inside the first line, so this has to read.
fn codex_presence(session_id: &str) -> SessionPresence {
    let Some(root) = crate::codex_sessions::codex_sessions_dir() else {
        return SessionPresence::Unknown;
    };
    if !root.is_dir() {
        return SessionPresence::Absent;
    }
    let mut files = Vec::new();
    crate::codex_sessions::collect_jsonl_files(&root, &mut files);
    // Cheap first: the id appears in the file name for newer sessions.
    if files.iter().any(|path| file_name_contains(path, session_id)) {
        return SessionPresence::Present;
    }
    if files
        .iter()
        .any(|path| crate::codex_sessions::session_meta_id(path).as_deref() == Some(session_id))
    {
        SessionPresence::Present
    } else {
        SessionPresence::Absent
    }
}

fn file_name_contains(path: &Path, needle: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.contains(needle))
}

/// Whether `session_id` can be resumed for `agent` in `cwd`.
pub fn session_presence(agent: &str, cwd: &str, session_id: &str) -> SessionPresence {
    if session_id.trim().is_empty() {
        return SessionPresence::Absent;
    }
    match agent {
        "claude" => claude_presence(cwd, session_id),
        "codex" => codex_presence(session_id),
        // Not `Absent`: their storage is not read here, and claiming absence would discard valid
        // ids. See the module comment.
        _ => SessionPresence::Unknown,
    }
}

#[tauri::command]
pub async fn agent_session_presence(
    agent: String,
    cwd: String,
    session_id: String,
) -> Result<SessionPresence, String> {
    // `spawn_blocking` for the same reason the session listings use it: the Codex branch walks a
    // directory tree, and doing that on Tauri's dispatch thread is what used to freeze the window.
    tokio::task::spawn_blocking(move || session_presence(&agent, &cwd, &session_id))
        .await
        .map_err(|error| format!("agent_session_presence: blocking task failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_id_is_absent_not_unknown() {
        // An empty id cannot be resumed by anyone, so there is nothing to be uncertain about.
        assert_eq!(session_presence("claude", "C:/x", ""), SessionPresence::Absent);
        assert_eq!(
            session_presence("opencode", "C:/x", "   "),
            SessionPresence::Absent
        );
    }

    #[test]
    fn an_unreadable_agent_is_unknown_so_a_valid_id_is_never_discarded() {
        // The whole point of the third state. Answering `Absent` here would silently drop a resume
        // that would have worked, trading a visible error for invisible data loss.
        assert_eq!(
            session_presence("opencode", "C:/x", "abc"),
            SessionPresence::Unknown
        );
        assert_eq!(
            session_presence("antigravity", "C:/x", "abc"),
            SessionPresence::Unknown
        );
        assert_eq!(session_presence("shell", "C:/x", "abc"), SessionPresence::Unknown);
    }

    #[test]
    fn a_claude_id_with_no_project_directory_is_absent() {
        // The reported bug, reduced: a cwd the agent has never run in holds no session, and the
        // storage answering "nothing here" is evidence, not uncertainty.
        let nowhere = std::env::temp_dir().join(format!(
            "alethe-presence-{}-{}",
            std::process::id(),
            crate::provider_common::now_ms()
        ));
        assert_eq!(
            session_presence("claude", &nowhere.to_string_lossy(), "ce626fd7-2b5f-4f81-8cac-add95fe03daf"),
            SessionPresence::Absent
        );
    }

    #[test]
    fn presence_serializes_to_the_wire_values_the_frontend_matches_on() {
        assert_eq!(
            serde_json::to_string(&SessionPresence::Present).unwrap(),
            "\"present\""
        );
        assert_eq!(
            serde_json::to_string(&SessionPresence::Absent).unwrap(),
            "\"absent\""
        );
        assert_eq!(
            serde_json::to_string(&SessionPresence::Unknown).unwrap(),
            "\"unknown\""
        );
    }
}
