use chrono::DateTime;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

use crate::provider_common::{file_modified_ms, normalize_cwd, provider_home_dir};

#[derive(Serialize, Debug, Clone)]
pub struct AntigravitySessionSnapshot {
    pub id: String,
    pub preview: String,
    pub modified_at_ms: u128,
}

pub(crate) fn antigravity_metadata_file() -> Option<PathBuf> {
    provider_home_dir(&[
        ".gemini",
        "antigravity-cli",
        "cache",
        "conversation_metadata.json",
    ])
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

fn normalize_uri_path(uri: &str) -> String {
    let mut clean = uri.trim();
    if clean.starts_with("file:///") {
        clean = &clean["file:///".len()..];
    } else if clean.starts_with("file://") {
        clean = &clean["file://".len()..];
    }
    let decoded = clean
        .replace("%3A", ":")
        .replace("%3a", ":")
        .replace("%5C", "\\")
        .replace("%5c", "\\");
    let trimmed = decoded.trim_matches('/');
    if cfg!(windows) {
        trimmed.replace('/', "\\").to_ascii_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// outro (workspace root vs subpasta — o Antigravity registra `WorkspaceURIs`

/// "c:\users\foo\project" e "c:\users\foo\project2" combinariam

fn cwd_matches(norm: &str, target_cwd: &str) -> bool {
    if norm == target_cwd {
        return true;
    }
    let sep = if cfg!(windows) { '\\' } else { '/' };
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
    let Some(meta_path) = antigravity_metadata_file() else {
        return Ok(Vec::new());
    };

    if !meta_path.is_file() {
        return Ok(Vec::new());
    }

    let metadata = fs::metadata(&meta_path).ok();
    let default_ms = metadata.as_ref().map(file_modified_ms).unwrap_or(0);

    let contents = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&contents).map_err(|e| e.to_string())?;

    let target_cwd = normalize_cwd(&cwd);
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
                        let norm = normalize_uri_path(u_str);
                        if cwd_matches(&norm, &target_cwd) {
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
