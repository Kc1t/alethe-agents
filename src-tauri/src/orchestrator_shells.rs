//! Shells a planner asks Alethe to keep running: a dev server, `docker compose up`, a watcher.
//!
//! Tauri-free on purpose, like `orchestrator_core`, which declares this module: both compile inside
//! the orchestrator tests and the standalone MCP binary. The app supplies the `ShellHost`.

use serde_json::{json, Value};

pub const SHELL_RUNNING: &str = "running";
pub const SHELL_EXITED: &str = "exited";
pub const SHELL_STOPPED: &str = "stopped";

/// Runs shells for the core. Implemented by the app on top of its PTYs.
pub trait ShellHost: Send + Sync {
    /// Starts `command_line` in `cwd` under `pty_id`. `run` tells this start apart from a later
    /// restart of the same shell, so a late exit report from the old process can be ignored.
    fn open(&self, pty_id: &str, run: u64, command_line: &str, cwd: &str) -> Result<(), String>;
    /// The last `max_bytes` the shell printed, escape sequences included.
    fn output(&self, pty_id: &str, max_bytes: usize) -> Result<String, String>;
    /// Stops the shell and releases its PTY: Ctrl+C first, the whole process tree if it has not
    /// exited in time. Safe on a shell whose process already ended.
    fn stop(&self, pty_id: &str) -> Result<(), String>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellOwnerKind {
    Planner,
    Worker,
}

impl ShellOwnerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Planner => "planner",
            Self::Worker => "worker",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "planner" => Some(Self::Planner),
            "worker" => Some(Self::Worker),
            _ => None,
        }
    }
}

/// Who asked for this shell. Only planners can open one today; the kind is carried so a worker-owned
/// shell needs no change here or on the board.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellOwner {
    pub kind: ShellOwnerKind,
    pub id: String,
}

impl ShellOwner {
    pub fn planner(id: impl Into<String>) -> Self {
        Self { kind: ShellOwnerKind::Planner, id: id.into() }
    }

    pub fn to_value(&self) -> Value {
        json!({ "kind": self.kind.as_str(), "id": self.id })
    }

    pub fn from_value(value: &Value) -> Option<Self> {
        let kind = ShellOwnerKind::parse(value.get("kind")?.as_str()?)?;
        let id = value.get("id")?.as_str()?;
        if id.is_empty() {
            return None;
        }
        Some(Self { kind, id: id.to_string() })
    }
}

#[derive(Clone, Debug)]
pub struct Shell {
    pub id: String,
    pub name: String,
    pub command: String,
    pub cwd: String,
    /// Who opened it. `None` for a shell whose owner was never recorded.
    pub owner: Option<ShellOwner>,
    pub status: String,
    pub exit_code: Option<i32>,
    pub started_at_ms: u64,
    /// Counts starts; an exit report carries the run it belongs to.
    pub run: u64,
    /// What it printed last, kept when it stops or exits: stopping releases the PTY and its
    /// scrollback with it.
    pub last_output: String,
}

/// The orchestrator's PTY ids carry this prefix, which is how the frontend recognises them.
pub fn pty_id_for(shell_id: &str) -> String {
    format!("orchestrator-{shell_id}")
}

/// True when `existing` is already doing what `command`/`cwd` asks for: same command line, same
/// folder, still running. A `stopped` or `exited` shell never matches — the person may want a
/// fresh run, so those keep opening a new shell.
pub fn is_equivalent_running(existing: &Shell, command: &str, cwd: &str) -> bool {
    existing.status == SHELL_RUNNING && existing.command == command && existing.cwd == cwd
}

/// Finds a running shell equivalent to `command`/`cwd`, so a duplicate `alethe_open_shell` call can
/// adopt it instead of starting a second process for the same thing.
pub fn find_equivalent_running<'a>(
    shells: &'a [Shell],
    command: &str,
    cwd: &str,
) -> Option<&'a Shell> {
    shells.iter().find(|shell| is_equivalent_running(shell, command, cwd))
}

pub fn default_name(command: &str) -> String {
    command.split_whitespace().next().unwrap_or("shell").to_string()
}

/// Removes terminal escape sequences: CSI (colors, cursor moves), OSC (window titles) and the
/// two-character ones.
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // Parameters and intermediates sit below '@'; the first byte in '@'..='~' ends it.
            Some('[') => {
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            // Ends at BEL or at ESC '\'.
            Some(']') => {
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// The last `lines` lines as a person would see them: escapes removed, a line rewritten with `\r`
/// (a progress bar) reduced to its final state, trailing blank lines dropped.
pub fn tail_lines(text: &str, lines: usize) -> String {
    let cleaned: Vec<String> = strip_ansi(text)
        .split('\n')
        .map(|line| {
            line.rsplit('\r')
                .find(|part| !part.is_empty())
                .unwrap_or("")
                .trim_end()
                .to_string()
        })
        .collect();
    let end = cleaned
        .iter()
        .rposition(|line| !line.is_empty())
        .map_or(0, |index| index + 1);
    cleaned[end.saturating_sub(lines)..end].join("\n")
}

impl Shell {
    pub fn pty_id(&self) -> String {
        pty_id_for(&self.id)
    }

    pub fn snapshot(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "command": self.command,
            "cwd": self.cwd,
            "owner": self.owner.as_ref().map(ShellOwner::to_value),
            "status": self.status,
            "exitCode": self.exit_code,
            "startedAtMs": self.started_at_ms,
            "ptyId": self.pty_id(),
        })
    }

    pub fn record(&self) -> Value {
        let mut value = self.snapshot();
        value["lastOutput"] = Value::String(self.last_output.clone());
        value
    }

    /// A shell read back from disk never runs: its process died with the app that owned it.
    pub fn from_record(value: &Value) -> Option<Shell> {
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(ToOwned::to_owned);
        Some(Shell {
            id: text("id")?,
            name: text("name").unwrap_or_default(),
            command: text("command")?,
            cwd: text("cwd").unwrap_or_default(),
            // `plannerId` is what shells persisted before owners existed; it was always a planner.
            owner: value
                .get("owner")
                .and_then(ShellOwner::from_value)
                .or_else(|| text("plannerId").map(ShellOwner::planner)),
            status: SHELL_STOPPED.to_string(),
            exit_code: value
                .get("exitCode")
                .and_then(Value::as_i64)
                .map(|code| code as i32),
            started_at_ms: value
                .get("startedAtMs")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            run: 0,
            last_output: text("lastOutput").unwrap_or_default(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Shell {
        Shell {
            id: "shell-01".into(),
            name: "npm".into(),
            command: "npm run dev".into(),
            cwd: "C:\\app".into(),
            owner: Some(ShellOwner::planner("p1")),
            status: SHELL_RUNNING.into(),
            exit_code: None,
            started_at_ms: 1,
            run: 3,
            last_output: "ready".into(),
        }
    }

    #[test]
    fn strip_ansi_removes_colors_cursor_moves_and_titles() {
        let raw = "\u{1b}]0;npm\u{7}\u{1b}[32mready\u{1b}[0m in \u{1b}[1;33m120\u{1b}[0mms\u{1b}[2K\u{1b}[?25h";
        assert_eq!(strip_ansi(raw), "ready in 120ms");
    }

    #[test]
    fn strip_ansi_keeps_plain_text() {
        assert_eq!(strip_ansi("listening on :3000"), "listening on :3000");
    }

    #[test]
    fn tail_lines_keeps_the_end_and_the_final_state_of_rewritten_lines() {
        let raw = "one\r\ntwo\r\nbuild 10%\rbuild 100%\r\n\r\n";
        assert_eq!(tail_lines(raw, 2), "two\nbuild 100%");
    }

    #[test]
    fn a_shell_is_named_after_its_command_and_prefixed_as_a_pty() {
        assert_eq!(default_name("npm run dev"), "npm");
        assert_eq!(sample().pty_id(), "orchestrator-shell-01");
    }

    #[test]
    fn a_restored_shell_is_stopped_and_keeps_what_it_printed() {
        let restored = Shell::from_record(&sample().record()).expect("a shell");
        assert_eq!(restored.status, SHELL_STOPPED);
        assert_eq!(restored.command, "npm run dev");
        assert_eq!(restored.owner, Some(ShellOwner::planner("p1")));
        assert_eq!(restored.last_output, "ready");
        assert_eq!(restored.run, 0);
    }

    #[test]
    fn a_record_round_trips_its_owner() {
        let shell = sample();
        let restored = Shell::from_record(&shell.record()).expect("a shell");
        assert_eq!(
            restored.owner,
            Some(ShellOwner::planner("p1")),
            "the owner was lost on the way back"
        );
    }

    #[test]
    fn a_record_written_before_owners_reads_as_a_planner() {
        let legacy = json!({
            "id": "shell-01",
            "name": "npm",
            "command": "npm run dev",
            "cwd": "C:\\app",
            "plannerId": "p1",
            "status": "running",
            "exitCode": null,
            "startedAtMs": 0
        });
        let restored = Shell::from_record(&legacy).expect("a shell");
        assert_eq!(restored.owner, Some(ShellOwner::planner("p1")));
    }

    #[test]
    fn a_record_with_no_owner_at_all_reads_as_none() {
        let legacy = json!({ "id": "shell-01", "command": "npm run dev" });
        let restored = Shell::from_record(&legacy).expect("a shell");
        assert_eq!(restored.owner, None);
    }

    #[test]
    fn a_running_shell_with_the_same_command_and_cwd_is_equivalent() {
        assert!(is_equivalent_running(&sample(), "npm run dev", "C:\\app"));
    }

    #[test]
    fn a_different_command_or_cwd_is_not_equivalent() {
        assert!(!is_equivalent_running(&sample(), "npm run build", "C:\\app"));
        assert!(!is_equivalent_running(&sample(), "npm run dev", "C:\\other"));
    }

    #[test]
    fn a_stopped_or_exited_shell_is_never_equivalent_even_with_the_same_command_and_cwd() {
        let mut stopped = sample();
        stopped.status = SHELL_STOPPED.into();
        assert!(!is_equivalent_running(&stopped, "npm run dev", "C:\\app"));

        let mut exited = sample();
        exited.status = SHELL_EXITED.into();
        assert!(!is_equivalent_running(&exited, "npm run dev", "C:\\app"));
    }

    #[test]
    fn finding_an_equivalent_running_shell_skips_ones_that_do_not_match() {
        let mut stopped = sample();
        stopped.id = "shell-00".into();
        stopped.status = SHELL_STOPPED.into();
        let running = sample();
        let shells = vec![stopped, running];

        let found = find_equivalent_running(&shells, "npm run dev", "C:\\app").expect("a match");
        assert_eq!(found.id, "shell-01");

        assert!(find_equivalent_running(&shells, "npm run dev", "C:\\other").is_none());
    }
}
