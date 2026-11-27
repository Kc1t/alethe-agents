//! Agent transcripts that a profile's tabs resume from, carried inside a profile backup.

use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use crate::claude_sessions::{claude_projects_dir, is_session_file_stem};
use crate::codex_sessions::{codex_sessions_dir, collect_jsonl_files};

pub(crate) const ARCHIVE_ROOT: &str = "agent-sessions";
const CLAUDE: &str = "claude";
const CODEX: &str = "codex";

#[derive(Debug, Default, Clone)]
pub(crate) struct SessionRoots {
    pub claude: Option<PathBuf>,
    pub codex: Option<PathBuf>,
}

impl SessionRoots {
    pub(crate) fn host() -> Self {
        Self {
            claude: claude_projects_dir(),
            codex: codex_sessions_dir(),
        }
    }

    fn root_for(&self, provider: &str) -> Option<&Path> {
        match provider {
            CLAUDE => self.claude.as_deref(),
            CODEX => self.codex.as_deref(),
            _ => None,
        }
    }
}

/// Every session id a tab resumes from or keeps in its history.
pub(crate) fn referenced_session_ids(projects: &Value) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    collect_ids(projects, &mut ids);
    ids
}

fn collect_ids(value: &Value, ids: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                match (key.as_str(), child) {
                    ("sessionId", Value::String(id)) => push_id(id, ids),
                    ("previousSessionIds", Value::Array(list)) => list
                        .iter()
                        .filter_map(Value::as_str)
                        .for_each(|id| push_id(id, ids)),
                    _ => collect_ids(child, ids),
                }
            }
        }
        Value::Array(list) => list.iter().for_each(|child| collect_ids(child, ids)),
        _ => {}
    }
}

fn push_id(id: &str, ids: &mut BTreeSet<String>) {
    if is_session_file_stem(id) {
        ids.insert(id.to_string());
    }
}

/// Archive name → transcript on disk, for the ids found under each provider's root.
pub(crate) fn locate_transcripts(
    roots: &SessionRoots,
    ids: &BTreeSet<String>,
) -> Vec<(String, PathBuf)> {
    if ids.is_empty() {
        return Vec::new();
    }
    let mut found = Vec::new();
    if let Some(root) = roots.claude.as_deref() {
        locate_claude(root, ids, &mut found);
    }
    if let Some(root) = roots.codex.as_deref() {
        locate_codex(root, ids, &mut found);
    }
    found
}

// Claude keeps `<project-dir>/<id>.jsonl`; the project dir name is kept as-is.
fn locate_claude(root: &Path, ids: &BTreeSet<String>, found: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for dir in entries.filter_map(Result::ok).map(|entry| entry.path()) {
        let Some(dir_name) = dir.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        for id in ids {
            let file = dir.join(format!("{id}.jsonl"));
            if file.is_file() {
                found.push((format!("{ARCHIVE_ROOT}/{CLAUDE}/{dir_name}/{id}.jsonl"), file));
            }
        }
    }
}

// Codex keeps `<yyyy>/<mm>/<dd>/rollout-<timestamp>-<id>.jsonl`.
fn locate_codex(root: &Path, ids: &BTreeSet<String>, found: &mut Vec<(String, PathBuf)>) {
    let mut files = Vec::new();
    collect_jsonl_files(root, &mut files);
    for file in files {
        let Some(name) = file.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !ids.iter().any(|id| name.ends_with(&format!("{id}.jsonl"))) {
            continue;
        }
        let Ok(relative) = file.strip_prefix(root) else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        found.push((format!("{ARCHIVE_ROOT}/{CODEX}/{relative}"), file));
    }
}

pub(crate) fn is_session_entry(name: &str) -> bool {
    name.replace('\\', "/")
        .trim_start_matches('/')
        .starts_with(&format!("{ARCHIVE_ROOT}/"))
}

/// Where an archived transcript lands, or `None` when the name could escape its provider root.
fn restore_target(roots: &SessionRoots, name: &str) -> Option<PathBuf> {
    let name = name.replace('\\', "/");
    let mut parts = name.trim_start_matches('/').split('/');
    if parts.next() != Some(ARCHIVE_ROOT) {
        return None;
    }
    let root = roots.root_for(parts.next()?)?;
    let rest: Vec<&str> = parts.collect();
    let is_safe = !rest.is_empty()
        && rest.iter().all(|part| {
            if part.contains(':') {
                return false;
            }
            let mut components = Path::new(part).components();
            matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
        })
        && rest.last().is_some_and(|file| file.ends_with(".jsonl"));
    is_safe.then(|| rest.iter().fold(root.to_path_buf(), |acc, part| acc.join(part)))
}

/// Writes the transcript unless this machine already holds the same or a longer copy.
/// Transcripts only grow, so the longer file is the more recent one.
pub(crate) fn restore_entry<R: Read>(
    roots: &SessionRoots,
    name: &str,
    size: u64,
    reader: &mut R,
) -> io::Result<bool> {
    let Some(dest) = restore_target(roots, name) else {
        return Ok(false);
    };
    if fs::metadata(&dest).is_ok_and(|meta| meta.len() >= size) {
        return Ok(false);
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = dest.with_extension("jsonl.alethe-import");
    let mut out = fs::File::create(&tmp)?;
    io::copy(reader, &mut out)?;
    drop(out);
    fs::rename(&tmp, &dest)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "alethe-sessions-{label}-{}-{}",
            std::process::id(),
            nanoid::nanoid!(8)
        ));
        fs::create_dir_all(&root).expect("scratch");
        root
    }

    fn roots_under(root: &Path) -> SessionRoots {
        SessionRoots {
            claude: Some(root.join(".claude").join("projects")),
            codex: Some(root.join(".codex").join("sessions")),
        }
    }

    #[test]
    fn collects_current_and_earlier_session_ids_and_drops_unsafe_ones() {
        let projects = serde_json::json!({
            "projects": [{ "terminals": [{ "tabs": [
                { "type": "claude", "sessionId": "aaa-1", "previousSessionIds": ["old-0", "../x"] },
                { "type": "codex", "sessionId": "c0dex-2" },
                { "type": "shell" }
            ]}]}],
            "preferences": { "pomodoroSession": "ignored" }
        });
        let ids: Vec<String> = referenced_session_ids(&projects).into_iter().collect();
        assert_eq!(ids, ["aaa-1", "c0dex-2", "old-0"]);
    }

    #[test]
    fn finds_only_referenced_transcripts_of_both_providers() {
        let root = scratch("locate");
        let roots = roots_under(&root);
        let claude_dir = roots.claude.clone().expect("claude").join("C--Projetos-app");
        fs::create_dir_all(&claude_dir).expect("claude dir");
        fs::write(claude_dir.join("aaa-1.jsonl"), "{}").expect("claude kept");
        fs::write(claude_dir.join("other.jsonl"), "{}").expect("claude other");
        let codex_dir = roots.codex.clone().expect("codex").join("2026").join("11").join("27");
        fs::create_dir_all(&codex_dir).expect("codex dir");
        fs::write(codex_dir.join("rollout-2026-11-27T10-00-00-c0dex-2.jsonl"), "{}")
            .expect("codex kept");

        let ids = BTreeSet::from(["aaa-1".to_string(), "c0dex-2".to_string()]);
        let mut names: Vec<String> =
            locate_transcripts(&roots, &ids).into_iter().map(|(name, _)| name).collect();
        names.sort();
        assert_eq!(
            names,
            [
                "agent-sessions/claude/C--Projetos-app/aaa-1.jsonl",
                "agent-sessions/codex/2026/11/27/rollout-2026-11-27T10-00-00-c0dex-2.jsonl",
            ]
        );

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn a_restored_transcript_lands_where_the_agent_resumes_it() {
        let root = scratch("restore");
        let roots = roots_under(&root);
        let name = "agent-sessions/claude/C--Projetos-app/aaa-1.jsonl";

        let written = restore_entry(&roots, name, 5, &mut "hello".as_bytes()).expect("restore");

        assert!(written);
        let dest = root.join(".claude/projects/C--Projetos-app/aaa-1.jsonl");
        assert_eq!(fs::read_to_string(dest).expect("dest"), "hello");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn a_longer_local_transcript_is_never_replaced_by_an_older_backup() {
        let root = scratch("keep-newer");
        let roots = roots_under(&root);
        let dest_dir = root.join(".claude/projects/C--Projetos-app");
        fs::create_dir_all(&dest_dir).expect("dest dir");
        fs::write(dest_dir.join("aaa-1.jsonl"), "longer local copy").expect("local");
        let name = "agent-sessions/claude/C--Projetos-app/aaa-1.jsonl";

        let written = restore_entry(&roots, name, 3, &mut "old".as_bytes()).expect("restore");

        assert!(!written);
        let kept = fs::read_to_string(dest_dir.join("aaa-1.jsonl")).expect("kept");
        assert_eq!(kept, "longer local copy");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn names_that_could_escape_the_provider_root_are_refused() {
        let roots = roots_under(Path::new("home"));
        for name in [
            "agent-sessions/claude/../../evil.jsonl",
            "agent-sessions/claude/C:/evil.jsonl",
            "agent-sessions/claude//evil.jsonl",
            "agent-sessions/cursor/dir/a.jsonl",
            "agent-sessions/claude/dir/a.exe",
            "agent-sessions/claude",
            "scrollback/a.bin",
        ] {
            assert!(restore_target(&roots, name).is_none(), "{name}");
        }
        assert!(is_session_entry("agent-sessions\\codex\\a.jsonl"));
        assert!(!is_session_entry("scrollback/agent-sessions.bin"));
    }
}
