//! RFC-003 — Worktree Manager (dual-mode).
//!

//!

//!   `<repo>/.alethe/worktrees/<id>/`, compartilhando o `.git` do repo. Nesse

//! - **LocalCopy** (pesado/mais funcional): `git clone --local` gera um repo

//!   dois modos ao listar/remover.
//!

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::git_control::{
    checked_output, git_command, main_repository_root, repository_root, with_lock_awareness,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeMode {
    GitWorktree,
    LocalCopy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub agent_id: String,
    pub path: String,
    pub branch: String,
    pub mode: WorktreeMode,
}

fn sanitize_id(agent_id: &str) -> Result<String, String> {
    let trimmed = agent_id.trim();
    if trimmed.is_empty() {
        return Err("invalid_agent_id".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid_agent_id".to_string());
    }
    Ok(trimmed.to_string())
}

fn worktrees_base(root: &Path) -> PathBuf {
    root.join(".alethe").join("worktrees")
}

/// Remove o prefixo verbatim `\\?\` do Windows. `repository_root` canonicaliza os

/// (ex.: destino de `worktree add`/`clone`) — como `current_dir` funciona normal

/// Windows).
pub(crate) fn git_arg(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let stripped = raw
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| raw.strip_prefix(r"\\?\").map(|rest| rest.to_string()))
        .unwrap_or_else(|| raw.into_owned());
    stripped
}

fn detect_mode(dir: &Path) -> Option<WorktreeMode> {
    let marker = dir.join(".git");
    if marker.is_file() {
        Some(WorktreeMode::GitWorktree)
    } else if marker.is_dir() {
        Some(WorktreeMode::LocalCopy)
    } else {
        None
    }
}

fn current_branch(dir: &Path) -> String {
    git_command(dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn worktree_provision(
    repo: String,
    agent_id: String,
    mode: WorktreeMode,
) -> Result<WorktreeInfo, String> {
    tokio::task::spawn_blocking(move || worktree_provision_inner(repo, agent_id, mode))
        .await
        .map_err(|error| format!("worktree_provision: falha na task bloqueante: {error}"))?
}

pub(crate) fn worktree_provision_inner(
    repo: String,
    agent_id: String,
    mode: WorktreeMode,
) -> Result<WorktreeInfo, String> {
    // dentro da outra.
    let root = main_repository_root(&repo)?;
    let id = sanitize_id(&agent_id)?;
    let base = worktrees_base(&root);
    std::fs::create_dir_all(&base).map_err(|error| format!("mkdir_failed:{error}"))?;

    let dest = base.join(&id);
    if dest.exists() {
        return Err("worktree_exists".to_string());
    }
    let branch = format!("alethe/agent-{id}");
    let dest_arg = git_arg(&dest);

    match mode {
        WorktreeMode::GitWorktree => {
            checked_output(
                &root,
                &["worktree", "add", "-b", &branch, &dest_arg, "HEAD"],
            )?;
        }
        WorktreeMode::LocalCopy => {
            let root_arg = git_arg(&root);
            // `--local` usa hardlinks nos objetos: independente do repo original,

            checked_output(&root, &["clone", "--local", &root_arg, &dest_arg])?;
            checked_output(&dest, &["checkout", "-b", &branch])?;
        }
    }

    Ok(WorktreeInfo {
        agent_id: id,
        path: git_arg(&dest),
        branch,
        mode,
    })
}

#[tauri::command]
pub async fn worktree_list(repo: String) -> Result<Vec<WorktreeInfo>, String> {
    tokio::task::spawn_blocking(move || worktree_list_inner(repo))
        .await
        .map_err(|error| format!("worktree_list: falha na task bloqueante: {error}"))?
}

pub(crate) fn worktree_list_inner(repo: String) -> Result<Vec<WorktreeInfo>, String> {
    let root = repository_root(&repo)?;
    let base = worktrees_base(&root);
    let mut result = Vec::new();
    if !base.is_dir() {
        return Ok(result);
    }
    let entries = std::fs::read_dir(&base).map_err(|error| format!("read_dir_failed:{error}"))?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(mode) = detect_mode(&dir) else {
            continue;
        };
        let agent_id = dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        result.push(WorktreeInfo {
            agent_id,
            path: git_arg(&dir),
            branch: current_branch(&dir),
            mode,
        });
    }
    result.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
    Ok(result)
}

#[tauri::command]
pub async fn worktree_remove(repo: String, agent_id: String, force: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || worktree_remove_inner(repo, agent_id, force))
        .await
        .map_err(|error| format!("worktree_remove: falha na task bloqueante: {error}"))?
}

pub(crate) fn worktree_remove_inner(
    repo: String,
    agent_id: String,
    force: bool,
) -> Result<(), String> {
    let root = repository_root(&repo)?;
    let id = sanitize_id(&agent_id)?;
    let base = worktrees_base(&root);
    let dest = base.join(&id);
    if !dest.exists() {
        return Err("worktree_not_found".to_string());
    }

    // que o destino esteja dentro de `<repo>/.alethe/worktrees`.
    let canon_base = base
        .canonicalize()
        .map_err(|_| "invalid_worktree_path".to_string())?;
    let canon_dest = dest
        .canonicalize()
        .map_err(|_| "invalid_worktree_path".to_string())?;
    if !canon_dest.starts_with(&canon_base) {
        return Err("invalid_worktree_path".to_string());
    }

    match detect_mode(&dest) {
        Some(WorktreeMode::GitWorktree) => {
            let dest_arg = git_arg(&canon_dest);

            with_lock_awareness(&canon_dest, || {
                if force {
                    checked_output(&root, &["worktree", "remove", "--force", &dest_arg])
                } else {
                    checked_output(&root, &["worktree", "remove", &dest_arg])
                }
            })?;
        }

        _ => {
            std::fs::remove_dir_all(&canon_dest)
                .map_err(|error| format!("remove_failed:{error}"))?;
        }
    }
    Ok(())
}

/// Trava administrativamente um worktree (`git worktree lock`), com motivo

#[tauri::command]
pub async fn worktree_lock(
    repo: String,
    agent_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || worktree_lock_inner(repo, agent_id, reason))
        .await
        .map_err(|error| format!("worktree_lock: falha na task bloqueante: {error}"))?
}

pub(crate) fn worktree_lock_inner(
    repo: String,
    agent_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    let root = repository_root(&repo)?;
    let id = sanitize_id(&agent_id)?;
    let dest = worktrees_base(&root).join(&id);
    if !dest.exists() {
        return Err("worktree_not_found".to_string());
    }
    let dest_arg = git_arg(&dest);
    match reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => checked_output(&root, &["worktree", "lock", "--reason", value, &dest_arg])?,
        None => checked_output(&root, &["worktree", "lock", &dest_arg])?,
    };
    Ok(())
}

#[tauri::command]
pub async fn worktree_unlock(repo: String, agent_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || worktree_unlock_inner(repo, agent_id))
        .await
        .map_err(|error| format!("worktree_unlock: falha na task bloqueante: {error}"))?
}

pub(crate) fn worktree_unlock_inner(repo: String, agent_id: String) -> Result<(), String> {
    let root = repository_root(&repo)?;
    let id = sanitize_id(&agent_id)?;
    let dest = worktrees_base(&root).join(&id);
    if !dest.exists() {
        return Err("worktree_not_found".to_string());
    }
    let dest_arg = git_arg(&dest);

    checked_output(&root, &["worktree", "unlock", &dest_arg])?;
    Ok(())
}

#[tauri::command]
pub async fn worktree_fetch_branch(repo: String, agent_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || worktree_fetch_branch_inner(repo, agent_id))
        .await
        .map_err(|error| format!("worktree_fetch_branch: falha na task bloqueante: {error}"))?
}

pub(crate) fn worktree_fetch_branch_inner(repo: String, agent_id: String) -> Result<(), String> {
    let root = repository_root(&repo)?;
    let id = sanitize_id(&agent_id)?;
    let env = worktrees_base(&root).join(&id);
    let branch = format!("alethe/agent-{id}");

    match detect_mode(&env) {
        Some(WorktreeMode::LocalCopy) => {
            let env_arg = git_arg(&env);
            let refspec = format!("+refs/heads/{branch}:refs/heads/{branch}");
            checked_output(&root, &["fetch", &env_arg, &refspec])?;
            Ok(())
        }
        Some(WorktreeMode::GitWorktree) => Ok(()),
        None => Err("worktree_not_found".to_string()),
    }
}

/// `git merge` only moves commits — an agent that wrote files in the worktree
/// without ever running `git commit` leaves its branch with no new commit
/// relative to the target, so the merge silently no-ops (`merged: true`
/// reported, nothing actually changes upstream). Called before
/// `merge_prepare`/`merge_analyze` in the "Integrate" flow to auto-commit
/// whatever is pending, so the user/agent never has to remember to commit by
/// hand. No-op on an already-clean worktree.
#[tauri::command]
pub async fn worktree_commit_pending(repo: String, agent_id: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || worktree_commit_pending_inner(repo, agent_id))
        .await
        .map_err(|error| format!("worktree_commit_pending: blocking task failed: {error}"))?
}

pub(crate) fn worktree_commit_pending_inner(
    repo: String,
    agent_id: String,
) -> Result<bool, String> {
    let env = resolve_worktree_env(&repo, &agent_id)?;
    commit_all_pending(&env, "Agent work (auto-commit before integration)")
}

/// Shared by the three pending-commit operations (auto/list/commit-with-message).
fn resolve_worktree_env(repo: &str, agent_id: &str) -> Result<PathBuf, String> {
    // main_repository_root, not repository_root: same reason as
    // worktree_provision_inner — `repo` may already be an isolated worktree
    // if the project has no "plain" terminal left to use as a reference.
    let root = main_repository_root(repo)?;
    let id = sanitize_id(agent_id)?;
    let env = worktrees_base(&root).join(&id);
    if detect_mode(&env).is_none() {
        return Err("worktree_not_found".to_string());
    }
    Ok(env)
}

/// Mirrors `isRealWork()` in `assets/opencode-plugins/alethe-gsd-state.ts` —
/// Alethe's own infrastructure (GSD plugin in `.opencode/`, GSD Sync state in
/// `.planning/`, the `opencode.json` Alethe writes on every spawn) is never
/// real agent work in this worktree and must not be auto-committed/merged.
fn is_real_work(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with(".planning/")
        && !path.starts_with(".opencode/")
        && path != "opencode.json"
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChange {
    pub path: String,
    pub status: String,
}

fn parse_porcelain(output: &str) -> Vec<PendingChange> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| PendingChange {
            status: line.get(0..2).unwrap_or("").trim().to_string(),
            path: line.get(3..).unwrap_or("").trim().to_string(),
        })
        .filter(|change| is_real_work(&change.path))
        .collect()
}

fn commit_all_pending(env: &Path, message: &str) -> Result<bool, String> {
    let status = checked_output(env, &["status", "--porcelain"])?;
    let changes = parse_porcelain(&String::from_utf8_lossy(&status.stdout));
    if changes.is_empty() {
        return Ok(false);
    }
    let message = if message.trim().is_empty() {
        "Agent work (auto-commit before integration)"
    } else {
        message
    };
    // Never `add -A`: stage only the real paths (filtered above) so Alethe's
    // own infrastructure never rides along into the commit.
    let mut add_args: Vec<&str> = vec!["add", "--"];
    add_args.extend(changes.iter().map(|change| change.path.as_str()));
    checked_output(env, &add_args)?;
    checked_output(env, &["commit", "-m", message])?;
    Ok(true)
}

/// Lists what's pending (staged/unstaged/untracked) in an agent worktree
/// without touching anything — used by the confirmation dialog before
/// integrating, so the user can review and write the commit message before
/// `worktree_commit_worktree` actually runs.
#[tauri::command]
pub async fn worktree_pending_changes(
    repo: String,
    agent_id: String,
) -> Result<Vec<PendingChange>, String> {
    tokio::task::spawn_blocking(move || worktree_pending_changes_inner(repo, agent_id))
        .await
        .map_err(|error| format!("worktree_pending_changes: blocking task failed: {error}"))?
}

pub(crate) fn worktree_pending_changes_inner(
    repo: String,
    agent_id: String,
) -> Result<Vec<PendingChange>, String> {
    let env = resolve_worktree_env(&repo, &agent_id)?;
    let status = checked_output(&env, &["status", "--porcelain"])?;
    Ok(parse_porcelain(&String::from_utf8_lossy(&status.stdout)))
}

/// Like `worktree_commit_pending`, but with the message the user chose in the
/// confirmation dialog instead of the generic text — still a no-op on an
/// already-clean worktree.
#[tauri::command]
pub async fn worktree_commit_worktree(
    repo: String,
    agent_id: String,
    message: String,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || worktree_commit_worktree_inner(repo, agent_id, message))
        .await
        .map_err(|error| format!("worktree_commit_worktree: blocking task failed: {error}"))?
}

pub(crate) fn worktree_commit_worktree_inner(
    repo: String,
    agent_id: String,
    message: String,
) -> Result<bool, String> {
    let env = resolve_worktree_env(&repo, &agent_id)?;
    commit_all_pending(&env, &message)
}

#[tauri::command]
pub async fn worktree_cleanup(repo: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || worktree_cleanup_inner(repo))
        .await
        .map_err(|error| format!("worktree_cleanup: falha na task bloqueante: {error}"))?
}

pub(crate) fn worktree_cleanup_inner(repo: String) -> Result<(), String> {
    let root = repository_root(&repo)?;
    checked_output(&root, &["worktree", "prune"])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::worktree_cleanup_inner as worktree_cleanup;
    use super::worktree_fetch_branch_inner as worktree_fetch_branch;
    use super::worktree_list_inner as worktree_list;
    use super::worktree_provision_inner as worktree_provision;
    use super::worktree_remove_inner as worktree_remove;
    use super::worktree_unlock_inner as worktree_unlock;

    fn temp_repo() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("alethe-worktrees-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        let run = |args: &[&str]| checked_output(&root, args).unwrap();
        run(&["init"]);
        run(&["config", "user.name", "Alethe Test"]);
        run(&["config", "user.email", "alethe@example.invalid"]);
        fs::write(root.join("file.txt"), "one\n").unwrap();
        run(&["add", "file.txt"]);
        run(&["commit", "-m", "init"]);
        root
    }

    #[test]
    fn rejects_unsafe_ids() {
        assert!(sanitize_id("../evil").is_err());
        assert!(sanitize_id("a/b").is_err());
        assert!(sanitize_id("has space").is_err());
        assert!(sanitize_id("").is_err());
        assert!(sanitize_id("agent-01_x").is_ok());
    }

    #[test]
    fn fetch_branch_brings_local_copy_work_into_main_repo() {
        let root = temp_repo();
        let root_str = root.to_string_lossy().into_owned();

        let lc = worktree_provision(root_str.clone(), "fetchme".into(), WorktreeMode::LocalCopy)
            .unwrap();
        let env = Path::new(&lc.path);

        fs::write(env.join("file.txt"), "changed in copy\n").unwrap();
        checked_output(env, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(env, &["config", "user.email", "alethe@example.invalid"]).unwrap();
        checked_output(env, &["commit", "-am", "copy work"]).unwrap();

        let missing = git_command(
            &root,
            &["rev-parse", "--verify", "refs/heads/alethe/agent-fetchme"],
        )
        .unwrap();
        assert!(
            !missing.status.success(),
            "branch não devia existir antes do fetch"
        );

        worktree_fetch_branch(root_str.clone(), "fetchme".into()).unwrap();
        let present = git_command(
            &root,
            &["rev-parse", "--verify", "refs/heads/alethe/agent-fetchme"],
        )
        .unwrap();
        assert!(
            present.status.success(),
            "branch devia existir após o fetch"
        );

        // GitWorktree: no-op ok. Inexistente: erro limpo.
        let wt = worktree_provision(root_str.clone(), "wtnoop".into(), WorktreeMode::GitWorktree)
            .unwrap();
        assert_eq!(wt.mode, WorktreeMode::GitWorktree);
        worktree_fetch_branch(root_str.clone(), "wtnoop".into()).unwrap();
        assert!(worktree_fetch_branch(root_str.clone(), "nope".into()).is_err());

        worktree_remove(root_str.clone(), "fetchme".into(), true).unwrap();
        worktree_remove(root_str, "wtnoop".into(), true).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn commit_pending_commits_untracked_and_modified_work() {
        use super::worktree_commit_pending_inner as worktree_commit_pending;

        let root = temp_repo();
        let root_str = root.to_string_lossy().into_owned();
        let wt =
            worktree_provision(root_str.clone(), "op1".into(), WorktreeMode::GitWorktree).unwrap();
        let env = Path::new(&wt.path);
        checked_output(env, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(env, &["config", "user.email", "alethe@example.invalid"]).unwrap();

        // Nothing pending yet — no-op, no new commit.
        assert!(!worktree_commit_pending(root_str.clone(), "op1".into()).unwrap());
        let before = git_command(env, &["rev-parse", "HEAD"]).unwrap();

        // Agent "forgot" to commit: new untracked file.
        fs::write(env.join("README.md"), "agent work\n").unwrap();
        assert!(worktree_commit_pending(root_str.clone(), "op1".into()).unwrap());

        let after = git_command(env, &["rev-parse", "HEAD"]).unwrap();
        assert_ne!(before.stdout, after.stdout, "should have a new commit");
        let status = checked_output(env, &["status", "--porcelain"]).unwrap();
        assert!(
            String::from_utf8_lossy(&status.stdout).trim().is_empty(),
            "worktree should be clean after the commit"
        );

        // Repeat with no change: no-op again.
        assert!(!worktree_commit_pending(root_str.clone(), "op1".into()).unwrap());

        assert!(worktree_commit_pending(root_str.clone(), "nope".into()).is_err());

        worktree_remove(root_str, "op1".into(), true).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pending_changes_lists_without_mutating_and_commit_worktree_uses_chosen_message() {
        use super::worktree_commit_worktree_inner as worktree_commit_worktree;
        use super::worktree_pending_changes_inner as worktree_pending_changes;

        let root = temp_repo();
        let root_str = root.to_string_lossy().into_owned();
        let wt =
            worktree_provision(root_str.clone(), "op2".into(), WorktreeMode::GitWorktree).unwrap();
        let env = Path::new(&wt.path);
        checked_output(env, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(env, &["config", "user.email", "alethe@example.invalid"]).unwrap();

        assert!(worktree_pending_changes(root_str.clone(), "op2".into())
            .unwrap()
            .is_empty());

        fs::write(env.join("README.md"), "agent work\n").unwrap();
        let pending = worktree_pending_changes(root_str.clone(), "op2".into()).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].path, "README.md");
        assert_eq!(pending[0].status, "??");
        // Listing must not touch anything — still untracked, no new commit.
        let status_after_list = checked_output(env, &["status", "--porcelain"]).unwrap();
        assert!(!String::from_utf8_lossy(&status_after_list.stdout)
            .trim()
            .is_empty());

        assert!(worktree_commit_worktree(
            root_str.clone(),
            "op2".into(),
            "real work summary".into()
        )
        .unwrap());
        let log = git_command(env, &["log", "-1", "--format=%s"]).unwrap();
        assert_eq!(
            String::from_utf8_lossy(&log.stdout).trim(),
            "real work summary"
        );
        assert!(worktree_pending_changes(root_str.clone(), "op2".into())
            .unwrap()
            .is_empty());

        // Blank message falls back to the generic text instead of failing the commit.
        fs::write(env.join("README.md"), "one more change\n").unwrap();
        assert!(worktree_commit_worktree(root_str.clone(), "op2".into(), "   ".into()).unwrap());
        let log2 = git_command(env, &["log", "-1", "--format=%s"]).unwrap();
        assert_eq!(
            String::from_utf8_lossy(&log2.stdout).trim(),
            "Agent work (auto-commit before integration)"
        );

        worktree_remove(root_str, "op2".into(), true).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn infra_files_never_show_up_pending_and_never_get_committed() {
        use super::worktree_commit_worktree_inner as worktree_commit_worktree;
        use super::worktree_pending_changes_inner as worktree_pending_changes;

        let root = temp_repo();
        let root_str = root.to_string_lossy().into_owned();
        let wt =
            worktree_provision(root_str.clone(), "op3".into(), WorktreeMode::GitWorktree).unwrap();
        let env = Path::new(&wt.path);
        checked_output(env, &["config", "user.name", "Alethe Test"]).unwrap();
        checked_output(env, &["config", "user.email", "alethe@example.invalid"]).unwrap();

        // Only Alethe infrastructure pending (GSD plugin + OpenCode config
        // auto-written on spawn) — no real agent work.
        fs::create_dir_all(env.join(".opencode").join("plugins")).unwrap();
        fs::write(
            env.join(".opencode")
                .join("plugins")
                .join("alethe-gsd-state.ts"),
            "// alethe-managed: v1\n",
        )
        .unwrap();
        fs::create_dir_all(env.join(".planning")).unwrap();
        fs::write(env.join(".planning").join("goal.md"), "goal\n").unwrap();
        fs::write(env.join("opencode.json"), "{}\n").unwrap();

        assert!(
            worktree_pending_changes(root_str.clone(), "op3".into())
                .unwrap()
                .is_empty(),
            "Alethe infrastructure files must not show up as pending"
        );
        assert!(
            !worktree_commit_worktree(root_str.clone(), "op3".into(), "infra only".into()).unwrap(),
            "with no real work, no commit should be created"
        );

        // Mix of infra + real work: only the real part enters the list and the commit.
        fs::write(env.join("README.md"), "real work\n").unwrap();
        let pending = worktree_pending_changes(root_str.clone(), "op3".into()).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].path, "README.md");

        assert!(
            worktree_commit_worktree(root_str.clone(), "op3".into(), "summary".into()).unwrap()
        );
        let committed = checked_output(env, &["show", "--stat", "--format=", "HEAD"]).unwrap();
        let committed_files = String::from_utf8_lossy(&committed.stdout);
        assert!(committed_files.contains("README.md"));
        assert!(!committed_files.contains("opencode.json"));
        assert!(!committed_files.contains(".planning"));
        assert!(!committed_files.contains(".opencode"));
        // Infra stays untracked (never committed), nothing else broken.
        let final_status = checked_output(env, &["status", "--porcelain"]).unwrap();
        assert!(String::from_utf8_lossy(&final_status.stdout).contains("opencode.json"));

        worktree_remove(root_str, "op3".into(), true).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn provisions_lists_and_removes_both_modes() {
        let root = temp_repo();
        let root_str = root.to_string_lossy().into_owned();

        let wt =
            worktree_provision(root_str.clone(), "wt1".into(), WorktreeMode::GitWorktree).unwrap();
        assert_eq!(wt.mode, WorktreeMode::GitWorktree);
        assert!(Path::new(&wt.path).join(".git").is_file());

        let lc =
            worktree_provision(root_str.clone(), "lc1".into(), WorktreeMode::LocalCopy).unwrap();
        assert_eq!(lc.mode, WorktreeMode::LocalCopy);
        assert!(Path::new(&lc.path).join(".git").is_dir());

        let listed = worktree_list(root_str.clone()).unwrap();
        assert_eq!(listed.len(), 2);

        // Reprovisioning the same id should fail (destination already exists).
        assert!(
            worktree_provision(root_str.clone(), "wt1".into(), WorktreeMode::GitWorktree).is_err()
        );

        worktree_remove(root_str.clone(), "wt1".into(), false).unwrap();
        worktree_remove(root_str.clone(), "lc1".into(), false).unwrap();
        assert_eq!(worktree_list(root_str.clone()).unwrap().len(), 0);

        worktree_cleanup(root_str).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn worktree_remove_reports_admin_lock_reason_without_retry() {
        let root = temp_repo();
        let root_str = root.to_string_lossy().into_owned();

        let wt = worktree_provision(
            root_str.clone(),
            "ambiente-a".into(),
            WorktreeMode::GitWorktree,
        )
        .unwrap();

        // Real administrative lock via `git worktree lock --reason`, like a
        // user would do outside Alethe.
        checked_output(
            &root,
            &[
                "worktree",
                "lock",
                "--reason",
                "Aguardando homologacao",
                &wt.path,
            ],
        )
        .unwrap();

        // timing em git_control::tests::admin_lock_takes_precedence_and_is_never_retried.

        // motivo correto.
        let error = worktree_remove(root_str.clone(), "ambiente-a".into(), true).unwrap_err();
        assert_eq!(error, "admin_locked:Aguardando homologacao");

        worktree_unlock(root_str.clone(), "ambiente-a".into()).unwrap();
        worktree_remove(root_str.clone(), "ambiente-a".into(), true).unwrap();
        assert_eq!(worktree_list(root_str).unwrap().len(), 0);

        fs::remove_dir_all(root).unwrap();
    }

    // ========================================================================

    //

    //

    // manualmente com `cargo test --lib worktrees::tests::opencode_e2e -- --ignored --nocapture`.
    #[cfg(test)]
    mod opencode_e2e {
        use super::temp_repo;
        use crate::worktrees::WorktreeMode;
        use crate::worktrees::{
            worktree_list_inner as worktree_list, worktree_provision_inner as worktree_provision,
            worktree_remove_inner as worktree_remove,
        };
        use std::fs;
        use std::path::{Path, PathBuf};
        use std::process::{Command, Stdio};
        use std::time::{SystemTime, UNIX_EPOCH};

        /// corrida nenhuma, ainda mais com N agentes paralelos.
        fn opencode_binary() -> Option<PathBuf> {
            crate::cli_resolver::find_windows_cli_launcher("opencode")
        }

        const FREE_MODEL: &str = "opencode/deepseek-v4-flash-free";

        fn task_pool() -> Vec<(&'static str, &'static str, &'static str)> {
            vec![
                (
                    "Crie um arquivo chamado resultado.txt contendo exatamente a palavra ALFA (maiúsculas, sem mais nada). Não peça confirmação, apenas crie.",
                    "resultado.txt",
                    "ALFA",
                ),
                (
                    "Crie um arquivo chamado resultado.txt contendo exatamente a palavra BETA (maiúsculas, sem mais nada). Não peça confirmação, apenas crie.",
                    "resultado.txt",
                    "BETA",
                ),
                (
                    "Crie um arquivo chamado resultado.txt contendo exatamente a palavra GAMA (maiúsculas, sem mais nada). Não peça confirmação, apenas crie.",
                    "resultado.txt",
                    "GAMA",
                ),
            ]
        }

        fn pick_pseudo_random<T: Copy>(pool: &[T], salt: u128) -> T {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
                .wrapping_add(salt);
            pool[(nanos as usize) % pool.len()]
        }

        struct OpenCodeRunOutcome {
            session_id: String,
            raw_events: Vec<serde_json::Value>,
        }

        /// Runs `opencode run` non-interactively, without --pure (graphify needs
        /// to show up), with --auto (approves permissions without stalling the
        /// script), and captures the --format json stream line by line.
        fn run_opencode(
            bin: &Path,
            cwd: &Path,
            prompt: &str,
            session_id: Option<&str>,
        ) -> Result<OpenCodeRunOutcome, String> {
            let mut cmd = Command::new(bin);
            cmd.current_dir(cwd)
                .args(["run", "--format", "json", "--auto", "-m", FREE_MODEL]);
            if let Some(id) = session_id {
                cmd.args(["--session", id]);
            }
            cmd.arg(prompt);
            cmd.stdout(Stdio::piped());
            cmd.stderr(Stdio::piped());

            let output = cmd
                .output()
                .map_err(|e| format!("falha ao rodar opencode: {e}"))?;
            if !output.status.success() {
                return Err(format!(
                    "opencode run saiu com codigo {:?}\nstderr: {}\nstdout (ultimos 2000 chars): {}",
                    output.status.code(),
                    String::from_utf8_lossy(&output.stderr),
                    String::from_utf8_lossy(&output.stdout)
                        .chars()
                        .rev()
                        .take(2000)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>()
                ));
            }

            let mut raw_events = Vec::new();
            let mut session_id_found: Option<String> = None;
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                if session_id_found.is_none() {
                    if let Some(sid) = value.get("sessionID").and_then(|v| v.as_str()) {
                        session_id_found = Some(sid.to_string());
                    }
                }
                raw_events.push(value);
            }

            let session_id = session_id_found
                .ok_or_else(|| "sessionID nunca apareceu no stream de eventos".to_string())?;
            Ok(OpenCodeRunOutcome {
                session_id,
                raw_events,
            })
        }

        #[test]
        #[ignore]
        fn parallel_opencode_agents_respect_worktree_isolation_and_session_continuity() {
            let Some(bin) = opencode_binary() else {
                eprintln!("[e2e] opencode não encontrado no PATH — pulando (instale o CLI pra rodar este teste)");
                return;
            };

            const N: usize = 2; // paralelismo real, mas contido (custo/tempo de rede).
            let root = temp_repo();
            let root_str = root.to_string_lossy().into_owned();

            let pool = task_pool();

            // 1) Provisiona N worktrees.
            let mut worktrees = Vec::new();
            for i in 0..N {
                let agent_id = format!("e2e-{i}");
                let wt = worktree_provision(
                    root_str.clone(),
                    agent_id.clone(),
                    WorktreeMode::GitWorktree,
                )
                .expect("worktree_provision falhou");
                let wt_path = PathBuf::from(&wt.path);

                let _ = crate::graphify::graphify_opencode_config_write_inner(
                    wt_path.to_string_lossy().into_owned(),
                    None,
                );
                let (prompt, expected_file, expected_content) =
                    pick_pseudo_random(&pool, i as u128 * 7919);
                worktrees.push((agent_id, wt_path, prompt, expected_file, expected_content));
            }

            // 2) Dispara os N `opencode run` em paralelo de verdade (threads,

            let handles: Vec<_> = worktrees
                .iter()
                .map(|(agent_id, wt_path, prompt, _, _)| {
                    let bin = bin.clone();
                    let wt_path = wt_path.clone();
                    let prompt = prompt.to_string();
                    let agent_id = agent_id.clone();
                    std::thread::spawn(move || {
                        let result = run_opencode(&bin, &wt_path, &prompt, None);
                        (agent_id, result)
                    })
                })
                .collect();

            let mut outcomes = std::collections::HashMap::new();
            for h in handles {
                let (agent_id, result) = h
                    .join()
                    .expect("thread do opencode paralelo entrou em pânico");
                match result {
                    Ok(outcome) => {
                        outcomes.insert(agent_id, outcome);
                    }
                    Err(e) => panic!("agente {agent_id} falhou: {e}"),
                }
            }

            //    no repo principal.
            for (agent_id, wt_path, _, expected_file, expected_content) in &worktrees {
                let own_file = wt_path.join(expected_file);
                assert!(
                    own_file.is_file(),
                    "agente {agent_id} devia ter criado {expected_file} na própria worktree"
                );
                let content = fs::read_to_string(&own_file).unwrap_or_default();
                assert!(
                    content.contains(expected_content),
                    "conteúdo de {expected_file} do agente {agent_id} não bate com o esperado ({expected_content}): {content:?}"
                );

                for (other_id, other_path, _, _, other_expected_content) in &worktrees {
                    if other_id == agent_id || expected_content == other_expected_content {
                        continue;
                    }
                    let other_file = other_path.join(expected_file);
                    if !other_file.is_file() {
                        continue;
                    }
                    let other_content = fs::read_to_string(&other_file).unwrap_or_default();
                    assert!(
                        !other_content.contains(expected_content),
                        "vazamento: conteúdo do agente {agent_id} ({expected_content}) apareceu na worktree do agente {other_id}"
                    );
                }
                assert!(
                    !root.join(expected_file).is_file(),
                    "vazamento: arquivo do agente {agent_id} apareceu no repo principal (fora de qualquer worktree)"
                );
            }

            for (agent_id, wt_path, _, _, _) in &worktrees {
                let outcome = outcomes.get(agent_id).unwrap();
                let resumed = run_opencode(
                    &bin,
                    wt_path,
                    "Confirme rapidamente: qual arquivo voce acabou de criar?",
                    Some(&outcome.session_id),
                )
                .unwrap_or_else(|e| panic!("retomada de sessão falhou pro agente {agent_id}: {e}"));
                assert_eq!(
                    resumed.session_id, outcome.session_id,
                    "retomada com --session {} devia continuar a MESMA sessão pro agente {agent_id}, não criar uma nova",
                    outcome.session_id
                );
                assert!(
                    !resumed.raw_events.is_empty(),
                    "retomada da sessão do agente {agent_id} não produziu nenhum evento"
                );
            }

            for (agent_id, _, _, _, _) in &worktrees {
                worktree_remove(root_str.clone(), agent_id.clone(), true).unwrap_or_else(|e| {
                    panic!("worktree_remove falhou pro agente {agent_id}: {e}")
                });
            }
            assert_eq!(
                worktree_list(root_str).unwrap().len(),
                0,
                "nenhuma worktree deveria sobrar depois da limpeza"
            );

            fs::remove_dir_all(root).unwrap();
        }
    }
}
