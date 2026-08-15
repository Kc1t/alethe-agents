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
    let repo_root = crate::git_control::repository_root(&repo_path)?;
    let planning_dir = repo_root.join(".planning");
    if !planning_dir.is_dir() {
        std::fs::create_dir_all(&planning_dir).map_err(|e| format!("mkdir_failed:{e}"))?;
    }

    let mut map = state.0.lock().map_err(|e| e.to_string())?;
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
    let repo_root = crate::git_control::repository_root(&repo_path)?;
    let planning_dir = repo_root.join(".planning");
    let key = format!("{}:{}", project_id, planning_dir.to_string_lossy());

    let mut map = state.0.lock().map_err(|e| e.to_string())?;
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
