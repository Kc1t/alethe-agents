//! Procedures that can be *verified*, not just written.
//!
//! A procedure file that is merely read and trusted goes stale in silence: it says what someone
//! once intended, and nothing can tell how far the code has drifted from it since.
//!
//! So here a procedure is a claim about specific files, and the system holds it to that claim. Each
//! step names the files it covers, and each covered file records a fingerprint of its contents at
//! the moment it was covered. That fingerprint is what makes the difference between "this file has
//! a procedure" and "this file has a procedure that still describes it".
//!
//! Checking a procedure against the current tree yields three outcomes per changed file, and they
//! are deliberately not collapsed into one "incomplete" flag, because they call for different
//! things from the agent:
//!
//! - **Uncovered** — changed, and no step mentions it. Something was done and never written down.
//! - **Stale** — covered, but the file changed after the step was written. The step may still be
//!   right, or may now be describing code that no longer exists; only the agent can say which, so
//!   this asks whether to amend the existing step or add a new one.
//! - **Covered** — mentioned, and unchanged since. Nothing to do.
//!
//! Grouping is a first-class outcome, not a workaround: one step may cover many files. A refactor
//! touching forty files should not require forty steps — that produces filler text, not a
//! procedure. What the system insists on is that no changed file goes *unmentioned*.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// A file a step claims to cover, plus what it looked like when that claim was made.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoveredFile {
    pub path: String,
    /// Fingerprint of the file's contents when the step was written. Comparing it to the file now
    /// is what detects a step that has gone stale — without it, "covered" would mean "was covered
    /// at some point", which is the failure mode this module exists to prevent.
    pub content_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcedureStep {
    pub step_id: String,
    /// What was done.
    pub summary: String,
    /// How a person verifies it — the part that makes a procedure usable rather than a changelog.
    /// e.g. "open the chat panel and paste two images; both must appear in one message".
    #[serde(default)]
    pub verification: Option<String>,
    pub files: Vec<CoveredFile>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Procedure {
    pub procedure_id: String,
    pub project_id: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub steps: Vec<ProcedureStep>,
}

/// A file that differs from what the procedure recorded, and why it is being reported.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFinding {
    pub path: String,
    /// Set for a stale file: the step whose claim no longer holds, so the agent can amend that one
    /// instead of guessing which it was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_summary: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageReport {
    /// Changed, and no step mentions it at all.
    pub uncovered: Vec<FileFinding>,
    /// Covered by a step, but changed since that step was written.
    pub stale: Vec<FileFinding>,
    /// Changed and still accurately covered.
    pub covered_count: usize,
    /// Files a step claims that no longer exist or were never changed. Reported rather than
    /// ignored: a step pointing at a file nobody touched usually means the agent wrote the path
    /// wrong, and silently accepting it would let a procedure look complete while covering
    /// nothing.
    pub unknown_claims: Vec<FileFinding>,
}

impl CoverageReport {
    /// Whether the procedure fully accounts for the change. `unknown_claims` deliberately does not
    /// block: a stray path is worth reporting but does not mean the real work went undescribed.
    pub fn is_complete(&self) -> bool {
        self.uncovered.is_empty() && self.stale.is_empty()
    }
}

pub fn fingerprint(contents: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(contents);
    // The first 16 bytes are plenty to detect an edit; this is change detection, not security.
    format!("{:x}", hasher.finalize())[..32].to_string()
}

/// Compares a procedure against the files that actually changed.
///
/// `changed` maps each changed file's path to its current fingerprint. Callers build it from the
/// working tree; this function stays pure so the rule is testable without touching disk.
pub fn check_coverage(procedure: &Procedure, changed: &BTreeMap<String, String>) -> CoverageReport {
    let mut uncovered = Vec::new();
    let mut stale = Vec::new();
    let mut unknown_claims = Vec::new();
    let mut covered_count = 0;
    let mut claimed: BTreeSet<&str> = BTreeSet::new();

    for step in &procedure.steps {
        for file in &step.files {
            claimed.insert(file.path.as_str());
            match changed.get(&file.path) {
                Some(current_hash) if *current_hash == file.content_hash => covered_count += 1,
                Some(_) => stale.push(FileFinding {
                    path: file.path.clone(),
                    step_id: Some(step.step_id.clone()),
                    step_summary: Some(step.summary.clone()),
                }),
                None => unknown_claims.push(FileFinding {
                    path: file.path.clone(),
                    step_id: Some(step.step_id.clone()),
                    step_summary: Some(step.summary.clone()),
                }),
            }
        }
    }

    for path in changed.keys() {
        if !claimed.contains(path.as_str()) {
            uncovered.push(FileFinding {
                path: path.clone(),
                step_id: None,
                step_summary: None,
            });
        }
    }

    CoverageReport {
        uncovered,
        stale,
        covered_count,
        unknown_claims,
    }
}

/// Builds the `changed` map `check_coverage` expects, by fingerprinting each changed file as it
/// currently stands on disk.
///
/// This is the glue between the coverage rule and reality: the rule is pure and testable, but it
/// can only be trusted if the fingerprints it compares against are the files as they are *now*,
/// not as they were when the procedure was written.
///
/// A path that no longer exists (deleted, or renamed away) is skipped rather than reported as
/// changed-with-no-content. A deletion is real work, but it has no contents to fingerprint, so it
/// cannot go stale the way an edit can — treating it as an ordinary changed file would leave a
/// procedure permanently incomplete with no way for the agent to satisfy it.
pub fn fingerprint_changed_files<P: AsRef<std::path::Path>>(
    repo_root: P,
    changed_paths: &[String],
) -> BTreeMap<String, String> {
    let root = repo_root.as_ref();
    let mut map = BTreeMap::new();
    for path in changed_paths {
        if let Ok(contents) = std::fs::read(root.join(path)) {
            map.insert(path.clone(), fingerprint(&contents));
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(id: &str, summary: &str, files: &[(&str, &str)]) -> ProcedureStep {
        ProcedureStep {
            step_id: id.to_string(),
            summary: summary.to_string(),
            verification: None,
            files: files
                .iter()
                .map(|(path, hash)| CoveredFile {
                    path: path.to_string(),
                    content_hash: hash.to_string(),
                })
                .collect(),
        }
    }

    fn procedure(steps: Vec<ProcedureStep>) -> Procedure {
        Procedure {
            procedure_id: "proc_1".into(),
            project_id: "p1".into(),
            created_at_ms: 0,
            updated_at_ms: 0,
            steps,
        }
    }

    fn changed(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(p, h)| (p.to_string(), h.to_string()))
            .collect()
    }

    #[test]
    fn reports_a_changed_file_no_step_mentions() {
        let proc = procedure(vec![step("s1", "chat grid", &[("src/chat.tsx", "aaa")])]);
        let report = check_coverage(&proc, &changed(&[("src/chat.tsx", "aaa"), ("src/git.rs", "bbb")]));

        assert_eq!(report.covered_count, 1);
        assert_eq!(report.uncovered.len(), 1);
        assert_eq!(report.uncovered[0].path, "src/git.rs");
        assert!(!report.is_complete());
    }

    #[test]
    fn a_file_edited_after_being_covered_is_stale_not_covered() {
        // The whole reason covered files carry a fingerprint: without it this file would still
        // count as covered, and the procedure would describe code that has since changed.
        let proc = procedure(vec![step("s1", "chat grid", &[("src/chat.tsx", "hash-when-written")])]);
        let report = check_coverage(&proc, &changed(&[("src/chat.tsx", "hash-now-different")]));

        assert_eq!(report.covered_count, 0);
        assert_eq!(report.stale.len(), 1);
        assert_eq!(report.stale[0].path, "src/chat.tsx");
        // The offending step is named, so the agent can amend that step rather than guess.
        assert_eq!(report.stale[0].step_id.as_deref(), Some("s1"));
        assert_eq!(report.stale[0].step_summary.as_deref(), Some("chat grid"));
        assert!(!report.is_complete());
    }

    #[test]
    fn one_step_may_cover_many_files() {
        // A forty-file refactor must not require forty steps — that produces filler, not a
        // procedure. Grouping is a supported outcome, and a grouped step counts as real coverage.
        let files: Vec<(String, String)> = (0..40)
            .map(|i| (format!("src/file{i}.rs"), format!("h{i}")))
            .collect();
        let borrowed: Vec<(&str, &str)> = files
            .iter()
            .map(|(p, h)| (p.as_str(), h.as_str()))
            .collect();
        let proc = procedure(vec![step("s1", "rename type across the codebase", &borrowed)]);

        let report = check_coverage(&proc, &changed(&borrowed));
        assert_eq!(report.covered_count, 40);
        assert!(report.is_complete());
    }

    #[test]
    fn a_step_pointing_at_an_untouched_file_is_reported_but_does_not_block() {
        // Usually a typo'd path. Worth surfacing — a procedure covering nothing would otherwise
        // look complete — but it does not mean real work went undescribed.
        let proc = procedure(vec![step(
            "s1",
            "chat grid",
            &[("src/chat.tsx", "aaa"), ("src/typo-path.tsx", "zzz")],
        )]);
        let report = check_coverage(&proc, &changed(&[("src/chat.tsx", "aaa")]));

        assert_eq!(report.unknown_claims.len(), 1);
        assert_eq!(report.unknown_claims[0].path, "src/typo-path.tsx");
        assert!(report.is_complete(), "a stray claim must not block completion");
    }

    #[test]
    fn fingerprinting_skips_a_path_that_no_longer_exists() {
        // A deleted file has no contents to fingerprint. Reporting it as changed anyway would make
        // it permanently uncovered — no step could ever match a hash that cannot be computed.
        let root = std::env::temp_dir().join(format!("alethe-procedure-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("present.txt"), b"hello").unwrap();

        let map = fingerprint_changed_files(
            &root,
            &["present.txt".to_string(), "deleted.txt".to_string()],
        );

        assert_eq!(map.len(), 1);
        assert_eq!(map.get("present.txt"), Some(&fingerprint(b"hello")));
        assert!(!map.contains_key("deleted.txt"));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn fingerprint_changes_with_contents_and_is_stable_for_equal_contents() {
        assert_eq!(fingerprint(b"same"), fingerprint(b"same"));
        assert_ne!(fingerprint(b"before"), fingerprint(b"after"));
    }
}
