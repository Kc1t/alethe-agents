use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::provider_common::{file_modified_ms, provider_home_dir};

#[derive(Serialize)]
pub struct ClaudeSessionMeta {
    pub id: String,
    pub title: Option<String>,
    pub first_user_prompt: Option<String>,
    pub message_count: usize,
    pub modified_at_ms: u128,
    pub size_bytes: u64,
}

#[derive(Serialize)]
pub struct ClaudeSessionSnapshot {
    pub id: String,
    pub modified_at_ms: u128,
    pub size_bytes: u64,
}

/// Mirrors how Claude names the directory it stores a project's sessions in.
///
/// The dot matters. Worktrees live under `<repo>/.alethe/worktrees/<id>`, and
/// Claude folds the dot into a hyphen along with the separators, writing
/// `-home-user-repo--alethe-worktrees-<id>`. Leaving it as `.alethe` produced a
/// path that never exists, so no session was ever found for a pane running in a
/// worktree.
fn encode_cwd_for_claude(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches(|c: char| c == '\\' || c == '/');
    trimmed
        .chars()
        .map(|c| match c {
            ':' | '\\' | '/' | '.' => '-',
            _ => c,
        })
        .collect()
}

pub(crate) fn claude_projects_dir() -> Option<PathBuf> {
    provider_home_dir(&[".claude", "projects"])
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut count = 0;
    for c in s.chars() {
        if count >= max_chars {
            out.push('…');
            return out;
        }
        out.push(c);
        count += 1;
    }
    out
}

/// Session JSONL lines can be tens of MB (pasted files, image payloads, tool
/// results). Reading one whole line into memory is what made a single scan
/// allocate gigabytes and abort the process, so lines are capped here.
const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;

/// Only the fields the sidebar and the history modal actually read. Deserializing
/// into this instead of `serde_json::Value` avoids building a full node tree for
/// every record — that tree, over a project's whole session history, is what made
/// the scan allocate gigabytes.
#[derive(Deserialize)]
struct RecordHeader {
    #[serde(rename = "type", default)]
    entry_type: Option<String>,
    #[serde(rename = "aiTitle", default)]
    ai_title: Option<String>,
}

/// Reads one line, keeping at most `MAX_LINE_BYTES` and discarding the rest
/// without buffering it. Returns false at EOF.
fn read_capped_line(reader: &mut impl BufRead, buf: &mut Vec<u8>) -> std::io::Result<bool> {
    buf.clear();
    let mut consumed_any = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(consumed_any);
        }
        consumed_any = true;
        let newline = available.iter().position(|byte| *byte == b'\n');
        let chunk_len = newline.unwrap_or(available.len());
        if buf.len() < MAX_LINE_BYTES {
            let take = chunk_len.min(MAX_LINE_BYTES - buf.len());
            buf.extend_from_slice(&available[..take]);
        }
        match newline {
            Some(index) => {
                reader.consume(index + 1);
                return Ok(true);
            }
            None => {
                let len = available.len();
                reader.consume(len);
            }
        }
    }
}

fn first_text_block(line: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(line).ok()?;
    let content = value
        .get("message")
        .and_then(|message| message.get("content"))?;
    match content {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Array(blocks) => blocks.iter().find_map(|block| {
            block
                .get("text")
                .and_then(|text| text.as_str())
                .map(String::from)
        }),
        _ => None,
    }
}

fn parse_session_file(
    id: String,
    path: PathBuf,
    metadata: &fs::Metadata,
) -> Option<ClaudeSessionMeta> {
    let file = fs::File::open(&path).ok()?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);

    let mut title: Option<String> = None;
    let mut first_user_prompt: Option<String> = None;
    let mut message_count: usize = 0;
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);

    while read_capped_line(&mut reader, &mut buf).unwrap_or(false) {
        if buf.is_empty() {
            continue;
        }
        let Ok(line) = std::str::from_utf8(&buf) else {
            continue;
        };
        let Ok(header) = serde_json::from_str::<RecordHeader>(line) else {
            continue;
        };
        match header.entry_type.as_deref().unwrap_or("") {
            "ai-title" => {
                if title.is_none() {
                    title = header
                        .ai_title
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty());
                }
            }
            "user" => {
                message_count += 1;
                // Only the first user record needs its payload, so this is the
                // one line per file that still pays for a full value tree.
                if first_user_prompt.is_none() {
                    first_user_prompt =
                        first_text_block(line).map(|s| truncate_chars(s.trim(), 240));
                }
            }
            "assistant" => {
                message_count += 1;
            }
            _ => {}
        }
    }

    Some(ClaudeSessionMeta {
        id,
        title,
        first_user_prompt,
        message_count,
        modified_at_ms: file_modified_ms(metadata),
        size_bytes: metadata.len(),
    })
}

/// letter maiuscula ou minuscula).
fn matching_project_dirs(root: &PathBuf, encoded: &str) -> Vec<PathBuf> {
    let direct = root.join(encoded);
    if direct.is_dir() {
        return vec![direct];
    }
    let target_lower = encoded.to_ascii_lowercase();
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            let name = path.file_name()?.to_str()?.to_string();
            if name.to_ascii_lowercase() == target_lower {
                Some(path)
            } else {
                None
            }
        })
        .collect()
}

pub(crate) fn project_dirs_for_cwd(cwd: &str) -> Result<Vec<PathBuf>, String> {
    let cwd_trimmed = cwd.trim();
    if cwd_trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let Some(root) = claude_projects_dir() else {
        return Err("USERPROFILE/HOME nao definido".to_string());
    };
    let encoded = encode_cwd_for_claude(cwd_trimmed);
    Ok(matching_project_dirs(&root, &encoded))
}

#[tauri::command]
pub async fn snapshot_claude_sessions(cwd: String) -> Result<Vec<ClaudeSessionSnapshot>, String> {
    tokio::task::spawn_blocking(move || snapshot_claude_sessions_inner(cwd))
        .await
        .map_err(|error| format!("snapshot_claude_sessions: falha na task bloqueante: {error}"))?
}

fn snapshot_claude_sessions_inner(cwd: String) -> Result<Vec<ClaudeSessionSnapshot>, String> {
    let project_dirs = project_dirs_for_cwd(&cwd)?;

    let mut sessions: Vec<ClaudeSessionSnapshot> = Vec::new();
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for project_dir in project_dirs {
        let entries = match fs::read_dir(&project_dir) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for entry in entries.filter_map(|entry| entry.ok()) {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
                continue;
            };
            if !seen_ids.insert(id.clone()) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            sessions.push(ClaudeSessionSnapshot {
                id,
                modified_at_ms: file_modified_ms(&metadata),
                size_bytes: metadata.len(),
            });
        }
    }

    sessions.sort_by(|a, b| b.modified_at_ms.cmp(&a.modified_at_ms));
    Ok(sessions)
}

/// `async` + `spawn_blocking` for the same reason as `snapshot_claude_sessions`:
/// this walks every JSONL of the project, which on a busy machine is hundreds of
/// MB. Running it on Tauri's dispatch thread froze the whole window.
#[tauri::command]
pub async fn list_claude_sessions(cwd: String) -> Result<Vec<ClaudeSessionMeta>, String> {
    tokio::task::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let result = list_claude_sessions_inner(cwd);
        log_slow_scan(
            "list_claude_sessions",
            started,
            result.as_ref().map(Vec::len).unwrap_or(0),
        );
        result
    })
    .await
    .map_err(|error| format!("list_claude_sessions: falha na task bloqueante: {error}"))?
}

const SLOW_SCAN_MS: u128 = 250;

/// Session scans are the historical cause of UI freezes here; log the slow ones
/// so a regression shows up in app-events.log instead of only as a hang.
fn log_slow_scan(command: &str, started: std::time::Instant, files: usize) {
    let elapsed = started.elapsed().as_millis();
    if elapsed < SLOW_SCAN_MS {
        return;
    }
    let _ = crate::logging::record_app_event(
        "sessions.slow_scan".to_string(),
        format!("command={command} elapsed_ms={elapsed} files={files}"),
    );
}

fn list_claude_sessions_inner(cwd: String) -> Result<Vec<ClaudeSessionMeta>, String> {
    let project_dirs = project_dirs_for_cwd(&cwd)?;

    if project_dirs.is_empty() {
        return Ok(Vec::new());
    }

    let mut sessions: Vec<ClaudeSessionMeta> = Vec::new();
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for project_dir in project_dirs {
        let entries = match fs::read_dir(&project_dir) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for entry in entries.filter_map(|entry| entry.ok()) {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
                continue;
            };
            if !seen_ids.insert(id.clone()) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if let Some(meta) = parse_session_file(id, path, &metadata) {
                sessions.push(meta);
            }
        }
    }

    sessions.sort_by(|a, b| b.modified_at_ms.cmp(&a.modified_at_ms));
    Ok(sessions)
}

/// Sidebar rows only need the title of the session they are attached to.
/// `list_claude_sessions` parses every JSONL of the project to answer that,
/// so this opens the single matching file instead.
#[tauri::command]
pub async fn get_claude_session_title(
    cwd: String,
    session_id: String,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let result = get_claude_session_title_inner(cwd, session_id);
        log_slow_scan("get_claude_session_title", started, 1);
        result
    })
    .await
    .map_err(|error| format!("get_claude_session_title: falha na task bloqueante: {error}"))?
}

fn get_claude_session_title_inner(
    cwd: String,
    session_id: String,
) -> Result<Option<String>, String> {
    if session_id.is_empty() || session_id.contains(['/', '\\', '.']) {
        return Ok(None);
    }
    for project_dir in project_dirs_for_cwd(&cwd)? {
        let path = project_dir.join(format!("{session_id}.jsonl"));
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let Some(meta) = parse_session_file(session_id.clone(), path, &metadata) else {
            continue;
        };
        return Ok(meta.title.or(meta.first_user_prompt));
    }
    Ok(None)
}

#[derive(Serialize)]
pub struct ActivityDay {
    /// Data UTC no formato YYYY-MM-DD
    pub date: String,

    pub count: usize,
}

#[tauri::command]
pub async fn get_claude_activity(days: usize) -> Result<Vec<ActivityDay>, String> {
    tokio::task::spawn_blocking(move || get_claude_activity_inner(days))
        .await
        .map_err(|e| e.to_string())?
}

fn get_claude_activity_inner(days: usize) -> Result<Vec<ActivityDay>, String> {
    let days = days.clamp(1, 366);
    let Some(root) = claude_projects_dir() else {
        return Ok(empty_activity_window(days));
    };
    if !root.is_dir() {
        return Ok(empty_activity_window(days));
    }

    let now = SystemTime::now();
    let window_start = now
        .checked_sub(Duration::from_secs(days as u64 * 86_400))
        .unwrap_or(UNIX_EPOCH);

    let mut counts: HashMap<String, usize> = HashMap::new();

    let project_entries = match fs::read_dir(&root) {
        Ok(it) => it,
        Err(_) => return Ok(empty_activity_window(days)),
    };

    for project_entry in project_entries.filter_map(|e| e.ok()) {
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }
        let session_entries = match fs::read_dir(&project_path) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for entry in session_entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }

            if let Ok(metadata) = entry.metadata() {
                if let Ok(modified) = metadata.modified() {
                    if modified < window_start {
                        continue;
                    }
                }
            }
            count_messages_per_day(&path, &mut counts);
        }
    }

    Ok(build_activity_window(days, &counts))
}

fn count_messages_per_day(path: &PathBuf, counts: &mut HashMap<String, usize>) {
    let Ok(file) = fs::File::open(path) else {
        return;
    };
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let entry_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if entry_type != "user" && entry_type != "assistant" {
            continue;
        }
        let Some(timestamp) = value.get("timestamp").and_then(|v| v.as_str()) else {
            continue;
        };
        // ISO8601: "2026-05-10T14:23:45.123Z" → primeiros 10 chars = data UTC
        if timestamp.len() < 10 {
            continue;
        }
        let date = &timestamp[..10];

        if date.as_bytes().get(4) != Some(&b'-') || date.as_bytes().get(7) != Some(&b'-') {
            continue;
        }
        *counts.entry(date.to_string()).or_insert(0) += 1;
    }
}

#[tauri::command]
pub async fn get_multi_agent_activity(days: usize) -> Result<Vec<ActivityDay>, String> {
    tokio::task::spawn_blocking(move || get_multi_agent_activity_inner(days))
        .await
        .map_err(|e| e.to_string())?
}

fn get_multi_agent_activity_inner(days: usize) -> Result<Vec<ActivityDay>, String> {
    let days = days.clamp(1, 366);
    let now = SystemTime::now();
    let window_start = now
        .checked_sub(Duration::from_secs(days as u64 * 86_400))
        .unwrap_or(UNIX_EPOCH);
    let window_start_ms = window_start
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let mut counts: HashMap<String, usize> = HashMap::new();

    if let Some(root) = claude_projects_dir() {
        if root.is_dir() {
            if let Ok(project_entries) = fs::read_dir(&root) {
                for project_entry in project_entries.filter_map(|e| e.ok()) {
                    let project_path = project_entry.path();
                    if !project_path.is_dir() {
                        continue;
                    }
                    let Ok(session_entries) = fs::read_dir(&project_path) else {
                        continue;
                    };
                    for entry in session_entries.filter_map(|e| e.ok()) {
                        let path = entry.path();
                        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                            continue;
                        }
                        if let Ok(metadata) = entry.metadata() {
                            if let Ok(modified) = metadata.modified() {
                                if modified < window_start {
                                    continue;
                                }
                            }
                        }
                        count_messages_per_day(&path, &mut counts);
                    }
                }
            }
        }
    }

    if let Some(root) = crate::codex_sessions::codex_sessions_dir() {
        if root.is_dir() {
            let mut files = Vec::new();
            crate::codex_sessions::collect_jsonl_files(&root, &mut files);
            for path in files {
                let Ok(metadata) = fs::metadata(&path) else {
                    continue;
                };
                let Ok(modified) = metadata.modified() else {
                    continue;
                };
                if modified < window_start {
                    continue;
                }
                if let Ok(secs) = modified.duration_since(UNIX_EPOCH) {
                    let (y, m, d) = epoch_secs_to_ymd(secs.as_secs() as i64);
                    let date = format!("{y:04}-{m:02}-{d:02}");
                    *counts.entry(date).or_insert(0) += 1;
                }
            }
        }
    }

    // OpenCode: mensagem por mensagem, direto do opencode.db (mesma granularidade do Claude).
    if let Some(db_path) = crate::agent_cost::opencode_db_path() {
        if db_path.is_file() {
            if let Ok(conn) = rusqlite::Connection::open_with_flags(
                &db_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            ) {
                if let Ok(mut stmt) =
                    conn.prepare("SELECT time_created FROM message WHERE time_created >= ?1")
                {
                    if let Ok(mut rows) = stmt.query(rusqlite::params![window_start_ms]) {
                        while let Ok(Some(row)) = rows.next() {
                            let created_ms: i64 = row.get(0).unwrap_or(0);
                            let (y, m, d) = epoch_secs_to_ymd(created_ms / 1000);
                            let date = format!("{y:04}-{m:02}-{d:02}");
                            *counts.entry(date).or_insert(0) += 1;
                        }
                    }
                }
            }
        }
    }

    Ok(build_activity_window(days, &counts))
}

fn build_activity_window(days: usize, counts: &HashMap<String, usize>) -> Vec<ActivityDay> {
    let mut out = Vec::with_capacity(days);
    let today = today_utc_ymd();
    for i in (0..days).rev() {
        let date = days_ago_ymd(&today, i);
        let count = counts.get(&date).copied().unwrap_or(0);
        out.push(ActivityDay { date, count });
    }
    out
}

fn empty_activity_window(days: usize) -> Vec<ActivityDay> {
    let today = today_utc_ymd();
    (0..days)
        .rev()
        .map(|i| ActivityDay {
            date: days_ago_ymd(&today, i),
            count: 0,
        })
        .collect()
}

fn today_utc_ymd() -> (i64, u32, u32) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    epoch_secs_to_ymd(secs)
}

fn days_ago_ymd(today: &(i64, u32, u32), days: usize) -> String {
    let epoch_days = ymd_to_epoch_days(today.0, today.1, today.2);
    let target = epoch_days - days as i64;
    let (y, m, d) = epoch_days_to_ymd(target);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Converte segundos UNIX → (year, month, day) UTC. Algoritmo de Howard

fn epoch_secs_to_ymd(secs: i64) -> (i64, u32, u32) {
    let days = secs.div_euclid(86_400);
    epoch_days_to_ymd(days)
}

fn epoch_days_to_ymd(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn ymd_to_epoch_days(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64; // [0, 399]
    let m = m as u64;
    let d = d as u64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe as i64 - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn read_all(input: &str) -> Vec<String> {
        let mut reader = std::io::BufReader::new(Cursor::new(input.as_bytes().to_vec()));
        let mut buf = Vec::new();
        let mut lines = Vec::new();
        while read_capped_line(&mut reader, &mut buf).unwrap() {
            lines.push(String::from_utf8_lossy(&buf).to_string());
        }
        lines
    }

    #[test]
    fn capped_line_reader_splits_on_newlines() {
        assert_eq!(read_all("a\nbb\n"), vec!["a", "bb"]);
        assert_eq!(read_all("a\nbb"), vec!["a", "bb"]);
    }

    #[test]
    fn capped_line_reader_bounds_a_giant_line() {
        let giant = "x".repeat(MAX_LINE_BYTES * 3);
        let input = format!("{giant}\ntail\n");
        let lines = read_all(&input);
        assert_eq!(lines[0].len(), MAX_LINE_BYTES);
        assert_eq!(lines[1], "tail");
    }

    #[test]
    fn record_header_reads_only_the_top_level_type() {
        let line = r#"{"parentUuid":null,"type":"user","message":{"content":[{"type":"text","text":"oi"}]}}"#;
        let header = serde_json::from_str::<RecordHeader>(line).unwrap();
        assert_eq!(header.entry_type.as_deref(), Some("user"));
        assert_eq!(first_text_block(line).as_deref(), Some("oi"));
    }
}

#[cfg(test)]
mod encode_cwd_tests {
    use super::encode_cwd_for_claude;

    #[test]
    fn folds_the_dot_of_a_worktree_path() {
        assert_eq!(
            encode_cwd_for_claude("/home/user/repo/.alethe/worktrees/cl-a1b2c3"),
            "-home-user-repo--alethe-worktrees-cl-a1b2c3"
        );
    }

    #[test]
    fn a_path_without_a_dot_is_unaffected() {
        assert_eq!(encode_cwd_for_claude("/home/user/repo"), "-home-user-repo");
    }

    #[test]
    fn trailing_separator_is_dropped() {
        assert_eq!(encode_cwd_for_claude("/tmp/x/"), "-tmp-x");
    }
}
