//! Reads a checkout's `.planning/` folder and reports how far its planning says the work has got.
//!
//! Three files, each optional, read in order of authority:
//!
//! - `status.md` — `Status: <value>` / `Progress: <pct>%`. When present it decides, and an explicit
//!   status wins over a conflicting percentage.
//! - `task.md` — a markdown checklist. Used as the fallback when there is no `status.md`: zero
//!   pending items among at least one checkbox counts as complete, so a project that only keeps a
//!   checklist still reports progress.
//! - `plan.md` — the step-by-step plan, passed through as prose for the UI to present.
//!
//! Everything here resolves the path it is given through `repository_root`, so a worktree reports
//! its own planning rather than the main checkout's — an agent working in isolation has planning of
//! its own, and reading the wrong one would report another branch's progress as this one's.
//!
//! Nothing in Alethe writes these files; they are whatever the user or an agent puts there.

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanningStatus {
    pub has_planning: bool,
    pub reported_complete: bool,
    pub progress: Option<u8>,
    pub roadmap_pending_count: Option<usize>,
    pub roadmap_total_count: Option<usize>,

    /// First lines of `.planning/plan.md`, when it exists — the step-by-step plan, handed to the
    /// frontend as raw text for it to present however it needs (the test briefing splits it into a
    /// checklist, for instance).
    pub notes: Option<String>,
}

/// Parses `status.md`: `Status: <value>` / `Progress: <pct>%` lines, in any order, quotes and a
/// trailing `%` tolerated. Both are returned rather than reconciled here, so the caller can let an
/// explicit status win — a file left at `Status: In Progress` with a stale `Progress: 100%` must
/// not read as complete.
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

/// One markdown checklist item (`- [ ] text` / `- [x] text`). Any mark other than a space counts
/// as checked, since `[x]` and `[X]` are both common and neither is worth failing over.
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
        // Sem status.md: fallback pro task.md — 0 pendentes entre pelo menos
        // uma checkbox conta como completo pra quem não quer manter status.md.
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

/// Planning status for the checkout at `repo_path`. `repository_root` resolves the real root of
/// *that* checkout, so passing a worktree reports the worktree's own planning rather than the main
/// repository's — an agent working in isolation has planning of its own, and reading the main
/// checkout's would report another branch's progress as this one's.
#[tauri::command]
pub fn read_planning_status(repo_path: String) -> Result<PlanningStatus, String> {
    let root = crate::git_control::repository_root(&repo_path)?;
    Ok(compute_planning_status(&root))
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

}
