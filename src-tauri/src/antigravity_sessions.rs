use chrono::DateTime;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

use crate::provider_common::{
    file_modified_ms, normalize_cwd_for, provider_home_dir, provider_scope,
};

#[derive(Serialize, Debug, Clone)]
pub struct AntigravitySessionSnapshot {
    pub id: String,
    pub preview: String,
    pub modified_at_ms: u128,
}

const METADATA_SEGMENTS: [&str; 4] = [
    ".gemini",
    "antigravity-cli",
    "cache",
    "conversation_metadata.json",
];

pub(crate) fn antigravity_metadata_file() -> Option<PathBuf> {
    provider_home_dir(&METADATA_SEGMENTS)
}

fn conversation_modified_ms(item: &serde_json::Value, default_ms: u128) -> u128 {
    let summary_updated = item
        .get("summary")
        .and_then(|s| s.get("UpdatedAt"))
        .and_then(|v| v.as_str());
    let last_modified = item.get("last_modified_time").and_then(|v| v.as_str());

    for candidate in [summary_updated, last_modified].into_iter().flatten() {
        if let Ok(parsed) = DateTime::parse_from_rfc3339(candidate) {
            let millis = parsed.timestamp_millis();
            if millis >= 0 {
                return millis as u128;
            }
        }
    }
    default_ms
}

fn normalize_uri_path(uri: &str, guest: bool) -> String {
    let mut clean = uri.trim();
    if let Some(rest) = clean.strip_prefix("file://") {
        clean = rest;
    }
    let decoded = clean
        .replace("%3A", ":")
        .replace("%3a", ":")
        .replace("%5C", "\\")
        .replace("%5c", "\\");
    if guest {
        // The leading slash of a guest URI is part of the path, not a separator to strip.
        return normalize_cwd_for(&decoded, true);
    }
    let trimmed = decoded.trim_matches('/');
    if cfg!(windows) {
        trimmed.replace('/', "\\").to_ascii_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// True when one path contains the other (Antigravity records `WorkspaceURIs`, which
/// may be the workspace root or a subfolder). The separator check keeps
/// `c:\users\dev\project` from matching `c:\users\dev\project2`.
fn cwd_matches(norm: &str, target_cwd: &str, sep: char) -> bool {
    if norm == target_cwd {
        return true;
    }
    if let Some(rest) = norm.strip_prefix(target_cwd) {
        if rest.starts_with(sep) {
            return true;
        }
    }
    if let Some(rest) = target_cwd.strip_prefix(norm) {
        if rest.starts_with(sep) {
            return true;
        }
    }
    false
}

#[tauri::command]
pub async fn snapshot_antigravity_sessions(
    cwd: String,
) -> Result<Vec<AntigravitySessionSnapshot>, String> {
    tokio::task::spawn_blocking(move || snapshot_antigravity_sessions_inner(cwd))
        .await
        .map_err(|error| {
            format!("snapshot_antigravity_sessions: falha na task bloqueante: {error}")
        })?
}

fn snapshot_antigravity_sessions_inner(
    cwd: String,
) -> Result<Vec<AntigravitySessionSnapshot>, String> {
    let trimmed = cwd.trim();
    let (meta_path, target_cwd, sep, guest) = if trimmed.is_empty() {
        let Some(path) = antigravity_metadata_file() else {
            return Ok(Vec::new());
        };
        let host_sep = if cfg!(windows) { '\\' } else { '/' };
        (path, String::new(), host_sep, false)
    } else {
        let Some(scope) = provider_scope(trimmed, &METADATA_SEGMENTS) else {
            return Ok(Vec::new());
        };
        (
            scope.root.clone(),
            scope.match_key(),
            scope.separator(),
            scope.is_guest(),
        )
    };

    if !meta_path.is_file() {
        return Ok(Vec::new());
    }

    let metadata = fs::metadata(&meta_path).ok();
    let default_ms = metadata.as_ref().map(file_modified_ms).unwrap_or(0);

    let contents = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&contents).map_err(|e| e.to_string())?;

    let mut snapshots = Vec::new();

    let conversations = json.get("conversations").and_then(|v| v.as_object());
    if let Some(map) = conversations {
        for (id, item) in map {
            let summary = item.get("summary");
            let preview = summary
                .and_then(|s| s.get("Preview"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let uris = summary
                .and_then(|s| s.get("WorkspaceURIs"))
                .and_then(|v| v.as_array());

            let mut matches_cwd = target_cwd.is_empty();
            if let Some(uri_list) = uris {
                for uri in uri_list {
                    if let Some(u_str) = uri.as_str() {
                        let norm = normalize_uri_path(u_str, guest);
                        if cwd_matches(&norm, &target_cwd, sep) {
                            matches_cwd = true;
                            break;
                        }
                    }
                }
            }

            if matches_cwd {
                snapshots.push(AntigravitySessionSnapshot {
                    id: id.clone(),
                    preview,
                    modified_at_ms: conversation_modified_ms(item, default_ms),
                });
            }
        }
    }

    snapshots.sort_by(|a, b| b.modified_at_ms.cmp(&a.modified_at_ms));
    Ok(snapshots)
}

#[cfg(test)]
mod cwd_match_tests {
    use super::*;
    use crate::provider_common::normalize_cwd;

    #[test]
    fn a_guest_workspace_uri_keeps_its_leading_slash_and_its_case() {
        let norm = normalize_uri_path("file:///home/Dev/App", true);
        assert_eq!(norm, "/home/Dev/App");
        assert!(cwd_matches(&norm, "/home/Dev/App", '/'));
        assert!(cwd_matches(
            &normalize_uri_path("file:///home/Dev/App/pkg", true),
            "/home/Dev/App",
            '/'
        ));
        assert!(!cwd_matches(&norm, "/home/Dev/Other", '/'));
    }

    #[test]
    fn a_windows_workspace_uri_is_folded_the_way_the_host_demands() {
        assert_eq!(
            normalize_uri_path("file:///c%3A/projects/Acme", false),
            normalize_cwd("c:/projects/Acme")
        );
    }
}
