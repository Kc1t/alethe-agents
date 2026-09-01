//! RFC-007 — Conflict Resolution (ephemeral merge environment).
//!
//! Second stage of the safe merge cycle. The Merge Analyzer (RFC-006) decided
//! there's integration work to do; this module provisions an **ephemeral
//! environment** (worktree `alethe/merge-<id>`) with the real merge applied —
//! including the conflict markers — and the **minimal context**
//! (`ALETHE_CONFLICT.md`) for the Conflict Resolution Agent to work with:
//!
//! - the agent is ephemeral and provider-agnostic: the FRONTEND spawns the
//!   configured CLI (Claude/Codex/OpenCode) with `cwd = env.path`; it's born,
//!   resolves, dies;
//! - the agent NEVER decides whether there's a conflict (that's the
//!   Analyzer's job) and NEVER implements features (the prompt locks the
//!   scope);
//! - `merge_finalize` is the gate: it checks that no marker was left behind,
//!   runs the Validation Pipeline (RFC-008, `validation.rs`), and only then
//!   commits and integrates into the target branch via `--ff-only` — the
//!   user's worktree only ever advances cleanly;
//! - `merge_abort` destroys the environment without leaving a trace.
//!
//! Cycle metadata lives OUTSIDE the worktree (`merge-envs/<id>.json`) so it
//! doesn't contaminate the merge commit; the prompt lives inside (the agent
//! needs to read it), but it's removed before the commit.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::git_control::{checked_output, git_command, repository_root};
use crate::merge_analyzer::{
    class_strategy, classify_path, merge_envs_dir, unmerged_files, ConflictFile,
};
use crate::worktrees::git_arg;

const PROMPT_FILE: &str = "ALETHE_CONFLICT.md";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeMeta {
    id: String,
    source: String,
    target: String,
    project_id: Option<String>,
    conflict_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictEnv {
    pub id: String,
    pub path: String,
    pub branch: String,
    pub clean: bool,
    pub conflicts: Vec<ConflictFile>,
    pub prompt_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub merged: bool,
    pub stage: String,
    pub output: String,
    /// Shield Layer 3 (warning, never blocks): endpoints called by the
    /// frontend with no matching backend route found in the ephemeral
    /// environment. Best-effort — a silent failure doesn't block the merge.
    #[serde(default)]
    pub contract_warnings: Vec<crate::contract_check::ContractWarning>,
    /// `false` when the project had no `validationCommands` configured —
    /// distinguishes "validated and passed" from "nothing was checked", so
    /// the frontend never claims an integration was verified when it wasn't.
    #[serde(default)]
    pub validation_ran: bool,
    /// Shield Layer 4 (warning, never blocks): result of the app's real boot
    /// in the ephemeral environment, if `healthCheckCommand` was configured.
    #[serde(default)]
    pub health_probe: Option<crate::health_probe::HealthProbeResult>,
}

fn validate_env_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid_env_id".to_string());
    }
    Ok(())
}

fn env_dir(root: &Path, id: &str) -> PathBuf {
    merge_envs_dir(root).join(id)
}

fn meta_path(root: &Path, id: &str) -> PathBuf {
    merge_envs_dir(root).join(format!("{id}.json"))
}

fn read_meta(root: &Path, id: &str) -> Result<MergeMeta, String> {
    let raw = std::fs::read_to_string(meta_path(root, id))
        .map_err(|_| "merge_env_not_found".to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("invalid_merge_meta:{e}"))
}

fn emit(event_type: &str, meta: &MergeMeta, data: serde_json::Value) {
    crate::event_bus::publish_event_simple(
        event_type,
        &format!("merge-{}", meta.id),
        meta.project_id.clone(),
        None,
        data,
    );
}

fn build_prompt(meta: &MergeMeta, conflicts: &[ConflictFile]) -> String {
    let mut lines = vec![
        "# Merge conflict resolution (Alethe)".to_string(),
        String::new(),
        format!("Merge from `{}` into `{}`. This directory is an EPHEMERAL environment for this integration only.", meta.source, meta.target),
        String::new(),
        "## Rules (locked scope)".to_string(),
        "- Resolve ONLY the conflicts listed below. Nothing beyond that.".to_string(),
        "- NEVER implement features, change requirements, or change architecture.".to_string(),
        "- Preserve the intent of BOTH branches; confirm nothing was lost.".to_string(),
        "- When done, just save the resolved files (no commit — Alethe commits after validation).".to_string(),
        String::new(),
        "## Conflicted files".to_string(),
    ];
    for conflict in conflicts {
        lines.push(format!(
            "- `{}` — {:?}: {}",
            conflict.path,
            conflict.class,
            class_strategy(conflict.class)
        ));
    }
    lines.push(String::new());
    lines.push(
        "Use `git diff` in this directory to see the markers (`<<<<<<<`/`>>>>>>>`).".to_string(),
    );
    lines.join("\n")
}

/// Provisions the ephemeral environment with the merge applied (with markers,
/// if there's a conflict). Publishes `MergeRequested` (+ `MergeConflict` when
/// applicable).
///
/// Commands in this file run real `git`/IO — same as `spawn_pty` in `pty.rs`
/// and the commands in `worktrees.rs` (both already fixed), this can never run
/// directly on the Tauri dispatch thread. Each command's logic lives in a
/// common synchronous `_inner` function (directly testable), and the exposed
/// `#[tauri::command]` is just a thin wrapper in `spawn_blocking`.
#[tauri::command]
pub async fn merge_prepare(
    repo: String,
    source: String,
    target: String,
    project_id: Option<String>,
) -> Result<ConflictEnv, String> {
    tokio::task::spawn_blocking(move || merge_prepare_inner(repo, source, target, project_id))
        .await
        .map_err(|error| format!("merge_prepare: blocking task failed: {error}"))?
}

pub(crate) fn merge_prepare_inner(
    repo: String,
    source: String,
    target: String,
    project_id: Option<String>,
) -> Result<ConflictEnv, String> {
    let root = repository_root(&repo)?;
    let id = nanoid::nanoid!(10).replace(['_', '-'], "x");
    let envs = merge_envs_dir(&root);
    std::fs::create_dir_all(&envs).map_err(|e| format!("mkdir_failed:{e}"))?;
    let env = env_dir(&root, &id);
    let env_arg = git_arg(&env);
    let branch = format!("alethe/merge-{id}");

    checked_output(
        &root,
        &["worktree", "add", "-b", &branch, &env_arg, &target],
    )?;
    let merge = git_command(&env, &["merge", "--no-commit", "--no-ff", &source])?;
    let clean = merge.status.success();
    let conflicts: Vec<ConflictFile> = if clean {
        Vec::new()
    } else {
        unmerged_files(&env)?
            .into_iter()
            .map(|path| ConflictFile {
                class: classify_path(&path),
                path,
            })
            .collect()
    };

    let meta = MergeMeta {
        id: id.clone(),
        source,
        target,
        project_id,
        conflict_paths: conflicts.iter().map(|c| c.path.clone()).collect(),
    };
    let meta_body = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    std::fs::write(meta_path(&root, &id), meta_body).map_err(|e| format!("write_failed:{e}"))?;

    let prompt_path = if clean {
        None
    } else {
        let path = env.join(PROMPT_FILE);
        std::fs::write(&path, build_prompt(&meta, &conflicts))
            .map_err(|e| format!("write_failed:{e}"))?;
        Some(git_arg(&path))
    };

    emit(
        "MergeRequested",
        &meta,
        serde_json::json!({ "source": meta.source, "target": meta.target, "clean": clean }),
    );
    if !clean {
        emit(
            "MergeConflict",
            &meta,
            serde_json::json!({ "conflict_count": conflicts.len(), "env": env.to_string_lossy() }),
        );
    }

    Ok(ConflictEnv {
        id,
        // `env` comes from a `root` that's already canonicalized (`\\?\`
        // prefix on Windows) — without stripping it here, the frontend uses
        // this `path` as the cwd to spawn the conflict resolution agent, and
        // not every CLI tolerates that prefix as a working directory (same
        // root cause fixed in `worktrees::worktree_provision`/`worktree_list`).
        path: git_arg(&env),
        branch,
        clean,
        conflicts,
        prompt_path,
    })
}

/// Scans the files that were in conflict for leftover forgotten markers.
fn leftover_markers(env: &Path, paths: &[String]) -> Vec<String> {
    let mut leftovers = Vec::new();
    for rel in paths {
        let file = env.join(rel);
        let Ok(content) = std::fs::read_to_string(&file) else {
            continue; // binary/removed — the unmerged stage already covers this
        };
        if content
            .lines()
            .any(|line| line.starts_with("<<<<<<<") || line.starts_with(">>>>>>>"))
        {
            leftovers.push(rel.clone());
        }
    }
    leftovers
}

/// Final gate: no markers → Validation Pipeline → commit → `--ff-only` on the
/// target branch → teardown. If any step fails, the environment is PRESERVED
/// for inspection/retry and the reason comes back in `MergeOutcome`.
#[tauri::command]
pub async fn merge_finalize(
    repo: String,
    env_id: String,
    validation_commands: Vec<String>,
    health_check_command: Option<String>,
    health_check_path: Option<String>,
) -> Result<MergeOutcome, String> {
    tokio::task::spawn_blocking(move || {
        merge_finalize_inner(
            repo,
            env_id,
            validation_commands,
            health_check_command,
            health_check_path,
        )
    })
    .await
    .map_err(|error| format!("merge_finalize: blocking task failed: {error}"))?
}

/// Result of `validate_and_stage`: either it's blocked (with a `MergeOutcome`
/// already ready to return to the caller), or it passed and is ready to
/// commit — carrying whether any real validation command actually ran, so the
/// caller can propagate that honestly instead of assuming "validated" when
/// nothing was actually checked.
enum StageOutcome {
    /// Blocked (markers, unmerged, or validation failed) — never integrates.
    Blocked(MergeOutcome),
    /// Validated and staged, ready to commit.
    Proceed { ran_any_command: bool },
}

/// Checks markers/unmerged, stages (`add -A`), and runs the Validation
/// Pipeline — WITHOUT committing or integrating. Shared by `merge_validate`
/// (stops here, manual gate) and `merge_finalize` (continues to commit only
/// after this returns `Proceed`).
fn validate_and_stage(
    env: &Path,
    meta: &MergeMeta,
    validation_commands: Vec<String>,
) -> Result<StageOutcome, String> {
    // Conflicts not yet resolved (not staged) count as pending.
    let pending = unmerged_files(env)?;
    let markers = leftover_markers(env, &meta.conflict_paths);
    if !markers.is_empty() {
        return Ok(StageOutcome::Blocked(MergeOutcome {
            merged: false,
            stage: "conflict_markers".to_string(),
            output: format!("Conflict markers remaining in: {}", markers.join(", ")),
            ..Default::default()
        }));
    }

    // Remove the prompt BEFORE `add -A` — it can't enter the commit. Removing
    // it AFTER staging doesn't help: `git add -A` already captured its
    // content in the index, and deleting it from disk afterward doesn't undo
    // that stage on its own (it would need another `add -A`/`rm` to reflect
    // the removal) — confirmed live: `ALETHE_CONFLICT.md` leaked into the
    // final commit because of exactly this wrong ordering, in an earlier
    // version of this same code in this session. It also can't be removed
    // any earlier than this, unconditionally (as it was before this gate
    // existed) — it deleted the file on the first periodic poll (every 7s,
    // see `beginResolvingWatch` in the frontend) even while the agent was
    // still typing/confirming the initial prompt.
    let _ = std::fs::remove_file(env.join(PROMPT_FILE));

    checked_output(env, &["add", "-A"])?;
    if !pending.is_empty() {
        // add -A just staged everything; if unmerged files still remain, something is wrong.
        let still = unmerged_files(env)?;
        if !still.is_empty() {
            return Ok(StageOutcome::Blocked(MergeOutcome {
                merged: false,
                stage: "unmerged".to_string(),
                output: format!("Unresolved files: {}", still.join(", ")),
                ..Default::default()
            }));
        }
    }

    // RFC-008 — Validation Pipeline in the merge environment, before integrating.
    let validation =
        crate::validation::run_validation(env.to_string_lossy().into_owned(), validation_commands)?;
    if !validation.success {
        emit(
            "MergeValidationFailed",
            meta,
            serde_json::json!({ "stage": validation.stage }),
        );
        return Ok(StageOutcome::Blocked(MergeOutcome {
            merged: false,
            stage: format!("validation:{}", validation.stage),
            output: validation.output,
            ..Default::default()
        }));
    }
    emit("MergeValidated", meta, serde_json::json!({}));
    Ok(StageOutcome::Proceed {
        ran_any_command: validation.ran_any_command,
    })
}

/// Only validates (markers + Validation Pipeline), without committing or
/// integrating — manual gate: the user confirms the resolution is good
/// BEFORE `merge_finalize` touches `git commit`/`git merge`. Explicit user
/// request: the automatic 3-layer trigger (see `beginResolvingWatch` in the
/// frontend) integrated on its own as soon as the agent signaled "done", with
/// no human confirming the resolution made sense — confirmed live as
/// reckless (an agent merged incompatible content into a single file without
/// asking, and it was auto-committed/integrated).
#[tauri::command]
pub async fn merge_validate(
    repo: String,
    env_id: String,
    validation_commands: Vec<String>,
) -> Result<MergeOutcome, String> {
    tokio::task::spawn_blocking(move || merge_validate_inner(repo, env_id, validation_commands))
        .await
        .map_err(|error| format!("merge_validate: blocking task failed: {error}"))?
}

pub(crate) fn merge_validate_inner(
    repo: String,
    env_id: String,
    validation_commands: Vec<String>,
) -> Result<MergeOutcome, String> {
    let root = repository_root(&repo)?;
    validate_env_id(&env_id)?;
    let env = env_dir(&root, &env_id);
    if !env.is_dir() {
        return Err("merge_env_not_found".to_string());
    }
    let meta = read_meta(&root, &env_id)?;
    match validate_and_stage(&env, &meta, validation_commands)? {
        StageOutcome::Blocked(outcome) => Ok(outcome),
        StageOutcome::Proceed { ran_any_command } => Ok(MergeOutcome {
            merged: false,
            stage: "validated".to_string(),
            output: if ran_any_command {
                "Validation passed — ready to integrate.".to_string()
            } else {
                "No validation command configured — nothing was checked (not a blocker)."
                    .to_string()
            },
            validation_ran: ran_any_command,
            ..Default::default()
        }),
    }
}

pub(crate) fn merge_finalize_inner(
    repo: String,
    env_id: String,
    validation_commands: Vec<String>,
    health_check_command: Option<String>,
    health_check_path: Option<String>,
) -> Result<MergeOutcome, String> {
    let root = repository_root(&repo)?;
    validate_env_id(&env_id)?;
    let env = env_dir(&root, &env_id);
    if !env.is_dir() {
        return Err("merge_env_not_found".to_string());
    }
    let meta = read_meta(&root, &env_id)?;

    // Revalidates at commit time (idempotent and cheap enough) — covers the
    // case of the user clicking "Integrate" without going through "Validate"
    // first, or something having changed in the environment between the two
    // clicks.
    let ran_any_command = match validate_and_stage(&env, &meta, validation_commands)? {
        StageOutcome::Blocked(outcome) => return Ok(outcome),
        StageOutcome::Proceed { ran_any_command } => ran_any_command,
    };

    // Shield Layer 3 — API Contract Checker (heuristic, best-effort).
    // Never fails the merge: a check error just becomes an empty warning list.
    let contract_warnings =
        crate::contract_check::contract_check(env.to_string_lossy().into_owned())
            .unwrap_or_default();

    // Shield Layer 4 — Health Probe (warning, never blocks): boots the
    // project's start command in the SAME ephemeral environment (never in
    // the user's real worktree) and confirms the app actually responds —
    // and, if it's an Alethe core, that a real terminal works (a
    // write/read round-trip, not just "the process exists").
    // `block_on` is safe here: this function already runs inside a
    // `spawn_blocking` (a thread from tokio's blocking pool, not the async
    // reactor thread), so blocking doesn't stall anything.
    let health_probe_result = health_check_command
        .filter(|cmd| !cmd.trim().is_empty())
        .and_then(|cmd| {
            let path = health_check_path
                .filter(|p| !p.trim().is_empty())
                .unwrap_or_else(|| "/".to_string());
            tokio::runtime::Handle::current()
                .block_on(crate::health_probe::health_probe(
                    env.to_string_lossy().into_owned(),
                    cmd,
                    path,
                    8000,
                ))
                .ok()
        });

    let message = format!("merge(alethe): {} -> {}", meta.source, meta.target);
    // After a successful merge_rebase_onto_target, the reconciliation already
    // committed everything — nothing is left staged here, and that's expected
    // (HEAD is already the right commit). `diff --cached --quiet`: exit 0 =
    // nothing staged (git prints "nothing to commit" to STDOUT, which
    // checked_output doesn't even capture — checking staged state up front is
    // more robust than trying to match that message).
    let has_staged_changes = git_command(&env, &["diff", "--cached", "--quiet"])
        .map(|output| !output.status.success())
        .unwrap_or(true);
    if has_staged_changes {
        // `ALETHE_CONFLICT.md` sits on disk (untracked) from BEFORE the agent
        // even starts working (written in `merge_prepare`, above) — if the
        // agent finishes the resolution with the common "stage everything and
        // commit" pattern, this file unintentionally leaks into ITS commit
        // (it doesn't even know this file exists). The removal just above
        // (`validate_and_stage`) then ends up staged here as a real removal —
        // and without this check, that alone was enough to create an ENTIRE
        // second commit just to drop 1 support file, visually duplicating
        // each resolution in the graph (the agent's real commit + a generic
        // "merge(alethe): ..." commit with no new information). When the
        // ONLY staged change is exactly this removal and there's already a
        // prior commit on this branch (the agent's), amend it instead of
        // creating a new commit — fast-forward still works the same, since
        // we only use the ephemeral branch's current HEAD to integrate.
        let staged_files = git_command(&env, &["diff", "--cached", "--name-only"])
            .map(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let only_prompt_file_removed = staged_files == [PROMPT_FILE.to_string()];
        let has_prior_commit = git_command(&env, &["rev-parse", "--verify", "-q", "HEAD"])
            .map(|output| output.status.success())
            .unwrap_or(false);
        if only_prompt_file_removed && has_prior_commit {
            checked_output(&env, &["commit", "--amend", "--no-edit"])?;
        } else {
            checked_output(&env, &["commit", "-m", &message])?;
        }
    }

    // Integration: the target branch needs to be checked out in the user's
    // repo and the advance must be fast-forward — we never rewrite anything
    // of the user's.
    let head = checked_output(&root, &["symbolic-ref", "--short", "HEAD"])
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    if head != meta.target {
        return Ok(MergeOutcome {
            merged: false,
            stage: "target_not_checked_out".to_string(),
            output: format!(
                "The target branch '{}' is not checked out in the repository (current: '{}'). Check it out and finalize again.",
                meta.target, head
            ),
            ..Default::default()
        });
    }
    let branch = format!("alethe/merge-{env_id}");
    // Real bug, confirmed live with a real agent (a branch with no commit
    // relative to the target — nothing was committed above because there was
    // no change at all): without this check, `git merge --ff-only` responds
    // "Already up to date" with exit 0 (success!) even without moving `main`
    // NOR A SINGLE commit — and the code carried on to the end returning
    // `merged: true`. The UI showed "Merge complete" with a real toast, the
    // card turned "Integrated", but `main` never advanced. Compares the
    // ephemeral branch's HEAD with the target's HEAD BEFORE attempting the
    // fast-forward: if they're identical, there's nothing new to integrate —
    // report honestly instead of faking success.
    let branch_sha = git_command(&env, &["rev-parse", "HEAD"])
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let target_sha = git_command(&root, &["rev-parse", "HEAD"])
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    if !branch_sha.is_empty() && branch_sha == target_sha {
        return Ok(MergeOutcome {
            merged: false,
            stage: "nothing_to_integrate".to_string(),
            output:
                "Nothing to integrate — the agent's branch has no changes relative to the target branch."
                    .to_string(),
            validation_ran: ran_any_command,
            ..Default::default()
        });
    }
    if let Err(error) = checked_output(&root, &["merge", "--ff-only", &branch]) {
        // Distinguishes "the target advanced since merge_prepare" (recoverable
        // via merge_rebase_onto_target) from a generic/hard error — git uses
        // this message (case variations) specifically for ff-only refused due
        // to divergence, not due to corruption or I/O.
        let lower = error.to_lowercase();
        let stage = if lower.contains("not possible to fast-forward")
            || lower.contains("non-fast-forward")
        {
            "branch_diverged"
        } else {
            "integration"
        };
        return Ok(MergeOutcome {
            merged: false,
            stage: stage.to_string(),
            output: error,
            ..Default::default()
        });
    }

    // Teardown: worktree + temporary branch + metadata.
    let env_arg = git_arg(&env);
    let _ = git_command(&root, &["worktree", "remove", "--force", &env_arg]);
    let _ = git_command(&root, &["branch", "-d", &branch]);
    let _ = std::fs::remove_file(meta_path(&root, &env_id));

    emit(
        "MergeMerged",
        &meta,
        serde_json::json!({ "source": meta.source, "target": meta.target }),
    );

    // The graph is versioned knowledge: automatic post-integration snapshot
    // (best-effort — with no graph in the repo, it's simply skipped). Ties
    // RFC-004 ↔ RFC-006 together.
    let _ = crate::graphify::graphify_snapshot_inner(
        root.to_string_lossy().into_owned(),
        meta.project_id.clone(),
    );

    Ok(MergeOutcome {
        merged: true,
        stage: "merged".to_string(),
        output: message,
        contract_warnings,
        validation_ran: ran_any_command,
        health_probe: health_probe_result,
    })
}

/// `git merge --abort`/`git rebase --abort` in the ephemeral worktree are
/// expected no-ops when nothing is in progress — only propagates errors that
/// indicate something actually wrong (including an administrative lock, via
/// `checked_output` which is already lock-aware).
fn safe_abort(env: &Path, args: &[&str]) -> Result<(), String> {
    match checked_output(env, args) {
        Ok(_) => Ok(()),
        Err(error) => {
            let lower = error.to_lowercase();
            if lower.contains("no merge") || lower.contains("no rebase") {
                Ok(())
            } else {
                Err(error)
            }
        }
    }
}

/// Preventive abort called by the frontend's "Manual Retry" before
/// reprocessing a merge in `Failed`: cleans up any unfinished merge/rebase in
/// the EPHEMERAL worktree (never the user's). An error here that isn't an
/// administrative lock indicates real environment corruption — the frontend
/// treats it as `TerminalError`.
#[tauri::command]
pub async fn merge_preflight_abort(repo: String, env_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || merge_preflight_abort_inner(repo, env_id))
        .await
        .map_err(|error| format!("merge_preflight_abort: blocking task failed: {error}"))?
}

pub(crate) fn merge_preflight_abort_inner(repo: String, env_id: String) -> Result<(), String> {
    let root = repository_root(&repo)?;
    validate_env_id(&env_id)?;
    let env = env_dir(&root, &env_id);
    if !env.is_dir() {
        return Err("merge_env_not_found".to_string());
    }
    safe_abort(&env, &["merge", "--abort"])?;
    safe_abort(&env, &["rebase", "--abort"])?;
    Ok(())
}

/// Called when `merge_finalize` reports `stage == "branch_diverged"`: the
/// target branch advanced since `merge_prepare`. Brings the target's current
/// tip into the EPHEMERAL worktree (local fetch, without touching the user's
/// worktree) and reconciles via `git merge` (not rebase) — the ephemeral
/// branch already has a merge commit formed (made in `merge_finalize`), and
/// REBASing a merge commit is a patch-replay that can generate spurious
/// conflicts even when a normal tree merge would apply cleanly. The practical
/// result is equivalent to what the user would call "RebaseAttempt": the
/// target's new tip becomes an ancestor of the ephemeral branch, which is
/// already enough for the reintegration's `--ff-only` to work.
///
/// - Clean reconciliation → `stage: "rebase_ok"`, ready for the frontend to
///   call `merge_finalize` again.
/// - Conflicts → rewrites `ALETHE_CONFLICT.md`/metadata with the new
///   conflicted files and returns `stage: "rebase_conflict"` — same
///   "resolve" surface as before, frontend goes back to `resolving`.
/// - Hard failure (not a conflict) → aborts and returns `stage: "rebase_failed"`.
#[tauri::command]
pub async fn merge_rebase_onto_target(
    repo: String,
    env_id: String,
) -> Result<MergeOutcome, String> {
    tokio::task::spawn_blocking(move || merge_rebase_onto_target_inner(repo, env_id))
        .await
        .map_err(|error| format!("merge_rebase_onto_target: blocking task failed: {error}"))?
}

pub(crate) fn merge_rebase_onto_target_inner(
    repo: String,
    env_id: String,
) -> Result<MergeOutcome, String> {
    let root = repository_root(&repo)?;
    validate_env_id(&env_id)?;
    let env = env_dir(&root, &env_id);
    if !env.is_dir() {
        return Err("merge_env_not_found".to_string());
    }
    let meta = read_meta(&root, &env_id)?;

    let root_arg = git_arg(&root);
    checked_output(&env, &["fetch", &root_arg, &meta.target])?;

    let reconcile = git_command(&env, &["merge", "--no-edit", "FETCH_HEAD"])?;
    if reconcile.status.success() {
        return Ok(MergeOutcome {
            merged: false,
            stage: "rebase_ok".to_string(),
            output: "Reconciled with the updated target — ready to reintegrate.".to_string(),
            ..Default::default()
        });
    }

    let unresolved = unmerged_files(&env).unwrap_or_default();
    if !unresolved.is_empty() {
        // Conflicts: same resolution surface as before — rewrites the prompt
        // and the metadata with the new conflicted files.
        let conflicts: Vec<ConflictFile> = unresolved
            .into_iter()
            .map(|path| ConflictFile {
                class: classify_path(&path),
                path,
            })
            .collect();
        let prompt_path = env.join(PROMPT_FILE);
        let _ = std::fs::write(&prompt_path, build_prompt(&meta, &conflicts));
        let updated_meta = MergeMeta {
            conflict_paths: conflicts.iter().map(|c| c.path.clone()).collect(),
            ..meta
        };
        if let Ok(body) = serde_json::to_string_pretty(&updated_meta) {
            let _ = std::fs::write(meta_path(&root, &env_id), body);
        }
        let paths = conflicts
            .iter()
            .map(|c| c.path.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Ok(MergeOutcome {
            merged: false,
            stage: "rebase_conflict".to_string(),
            output: format!("Conflicts while reconciling with the updated target: {paths}"),
            ..Default::default()
        });
    }

    // Hard failure (not a conflict): aborts so the ephemeral environment
    // isn't left with a hanging merge, and propagates git's real message.
    let stderr = String::from_utf8_lossy(&reconcile.stderr)
        .trim()
        .to_string();
    let _ = git_command(&env, &["merge", "--abort"]);
    Ok(MergeOutcome {
        merged: false,
        stage: "rebase_failed".to_string(),
        output: if stderr.is_empty() {
            "rebase_failed".to_string()
        } else {
            stderr
        },
        ..Default::default()
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForceCleanupResult {
    pub deleted: bool,
    pub pruned: bool,
}

/// Brute-force cleanup of an unrecoverable merge environment (`TerminalError`,
/// when the preventive abort already failed due to real corruption). Direct
/// physical deletion of the directory (double-checked to never leave
/// `.alethe/merge-envs/`) followed by a best-effort `git worktree prune`. The
/// frontend decides `pruneOnly` vs `requiresRawDeletion` based on
/// `deleted`/`pruned`.
#[tauri::command]
pub async fn merge_force_cleanup(
    repo: String,
    env_id: String,
) -> Result<ForceCleanupResult, String> {
    tokio::task::spawn_blocking(move || merge_force_cleanup_inner(repo, env_id))
        .await
        .map_err(|error| format!("merge_force_cleanup: blocking task failed: {error}"))?
}

pub(crate) fn merge_force_cleanup_inner(
    repo: String,
    env_id: String,
) -> Result<ForceCleanupResult, String> {
    let root = repository_root(&repo)?;
    validate_env_id(&env_id)?;
    let envs_base = merge_envs_dir(&root);
    let env = env_dir(&root, &env_id);

    let deleted = if !env.exists() {
        true
    } else {
        let canon_base = envs_base
            .canonicalize()
            .map_err(|_| "invalid_merge_env_path".to_string())?;
        let canon_env = env
            .canonicalize()
            .map_err(|_| "invalid_merge_env_path".to_string())?;
        if !canon_env.starts_with(&canon_base) {
            return Err("invalid_merge_env_path".to_string());
        }
        std::fs::remove_dir_all(&canon_env).is_ok()
    };

    let pruned = checked_output(&root, &["worktree", "prune"]).is_ok();
    let _ = std::fs::remove_file(meta_path(&root, &env_id));

    Ok(ForceCleanupResult { deleted, pruned })
}

/// Destroys the ephemeral environment without integrating anything.
#[tauri::command]
pub async fn merge_abort(repo: String, env_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || merge_abort_inner(repo, env_id))
        .await
        .map_err(|error| format!("merge_abort: blocking task failed: {error}"))?
}

pub(crate) fn merge_abort_inner(repo: String, env_id: String) -> Result<(), String> {
    let root = repository_root(&repo)?;
    validate_env_id(&env_id)?;
    let env = env_dir(&root, &env_id);
    let meta = read_meta(&root, &env_id).ok();

    let env_arg = git_arg(&env);
    let _ = git_command(&root, &["worktree", "remove", "--force", &env_arg]);
    let _ = git_command(&root, &["branch", "-D", &format!("alethe/merge-{env_id}")]);
    let _ = std::fs::remove_file(meta_path(&root, &env_id));

    if let Some(meta) = meta {
        emit("MergeAborted", &meta, serde_json::json!({}));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::merge_analyzer::tests::conflicting_repo;
    use std::fs;

    // Tests call the synchronous logic directly, no need for an async runtime
    // — the async `#[tauri::command]`s above are just thin wrappers in
    // `spawn_blocking`. Explicit shadowing wins over the `use super::*`
    // above without conflict (Rust's standard name-resolution rule).
    use super::merge_abort_inner as merge_abort;
    use super::merge_finalize_inner as merge_finalize;
    use super::merge_force_cleanup_inner as merge_force_cleanup;
    use super::merge_preflight_abort_inner as merge_preflight_abort;
    use super::merge_prepare_inner as merge_prepare;
    use super::merge_rebase_onto_target_inner as merge_rebase_onto_target;

    #[test]
    fn full_cycle_conflict_resolution_validation_and_ff() {
        let (root, root_str) = conflicting_repo();
        // Integration target: agent-a needs to be checked out in the repo.
        checked_output(&root, &["checkout", "agent-a"]).unwrap();

        let env =
            merge_prepare(root_str.clone(), "agent-b".into(), "agent-a".into(), None).unwrap();
        assert!(!env.clean);
        assert_eq!(env.conflicts.len(), 1);
        let env_path = PathBuf::from(&env.path);
        // Minimal context prompt exists and locks the scope.
        let prompt = fs::read_to_string(env.prompt_path.as_ref().unwrap()).unwrap();
        assert!(prompt.contains("shared.ts"));
        assert!(prompt.contains("NEVER implement"));
        // The file has real conflict markers.
        let conflicted = fs::read_to_string(env_path.join("shared.ts")).unwrap();
        assert!(conflicted.contains("<<<<<<<"));

        // Finalize BEFORE resolving → blocked on markers, environment preserved.
        let blocked = merge_finalize(root_str.clone(), env.id.clone(), vec![], None, None).unwrap();
        assert!(!blocked.merged);
        assert_eq!(blocked.stage, "conflict_markers");
        assert!(env_path.is_dir());

        // "Agent" resolves preserving both intentions.
        fs::write(
            env_path.join("shared.ts"),
            "export const value = 'from-a+from-b'\n",
        )
        .unwrap();

        // Validation that fails → merge blocked, environment preserved.
        let failed = merge_finalize(
            root_str.clone(),
            env.id.clone(),
            vec!["exit 1".into()],
            None,
            None,
        )
        .unwrap();
        assert!(!failed.merged);
        assert!(failed.stage.starts_with("validation:"));
        assert!(env_path.is_dir());

        // Validation that passes → commit + ff on agent-a + teardown.
        let ok = merge_finalize(
            root_str.clone(),
            env.id.clone(),
            vec!["echo ok".into()],
            None,
            None,
        )
        .unwrap();
        assert!(
            ok.merged,
            "expected a merge, got: {} / {}",
            ok.stage, ok.output
        );
        assert!(!env_path.exists());
        let merged = fs::read_to_string(root.join("shared.ts")).unwrap();
        assert!(merged.contains("from-a+from-b"));
        // other.rs came along from branch B in the merge.
        let other = fs::read_to_string(root.join("other.rs")).unwrap();
        assert!(other.contains("from_b"));
        // ALETHE_CONFLICT.md (the ephemeral prompt) must never leak into the
        // final commit — real regression: `git add -A` staged the file
        // BEFORE it was removed from disk, so deleting it afterward didn't
        // undo the stage and it still ended up in the commit (fixed: removal
        // now happens before `add -A`).
        assert!(!root.join("ALETHE_CONFLICT.md").exists());
        // Temporary branch removed.
        let branches = checked_output(&root, &["branch", "--list", "alethe/merge-*"]).unwrap();
        assert!(String::from_utf8_lossy(&branches.stdout).trim().is_empty());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clean_merge_skips_agent_and_integrates() {
        let (root, root_str) = conflicting_repo();
        // main is an ancestor of agent-a → merge is clean right away.
        let env = merge_prepare(root_str.clone(), "agent-a".into(), "main".into(), None).unwrap();
        assert!(env.clean);
        assert!(env.prompt_path.is_none());
        let ok =
            merge_finalize(root_str.clone(), env.id, vec!["echo ok".into()], None, None).unwrap();
        assert!(
            ok.merged,
            "expected a merge, got: {} / {}",
            ok.stage, ok.output
        );
        let value = fs::read_to_string(root.join("shared.ts")).unwrap();
        assert!(value.contains("from-a"));
        fs::remove_dir_all(root).unwrap();
    }

    /// Real bug, confirmed live with a real OpenCode agent: a branch WITHOUT
    /// any commit relative to the target (`git merge --ff-only` responds
    /// "Already up to date", exit 0) made `merge_finalize_inner` return
    /// `merged: true` all the same — the UI showed "Merge complete" without
    /// `main` advancing even a single commit. Locks in this fix: a branch
    /// created from `main`, with no changes at all, needs to honestly report
    /// that there's nothing to integrate.
    #[test]
    fn finalize_reports_nothing_to_integrate_for_branch_without_changes() {
        let (root, root_str) = conflicting_repo();
        // New branch, created on top of `main`, with no commit of its own.
        checked_output(&root, &["checkout", "-b", "agent-empty"]).unwrap();
        checked_output(&root, &["checkout", "main"]).unwrap();

        let env =
            merge_prepare(root_str.clone(), "agent-empty".into(), "main".into(), None).unwrap();
        assert!(env.clean);
        let outcome =
            merge_finalize(root_str.clone(), env.id, vec!["echo ok".into()], None, None).unwrap();
        assert!(
            !outcome.merged,
            "should not report a merge — nothing changed: {} / {}",
            outcome.stage, outcome.output
        );
        assert_eq!(outcome.stage, "nothing_to_integrate");
        // Ephemeral environment preserved (same rule as the other blocked
        // stages) — no teardown for a "merge" that didn't happen.
        assert!(PathBuf::from(&env.path).is_dir());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preflight_abort_is_a_safe_noop_when_nothing_in_progress() {
        let (root, root_str) = conflicting_repo();
        let env =
            merge_prepare(root_str.clone(), "agent-b".into(), "agent-a".into(), None).unwrap();
        // Nothing in progress — should not fail even without a pending merge/rebase.
        merge_preflight_abort(root_str.clone(), env.id.clone()).unwrap();
        merge_abort(root_str, env.id).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rebase_onto_target_recovers_from_concurrent_commit_on_target() {
        let (root, root_str) = conflicting_repo();
        checked_output(&root, &["checkout", "agent-a"]).unwrap();

        // Normal conflict between agent-b and agent-a, like in the full cycle.
        let env =
            merge_prepare(root_str.clone(), "agent-b".into(), "agent-a".into(), None).unwrap();
        assert!(!env.clean);
        let env_path = PathBuf::from(&env.path);

        // "Agent" resolves preserving both intentions.
        fs::write(
            env_path.join("shared.ts"),
            "export const value = 'from-a+from-b'\n",
        )
        .unwrap();

        // CONCURRENT commit on agent-a (the target) — simulates another
        // integration that advanced the branch while the merge was in
        // progress. Needs to be in a different file so it doesn't also
        // generate a rebase conflict.
        fs::write(root.join("concurrent.txt"), "concurrent commit\n").unwrap();
        checked_output(&root, &["add", "concurrent.txt"]).unwrap();
        checked_output(&root, &["commit", "-m", "concurrent commit"]).unwrap();

        // Finalize now fails due to divergence, not markers/validation.
        let diverged = merge_finalize(
            root_str.clone(),
            env.id.clone(),
            vec!["echo ok".into()],
            None,
            None,
        )
        .unwrap();
        assert!(!diverged.merged);
        assert_eq!(diverged.stage, "branch_diverged");
        assert!(env_path.is_dir(), "environment must be preserved for retry");

        // Preventive abort (Manual Retry) — nothing in progress yet, no-op ok.
        merge_preflight_abort(root_str.clone(), env.id.clone()).unwrap();

        // Rebase onto the target's new tip — no conflict (different file).
        let rebased = merge_rebase_onto_target(root_str.clone(), env.id.clone()).unwrap();
        assert_eq!(rebased.stage, "rebase_ok", "output: {}", rebased.output);

        // Reintegrates — the ff-only should work now.
        let ok = merge_finalize(
            root_str.clone(),
            env.id.clone(),
            vec!["echo ok".into()],
            None,
            None,
        )
        .unwrap();
        assert!(
            ok.merged,
            "expected a merge, got: {} / {}",
            ok.stage, ok.output
        );

        // Critical assertion: the concurrent commit is present in the final target.
        assert!(root.join("concurrent.txt").is_file());
        let merged = fs::read_to_string(root.join("shared.ts")).unwrap();
        assert!(merged.contains("from-a+from-b"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn force_cleanup_deletes_and_prunes_then_is_idempotent() {
        let (root, root_str) = conflicting_repo();
        let env =
            merge_prepare(root_str.clone(), "agent-b".into(), "agent-a".into(), None).unwrap();
        let env_path = PathBuf::from(&env.path);
        assert!(env_path.is_dir());

        let result = merge_force_cleanup(root_str.clone(), env.id.clone()).unwrap();
        assert!(result.deleted);
        assert!(result.pruned);
        assert!(!env_path.exists());

        // Running again (folder already gone) still reports success — this is
        // exactly the `pruneOnly` scenario the frontend catalogs as orphaned.
        let again = merge_force_cleanup(root_str.clone(), env.id).unwrap();
        assert!(again.deleted);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn abort_destroys_environment() {
        let (root, root_str) = conflicting_repo();
        let env =
            merge_prepare(root_str.clone(), "agent-b".into(), "agent-a".into(), None).unwrap();
        let env_path = PathBuf::from(&env.path);
        assert!(env_path.is_dir());
        merge_abort(root_str.clone(), env.id.clone()).unwrap();
        assert!(!env_path.exists());
        // Forged id is rejected.
        assert!(merge_abort(root_str, "../evil".into()).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
