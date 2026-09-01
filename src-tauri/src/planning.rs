use nanoid::nanoid;
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::git_control::{checked_output, git_command};

#[derive(Default)]
pub struct PlanningWatchers(pub Arc<Mutex<HashMap<String, RecommendedWatcher>>>);

#[tauri::command]
pub fn start_gsd_watcher(
    _app: tauri::AppHandle,
    state: tauri::State<'_, PlanningWatchers>,
    project_id: String,
    repo_path: String,
) -> Result<(), String> {
    start_gsd_watcher_core(&state, project_id, repo_path)
}

/// Core without `AppHandle`/`tauri::State` — split out so the watcher logic
/// can be driven by any owner of a `PlanningWatchers`, not just the one
/// Tauri manages. The `State` wrapper above never used anything besides the
/// inner map anyway.
pub fn start_gsd_watcher_core(
    watchers: &PlanningWatchers,
    project_id: String,
    repo_path: String,
) -> Result<(), String> {
    let repo_root = crate::git_control::repository_root(&repo_path)?;
    let planning_dir = repo_root.join(".planning");
    if !planning_dir.is_dir() {
        std::fs::create_dir_all(&planning_dir).map_err(|e| format!("mkdir_failed:{e}"))?;
    }

    let mut map = watchers.0.lock().map_err(|e| e.to_string())?;
    let key = format!("{}:{}", project_id, planning_dir.to_string_lossy());
    if map.contains_key(&key) {
        return Ok(());
    }

    let project_id_clone = project_id.clone();
    let planning_dir_clone = planning_dir.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            if !matches!(
                event.kind,
                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
            ) {
                return;
            }

            // Publica no EventBus com correlation_id usando nanoid!()
            let correlation_id = format!("gsd-{}", nanoid!());
            crate::event_bus::publish_event_simple(
                "PlanningUpdated",
                &correlation_id,
                Some(project_id_clone.clone()),
                None,
                serde_json::json!({
                    "action": format!("{:?}", event.kind),
                    "planning_dir": planning_dir_clone.to_string_lossy().to_string(),
                }),
            );
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&planning_dir, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    map.insert(key, watcher);
    Ok(())
}

#[tauri::command]
pub fn stop_gsd_watcher(
    state: tauri::State<'_, PlanningWatchers>,
    project_id: String,
    repo_path: String,
) -> Result<(), String> {
    stop_gsd_watcher_core(&state, project_id, repo_path)
}

pub fn stop_gsd_watcher_core(
    watchers: &PlanningWatchers,
    project_id: String,
    repo_path: String,
) -> Result<(), String> {
    let repo_root = crate::git_control::repository_root(&repo_path)?;
    let planning_dir = repo_root.join(".planning");
    let key = format!("{}:{}", project_id, planning_dir.to_string_lossy());

    let mut map = watchers.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut watcher) = map.remove(&key) {
        let _ = watcher.unwatch(&planning_dir);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// RFC-005 — Auditoria do planejamento (versionamento de tarefas via Git).
//

// ---------------------------------------------------------------------------

const PLANNING_DIR: &str = ".planning";
/// Separadores ASCII (unit/record) no pretty-format do git log — imunes a
/// mensagens de commit com caracteres "normais".
const FIELD_SEP: char = '\u{1f}';
const RECORD_SEP: char = '\u{1e}';

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanningCommit {
    pub hash: String,
    pub author: String,
    pub timestamp_ms: u64,
    pub subject: String,
    pub agent_id: Option<String>,
}

fn planning_has_changes(root: &Path) -> Result<bool, String> {
    let output = checked_output(root, &["status", "--porcelain", "--", PLANNING_DIR])?;
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn audit_record(
    root: &Path,
    agent_id: Option<&str>,
    reason: Option<&str>,
    project_id: Option<String>,
) -> Result<Option<PlanningCommit>, String> {
    if !root.join(PLANNING_DIR).is_dir() {
        return Err("planning_directory_not_found".to_string());
    }
    if !planning_has_changes(root)? {
        return Ok(None);
    }

    checked_output(root, &["add", "--", PLANNING_DIR])?;
    let subject = format!(
        "gsd(alethe): {}",
        reason
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .unwrap_or("planning update")
    );
    let trailer = format!("Alethe-Agent: {}", agent_id.unwrap_or("unknown"));
    // Scoped commit: `commit -- .planning` guarantees staged changes from
    // other directories do NOT get pulled into this audit commit.
    checked_output(
        root,
        &["commit", "-m", &subject, "-m", &trailer, "--", PLANNING_DIR],
    )?;

    let hash = checked_output(root, &["rev-parse", "HEAD"])
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())?;

    let commit = PlanningCommit {
        hash: hash.clone(),
        author: String::new(),
        timestamp_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        subject,
        agent_id: agent_id.map(|s| s.to_string()),
    };
    crate::event_bus::publish_event_simple(
        "PlanningCommitted",
        &format!("gsd-audit-{}", nanoid!()),
        project_id,
        commit.agent_id.clone(),
        serde_json::json!({ "hash": hash, "subject": commit.subject }),
    );
    Ok(Some(commit))
}

#[tauri::command]
pub fn planning_audit_record(
    repo_path: String,
    agent_id: Option<String>,
    reason: Option<String>,
    project_id: Option<String>,
) -> Result<Option<PlanningCommit>, String> {
    let root = crate::git_control::repository_root(&repo_path)?;
    audit_record(&root, agent_id.as_deref(), reason.as_deref(), project_id)
}

#[tauri::command]
pub fn planning_audit_history(
    repo_path: String,
    limit: Option<u32>,
) -> Result<Vec<PlanningCommit>, String> {
    let root = crate::git_control::repository_root(&repo_path)?;
    let count = limit.unwrap_or(50).min(500).to_string();
    let format = format!(
        "%H{FIELD_SEP}%an{FIELD_SEP}%ct{FIELD_SEP}%s{FIELD_SEP}%(trailers:key=Alethe-Agent,valueonly,separator=,){RECORD_SEP}"
    );
    // With no commits yet (new repo) the log fails — return an empty history.
    let output = match git_command(
        &root,
        &[
            "log",
            "-n",
            &count,
            &format!("--pretty=format:{format}"),
            "--",
            PLANNING_DIR,
        ],
    ) {
        Ok(output) if output.status.success() => output,
        _ => return Ok(Vec::new()),
    };
    let raw = String::from_utf8_lossy(&output.stdout);
    let mut commits = Vec::new();
    for record in raw.split(RECORD_SEP) {
        let record = record.trim_matches(['\n', '\r']);
        if record.is_empty() {
            continue;
        }
        let fields: Vec<&str> = record.split(FIELD_SEP).collect();
        if fields.len() < 4 {
            continue;
        }
        let agent = fields
            .get(4)
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        commits.push(PlanningCommit {
            hash: fields[0].to_string(),
            author: fields[1].to_string(),
            timestamp_ms: fields[2].parse::<u64>().unwrap_or(0).saturating_mul(1000),
            subject: fields[3].to_string(),
            agent_id: agent,
        });
    }
    Ok(commits)
}

// --- Auto-commit dirigido por eventos (opt-in) ---------------------------------

static AUTOCOMMIT_ENABLED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn set_planning_autocommit(enabled: bool) -> Result<(), String> {
    AUTOCOMMIT_ENABLED.store(enabled, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn get_planning_autocommit() -> Result<bool, String> {
    Ok(AUTOCOMMIT_ENABLED.load(Ordering::SeqCst))
}

pub fn start_planning_autocommit_loop() {
    use std::sync::OnceLock;
    static GENERATIONS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    let generations = GENERATIONS.get_or_init(|| Mutex::new(HashMap::new()));

    tauri::async_runtime::spawn(async move {
        let mut rx = crate::event_bus::subscribe();
        while let Ok(event) = rx.recv().await {
            if event.event_type != "PlanningUpdated" || !AUTOCOMMIT_ENABLED.load(Ordering::SeqCst) {
                continue;
            }
            let Some(planning_dir) = event
                .data
                .get("planning_dir")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
            else {
                continue;
            };
            let my_generation = {
                let mut map = generations.lock().unwrap();
                let entry = map.entry(planning_dir.clone()).or_insert(0);
                *entry += 1;
                *entry
            };
            let project_id = event.task_id.clone();
            let generations = generations;
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;

                let latest = generations
                    .lock()
                    .unwrap()
                    .get(&planning_dir)
                    .copied()
                    .unwrap_or(0);
                if latest != my_generation {
                    return;
                }
                let Some(root) = Path::new(&planning_dir).parent().map(|p| p.to_path_buf()) else {
                    return;
                };
                if let Err(error) = audit_record(&root, None, Some("auto-commit"), project_id) {
                    eprintln!("[planning] auto-commit falhou: {error}");
                }
            });
        }
    });
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub id: String,
    pub project_id: String,
    pub terminal_id: Option<String>,
    pub title: String,
    pub file_path: String,
    pub relative_path: String,
    pub created_at_ms: u64,
    pub modified_at_ms: u64,
    pub content: Option<String>,
}

#[tauri::command]
pub fn list_project_plans(repo_path: String, project_id: String) -> Result<Vec<PlanItem>, String> {
    list_project_plans_core(&repo_path, &project_id)
}

pub fn list_project_plans_core(repo_path: &str, project_id: &str) -> Result<Vec<PlanItem>, String> {
    let repo_root = Path::new(repo_path);
    let plans_dir = repo_root.join(".alethe").join("plans");
    if !plans_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut plans = Vec::new();
    collect_plans_recursive(&plans_dir, &plans_dir, repo_root, project_id, &mut plans)?;
    plans.sort_by(|a, b| b.modified_at_ms.cmp(&a.modified_at_ms));
    Ok(plans)
}

fn collect_plans_recursive(
    current_dir: &Path,
    plans_root: &Path,
    repo_root: &Path,
    project_id: &str,
    plans: &mut Vec<PlanItem>,
) -> Result<(), String> {
    let entries = match std::fs::read_dir(current_dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_plans_recursive(&path, plans_root, repo_root, project_id, plans)?;
        } else if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext == "md" || ext == "markdown" {
                    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
                    let modified_at_ms = metadata
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    let created_at_ms = metadata
                        .created()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(modified_at_ms);

                    let relative_path = path
                        .strip_prefix(repo_root)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/");

                    let stem = path
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| "Plan".to_string());

                    // Infer terminal_id if saved in .alethe/plans/<terminal_id>/...
                    let terminal_id = path
                        .parent()
                        .and_then(|p| p.strip_prefix(plans_root).ok())
                        .and_then(|p| p.iter().next())
                        .map(|seg| seg.to_string_lossy().to_string());

                    let title = extract_plan_title(&path).unwrap_or_else(|| stem.clone());

                    plans.push(PlanItem {
                        id: stem,
                        project_id: project_id.to_string(),
                        terminal_id,
                        title,
                        file_path: path.to_string_lossy().to_string(),
                        relative_path,
                        created_at_ms,
                        modified_at_ms,
                        content: None,
                    });
                }
            }
        }
    }
    Ok(())
}

fn extract_plan_title(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(title) = trimmed.strip_prefix("# ") {
            let clean = title.trim();
            if !clean.is_empty() {
                return Some(clean.to_string());
            }
        }
    }
    None
}

#[tauri::command]
pub fn save_project_plan(
    repo_path: String,
    project_id: String,
    terminal_id: Option<String>,
    filename: String,
    content: String,
) -> Result<PlanItem, String> {
    let repo_root = Path::new(&repo_path);
    let mut target_dir = repo_root.join(".alethe").join("plans");
    if let Some(ref tid) = terminal_id {
        target_dir = target_dir.join(tid);
    }
    std::fs::create_dir_all(&target_dir).map_err(|e| format!("failed to create plan dir: {e}"))?;

    let file_stem = if filename.is_empty() {
        format!("plan_{}", crate::provider_common::now_ms())
    } else {
        filename
            .strip_suffix(".md")
            .unwrap_or(&filename)
            .to_string()
    };

    let target_file = target_dir.join(format!("{file_stem}.md"));
    std::fs::write(&target_file, &content).map_err(|e| format!("failed to write plan: {e}"))?;

    let title = extract_plan_title(&target_file).unwrap_or_else(|| file_stem.clone());
    let relative_path = target_file
        .strip_prefix(repo_root)
        .unwrap_or(&target_file)
        .to_string_lossy()
        .replace('\\', "/");
    let now = crate::provider_common::now_ms();

    Ok(PlanItem {
        id: file_stem,
        project_id,
        terminal_id,
        title,
        file_path: target_file.to_string_lossy().to_string(),
        relative_path,
        created_at_ms: now,
        modified_at_ms: now,
        content: Some(content),
    })
}

#[tauri::command]
pub fn patch_project_plan(
    file_path: String,
    target_content: String,
    replacement_content: String,
) -> Result<PlanItem, String> {
    let path = Path::new(&file_path);
    if !path.is_file() {
        return Err(format!("plan file not found: {file_path}"));
    }
    let current = std::fs::read_to_string(path).map_err(|e| format!("read failed: {e}"))?;
    if !current.contains(&target_content) {
        return Err("target content to replace was not found in the plan".to_string());
    }
    let updated = current.replacen(&target_content, &replacement_content, 1);
    std::fs::write(path, &updated).map_err(|e| format!("write failed: {e}"))?;

    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let modified_at_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(crate::provider_common::now_ms);

    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Plan".to_string());
    let title = extract_plan_title(path).unwrap_or_else(|| stem.clone());

    Ok(PlanItem {
        id: stem,
        project_id: "".to_string(),
        terminal_id: None,
        title,
        file_path: path.to_string_lossy().to_string(),
        relative_path: path.to_string_lossy().to_string(),
        created_at_ms: modified_at_ms,
        modified_at_ms,
        content: Some(updated),
    })
}

#[tauri::command]
pub fn append_plan_diagram(
    file_path: String,
    title: String,
    mermaid_code: String,
) -> Result<PlanItem, String> {
    let path = Path::new(&file_path);
    if !path.is_file() {
        return Err(format!("plan file not found: {file_path}"));
    }
    let current = std::fs::read_to_string(path).map_err(|e| format!("read failed: {e}"))?;
    let diagram_block = format!(
        "\n\n### {}\n\n```mermaid\n{}\n```\n",
        if title.is_empty() { "Architecture Diagram" } else { &title },
        mermaid_code.trim()
    );
    let updated = format!("{}{}", current.trim_end(), diagram_block);
    std::fs::write(path, &updated).map_err(|e| format!("write failed: {e}"))?;

    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let modified_at_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(crate::provider_common::now_ms);

    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Plan".to_string());
    let title = extract_plan_title(path).unwrap_or_else(|| stem.clone());

    Ok(PlanItem {
        id: stem,
        project_id: "".to_string(),
        terminal_id: None,
        title,
        file_path: path.to_string_lossy().to_string(),
        relative_path: path.to_string_lossy().to_string(),
        created_at_ms: modified_at_ms,
        modified_at_ms,
        content: Some(updated),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn planning_repo() -> (std::path::PathBuf, String) {
        let root = std::env::temp_dir().join(format!("alethe-planning-{}", nanoid!(8)));
        fs::create_dir_all(root.join(PLANNING_DIR)).unwrap();
        let run = |args: &[&str]| checked_output(&root, args).unwrap();
        run(&["init", "-b", "main"]);
        run(&["config", "user.name", "Alethe Test"]);
        run(&["config", "user.email", "alethe@example.invalid"]);
        fs::write(root.join("code.txt"), "code\n").unwrap();
        fs::write(root.join(PLANNING_DIR).join("roadmap.md"), "- [ ] task 1\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "base"]);
        let root_str = root.to_string_lossy().into_owned();
        (root, root_str)
    }

    #[test]
    fn records_scoped_audit_commit_with_agent_trailer() {
        let (root, root_str) = planning_repo();

        assert!(planning_audit_record(root_str.clone(), None, None, None)
            .unwrap()
            .is_none());

        fs::write(root.join(PLANNING_DIR).join("roadmap.md"), "- [x] task 1\n").unwrap();
        fs::write(root.join("code.txt"), "changed\n").unwrap();
        let commit = planning_audit_record(
            root_str.clone(),
            Some("agent-42".into()),
            Some("concluiu task 1".into()),
            None,
        )
        .unwrap()
        .expect("devia commitar");
        assert!(commit.subject.contains("concluiu task 1"));

        let status = checked_output(&root, &["status", "--porcelain"]).unwrap();
        let status = String::from_utf8_lossy(&status.stdout);
        assert!(status.contains("code.txt"));
        assert!(!status.contains("roadmap.md"));

        let history = planning_audit_history(root_str, Some(10)).unwrap();
        assert_eq!(history.len(), 2); // base + auditoria
        assert_eq!(history[0].agent_id.as_deref(), Some("agent-42"));
        assert!(history[0].subject.contains("gsd(alethe)"));
        assert!(history[0].timestamp_ms > 0);
        assert_eq!(history[1].agent_id, None);

        fs::remove_dir_all(root).unwrap();
    }
}
