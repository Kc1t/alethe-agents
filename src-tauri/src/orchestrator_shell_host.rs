//! The app side of orchestrator shells: each one is a PTY with no view attached, which the board
//! controls and a terminal pane can attach to.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Listener, Manager};

use crate::orchestrator::OrchestratorState;
use crate::orchestrator_core::ShellHost;
use crate::pty::{self, PtySessions};

/// How long Ctrl+C gets before the process tree is killed.
const STOP_GRACE: Duration = Duration::from_secs(5);
/// How long to wait, after a hard kill, for the old process's own `pty://exit` to land.
const EXIT_DRAIN: Duration = Duration::from_secs(3);
const HEADLESS_COLS: u16 = 120;
const HEADLESS_ROWS: u16 = 30;

#[derive(Deserialize)]
struct ExitPayload {
    code: Option<i32>,
}

pub struct PtyShellHost {
    app: AppHandle,
    /// PTYs whose process has ended, so `stop` knows Ctrl+C landed.
    exited: Arc<Mutex<HashSet<String>>>,
}

impl PtyShellHost {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            exited: Arc::default(),
        }
    }
}

fn shell_id_of(pty_id: &str) -> &str {
    pty_id.strip_prefix("orchestrator-").unwrap_or(pty_id)
}

impl ShellHost for PtyShellHost {
    fn open(&self, pty_id: &str, run: u64, command_line: &str, cwd: &str) -> Result<(), String> {
        if let Ok(mut exited) = self.exited.lock() {
            exited.remove(pty_id);
        }
        let exited = Arc::clone(&self.exited);
        let app = self.app.clone();
        let id = pty_id.to_string();
        self.app.once(format!("pty://exit/{pty_id}"), move |event| {
            let code = serde_json::from_str::<ExitPayload>(event.payload())
                .ok()
                .and_then(|payload| payload.code);
            if let Ok(mut exited) = exited.lock() {
                exited.insert(id.clone());
            }
            // Reported off the emitting thread: the core reads the final output back through this
            // host, and must not do that on the thread still tearing the PTY down.
            std::thread::spawn(move || {
                // On a natural exit the reader thread queues its final scrollback write and does
                // not wait for it (only a suspend does). Without this barrier, `shell_exited`'s
                // `host.output` can read the file before that write lands, or mid-truncation, and
                // report a shell's last output as empty or missing. This barrier only guarantees
                // writes queued before it are done, not this specific shell's write on its own, but
                // the writer processes one global queue in order, so waiting for it drains that
                // write too.
                let _ = pty::wait_for_scrollback_writer();
                let state = app.state::<OrchestratorState>();
                state.core().shell_exited(shell_id_of(&id), run, code);
            });
        });
        tauri::async_runtime::block_on(pty::spawn_pty(
            self.app.clone(),
            self.app.state::<PtySessions>(),
            self.app.state::<Arc<crate::remote::RemoteHub>>(),
            HEADLESS_COLS,
            HEADLESS_ROWS,
            Some(pty_id.to_string()),
            None,
            Some(cwd.to_string()),
            None,
            None,
            None,
            Some(command_line.to_string()),
        ))
        .map(|_| ())
    }

    fn output(&self, pty_id: &str, max_bytes: usize) -> Result<String, String> {
        tauri::async_runtime::block_on(pty::attach_pty(
            self.app.clone(),
            self.app.state::<PtySessions>(),
            pty_id.to_string(),
            Some(max_bytes),
        ))
    }

    fn stop(&self, pty_id: &str) -> Result<(), String> {
        // Ctrl+C lets `docker compose up` bring its containers down; killing its CLI outright
        // would leave them running under the Docker daemon.
        let ctrl_c_sent = tauri::async_runtime::block_on(pty::write_pty(
            self.app.state::<PtySessions>(),
            pty_id.to_string(),
            "\u{3}".to_string(),
        ))
        .is_ok();

        if !ctrl_c_sent {
            // No live PTY session to signal (the shell's `open` failed, or it was restored after
            // an app restart): there is nothing to wait out or drain, just release whatever
            // session state remains.
            return tauri::async_runtime::block_on(pty::kill_pty(
                self.app.clone(),
                self.app.state::<PtySessions>(),
                pty_id.to_string(),
            ));
        }

        let is_exited = |id: &str| {
            self.exited
                .lock()
                .map(|exited| exited.contains(id))
                .unwrap_or(false)
        };

        let deadline = Instant::now() + STOP_GRACE;
        while Instant::now() < deadline {
            if is_exited(pty_id) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let exited_before_kill = is_exited(pty_id);

        // Also releases the session a finished process still holds, so the id can be reused.
        let result = tauri::async_runtime::block_on(pty::kill_pty(
            self.app.clone(),
            self.app.state::<PtySessions>(),
            pty_id.to_string(),
        ));

        if !exited_before_kill {
            // `kill_pty` returns as soon as the kill is issued; it does not wait for the reader
            // task to notice the process died and emit `pty://exit` (reason "killed"). If a
            // restart calls `open` before that stale event lands, its fresh `once` listener would
            // catch it instead and misreport the new run as already exited, consuming the
            // listener that should have caught the new process's real exit. Wait here for the old
            // exit to actually land, so the next `open` starts with a clean listener.
            let drain_deadline = Instant::now() + EXIT_DRAIN;
            while Instant::now() < drain_deadline && !is_exited(pty_id) {
                std::thread::sleep(Duration::from_millis(100));
            }
        }

        result
    }
}
