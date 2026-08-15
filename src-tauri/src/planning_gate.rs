//!

//!

//!
//! Estrutura de `.planning/` (ver `assets/opencode-plugins/alethe-gsd-state.ts`):

//! sobrescrever o outro.

use serde::Serialize;
use std::path::Path;

/// dedicada (`gsd_record_step`, em `alethe-gsd-state.ts`) — nunca por parsing

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcedureStep {
    pub description: String,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GsdChildState {
    pub session_id: Option<String>,
    pub busy: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanningStatus {
    pub has_planning: bool,
    pub reported_complete: bool,
    pub progress: Option<u8>,
    pub roadmap_pending_count: Option<usize>,
    pub roadmap_total_count: Option<usize>,

    /// (`alethe-gsd-state.ts`) com o plano passo a passo, incluindo o

    /// exibir (ex.: dividir em linhas pro checklist do Briefing de Testes).
    pub notes: Option<String>,
}

/// Parse de `status.md`: linhas `Status: <valor>` / `Progress: <pct>%`.

/// (`Status: In Progress` + `Progress: 100%` esquecido) seja lido como
/// completo por engano.
fn parse_status_md(content: &str) -> (Option<String>, Option<u8>) {
    let mut status = None;
    let mut progress = None;
    for line in content.lines() {
        let Some((key, val)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_lowercase();
        let val = val.trim().trim_matches('"').trim_matches('\'');
        match key.as_str() {
            "status" => status = Some(val.to_lowercase()),
            "progress" => progress = val.trim_end_matches('%').trim().parse::<u8>().ok(),
            _ => {}
        }
    }
    (status, progress)
}

fn is_complete_status(status: &str) -> bool {
    matches!(status, "completed" | "complete" | "done")
}

/// Um item de checklist markdown (`- [ ] texto`/`- [x] texto`), com o texto

pub(crate) struct RoadmapItem {
    pub checked: bool,
    pub text: String,
}

pub(crate) fn parse_roadmap_items(content: &str) -> Vec<RoadmapItem> {
    let mut items = Vec::new();
    for line in content.lines() {
        let trimmed = line
            .trim_start()
            .trim_start_matches('-')
            .trim_start_matches('*')
            .trim();
        if let Some(rest) = trimmed.strip_prefix('[') {
            if let Some(mark) = rest.chars().next() {
                if rest.as_bytes().get(1) == Some(&b']') {
                    let text = rest[2..].trim().to_string();
                    items.push(RoadmapItem {
                        checked: mark != ' ',
                        text,
                    });
                }
            }
        }
    }
    items
}

/// Conta checkboxes markdown — wrapper fino sobre `parse_roadmap_items`.
fn count_roadmap_checkboxes(content: &str) -> (usize, usize) {
    let items = parse_roadmap_items(content);
    let total = items.len();
    let pending = items.iter().filter(|item| !item.checked).count();
    (pending, total)
}

pub(crate) fn compute_planning_status(worktree_root: &Path) -> PlanningStatus {
    let planning_dir = worktree_root.join(".planning");
    if !planning_dir.is_dir() {
        return PlanningStatus::default();
    }

    let status_content = std::fs::read_to_string(planning_dir.join("status.md")).ok();
    let task_content = std::fs::read_to_string(planning_dir.join("task.md")).ok();
    let plan_content = std::fs::read_to_string(planning_dir.join("plan.md")).ok();

    let (roadmap_pending_count, roadmap_total_count) = match &task_content {
        Some(content) if !content.trim().is_empty() => {
            let (pending, total) = count_roadmap_checkboxes(content);
            (Some(pending), Some(total))
        }
        _ => (None, None),
    };

    let notes = plan_content
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());

    let Some(status_content) = status_content.filter(|c| !c.trim().is_empty()) else {
        let reported_complete =
            roadmap_total_count.unwrap_or(0) > 0 && roadmap_pending_count == Some(0);
        return PlanningStatus {
            has_planning: true,
            reported_complete,
            progress: None,
            roadmap_pending_count,
            roadmap_total_count,
            notes,
        };
    };

    let (status, progress) = parse_status_md(&status_content);
    let reported_complete = match status {
        Some(s) => is_complete_status(&s),
        None => progress == Some(100),
    };

    PlanningStatus {
        has_planning: true,
        reported_complete,
        progress,
        roadmap_pending_count,
        roadmap_total_count,
        notes,
    }
}

/// principal) — `repository_root` resolve a raiz real do checkout passado,

#[tauri::command]
pub fn read_planning_status(repo_path: String) -> Result<PlanningStatus, String> {
    let root = crate::git_control::repository_root(&repo_path)?;
    Ok(compute_planning_status(&root))
}

#[tauri::command]
pub fn read_gsd_child_session(repo_path: String) -> Result<Option<String>, String> {
    let root = crate::git_control::repository_root(&repo_path)?;
    let content = std::fs::read_to_string(root.join(".planning").join(".gsd-child-session"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(content)
}

/// `laneVisible` da pane "GSD Sync" (aparece enquanto ocupada, colapsa

#[tauri::command]
pub fn read_gsd_child_busy(repo_path: String) -> Result<bool, String> {
    let root = crate::git_control::repository_root(&repo_path)?;
    Ok(root.join(".planning").join(".gsd-child-busy").is_file())
}

#[tauri::command]
pub fn read_gsd_child_error(repo_path: String) -> Result<Option<String>, String> {
    let root = crate::git_control::repository_root(&repo_path)?;
    let path = root.join(".planning").join(".gsd-child-error");
    let content = std::fs::read_to_string(&path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if content.is_some() {
        let _ = std::fs::remove_file(&path);
    }
    Ok(content)
}

fn read_gsd_child_state_inner(repo_path: String) -> Result<GsdChildState, String> {
    let root = crate::git_control::repository_root(&repo_path)?;
    let planning = root.join(".planning");
    let session_id = std::fs::read_to_string(planning.join(".gsd-child-session"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let busy = planning.join(".gsd-child-busy").is_file();
    let error = if session_id.is_some() {
        let path = planning.join(".gsd-child-error");
        let content = std::fs::read_to_string(&path)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if content.is_some() {
            let _ = std::fs::remove_file(path);
        }
        content
    } else {
        None
    };
    Ok(GsdChildState {
        session_id,
        busy,
        error,
    })
}

#[tauri::command]
pub async fn read_gsd_child_state(repo_path: String) -> Result<GsdChildState, String> {
    tokio::task::spawn_blocking(move || read_gsd_child_state_inner(repo_path))
        .await
        .map_err(|error| format!("read_gsd_child_state task failed: {error}"))?
}

#[tauri::command]
pub fn read_gsd_procedure(repo_path: String) -> Result<Vec<ProcedureStep>, String> {
    let root = crate::git_control::repository_root(&repo_path)?;
    let content = std::fs::read_to_string(root.join(".planning").join("procedure.json")).ok();
    let steps = content
        .and_then(|c| serde_json::from_str::<Vec<ProcedureStep>>(&c).ok())
        .unwrap_or_default();
    Ok(steps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("alethe-planning-gate-{label}-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn no_planning_dir_means_not_started() {
        let root = temp_dir("no-planning");
        let status = compute_planning_status(&root);
        assert!(!status.has_planning);
        assert!(!status.reported_complete);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn planning_dir_without_status_or_task_is_incomplete() {
        let root = temp_dir("empty-planning");
        fs::create_dir_all(root.join(".planning")).unwrap();
        let status = compute_planning_status(&root);
        assert!(status.has_planning);
        assert!(!status.reported_complete);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn status_md_complete_status_wins() {
        let root = temp_dir("status-complete");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("status.md"),
            "Status: Completed\nProgress: 100%\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        assert!(status.reported_complete);
        assert_eq!(status.progress, Some(100));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn status_md_status_overrides_conflicting_progress() {
        let root = temp_dir("status-conflict");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("status.md"),
            "Status: In Progress\nProgress: 100%\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        assert!(
            !status.reported_complete,
            "status desatualizado não pode vencer sobre progress esquecido em 100"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn task_fallback_when_status_md_missing() {
        let root = temp_dir("task-fallback");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("task.md"),
            "- [x] task 1\n- [x] task 2\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        assert!(status.reported_complete);
        assert_eq!(status.roadmap_pending_count, Some(0));
        assert_eq!(status.roadmap_total_count, Some(2));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn task_with_pending_items_is_reported_and_not_complete() {
        let root = temp_dir("task-pending");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("task.md"),
            "- [x] done 1\n- [ ] pending 1\n- [x] done 2\n- [ ] pending 2\n- [x] done 3\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        assert!(!status.reported_complete);
        assert_eq!(status.roadmap_pending_count, Some(2));
        assert_eq!(status.roadmap_total_count, Some(5));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notes_extracted_from_plan_md() {
        let root = temp_dir("plan-notes");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("plan.md"),
            "1. Criar o arquivo.\n2. Validar sua existência.\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        let notes = status.notes.expect("notes deveria estar presente");
        assert!(notes.contains("Criar o arquivo"));
        assert!(notes.contains("Validar sua existência"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notes_is_none_when_plan_md_missing_or_empty() {
        let root = temp_dir("plan-no-notes");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("status.md"),
            "Status: Completed\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        assert!(status.notes.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn read_planning_status_resolves_the_given_worktree_not_the_main_repo() {
        let root = temp_dir("worktree-resolve");
        crate::git_control::checked_output(&root, &["init", "-b", "main"]).unwrap();
        crate::git_control::checked_output(&root, &["config", "user.name", "Alethe Test"]).unwrap();
        crate::git_control::checked_output(
            &root,
            &["config", "user.email", "alethe@example.invalid"],
        )
        .unwrap();
        fs::write(root.join("a.txt"), "a\n").unwrap();
        crate::git_control::checked_output(&root, &["add", "-A"]).unwrap();
        crate::git_control::checked_output(&root, &["commit", "-m", "base"]).unwrap();

        let worktree = root.join("wt");
        crate::git_control::checked_output(
            &root,
            &[
                "worktree",
                "add",
                "-b",
                "agent-branch",
                worktree.to_str().unwrap(),
                "HEAD",
            ],
        )
        .unwrap();

        fs::create_dir_all(worktree.join(".planning")).unwrap();
        fs::write(
            worktree.join(".planning").join("status.md"),
            "Status: Completed\n",
        )
        .unwrap();

        let main_status = read_planning_status(root.to_string_lossy().into_owned()).unwrap();
        assert!(!main_status.has_planning);

        let worktree_status =
            read_planning_status(worktree.to_string_lossy().into_owned()).unwrap();
        assert!(worktree_status.reported_complete);

        fs::remove_dir_all(&root).unwrap();
    }

    /// `read_gsd_child_session`/`read_gsd_child_busy` passam por
    /// `repository_root` (igual `read_planning_status`) — precisam de um repo

    fn temp_git_repo(label: &str) -> std::path::PathBuf {
        let root = temp_dir(label);
        crate::git_control::checked_output(&root, &["init", "-b", "main"]).unwrap();
        crate::git_control::checked_output(&root, &["config", "user.name", "Alethe Test"]).unwrap();
        crate::git_control::checked_output(
            &root,
            &["config", "user.email", "alethe@example.invalid"],
        )
        .unwrap();
        fs::write(root.join("a.txt"), "a\n").unwrap();
        crate::git_control::checked_output(&root, &["add", "-A"]).unwrap();
        crate::git_control::checked_output(&root, &["commit", "-m", "base"]).unwrap();
        root
    }

    #[test]
    fn gsd_child_session_is_none_when_sentinel_missing() {
        let root = temp_git_repo("child-session-missing");
        fs::create_dir_all(root.join(".planning")).unwrap();
        assert_eq!(
            read_gsd_child_session(root.to_string_lossy().into_owned()).unwrap(),
            None
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gsd_child_session_reads_trimmed_sentinel_content() {
        let root = temp_git_repo("child-session-present");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join(".gsd-child-session"),
            "ses_abc123\n",
        )
        .unwrap();
        assert_eq!(
            read_gsd_child_session(root.to_string_lossy().into_owned()).unwrap(),
            Some("ses_abc123".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gsd_child_busy_reflects_sentinel_presence() {
        let root = temp_git_repo("child-busy");
        fs::create_dir_all(root.join(".planning")).unwrap();
        assert!(!read_gsd_child_busy(root.to_string_lossy().into_owned()).unwrap());
        fs::write(root.join(".planning").join(".gsd-child-busy"), "1").unwrap();
        assert!(read_gsd_child_busy(root.to_string_lossy().into_owned()).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gsd_child_error_is_none_when_sentinel_missing() {
        let root = temp_git_repo("child-error-missing");
        fs::create_dir_all(root.join(".planning")).unwrap();
        assert_eq!(
            read_gsd_child_error(root.to_string_lossy().into_owned()).unwrap(),
            None
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gsd_child_error_reads_and_consumes_sentinel() {
        let root = temp_git_repo("child-error-present");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join(".gsd-child-error"),
            "todos os modelos falharam\n",
        )
        .unwrap();
        assert_eq!(
            read_gsd_child_error(root.to_string_lossy().into_owned()).unwrap(),
            Some("todos os modelos falharam".to_string())
        );

        assert_eq!(
            read_gsd_child_error(root.to_string_lossy().into_owned()).unwrap(),
            None
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gsd_child_state_reads_all_sentinels_with_one_root_resolution() {
        let root = temp_git_repo("child-state");
        let planning = root.join(".planning");
        fs::create_dir_all(&planning).unwrap();
        fs::write(planning.join(".gsd-child-session"), "ses_combined\n").unwrap();
        fs::write(planning.join(".gsd-child-busy"), "1").unwrap();
        fs::write(planning.join(".gsd-child-error"), "model failed\n").unwrap();

        let state = read_gsd_child_state_inner(root.to_string_lossy().into_owned()).unwrap();

        assert_eq!(state.session_id.as_deref(), Some("ses_combined"));
        assert!(state.busy);
        assert_eq!(state.error.as_deref(), Some("model failed"));
        assert!(!planning.join(".gsd-child-error").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
