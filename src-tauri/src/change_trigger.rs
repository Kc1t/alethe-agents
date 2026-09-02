//! Watches a project's source for accumulated change and asks — once it has settled — whether the
//! agent should write up the procedure for what was done.
//!
//! Replaces the GSD watcher's premise. That one watched `.planning/` and reacted to the *procedure
//! file itself* changing, which only ever happened when something had already written it. This
//! watches the thing the procedure is supposed to describe (the code) and fires before it exists.
//!
//! Two conditions must hold, and the second is what keeps this from being an interruption:
//!
//! - **Volume**: at least `file_threshold` distinct files changed since the last time the trigger
//!   fired or was dismissed. Counted as distinct paths, not events, because one save can emit
//!   several events for the same file and a formatter can rewrite a file repeatedly.
//! - **Quiet**: nothing has changed for `quiet_period_ms`. Firing the moment the threshold is
//!   crossed would interrupt mid-edit, which is exactly when a prompt is least welcome and the
//!   description would be least accurate — the work is not finished yet.
//!
//! The trigger only ever *emits an event*. Whether that turns into a prompt for the agent is the
//! frontend's decision, and by design it asks the user first: this spends the user's tokens and
//! interrupts whatever the agent is doing.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

use crate::project_file_watcher::{start_project_watcher, ProjectWatcherHandle};

/// Emitted when both conditions are met. The frontend decides what to do with it.
pub const CHANGE_TRIGGER_EVENT: &str = "change-trigger://fired";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeTriggerConfig {
    /// Distinct files that must change before the trigger is eligible to fire.
    pub file_threshold: usize,
    /// How long the project must be untouched before firing.
    pub quiet_period_ms: u64,
}

impl Default for ChangeTriggerConfig {
    fn default() -> Self {
        Self {
            // Ten files is a chunk of work worth describing, without firing on a one-file fix.
            file_threshold: 10,
            // Two minutes of quiet reads as "stopped", not "paused to think".
            quiet_period_ms: 120_000,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeTriggerPayload {
    pub project_id: String,
    /// Distinct files changed since the last fire or dismissal.
    pub file_count: usize,
    /// A sample of the paths, for the prompt and for showing the user what it noticed. Capped so a
    /// large refactor cannot produce an unbounded event.
    pub sample_paths: Vec<String>,
}

const MAX_SAMPLE_PATHS: usize = 40;

struct WatchedProject {
    handle: ProjectWatcherHandle,
    state: Arc<Mutex<AccumulatedChange>>,
}

#[derive(Default)]
struct AccumulatedChange {
    /// Distinct relative paths seen since the last fire/dismissal. A set, not a counter: saving the
    /// same file twenty times is one file's worth of change, not twenty.
    paths: BTreeSet<String>,
    last_change_at: Option<Instant>,
    /// Set when the trigger fires, cleared on dismissal — stops it from firing again every quiet
    /// tick while the user has an unanswered prompt on screen.
    awaiting_answer: bool,
}

#[derive(Default)]
pub struct ChangeTriggerRegistry {
    projects: Mutex<HashMap<String, WatchedProject>>,
}

impl ChangeTriggerRegistry {
    fn insert(&self, project_id: String, watched: WatchedProject) {
        if let Some(previous) = self.projects.lock().unwrap().insert(project_id, watched) {
            previous.handle.stop();
        }
    }

    fn remove(&self, project_id: &str) {
        if let Some(previous) = self.projects.lock().unwrap().remove(project_id) {
            previous.handle.stop();
        }
    }

    fn state_for(&self, project_id: &str) -> Option<Arc<Mutex<AccumulatedChange>>> {
        self.projects
            .lock()
            .unwrap()
            .get(project_id)
            .map(|watched| watched.state.clone())
    }
}

/// Decides whether the accumulated change is ready to be reported. Pure, so the rule is testable
/// without a filesystem or a timer.
fn should_fire(
    change: &AccumulatedChange,
    config: &ChangeTriggerConfig,
    now: Instant,
) -> bool {
    if change.awaiting_answer {
        return false;
    }
    if change.paths.len() < config.file_threshold {
        return false;
    }
    match change.last_change_at {
        Some(last) => now.duration_since(last) >= Duration::from_millis(config.quiet_period_ms),
        None => false,
    }
}

#[tauri::command]
pub fn change_trigger_start(
    app: tauri::AppHandle,
    registry: tauri::State<'_, Arc<ChangeTriggerRegistry>>,
    project_id: String,
    project_root: String,
    config: Option<ChangeTriggerConfig>,
) -> Result<bool, String> {
    let config = config.unwrap_or_default();
    let root = PathBuf::from(&project_root);
    if !root.is_dir() {
        return Err("change_trigger_project_root_missing".to_string());
    }

    let state = Arc::new(Mutex::new(AccumulatedChange::default()));
    let batch_state = state.clone();
    let handle = start_project_watcher(root, move |batch| {
        let mut guard = batch_state.lock().unwrap();
        for path in batch.changed_paths {
            guard.paths.insert(path);
        }
        guard.last_change_at = Some(Instant::now());
    });
    let Some(handle) = handle else {
        return Ok(false);
    };

    let registry_inner: Arc<ChangeTriggerRegistry> = registry.inner().clone();
    registry_inner.insert(
        project_id.clone(),
        WatchedProject {
            handle,
            state: state.clone(),
        },
    );

    // The watcher only tells us when something changed; the quiet condition needs a clock of its
    // own, since "nothing happened for two minutes" produces no event to react to.
    let poll_project_id = project_id;
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        let Some(state) = registry_inner.state_for(&poll_project_id) else {
            // The project stopped being watched — this poller has nothing left to do.
            break;
        };
        let payload = {
            let mut guard = state.lock().unwrap();
            if !should_fire(&guard, &config, Instant::now()) {
                continue;
            }
            guard.awaiting_answer = true;
            ChangeTriggerPayload {
                project_id: poll_project_id.clone(),
                file_count: guard.paths.len(),
                sample_paths: guard.paths.iter().take(MAX_SAMPLE_PATHS).cloned().collect(),
            }
        };
        let _ = app.emit(CHANGE_TRIGGER_EVENT, payload);
    });

    Ok(true)
}

#[tauri::command]
pub fn change_trigger_stop(
    registry: tauri::State<'_, Arc<ChangeTriggerRegistry>>,
    project_id: String,
) {
    registry.remove(&project_id);
}

/// Clears what has accumulated. Called both when the user accepts (the procedure now covers this
/// work) and when they decline (they were asked once; asking again about the same batch would be
/// nagging).
#[tauri::command]
pub fn change_trigger_acknowledge(
    registry: tauri::State<'_, Arc<ChangeTriggerRegistry>>,
    project_id: String,
) {
    if let Some(state) = registry.state_for(&project_id) {
        let mut guard = state.lock().unwrap();
        guard.paths.clear();
        guard.last_change_at = None;
        guard.awaiting_answer = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change_with(paths: &[&str], last_change_ago: Option<Duration>) -> AccumulatedChange {
        AccumulatedChange {
            paths: paths.iter().map(|p| p.to_string()).collect(),
            last_change_at: last_change_ago.map(|ago| Instant::now() - ago),
            awaiting_answer: false,
        }
    }

    fn config() -> ChangeTriggerConfig {
        ChangeTriggerConfig {
            file_threshold: 3,
            quiet_period_ms: 1_000,
        }
    }

    #[test]
    fn waits_for_both_volume_and_quiet() {
        let now = Instant::now();

        // Enough files, but the last change was just now — firing here would interrupt an edit in
        // progress, and describe work that isn't finished.
        let busy = change_with(&["a.rs", "b.rs", "c.rs"], Some(Duration::from_millis(10)));
        assert!(!should_fire(&busy, &config(), now));

        // Quiet for long enough, but barely anything changed.
        let small = change_with(&["a.rs"], Some(Duration::from_secs(30)));
        assert!(!should_fire(&small, &config(), now));

        // Both conditions met.
        let ready = change_with(&["a.rs", "b.rs", "c.rs"], Some(Duration::from_secs(30)));
        assert!(should_fire(&ready, &config(), now));
    }

    #[test]
    fn repeated_saves_of_one_file_are_one_file() {
        // The watcher emits an event per save, and formatters rewrite files on save — counting
        // events instead of distinct paths would fire on a single file edited a few times.
        let mut change = AccumulatedChange::default();
        for _ in 0..25 {
            change.paths.insert("src/main.rs".to_string());
        }
        change.last_change_at = Some(Instant::now() - Duration::from_secs(30));
        assert_eq!(change.paths.len(), 1);
        assert!(!should_fire(&change, &config(), Instant::now()));
    }

    #[test]
    fn does_not_fire_again_while_an_answer_is_pending() {
        let mut change = change_with(&["a.rs", "b.rs", "c.rs"], Some(Duration::from_secs(30)));
        assert!(should_fire(&change, &config(), Instant::now()));
        change.awaiting_answer = true;
        assert!(
            !should_fire(&change, &config(), Instant::now()),
            "an unanswered prompt must not be re-fired every poll"
        );
    }
}
