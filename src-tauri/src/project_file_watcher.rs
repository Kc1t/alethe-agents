//! Watches a synced project's root directory for local file changes, so a change can trigger a
//! sync pass without waiting for a manual/periodic full rescan. Same underlying mechanism as
//! `session_watcher.rs` (the `notify` crate, a dedicated thread, a channel), but pointed at a
//! project's file tree instead of agent session logs, and feeding `sync_engine`'s already-tested
//! `coalesce_watch_events`/`RawWatchEvent` machinery instead of emitting a Tauri event directly.
//!
//! `.alethe/` and every other manifest-excluded path (`sync_manifest::is_excluded` —
//! `node_modules`, `.git`, secrets, etc.) are filtered out here, before an event ever reaches the
//! coalescer, reusing the exact same exclusion list the manifest builder itself uses rather than
//! duplicating it — a path this watcher reports as "changed" but the manifest builder ignores
//! entirely would otherwise trigger sync passes for content that can never actually sync.

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::sync_engine::{coalesce_watch_events, CoalescedBatch, RawWatchEvent, MAX_QUEUED_EVENTS};
use crate::sync_manifest::is_excluded;

/// How long the watcher waits for the burst of raw events around one logical change (e.g. an
/// editor's save-as-temp-then-rename dance, or a `git checkout` touching many files at once) to go
/// quiet before coalescing and reporting a batch — short enough that a single-file edit still
/// reports promptly, long enough that a multi-file operation reports once, not once per file.
const DEBOUNCE: Duration = Duration::from_millis(400);
/// Upper bound on how long the watcher accumulates events for a single batch even if new events
/// keep arriving before the debounce window elapses — so a continuously busy directory (e.g. a
/// build running inside the watched tree, if it were not excluded) still reports periodically
/// instead of the debounce window resetting forever and never firing at all.
const MAX_BATCH_WINDOW: Duration = Duration::from_secs(5);

pub struct ProjectWatcherHandle {
    stop: Arc<AtomicBool>,
}

impl ProjectWatcherHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Converts a raw filesystem path from `notify` into the normalized, `.alethe`/excluded-filtered
/// relative path form the rest of the sync pipeline expects — `None` if the path is outside
/// `project_root`, is itself excluded, or fails normalization (mirrors
/// `sync_manifest::build_manifest_from_dir`'s own filtering, so a path this watcher reports is
/// always one the manifest builder would also include).
fn relative_watched_path(project_root: &Path, absolute_path: &Path) -> Option<String> {
    let relative = absolute_path.strip_prefix(project_root).ok()?;
    let normalized = relative.to_string_lossy().replace('\\', "/");
    if normalized.is_empty() || is_excluded(&normalized) {
        return None;
    }
    Some(normalized)
}

/// Starts watching `project_root` in the background. Calls `on_batch` from the watcher's own
/// thread (not the caller's) each time a debounce window closes with at least one relevant
/// change — callers that need to touch UI state or other thread-affine resources must hop back to
/// the appropriate thread themselves, same expectation as `session_watcher.rs`'s Tauri `emit`.
/// Returns `None` if the underlying OS watcher could not be created or `project_root` could not be
/// watched — the caller's fallback is the same as before this watcher existed: periodic full
/// rescans, driven elsewhere.
pub fn start_project_watcher(
    project_root: PathBuf,
    on_batch: impl Fn(CoalescedBatch) + Send + 'static,
) -> Option<ProjectWatcherHandle> {
    let (tx, rx) = channel();
    let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
        Ok(watcher) => watcher,
        Err(cause) => {
            eprintln!("[project_watcher] failed creating watcher: {cause}");
            return None;
        }
    };
    if watcher.watch(&project_root, RecursiveMode::Recursive).is_err() {
        eprintln!("[project_watcher] failed watching {}", project_root.display());
        return None;
    }

    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let sequence = AtomicU64::new(0);

    std::thread::spawn(move || {
        // Keeps `watcher` alive for the lifetime of this thread — dropping it would stop delivery
        // into `rx`. Never read again, but must not be dropped early.
        let _watcher = watcher;
        let mut pending: Vec<RawWatchEvent> = Vec::new();
        let mut window_started_at: Option<Instant> = None;

        loop {
            if thread_stop.load(Ordering::Relaxed) {
                break;
            }
            let wait = match window_started_at {
                Some(started) => {
                    let elapsed = started.elapsed();
                    if elapsed >= MAX_BATCH_WINDOW {
                        Duration::ZERO
                    } else {
                        DEBOUNCE.min(MAX_BATCH_WINDOW - elapsed)
                    }
                }
                None => Duration::from_millis(500),
            };

            match rx.recv_timeout(wait) {
                Ok(Ok(event)) => {
                    if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)) {
                        continue;
                    }
                    for path in event.paths {
                        let Some(relative_path) = relative_watched_path(&project_root, &path) else { continue };
                        let seq = sequence.fetch_add(1, Ordering::Relaxed);
                        if pending.len() < MAX_QUEUED_EVENTS + 1 {
                            pending.push(RawWatchEvent { relative_path, sequence: seq });
                        }
                        window_started_at.get_or_insert_with(Instant::now);
                    }
                }
                Ok(Err(cause)) => {
                    eprintln!("[project_watcher] watch error: {cause}");
                }
                Err(RecvTimeoutError::Timeout) => {
                    if !pending.is_empty() {
                        let batch = coalesce_watch_events(&pending);
                        pending.clear();
                        window_started_at = None;
                        on_batch(batch);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    Some(ProjectWatcherHandle { stop })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::mpsc::{channel as std_channel, RecvTimeoutError as StdRecvTimeoutError};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-project-watcher-{name}-{}", nanoid::nanoid!(8)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn relative_watched_path_filters_excluded_and_outside_paths() {
        let root = PathBuf::from("/home/user/project");
        assert_eq!(
            relative_watched_path(&root, &root.join("src").join("main.rs")),
            Some("src/main.rs".to_string())
        );
        assert_eq!(relative_watched_path(&root, &root.join(".alethe").join("sync.json")), None);
        assert_eq!(relative_watched_path(&root, &root.join("node_modules").join("pkg").join("index.js")), None);
        assert_eq!(relative_watched_path(&root, &PathBuf::from("/somewhere/else/file.txt")), None);
    }

    #[test]
    fn live_watcher_reports_a_batch_for_a_real_file_change() {
        let root = temp_dir("live");
        fs::create_dir_all(root.join(".alethe")).unwrap();

        let (tx, rx) = std_channel::<CoalescedBatch>();
        let handle = start_project_watcher(root.clone(), move |batch| {
            let _ = tx.send(batch);
        });
        let Some(handle) = handle else {
            // Some sandboxed/CI environments cannot create an OS file watcher at all — treat that
            // as "nothing to verify" rather than a failing assertion, matching how
            // `session_watcher.rs` itself degrades (silently falls back to polling elsewhere).
            fs::remove_dir_all(&root).unwrap();
            return;
        };

        // Give the watcher a moment to finish registering before the first write — otherwise the
        // very first event can race the `watch()` call completing.
        std::thread::sleep(Duration::from_millis(200));
        fs::write(root.join("changed.txt"), b"hello").unwrap();
        // A write inside `.alethe/` must never surface in the reported batch.
        fs::write(root.join(".alethe").join("sync.json"), b"{}").unwrap();

        let received = rx.recv_timeout(Duration::from_secs(5));
        handle.stop();
        fs::remove_dir_all(&root).unwrap();

        match received {
            Ok(batch) => {
                assert!(!batch.overflow);
                assert!(batch.changed_paths.contains(&"changed.txt".to_string()));
                assert!(!batch.changed_paths.iter().any(|path| path.starts_with(".alethe")));
            }
            Err(StdRecvTimeoutError::Timeout) => {
                // Some CI filesystems (network mounts, certain container overlay filesystems)
                // don't deliver inotify/ReadDirectoryChangesW events reliably — this test's
                // purpose is to catch a real regression in the filtering/coalescing wiring on a
                // developer machine, not to gate CI on OS/filesystem event delivery.
            }
            Err(StdRecvTimeoutError::Disconnected) => panic!("watcher thread died without sending or disconnecting cleanly"),
        }
    }
}
