//! RFC-006 — Merge Analyzer + Conflict Classifier.
//!
//! First stage of the safe merge cycle: **this module is the one that decides
//! whether a conflict exists**, never the agent. The merge trial runs in a
//! temporary, disposable worktree (`.alethe/merge-envs/analyze-<id>`), so the
//! user's working tree is NEVER touched.
//!
//! Flow (blueprint):
//! `Agent A/B done → Merge Analyzer → conflict? ─no→ Validation → Merge
//!                                        └yes→ Classifier → skill → Resolution Agent`
//!
//! The Classifier maps each conflicted file to a class (Rust, TS, UI, Cargo,
//! Package, JSON, Config, Asset, Planning, Graph, Other) and each class
//! carries a strategy — that's what the Conflict Resolution Agent (RFC-007)
//! receives as minimal context.

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::git_control::{checked_output, git_command, repository_root};
use crate::worktrees::git_arg;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictClass {
    Rust,
    TypeScript,
    Ui,
    Cargo,
    Package,
    Json,
    Config,
    Asset,
    Planning,
    /// Sentinel for ephemeral machine state (e.g. `.gsd-child-session`) — an
    /// opaque value (session ID, busy flag), not mergeable prose.
    Sentinel,
    Graph,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub class: ConflictClass,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeAnalysis {
    pub clean: bool,
    pub source: String,
    pub target: String,
    pub conflicts: Vec<ConflictFile>,
    pub classes: Vec<ConflictClass>,
}

/// Classifies by path/extension. Lockfiles and manifests get their own class
/// because the resolution strategy differs from regular code (e.g. regenerate
/// the lockfile instead of hand-editing it).
pub fn classify_path(path: &str) -> ConflictClass {
    let normalized = path.replace('\\', "/");
    let lower = normalized.to_lowercase();
    let file_name = lower.rsplit('/').next().unwrap_or(&lower).to_string();

    // Ephemeral machine-state sentinels from GSD Sync (session ID, busy flag,
    // error message) — checked BEFORE the generic `.planning/` fallback:
    // they're opaque, single-line values with no cross-branch "intent" to
    // preserve. Confirmed live: treating them as `Planning` ("preserve both
    // branches' history") led the agent to paste both values together with
    // a real conflict marker inside the file — which was then read raw as if
    // it were a valid session ID
    // (`--session <<<<<<< HEAD\nses_...\n=======\n...`), breaking the spawn.
    if file_name == ".gsd-child-session"
        || file_name == ".gsd-child-busy"
        || file_name == ".gsd-child-error"
    {
        return ConflictClass::Sentinel;
    }
    if lower.starts_with(".planning/") || lower.contains("/.planning/") {
        return ConflictClass::Planning;
    }
    if lower.starts_with("graphify-out/") || lower.contains("/graphify-out/") {
        return ConflictClass::Graph;
    }
    match file_name.as_str() {
        "cargo.toml" | "cargo.lock" => return ConflictClass::Cargo,
        "package.json" | "package-lock.json" | "yarn.lock" | "pnpm-lock.yaml" => {
            return ConflictClass::Package
        }
        _ => {}
    }

    let ext = file_name.rsplit('.').next().unwrap_or_default().to_string();
    match ext.as_str() {
        "rs" => ConflictClass::Rust,
        "ts" | "tsx" | "js" | "jsx" | "mts" | "cts" => ConflictClass::TypeScript,
        "css" | "scss" | "less" => ConflictClass::Ui,
        "json" => ConflictClass::Json,
        "toml" | "yml" | "yaml" | "ini" | "conf" | "env" | "properties" => ConflictClass::Config,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico" | "ttf" | "otf" | "woff"
        | "woff2" | "mp3" | "mp4" | "bin" => ConflictClass::Asset,
        _ => ConflictClass::Other,
    }
}

/// Strategy text per class — becomes part of the Resolution Agent's minimal
/// context. Kept here so the Classifier and the prompt never diverge.
pub fn class_strategy(class: ConflictClass) -> &'static str {
    match class {
        ConflictClass::Rust => {
            "Rust code: preserve both intentions; after resolving, the code must compile (cargo check)."
        }
        ConflictClass::TypeScript => {
            "TypeScript/JS code: preserve both intentions; duplicate imports/exports are the common cause; tsc must pass."
        }
        ConflictClass::Ui => {
            "Styles: merge the rules from both branches; never invent new colors — use the existing theme tokens."
        }
        ConflictClass::Cargo => {
            "Cargo.toml/lock: merge the dependencies from both branches; on a Cargo.lock conflict, prefer regenerating (cargo update -p / cargo check) over hand-editing."
        }
        ConflictClass::Package => {
            "package.json/lockfile: merge the dependencies; on a lockfile conflict, prefer regenerating (npm install) over hand-editing."
        }
        ConflictClass::Json => {
            "JSON: the result must be valid JSON; merge the keys from both branches; watch out for commas."
        }
        ConflictClass::Config => {
            "Configuration: merge the entries; for duplicate keys with different values, understand each branch's intent before choosing."
        }
        ConflictClass::Asset => {
            "Binary/asset: there is no textual merge — pick the correct version (usually the newest) via git checkout --theirs/--ours."
        }
        ConflictClass::Planning => {
            "Planning (.planning/): preserve both branches' history; never discard tasks from either side."
        }
        ConflictClass::Sentinel => {
            "Ephemeral machine state from GSD Sync (session ID, busy/error flag) — this is NOT content to merge, it's a single-line opaque value. NEVER paste both values together nor leave any conflict marker (<<<<<<<, =======, >>>>>>>) in the file. Resolve by deleting the file entirely (it is recreated on its own on the next GSD Sync cycle) — never pick a 'middle ground' value."
        }
        ConflictClass::Graph => {
            "Graph (graphify-out/): don't resolve by hand — the graph is generated; pick either side and regenerate with Graphify afterward."
        }
        ConflictClass::Other => {
            "Preserve both intentions; if unsure, keep both snippets and flag it in the commit."
        }
    }
}

fn ensure_branch(root: &Path, branch: &str) -> Result<(), String> {
    let ok = git_command(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .map(|o| o.status.success())
    .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(format!("branch_not_found:{branch}"))
    }
}

pub(crate) fn merge_envs_dir(root: &Path) -> PathBuf {
    root.join(".alethe").join("merge-envs")
}

/// Lists the non-merged paths (`--diff-filter=U`) of a worktree in conflict.
pub(crate) fn unmerged_files(dir: &Path) -> Result<Vec<String>, String> {
    let output = checked_output(dir, &["diff", "--name-only", "--diff-filter=U", "-z"])?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect())
}

/// Trial merge `source → target` in a disposable worktree. Never touches the
/// user's working tree. Publishes `MergeClean`/`MergeConflict` on the Event Bus.
#[tauri::command]
pub fn merge_analyze(
    repo: String,
    source: String,
    target: String,
    project_id: Option<String>,
) -> Result<MergeAnalysis, String> {
    let root = repository_root(&repo)?;
    ensure_branch(&root, &source)?;
    ensure_branch(&root, &target)?;

    let envs = merge_envs_dir(&root);
    std::fs::create_dir_all(&envs).map_err(|e| format!("mkdir_failed:{e}"))?;
    let env = envs.join(format!("analyze-{}", nanoid::nanoid!(8)));
    let env_arg = git_arg(&env);

    // Detached worktree on the target: the trial happens in here.
    checked_output(&root, &["worktree", "add", "--detach", &env_arg, &target])?;

    let merge = git_command(&env, &["merge", "--no-commit", "--no-ff", &source])?;
    let clean = merge.status.success();
    let conflicts = if clean {
        Vec::new()
    } else {
        unmerged_files(&env)?
            .into_iter()
            .map(|path| ConflictFile {
                class: classify_path(&path),
                path,
            })
            .collect::<Vec<_>>()
    };

    // Trial teardown (abort is best-effort: a clean merge without a commit
    // also leaves staged state that worktree remove --force discards).
    let _ = git_command(&env, &["merge", "--abort"]);
    let _ = git_command(&root, &["worktree", "remove", "--force", &env_arg]);

    let mut classes: Vec<ConflictClass> = conflicts.iter().map(|c| c.class).collect();
    classes.sort_by_key(|c| format!("{c:?}"));
    classes.dedup();

    crate::event_bus::publish_event_simple(
        if clean { "MergeClean" } else { "MergeConflict" },
        &format!("merge-{}", nanoid::nanoid!()),
        project_id,
        None,
        serde_json::json!({
            "source": source,
            "target": target,
            "conflict_count": conflicts.len(),
            "classes": classes.iter().map(|c| format!("{c:?}")).collect::<Vec<_>>(),
        }),
    );

    Ok(MergeAnalysis {
        clean,
        source,
        target,
        conflicts,
        classes,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn classifies_by_extension_and_special_paths() {
        assert_eq!(classify_path("src-tauri/src/pty.rs"), ConflictClass::Rust);
        assert_eq!(classify_path("src/lib/tauri.ts"), ConflictClass::TypeScript);
        assert_eq!(classify_path("src/App.module.css"), ConflictClass::Ui);
        assert_eq!(classify_path("src-tauri/Cargo.lock"), ConflictClass::Cargo);
        assert_eq!(classify_path("package-lock.json"), ConflictClass::Package);
        assert_eq!(classify_path("tauri.conf.json"), ConflictClass::Json);
        assert_eq!(classify_path("config/settings.yml"), ConflictClass::Config);
        assert_eq!(classify_path("assets/logo.png"), ConflictClass::Asset);
        assert_eq!(
            classify_path(".planning/roadmap.md"),
            ConflictClass::Planning
        );
        assert_eq!(
            classify_path("graphify-out/graph.json"),
            ConflictClass::Graph
        );
        assert_eq!(classify_path("README.md"), ConflictClass::Other);
        // Windows path separator also classifies correctly.
        assert_eq!(classify_path("src\\main.rs"), ConflictClass::Rust);
    }

    pub(crate) fn conflicting_repo() -> (PathBuf, String) {
        let root = std::env::temp_dir().join(format!("alethe-merge-{}", nanoid::nanoid!(8)));
        fs::create_dir_all(&root).unwrap();
        let run = |args: &[&str]| checked_output(&root, args).unwrap();
        run(&["init", "-b", "main"]);
        run(&["config", "user.name", "Alethe Test"]);
        run(&["config", "user.email", "alethe@example.invalid"]);
        fs::write(root.join("shared.ts"), "export const value = 'base'\n").unwrap();
        fs::write(root.join("other.rs"), "fn base() {}\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "base"]);
        // Branch A changes shared.ts
        run(&["checkout", "-b", "agent-a"]);
        fs::write(root.join("shared.ts"), "export const value = 'from-a'\n").unwrap();
        run(&["commit", "-am", "a"]);
        // Branch B changes the SAME file (conflict) and other.rs (clean)
        run(&["checkout", "main"]);
        run(&["checkout", "-b", "agent-b"]);
        fs::write(root.join("shared.ts"), "export const value = 'from-b'\n").unwrap();
        fs::write(root.join("other.rs"), "fn from_b() {}\n").unwrap();
        run(&["commit", "-am", "b"]);
        run(&["checkout", "main"]);
        let root_str = root.to_string_lossy().into_owned();
        (root, root_str)
    }

    #[test]
    fn detects_conflict_and_clean_merges() {
        let (root, root_str) = conflicting_repo();

        // agent-a → main: clean (main didn't diverge from the shared.ts base...
        // actually main is the ancestor, so it's always clean).
        let clean = merge_analyze(root_str.clone(), "agent-a".into(), "main".into(), None).unwrap();
        assert!(clean.clean);
        assert!(clean.conflicts.is_empty());

        // agent-b → agent-a: both changed shared.ts → TypeScript conflict.
        let conflicted =
            merge_analyze(root_str.clone(), "agent-b".into(), "agent-a".into(), None).unwrap();
        assert!(!conflicted.clean);
        assert_eq!(conflicted.conflicts.len(), 1);
        assert_eq!(conflicted.conflicts[0].path, "shared.ts");
        assert_eq!(conflicted.conflicts[0].class, ConflictClass::TypeScript);
        assert_eq!(conflicted.classes, vec![ConflictClass::TypeScript]);

        // The trial doesn't leave a worktree behind.
        assert!(!merge_envs_dir(&root).join("analyze").exists());
        let leftovers = fs::read_dir(merge_envs_dir(&root))
            .map(|d| d.count())
            .unwrap_or(0);
        assert_eq!(leftovers, 0);

        // Nonexistent branch fails cleanly.
        assert!(merge_analyze(root_str, "nope".into(), "main".into(), None).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
