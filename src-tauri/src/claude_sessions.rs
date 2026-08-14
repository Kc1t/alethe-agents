use serde::Serialize;
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

/// Encode um cwd no formato que o Claude Code usa pra nomear o subdir em
/// ~/.claude/projects/. Regra: trim de separators finais, depois substitui
/// `:`, `\` e `/` por `-`. Preserva case.
fn encode_cwd_for_claude(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches(|c: char| c == '\\' || c == '/');
    trimmed
        .chars()
        .map(|c| match c {
            ':' | '\\' | '/' => '-',
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

fn parse_session_file(
    id: String,
    path: PathBuf,
    metadata: &fs::Metadata,
) -> Option<ClaudeSessionMeta> {
    let file = fs::File::open(&path).ok()?;
    let reader = BufReader::new(file);

    let mut title: Option<String> = None;
    let mut first_user_prompt: Option<String> = None;
    let mut message_count: usize = 0;

    for line in reader.lines().map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let entry_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match entry_type {
            "ai-title" => {
                if title.is_none() {
                    title = value
                        .get("aiTitle")
                        .and_then(|v| v.as_str())
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty());
                }
            }
            "user" => {
                message_count += 1;
                if first_user_prompt.is_none() {
                    let content = value.get("message").and_then(|m| m.get("content"));
                    let preview = match content {
                        Some(serde_json::Value::String(s)) => Some(s.clone()),
                        Some(serde_json::Value::Array(blocks)) => blocks
                            .iter()
                            .find_map(|b| b.get("text").and_then(|t| t.as_str()).map(String::from)),
                        _ => None,
                    };
                    first_user_prompt = preview.map(|s| truncate_chars(s.trim(), 240));
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

/// Case-insensitive match de subdirs do projeto (Claude Code pode usar drive
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

/// `async` + `spawn_blocking`: varre diretórios de sessão no disco, mesma
/// classe de I/O bloqueante já corrigida em `cli_resolver.rs`; chamado a
/// cada spawn/validação de resumo de terminal (`XTermView`), então travar a
/// thread de despacho do Tauri aqui trava outros comandos IPC concorrentes.
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

#[tauri::command]
pub fn list_claude_sessions(cwd: String) -> Result<Vec<ClaudeSessionMeta>, String> {
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

#[derive(Serialize)]
pub struct ActivityDay {
    /// Data UTC no formato YYYY-MM-DD
    pub date: String,
    /// Número de mensagens (user + assistant) registradas nesse dia
    pub count: usize,
}

/// Conta mensagens por dia em todos os JSONLs de ~/.claude/projects/.
/// Retorna `days` dias contínuos terminando hoje (UTC), ordenados do mais
/// antigo pro mais recente. Dias sem atividade têm count=0.
#[tauri::command]
pub async fn get_claude_activity(days: usize) -> Result<Vec<ActivityDay>, String> {
    // Varredura pesada das sessões → roda em spawn_blocking pra NÃO travar a
    // thread principal do Tauri (comando sync bloqueia a UI inteira enquanto lê
    // os arquivos; com muitas sessões isso "congela" a Home ao abrir).
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

    // Limite inferior: arquivos modificados antes desse instante são ignorados
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
            // Pula arquivos não tocados na janela
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
        // Validação básica: posições 4 e 7 devem ser '-'
        if date.as_bytes().get(4) != Some(&b'-') || date.as_bytes().get(7) != Some(&b'-') {
            continue;
        }
        *counts.entry(date.to_string()).or_insert(0) += 1;
    }
}

/// Mesma janela do heatmap "atividade", mas somando Claude + Codex + OpenCode
/// em vez de só Claude. Claude e OpenCode contam por MENSAGEM (granularidade
/// real); Codex conta por ARQUIVO de sessão tocado no dia (mtime) — o formato
/// exato de timestamp por linha do rollout do Codex não está confirmado, e
/// contar por arquivo é uma aproximação honesta em vez de arriscar um nome de
/// campo errado e ficar sempre zerado silenciosamente.
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

    // Claude: reaproveita a varredura já existente (mesma lógica de get_claude_activity).
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

    // Codex: 1 sessão tocada = +1 no dia do mtime do arquivo (ver nota acima).
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

/// Constrói a janela contígua dos últimos `days` dias até hoje (UTC),
/// preenchendo zeros onde não houve atividade.
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

/// Hoje em UTC como tupla (year, month, day) — sem dependência de chrono.
fn today_utc_ymd() -> (i64, u32, u32) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    epoch_secs_to_ymd(secs)
}

fn days_ago_ymd(today: &(i64, u32, u32), days: usize) -> String {
    // Converte today pra epoch days, subtrai e reconverte
    let epoch_days = ymd_to_epoch_days(today.0, today.1, today.2);
    let target = epoch_days - days as i64;
    let (y, m, d) = epoch_days_to_ymd(target);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Converte segundos UNIX → (year, month, day) UTC. Algoritmo de Howard
/// Hinnant (date.h), funciona pra qualquer ano civil proleptic Gregoriano.
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
