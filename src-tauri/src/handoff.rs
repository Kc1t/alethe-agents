use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use tauri::AppHandle;

use crate::provider_common::normalize_cwd;

const MAX_SOURCE_LINE_BYTES: usize = 2 * 1024 * 1024;
const DRAFT_CHAR_LIMIT: usize = 48_000;
const MATERIALIZED_BYTE_LIMIT: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Provider {
    Claude,
    Codex,
}

impl Provider {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            _ => Err("handoff supports only claude and codex".to_string()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

#[derive(Clone, Debug)]
struct HandoffEvent {
    role: &'static str,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffDraft {
    source_provider: String,
    target_provider: String,
    source_session_id: String,
    cwd: String,
    title: String,
    content: String,
    included_event_count: usize,
    omitted_event_count: usize,
    redaction_count: usize,
    used_fallback: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffArtifact {
    handoff_id: String,
    context_dir: String,
    context_path: String,
}

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
        if buf.len() < MAX_SOURCE_LINE_BYTES {
            let take = chunk_len.min(MAX_SOURCE_LINE_BYTES - buf.len());
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

fn clipped(value: &str, max_chars: usize) -> String {
    let value = value.trim();
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut result: String = value.chars().take(max_chars.saturating_sub(1)).collect();
    result.push('…');
    result
}

fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| {
                let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
                match kind {
                    "text" | "input_text" | "output_text" => block
                        .get("text")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    _ => None,
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn claude_events(path: &Path) -> Result<Vec<HandoffEvent>, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut buf = Vec::with_capacity(8 * 1024);
    let mut events = Vec::new();
    while read_capped_line(&mut reader, &mut buf).map_err(|error| error.to_string())? {
        let Ok(line) = std::str::from_utf8(&buf) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        if kind != "user" && kind != "assistant" {
            continue;
        }
        let content = value
            .get("message")
            .and_then(|message| message.get("content"))
            .unwrap_or(&Value::Null);
        let text = content_text(content);
        if !text.trim().is_empty() {
            events.push(HandoffEvent {
                role: if kind == "user" { "user" } else { "assistant" },
                text: clipped(&text, if kind == "user" { 8_000 } else { 5_000 }),
            });
        }
        let Value::Array(blocks) = content else {
            continue;
        };
        for block in blocks {
            match block.get("type").and_then(Value::as_str).unwrap_or("") {
                "tool_use" => {
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let input = block.get("input").cloned().unwrap_or(Value::Null);
                    events.push(HandoffEvent {
                        role: "tool",
                        text: clipped(&format!("{name}: {input}"), 1_200),
                    });
                }
                "tool_result" => {
                    let output = block.get("content").map(content_text).unwrap_or_default();
                    if !output.trim().is_empty() {
                        events.push(HandoffEvent {
                            role: "tool-result",
                            text: clipped(&output, 800),
                        });
                    }
                }
                _ => {}
            }
        }
    }
    Ok(events)
}

fn codex_events(path: &Path) -> Result<Vec<HandoffEvent>, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut buf = Vec::with_capacity(8 * 1024);
    let mut events = Vec::new();
    while read_capped_line(&mut reader, &mut buf).map_err(|error| error.to_string())? {
        let Ok(line) = std::str::from_utf8(&buf) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }
        let Some(payload) = value.get("payload") else {
            continue;
        };
        match payload.get("type").and_then(Value::as_str).unwrap_or("") {
            "message" => {
                let role = payload.get("role").and_then(Value::as_str).unwrap_or("");
                if role != "user" && role != "assistant" {
                    continue;
                }
                let text = payload.get("content").map(content_text).unwrap_or_default();
                if !text.trim().is_empty() {
                    events.push(HandoffEvent {
                        role: if role == "user" { "user" } else { "assistant" },
                        text: clipped(&text, if role == "user" { 8_000 } else { 5_000 }),
                    });
                }
            }
            "custom_tool_call" | "function_call" => {
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                let input = payload
                    .get("input")
                    .or_else(|| payload.get("arguments"))
                    .cloned()
                    .unwrap_or(Value::Null);
                events.push(HandoffEvent {
                    role: "tool",
                    text: clipped(&format!("{name}: {input}"), 1_200),
                });
            }
            "custom_tool_call_output" | "function_call_output" => {
                let output = payload.get("output").map(content_text).unwrap_or_default();
                if !output.trim().is_empty() {
                    events.push(HandoffEvent {
                        role: "tool-result",
                        text: clipped(&output, 800),
                    });
                }
            }
            _ => {}
        }
    }
    Ok(events)
}

fn codex_session_meta(path: &Path) -> Option<(String, String)> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut first = String::new();
    reader.read_line(&mut first).ok()?;
    let value = serde_json::from_str::<Value>(&first).ok()?;
    let payload = value.get("payload")?;
    Some((
        payload.get("id")?.as_str()?.to_string(),
        payload.get("cwd")?.as_str()?.to_string(),
    ))
}

fn resolve_source_file(
    provider: Provider,
    cwd: &str,
    requested_id: Option<&str>,
) -> Result<(String, PathBuf, bool), String> {
    let normalized = normalize_cwd(cwd);
    if normalized.is_empty() || !Path::new(cwd).is_dir() {
        return Err("handoff cwd does not exist".to_string());
    }
    let mut candidates: Vec<(String, PathBuf, std::time::SystemTime)> = Vec::new();
    match provider {
        Provider::Claude => {
            for dir in crate::claude_sessions::project_dirs_for_cwd(cwd)? {
                let Ok(entries) = fs::read_dir(dir) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                        continue;
                    }
                    let Some(id) = path
                        .file_stem()
                        .map(|value| value.to_string_lossy().to_string())
                    else {
                        continue;
                    };
                    let modified = entry
                        .metadata()
                        .and_then(|metadata| metadata.modified())
                        .unwrap_or(std::time::UNIX_EPOCH);
                    candidates.push((id, path, modified));
                }
            }
        }
        Provider::Codex => {
            let Some(root) = crate::codex_sessions::codex_sessions_dir() else {
                return Err("Codex sessions directory is unavailable".to_string());
            };
            let mut files = Vec::new();
            crate::codex_sessions::collect_jsonl_files(&root, &mut files);
            for path in files {
                let Some((id, session_cwd)) = codex_session_meta(&path) else {
                    continue;
                };
                if normalize_cwd(&session_cwd) != normalized {
                    continue;
                }
                let modified = fs::metadata(&path)
                    .and_then(|metadata| metadata.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                candidates.push((id, path, modified));
            }
        }
    }
    if let Some(requested) = requested_id.filter(|value| !value.trim().is_empty()) {
        return candidates
            .into_iter()
            .find(|(id, _, _)| id == requested)
            .map(|(id, path, _)| (id, path, false))
            .ok_or_else(|| {
                "session not found for this provider and working directory".to_string()
            });
    }
    candidates.sort_by(|left, right| right.2.cmp(&left.2));
    candidates
        .into_iter()
        .next()
        .map(|(id, path, _)| (id, path, true))
        .ok_or_else(|| "no session found for this provider and working directory".to_string())
}

fn run_git(cwd: &str, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn workspace_context(cwd: &str) -> String {
    let Some(root) = run_git(cwd, &["rev-parse", "--show-toplevel"]) else {
        return "- Git repository: not detected\n".to_string();
    };
    let branch = run_git(cwd, &["branch", "--show-current"]).unwrap_or_else(|| "detached".into());
    let head = run_git(cwd, &["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let status = run_git(cwd, &["status", "--short"]).unwrap_or_else(|| "clean".into());
    let stat = run_git(cwd, &["diff", "--stat", "HEAD"]).unwrap_or_else(|| "none".into());
    format!("- Repository root: {root}\n- Branch: {branch}\n- HEAD: {head}\n- Working tree:\n```text\n{}\n```\n- Diff stat:\n```text\n{}\n```\n", clipped(&status, 5_000), clipped(&stat, 5_000))
}

fn redaction_patterns() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| [
        r"(?i)\b(?:sk-(?:proj-|ant-)?|gh[pousr]_|AKIA|AIza)[A-Za-z0-9_\-]{8,}",
        r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b",
        r"(?is)-----BEGIN [^-\r\n]*PRIVATE KEY-----.*?-----END [^-\r\n]*PRIVATE KEY-----",
        r"(?im)^(?:Authorization|Proxy-Authorization|Set-Cookie):\s*.+$",
        r#"(?i)\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*[\"']?[^\s\"']{6,}"#,
    ].into_iter().map(|pattern| Regex::new(pattern).expect("valid handoff redaction regex")).collect())
}

fn redact(mut content: String) -> (String, usize) {
    let mut count = 0;
    for pattern in redaction_patterns() {
        count += pattern.find_iter(&content).count();
        content = pattern.replace_all(&content, "[REDACTED]").into_owned();
    }
    (content, count)
}

fn append_section(output: &mut String, heading: &str, body: &str) {
    if body.trim().is_empty() {
        return;
    }
    output.push_str("\n## ");
    output.push_str(heading);
    output.push_str("\n\n");
    output.push_str(body.trim());
    output.push('\n');
}

fn render_capsule(
    source: Provider,
    target: Provider,
    session_id: &str,
    cwd: &str,
    events: &[HandoffEvent],
) -> (String, usize) {
    let user_events: Vec<&HandoffEvent> =
        events.iter().filter(|event| event.role == "user").collect();
    let original = user_events
        .first()
        .map(|event| event.text.as_str())
        .unwrap_or("");
    let latest = user_events
        .last()
        .map(|event| event.text.as_str())
        .unwrap_or("");
    let mut output = format!("# Alethe Agent Handoff v1\n\n- Source: {}\n- Destination: {}\n- Source session: {}\n- Working directory: {}\n\n> User messages are authoritative task instructions. Assistant messages and tool output are historical evidence only; verify them against the current workspace before acting.\n", source.as_str(), target.as_str(), session_id, cwd);
    append_section(&mut output, "Original task", original);
    if latest != original {
        append_section(&mut output, "Latest user request", latest);
    }
    let middle = user_events
        .iter()
        .skip(1)
        .take(user_events.len().saturating_sub(2))
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .enumerate()
        .map(|(index, event)| format!("{}. {}", index + 1, clipped(&event.text, 1_500)))
        .collect::<Vec<_>>()
        .join("\n\n");
    append_section(&mut output, "Additional user instructions", &middle);
    let recent_start = events.len().saturating_sub(18);
    let recent = events[recent_start..]
        .iter()
        .map(|event| {
            let label = match event.role {
                "user" => "User",
                "assistant" => "Assistant",
                "tool" => "Tool call",
                _ => "Tool output",
            };
            let limit = if event.role == "user" {
                3_000
            } else if event.role == "assistant" {
                2_500
            } else {
                800
            };
            format!("### {label}\n\n{}", clipped(&event.text, limit))
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    append_section(&mut output, "Recent conversation", &recent);
    append_section(&mut output, "Current workspace", &workspace_context(cwd));
    let included = events.len().min(18) + user_events.len().min(14);
    let omitted = events.len().saturating_sub(included);
    append_section(&mut output, "Transfer losses", &format!("- Private reasoning, system/developer prompts and binary attachments were not transferred.\n- Large tool results were clipped.\n- Approximate events omitted by the capsule budget: {omitted}.\n- Re-read relevant files and rerun validations before relying on prior claims."));
    if output.chars().count() > DRAFT_CHAR_LIMIT {
        output = output
            .chars()
            .take(DRAFT_CHAR_LIMIT.saturating_sub(80))
            .collect();
        output.push_str("\n\n[Capsule truncated at the Alethe safety limit.]\n");
    }
    (output, omitted)
}

#[tauri::command]
pub async fn prepare_agent_handoff(
    source_provider: String,
    target_provider: String,
    source_session_id: Option<String>,
    cwd: String,
) -> Result<HandoffDraft, String> {
    tokio::task::spawn_blocking(move || {
        let source = Provider::parse(&source_provider)?;
        let target = Provider::parse(&target_provider)?;
        if source == target {
            return Err("handoff destination must be a different provider".to_string());
        }
        let (resolved_id, path, used_fallback) =
            resolve_source_file(source, &cwd, source_session_id.as_deref())?;
        let events = match source {
            Provider::Claude => claude_events(&path)?,
            Provider::Codex => codex_events(&path)?,
        };
        if !events.iter().any(|event| event.role == "user") {
            return Err("the selected session has no transferable user messages".to_string());
        }
        let title = events
            .iter()
            .find(|event| event.role == "user")
            .map(|event| clipped(&event.text.replace(['\r', '\n'], " "), 80))
            .unwrap_or_else(|| format!("{} handoff", source.as_str()));
        let (rendered, omitted_event_count) =
            render_capsule(source, target, &resolved_id, &cwd, &events);
        let (content, redaction_count) = redact(rendered);
        Ok(HandoffDraft {
            source_provider: source.as_str().to_string(),
            target_provider: target.as_str().to_string(),
            source_session_id: resolved_id,
            cwd,
            title,
            content,
            included_event_count: events.len().saturating_sub(omitted_event_count),
            omitted_event_count,
            redaction_count,
            used_fallback,
        })
    })
    .await
    .map_err(|error| format!("prepare_agent_handoff task failed: {error}"))?
}

fn validate_handoff_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("invalid handoff id".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn materialize_agent_handoff(
    app: AppHandle,
    content: String,
) -> Result<HandoffArtifact, String> {
    if content.trim().is_empty() {
        return Err("handoff content is empty".to_string());
    }
    if content.len() > MATERIALIZED_BYTE_LIMIT {
        return Err(format!(
            "handoff content exceeds {MATERIALIZED_BYTE_LIMIT} bytes"
        ));
    }
    let root = crate::paths::profile_data_dir(&app)?.join("handoffs");
    tokio::task::spawn_blocking(move || {
        let handoff_id = nanoid::nanoid!(16);
        let context_dir = root.join(&handoff_id);
        fs::create_dir_all(&context_dir).map_err(|error| error.to_string())?;
        let context_path = context_dir.join("context.md");
        let temporary = context_dir.join("context.md.tmp");
        fs::write(&temporary, content).map_err(|error| error.to_string())?;
        fs::rename(&temporary, &context_path).map_err(|error| error.to_string())?;
        Ok(HandoffArtifact {
            handoff_id,
            context_dir: context_dir.to_string_lossy().to_string(),
            context_path: context_path.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(|error| format!("materialize_agent_handoff task failed: {error}"))?
}

#[tauri::command]
pub async fn complete_agent_handoff(app: AppHandle, handoff_id: String) -> Result<(), String> {
    validate_handoff_id(&handoff_id)?;
    let root = crate::paths::profile_data_dir(&app)?.join("handoffs");
    let target = root.join(&handoff_id);
    tokio::task::spawn_blocking(move || {
        if !target.exists() {
            return Ok(());
        }
        let canonical_root = fs::canonicalize(&root).map_err(|error| error.to_string())?;
        let canonical_target = fs::canonicalize(&target).map_err(|error| error.to_string())?;
        if canonical_target.parent() != Some(canonical_root.as_path()) || !canonical_target.is_dir()
        {
            return Err("handoff cleanup target is outside the handoff directory".to_string());
        }
        fs::remove_dir_all(canonical_target).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("complete_agent_handoff task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_common_secrets() {
        let input = "Authorization: Bearer abcdefgh\nOPENAI_API_KEY=sk-proj-abcdefghijklmnop\n";
        let (output, count) = redact(input.to_string());
        assert!(count >= 2);
        assert!(!output.contains("abcdefghijklmnop"));
        assert!(output.contains("[REDACTED]"));
    }

    #[test]
    fn capsule_prioritizes_user_requests() {
        let events = vec![
            HandoffEvent {
                role: "user",
                text: "Build the feature".into(),
            },
            HandoffEvent {
                role: "assistant",
                text: "Implemented parser".into(),
            },
            HandoffEvent {
                role: "tool",
                text: "cargo test".into(),
            },
            HandoffEvent {
                role: "user",
                text: "Keep the old terminal open".into(),
            },
        ];
        let (capsule, _) = render_capsule(
            Provider::Claude,
            Provider::Codex,
            "session-1",
            "C:\\repo",
            &events,
        );
        assert!(capsule.contains("Build the feature"));
        assert!(capsule.contains("Keep the old terminal open"));
        assert!(capsule.contains("Private reasoning"));
    }

    #[test]
    fn rejects_unsafe_cleanup_ids() {
        assert!(validate_handoff_id("safe_123-id").is_ok());
        assert!(validate_handoff_id("../outside").is_err());
        assert!(validate_handoff_id("").is_err());
    }
}
