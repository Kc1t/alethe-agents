# Orchestrator Shells Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A planner can start long-running commands as shells Alethe owns, read their output, and the person can stop, restart, run again, open and remove them from the orchestration board.

**Architecture:** The Tauri-free orchestrator core gains shell records and a `ShellHost` trait, the same injection pattern launchers use; the app implements the host on `pty.rs` (headless PTY spawn, `attach_pty` tail, Ctrl+C then kill). Shells ride the existing `orchestrator://jobs` snapshot, render as a **Shells** section in the board's side rail, and use the PTY id prefix `orchestrator-shell-` so the frontend detaches instead of killing when a view closes.

**Tech Stack:** Rust (Tauri 2, portable-pty 0.8.1, serde_json), React 18 + TypeScript, Vitest + Testing Library, CSS Modules.

**Spec:** `docs/superpowers/specs/2026-09-15-orchestrator-shells-design.md`

## Global Constraints

- `src-tauri/src/orchestrator_core.rs` and the new `src-tauri/src/orchestrator_shells.rs` stay free of Tauri imports: both compile inside `src-tauri/tests/orchestrator.rs` and the standalone `alethe-orchestrator-mcp` binary through `#[path]`.
- English for code, comments, docs and commit messages. Every visible string goes through `t()` (or `translate(getLocale(), …)` outside React), with the key in both `src/lib/i18n/messages/en.ts` and `pt-BR.ts`.
- Colors only through theme tokens (`--fg`, `--fg-muted`, `--status-working`, …); no literal colors, no gradients. Spacing follows the literal-px practice of `OrchestratorPane.module.css`.
- Every user-facing change gets an entry under `[Unreleased]` in `docs/CHANGELOG.md`.
- Never stop or restart the owner's running app. Manual checks use `npm run app -- --no-watch`, only when the owner is ready.
- Commit only with the owner's go-ahead. Commit messages carry no co-author, session or tool trailers.
- Values: stop grace 5 s; `alethe_shell_output` 40 lines by default, 200 at most; output read window 64 KiB; headless PTY 120x30; board card tail 12 lines, polled every 2 s while running; PTY id `orchestrator-<shellId>`.

**Commands**

- Rust orchestrator tests: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator`
- Rust lib tests: `cargo test --manifest-path src-tauri/Cargo.toml --lib cli_resolver`
- App compiles: `cargo check --manifest-path src-tauri/Cargo.toml`
- Frontend tests: `npx vitest run <file>`
- Typecheck + i18n parity: `npm run build`

## File Structure

| File | Responsibility |
| --- | --- |
| `src-tauri/src/orchestrator_shells.rs` (new) | `ShellHost` trait, `Shell` record, status constants, PTY id prefix, ANSI stripping, tail extraction |
| `src-tauri/src/orchestrator_core.rs` | Owns shell records: open, output, exit, stop, restart, remove, persistence, tools, instructions |
| `src-tauri/src/cli_resolver.rs` | Builds `pwsh -Command <line>` / `$SHELL -lc <line>` for a shell given a command line |
| `src-tauri/src/pty.rs` | `spawn_pty` / `restart_pty` accept `command_line` |
| `src-tauri/src/orchestrator_shell_host.rs` (new) | `PtyShellHost`: the app's `ShellHost` on `pty.rs`, exit listener |
| `src-tauri/src/orchestrator.rs` | Registers the host; Tauri commands for the board |
| `src-tauri/src/lib.rs` | Module + command registration |
| `src/lib/orchestratorShells.ts` (new) | PTY prefix helpers, which controls a status offers |
| `src/lib/tauri/orchestrator.ts` | Shell types, snapshot field, command wrappers |
| `src/lib/terminalLifecycle.ts` | Closing a view of an orchestrator shell detaches instead of killing |
| `src/lib/tauri/pty.ts` | Restarting a view of an orchestrator shell restarts the service |
| `src/lib/terminalFactory.ts`, `src/stores/projectsStore.ts` | A new terminal's first tab may name its PTY id |
| `src/components/XTermView/useXtermSession.ts` | A view that outlived its shell never spawns under its id |
| `src/components/OrchestratorPane/ShellCard.tsx` + `.module.css` (new) | One shell on the board |
| `src/components/OrchestratorPane/index.tsx` | Shells section in the rail, controls, open terminal |
| `src-tauri/assets/planner-guide.md`, `docs/CHANGELOG.md` | Docs |

---

### Task 1: Shell records and clean output

**Files:**
- Create: `src-tauri/src/orchestrator_shells.rs`
- Modify: `src-tauri/src/orchestrator_core.rs` (module declaration after the `use serde_json::{json, Map, Value};` line)

**Interfaces:**
- Produces: `pub trait ShellHost { fn open(&self, pty_id: &str, run: u64, command_line: &str, cwd: &str) -> Result<(), String>; fn output(&self, pty_id: &str, max_bytes: usize) -> Result<String, String>; fn stop(&self, pty_id: &str) -> Result<(), String>; }`; `pub struct Shell { id, name, command, cwd, planner_id: Option<String>, status: String, exit_code: Option<i32>, started_at_ms: u64, run: u64, last_output: String }` with `pty_id()`, `snapshot()`, `record()`, `from_record()`; `pub const SHELL_RUNNING/SHELL_EXITED/SHELL_STOPPED: &str`; `pub fn pty_id_for(&str) -> String`; `pub fn default_name(&str) -> String`; `pub fn strip_ansi(&str) -> String`; `pub fn tail_lines(&str, usize) -> String`. Re-exported from `orchestrator_core`.

- [ ] **Step 1: Write the module with its tests and an empty implementation**

Create `src-tauri/src/orchestrator_shells.rs`:

```rust
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

#[derive(Clone, Debug)]
pub struct Shell {
    pub id: String,
    pub name: String,
    pub command: String,
    pub cwd: String,
    pub planner_id: Option<String>,
    pub status: String,
    pub exit_code: Option<i32>,
    pub started_at_ms: u64,
    /// Counts starts; an exit report carries the run it belongs to.
    pub run: u64,
    /// What it printed last, kept when it stops or exits: stopping releases the PTY and its
    /// scrollback with it.
    pub last_output: String,
}

pub fn pty_id_for(_shell_id: &str) -> String {
    String::new()
}

pub fn default_name(_command: &str) -> String {
    String::new()
}

pub fn strip_ansi(_text: &str) -> String {
    String::new()
}

pub fn tail_lines(_text: &str, _lines: usize) -> String {
    String::new()
}

impl Shell {
    pub fn pty_id(&self) -> String {
        pty_id_for(&self.id)
    }

    pub fn snapshot(&self) -> Value {
        json!({})
    }

    pub fn record(&self) -> Value {
        json!({})
    }

    pub fn from_record(_value: &Value) -> Option<Shell> {
        None
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
            planner_id: Some("p1".into()),
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
        assert_eq!(restored.planner_id.as_deref(), Some("p1"));
        assert_eq!(restored.last_output, "ready");
        assert_eq!(restored.run, 0);
    }
}
```

In `src-tauri/src/orchestrator_core.rs`, right after `use serde_json::{json, Map, Value};`, add:

```rust
#[path = "orchestrator_shells.rs"]
mod shells;
pub use shells::{pty_id_for, Shell, ShellHost, SHELL_EXITED, SHELL_RUNNING, SHELL_STOPPED};
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator shells::tests`
Expected: 5 tests run, all FAIL on their assertions (e.g. `left: "" right: "ready in 120ms"`). A compile error about the module path means the `#[path]` line is wrong; it must resolve to `src-tauri/src/orchestrator_shells.rs`.

- [ ] **Step 3: Implement**

Replace the empty functions and the `impl Shell` block with:

```rust
/// The orchestrator's PTY ids carry this prefix, which is how the frontend recognises them.
pub fn pty_id_for(shell_id: &str) -> String {
    format!("orchestrator-{shell_id}")
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
            "plannerId": self.planner_id,
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
            planner_id: text("plannerId"),
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
```

- [ ] **Step 4: Run the tests to verify they pass, and the app still compiles**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator shells::tests`
Expected: 5 passed.
Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: `Finished`, no error (the lib and the standalone binary both reach the module through `orchestrator_core`).

- [ ] **Step 5: Commit (only with the owner's go-ahead)**

```bash
git add src-tauri/src/orchestrator_shells.rs src-tauri/src/orchestrator_core.rs
git commit -m "feat(orchestrator): shell records and clean terminal output"
```

---

### Task 2: Opening shells and reading them

**Files:**
- Modify: `src-tauri/src/orchestrator_core.rs` (constants near `MAX_WAIT_MS`; `Inner`; `Inner::snapshot`; `Core` + `Default`; new `Core` methods; `tools_for`/`shell_tools`; `dispatch_tool`; `"tools/list"` in `handle_mcp_body`)
- Test: `src-tauri/tests/orchestrator.rs`

**Interfaces:**
- Consumes: Task 1's `Shell`, `ShellHost`, `SHELL_RUNNING`, `shells::default_name`, `shells::tail_lines`.
- Produces: `Core::set_shell_host(&self, Arc<dyn ShellHost>)`, `Core::has_shell_host(&self) -> bool`, `Core::open_shell(&self, Option<&str>, &str, Option<&str>, &str) -> Result<Value, String>` returning `{ shellId, name, cwd, status }`, `Core::shell_output(&self, &str, usize) -> Result<Value, String>` returning `{ shellId, status, exitCode, output }`; snapshot key `shells`; tools `alethe_open_shell { command, cwd?, name? }`, `alethe_shell_output { shellId, lines? }`, listed only when a host is set.

- [ ] **Step 1: Write the failing tests**

In `src-tauri/tests/orchestrator.rs`, change the core import to:

```rust
use orchestrator_core::{handle_mcp_body, Core, Launcher, ShellHost};
```

Add after the `check_until_settled` helper:

```rust
#[derive(Default)]
struct FakeShellHost {
    calls: Mutex<Vec<String>>,
    printed: Mutex<String>,
    refuse_open: bool,
}

impl ShellHost for FakeShellHost {
    fn open(&self, pty_id: &str, run: u64, command_line: &str, cwd: &str) -> Result<(), String> {
        self.calls
            .lock()
            .expect("calls")
            .push(format!("open {pty_id} run={run} {command_line} @ {cwd}"));
        if self.refuse_open {
            Err("the folder does not exist".to_string())
        } else {
            Ok(())
        }
    }

    fn output(&self, pty_id: &str, _max_bytes: usize) -> Result<String, String> {
        self.calls.lock().expect("calls").push(format!("output {pty_id}"));
        Ok(self.printed.lock().expect("printed").clone())
    }

    fn stop(&self, pty_id: &str) -> Result<(), String> {
        self.calls.lock().expect("calls").push(format!("stop {pty_id}"));
        Ok(())
    }
}

fn shell_core() -> (Core, Arc<FakeShellHost>) {
    let core = Core::default();
    let host = Arc::new(FakeShellHost::default());
    core.set_shell_host(host.clone());
    (core, host)
}

fn tool_names(listed: &Value) -> Vec<String> {
    listed["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|tool| tool["name"].as_str().map(ToOwned::to_owned))
        .collect()
}

fn open_npm(core: &Core) -> Value {
    call(core, "alethe_open_shell", json!({ "command": "npm run dev", "cwd": "C:\\app" }))
}
```

Add the tests:

```rust
#[test]
fn shells_are_offered_only_where_something_can_run_them() {
    let bare = Core::default();
    let names = tool_names(&rpc(&bare, 1, "tools/list", json!({})));
    assert!(!names.iter().any(|name| name == "alethe_open_shell"), "{names:?}");

    let (core, _) = shell_core();
    let names = tool_names(&rpc(&core, 1, "tools/list", json!({})));
    assert!(names.iter().any(|name| name == "alethe_open_shell"), "{names:?}");
    assert!(names.iter().any(|name| name == "alethe_shell_output"), "{names:?}");
}

#[test]
fn opening_a_shell_starts_it_and_lists_it() {
    let (core, host) = shell_core();
    let opened = open_npm(&core);
    assert_eq!(opened["shellId"], "shell-01", "{opened}");
    assert_eq!(opened["status"], "running", "{opened}");
    assert_eq!(
        host.calls.lock().expect("calls")[0],
        "open orchestrator-shell-01 run=1 npm run dev @ C:\\app"
    );
    let listed = &core.snapshot()["shells"][0];
    assert_eq!(listed["name"], "npm", "{listed}");
    assert_eq!(listed["ptyId"], "orchestrator-shell-01", "{listed}");
}

#[test]
fn a_shell_that_fails_to_open_leaves_nothing_behind() {
    let core = Core::default();
    core.set_shell_host(Arc::new(FakeShellHost {
        refuse_open: true,
        ..FakeShellHost::default()
    }));
    let opened = open_npm(&core);
    assert!(
        opened["error"].as_str().unwrap_or_default().contains("does not exist"),
        "{opened}"
    );
    assert_eq!(core.snapshot()["shells"].as_array().expect("shells").len(), 0);
}

#[test]
fn the_output_is_the_clean_tail() {
    let (core, host) = shell_core();
    open_npm(&core);
    *host.printed.lock().expect("printed") =
        "\u{1b}[32mcompiled\u{1b}[0m\r\nlistening on :3000\r\n".to_string();
    let read = call(&core, "alethe_shell_output", json!({ "shellId": "shell-01", "lines": 1 }));
    assert_eq!(read["output"], "listening on :3000", "{read}");
    assert_eq!(read["status"], "running", "{read}");
}

#[test]
fn an_unknown_shell_is_refused() {
    let (core, _) = shell_core();
    let read = call(&core, "alethe_shell_output", json!({ "shellId": "shell-99" }));
    assert!(
        read["error"].as_str().unwrap_or_default().contains("unknown shell"),
        "{read}"
    );
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator shell`
Expected: compile error `no method named set_shell_host found for struct Core`.

- [ ] **Step 3: Implement**

In `orchestrator_core.rs`, next to `const MAX_WAIT_MS`:

```rust
const DEFAULT_OUTPUT_LINES: usize = 40;
const MAX_OUTPUT_LINES: usize = 200;
/// Enough scrollback to hold `MAX_OUTPUT_LINES` of ordinary output.
const OUTPUT_BYTES: usize = 64 * 1024;
```

In `struct Inner`, after `planners: HashMap<String, Planner>,`:

```rust
    shells: Vec<Shell>,
    shell_counter: u64,
```

In `Inner::snapshot`, add to the returned `json!` object:

```rust
            "shells": self.shells.iter().map(Shell::snapshot).collect::<Vec<_>>(),
```

In `pub struct Core`, after `store: Arc<Mutex<Option<PathBuf>>>,`:

```rust
    /// Runs shells for planners. Set by the desktop app; the standalone binary has none.
    shell_host: Arc<Mutex<Option<Arc<dyn ShellHost>>>>,
```

and in `impl Default for Core`, after `store: Arc::new(Mutex::new(None)),`:

```rust
            shell_host: Arc::new(Mutex::new(None)),
```

Add to `impl Core` (next to `set_launcher`):

```rust
    pub fn set_shell_host(&self, host: Arc<dyn ShellHost>) {
        *guard(&self.shell_host) = Some(host);
    }

    pub fn has_shell_host(&self) -> bool {
        guard(&self.shell_host).is_some()
    }

    fn shell_host(&self) -> Result<Arc<dyn ShellHost>, String> {
        guard(&self.shell_host)
            .clone()
            .ok_or_else(|| "shells are not available in this build".to_string())
    }

    /// Registers the shell before starting it: a command that fails at once reports its exit
    /// while `open` is still returning, and that report needs a shell to land on.
    pub fn open_shell(
        &self,
        planner: Option<&str>,
        command: &str,
        name: Option<&str>,
        cwd: &str,
    ) -> Result<Value, String> {
        let host = self.shell_host()?;
        let command = command.trim();
        if command.is_empty() {
            return Err("command is empty".to_string());
        }
        let shell = {
            let mut inner = guard(&self.inner);
            inner.shell_counter += 1;
            let shell = Shell {
                id: format!("shell-{:02}", inner.shell_counter),
                name: name
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| shells::default_name(command)),
                command: command.to_string(),
                cwd: cwd.to_string(),
                planner_id: planner.map(ToOwned::to_owned),
                status: SHELL_RUNNING.to_string(),
                exit_code: None,
                started_at_ms: now_ms(),
                run: 1,
                last_output: String::new(),
            };
            inner.shells.push(shell.clone());
            self.notify(&inner);
            shell
        };
        if let Err(error) = host.open(&shell.pty_id(), shell.run, &shell.command, &shell.cwd) {
            let mut inner = guard(&self.inner);
            inner.shells.retain(|entry| entry.id != shell.id);
            self.notify(&inner);
            return Err(error);
        }
        self.persist();
        Ok(json!({
            "shellId": shell.id,
            "name": shell.name,
            "cwd": shell.cwd,
            "status": shell.status
        }))
    }

    pub fn shell_output(&self, shell_id: &str, lines: usize) -> Result<Value, String> {
        let host = self.shell_host()?;
        let shell = guard(&self.inner)
            .shells
            .iter()
            .find(|entry| entry.id == shell_id)
            .cloned()
            .ok_or_else(|| format!("unknown shell {shell_id}"))?;
        let lines = lines.clamp(1, MAX_OUTPUT_LINES);
        let output = if shell.status == SHELL_RUNNING {
            shells::tail_lines(&host.output(&shell.pty_id(), OUTPUT_BYTES).unwrap_or_default(), lines)
        } else {
            shells::tail_lines(&shell.last_output, lines)
        };
        Ok(json!({
            "shellId": shell.id,
            "status": shell.status,
            "exitCode": shell.exit_code,
            "output": output
        }))
    }
```

Above `pub fn tools() -> Value {`, add:

```rust
/// The shell tools exist only where something can run them: the desktop app registers a host,
/// the standalone binary does not.
fn tools_for(core: &Core) -> Value {
    let mut list = tools();
    if core.has_shell_host() {
        if let Some(array) = list.as_array_mut() {
            array.extend(shell_tools());
        }
    }
    list
}

fn shell_tools() -> Vec<Value> {
    vec![
        json!({
            "name": "alethe_open_shell",
            "description": "Start a long-running command (a dev server, docker compose up, a watcher, a long build) as a shell Alethe keeps running and shows the person on its board, where they can stop and restart it. Keep the command in the foreground: a detached one returns at once. Returns a shellId for alethe_shell_output.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "The command line, run by the system shell exactly as typed." },
                    "cwd": { "type": "string", "description": "Folder to run it in. Pass the project's folder; without it the shell starts in Alethe's own directory." },
                    "name": { "type": "string", "description": "A short name the person will recognise on the board. Defaults to the command's first word." }
                },
                "required": ["command"]
            }
        }),
        json!({
            "name": "alethe_shell_output",
            "description": "Read what a shell printed last, with terminal escape codes removed, and whether it is still running or has exited, with its exit code.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "shellId": { "type": "string" },
                    "lines": { "type": "number", "description": "How many lines from the end, 40 by default, at most 200." }
                },
                "required": ["shellId"]
            }
        }),
    ]
}
```

In `dispatch_tool`, before `"alethe_guide" =>`:

```rust
        "alethe_open_shell" => {
            let command = required_str(arguments, "command")?;
            let name = arguments.get("name").and_then(Value::as_str);
            let cwd = arguments
                .get("cwd")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .or_else(|| {
                    std::env::current_dir()
                        .ok()
                        .map(|path| path.to_string_lossy().into_owned())
                })
                .unwrap_or_default();
            core.open_shell(planner, &command, name, &cwd)
        }
        "alethe_shell_output" => {
            let shell_id = required_str(arguments, "shellId")?;
            let lines = arguments
                .get("lines")
                .and_then(Value::as_u64)
                .map_or(DEFAULT_OUTPUT_LINES, |value| value as usize);
            core.shell_output(&shell_id, lines)
        }
```

In `handle_mcp_body`, change the `"tools/list"` arm to use `tools_for(core)`:

```rust
        "tools/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools_for(core) } }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator`
Expected: every test passes, including the 5 new ones and the handshake test.

- [ ] **Step 5: Commit (only with the owner's go-ahead)**

```bash
git add src-tauri/src/orchestrator_core.rs src-tauri/tests/orchestrator.rs
git commit -m "feat(orchestrator): planners can open shells and read their output"
```

---

### Task 3: Exit, stop, restart, remove and persistence

**Files:**
- Modify: `src-tauri/src/orchestrator_core.rs` (new `Core` methods; `persist`; `restore`)
- Test: `src-tauri/tests/orchestrator.rs`

**Interfaces:**
- Consumes: Task 2's shell records and host.
- Produces: `Core::shell_exited(&self, shell_id: &str, run: u64, code: Option<i32>)`, `Core::stop_shell(&self, &str) -> Result<Value, String>`, `Core::restart_shell(&self, &str) -> Result<Value, String>` (also the play of an exited or stopped shell), `Core::remove_shell(&self, &str) -> Result<Value, String>`. The three return the shell's snapshot, `remove_shell` returns `{ removed }`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn an_exit_report_marks_the_shell_exited_and_keeps_what_it_printed() {
    let (core, host) = shell_core();
    open_npm(&core);
    *host.printed.lock().expect("printed") = "Error: port 3000 is taken\r\n".to_string();
    core.shell_exited("shell-01", 1, Some(1));

    let shell = &core.snapshot()["shells"][0];
    assert_eq!(shell["status"], "exited", "{shell}");
    assert_eq!(shell["exitCode"], 1, "{shell}");

    *host.printed.lock().expect("printed") = String::new();
    let read = call(&core, "alethe_shell_output", json!({ "shellId": "shell-01" }));
    assert_eq!(read["output"], "Error: port 3000 is taken", "{read}");
}

#[test]
fn an_exit_report_from_an_earlier_run_is_ignored() {
    let (core, _) = shell_core();
    open_npm(&core);
    core.shell_exited("shell-01", 0, Some(1));
    assert_eq!(core.snapshot()["shells"][0]["status"], "running");
}

#[test]
fn stopping_a_shell_ignores_the_exit_its_own_stop_causes() {
    let (core, host) = shell_core();
    open_npm(&core);
    core.stop_shell("shell-01").expect("stopped");
    core.shell_exited("shell-01", 1, Some(-1073741510));

    let shell = &core.snapshot()["shells"][0];
    assert_eq!(shell["status"], "stopped", "{shell}");
    assert!(host
        .calls
        .lock()
        .expect("calls")
        .contains(&"stop orchestrator-shell-01".to_string()));
}

#[test]
fn restarting_runs_the_same_command_again_as_a_new_run() {
    let (core, host) = shell_core();
    open_npm(&core);
    core.shell_exited("shell-01", 1, Some(1));
    core.restart_shell("shell-01").expect("restarted");

    let calls = host.calls.lock().expect("calls").clone();
    assert!(calls.contains(&"stop orchestrator-shell-01".to_string()), "{calls:?}");
    assert_eq!(
        calls.last().map(String::as_str),
        Some("open orchestrator-shell-01 run=2 npm run dev @ C:\\app"),
        "{calls:?}"
    );
    let shell = &core.snapshot()["shells"][0];
    assert_eq!(shell["status"], "running", "{shell}");
    assert_eq!(shell["exitCode"], Value::Null, "{shell}");
}

#[test]
fn a_running_shell_cannot_be_removed() {
    let (core, _) = shell_core();
    open_npm(&core);
    assert!(core.remove_shell("shell-01").is_err());
    core.stop_shell("shell-01").expect("stopped");
    core.remove_shell("shell-01").expect("removed");
    assert_eq!(core.snapshot()["shells"].as_array().expect("shells").len(), 0);
}

#[test]
fn shells_come_back_stopped_after_a_restart_and_keep_counting() {
    let dir = workspace("shell-store");
    let store = dir.join("orchestrator.json");
    let (core, _) = shell_core();
    core.set_store(store.clone());
    open_npm(&core);

    let (reopened, _) = shell_core();
    reopened.set_store(store);
    reopened.restore();
    assert_eq!(reopened.snapshot()["shells"][0]["status"], "stopped");
    let next = call(
        &reopened,
        "alethe_open_shell",
        json!({ "command": "cargo watch", "cwd": "C:\\app" }),
    );
    assert_eq!(next["shellId"], "shell-02", "{next}");

    let _ = std::fs::remove_dir_all(&dir);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator shell`
Expected: compile error `no method named shell_exited found for struct Core`.

- [ ] **Step 3: Implement**

Add to `impl Core`:

```rust
    /// `run` ties the report to one start of the shell: after a restart, the old process's exit
    /// arrives late and must not mark the new one exited.
    pub fn shell_exited(&self, shell_id: &str, run: u64, code: Option<i32>) {
        let is_current = |entry: &Shell| {
            entry.id == shell_id && entry.run == run && entry.status == SHELL_RUNNING
        };
        let Some(pty_id) = guard(&self.inner)
            .shells
            .iter()
            .find(|entry| is_current(entry))
            .map(Shell::pty_id)
        else {
            return;
        };
        let printed = self
            .shell_host()
            .ok()
            .and_then(|host| host.output(&pty_id, OUTPUT_BYTES).ok())
            .unwrap_or_default();
        {
            let mut inner = guard(&self.inner);
            let Some(shell) = inner.shells.iter_mut().find(|entry| is_current(entry)) else {
                return;
            };
            shell.status = SHELL_EXITED.to_string();
            shell.exit_code = code;
            shell.last_output = shells::tail_lines(&printed, MAX_OUTPUT_LINES);
            self.notify(&inner);
        }
        self.persist();
    }

    /// Marks the shell stopped before stopping it, so the exit its own Ctrl+C causes is not
    /// reported as the command failing.
    pub fn stop_shell(&self, shell_id: &str) -> Result<Value, String> {
        let host = self.shell_host()?;
        let pty_id = {
            let inner = guard(&self.inner);
            let shell = inner
                .shells
                .iter()
                .find(|entry| entry.id == shell_id)
                .ok_or_else(|| format!("unknown shell {shell_id}"))?;
            if shell.status != SHELL_RUNNING {
                return Err(format!("{shell_id} is not running"));
            }
            shell.pty_id()
        };
        let printed = host.output(&pty_id, OUTPUT_BYTES).unwrap_or_default();
        {
            let mut inner = guard(&self.inner);
            if let Some(shell) = inner.shells.iter_mut().find(|entry| entry.id == shell_id) {
                shell.status = SHELL_STOPPED.to_string();
                shell.last_output = shells::tail_lines(&printed, MAX_OUTPUT_LINES);
            }
            self.notify(&inner);
        }
        self.persist();
        host.stop(&pty_id)?;
        self.shell_snapshot(shell_id)
    }

    /// Also the play of a shell that exited or was stopped. The old PTY is released first: a
    /// process that ended on its own still holds its session, and a new one cannot start under the
    /// same id until it is gone.
    pub fn restart_shell(&self, shell_id: &str) -> Result<Value, String> {
        let host = self.shell_host()?;
        let shell = {
            let mut inner = guard(&self.inner);
            let shell = inner
                .shells
                .iter_mut()
                .find(|entry| entry.id == shell_id)
                .ok_or_else(|| format!("unknown shell {shell_id}"))?;
            // Stopped first, so the old process's exit is not read as the new run failing.
            shell.status = SHELL_STOPPED.to_string();
            shell.clone()
        };
        host.stop(&shell.pty_id())?;
        let run = {
            let mut inner = guard(&self.inner);
            let entry = inner
                .shells
                .iter_mut()
                .find(|entry| entry.id == shell_id)
                .ok_or_else(|| format!("unknown shell {shell_id}"))?;
            entry.run += 1;
            entry.status = SHELL_RUNNING.to_string();
            entry.exit_code = None;
            entry.started_at_ms = now_ms();
            entry.last_output.clear();
            let run = entry.run;
            self.notify(&inner);
            run
        };
        if let Err(error) = host.open(&shell.pty_id(), run, &shell.command, &shell.cwd) {
            let mut inner = guard(&self.inner);
            if let Some(entry) = inner.shells.iter_mut().find(|entry| entry.id == shell_id) {
                entry.status = SHELL_STOPPED.to_string();
            }
            self.notify(&inner);
            return Err(error);
        }
        self.persist();
        self.shell_snapshot(shell_id)
    }

    pub fn remove_shell(&self, shell_id: &str) -> Result<Value, String> {
        let host = self.shell_host()?;
        let pty_id = {
            let inner = guard(&self.inner);
            let shell = inner
                .shells
                .iter()
                .find(|entry| entry.id == shell_id)
                .ok_or_else(|| format!("unknown shell {shell_id}"))?;
            if shell.status == SHELL_RUNNING {
                return Err(format!("stop {shell_id} before removing it"));
            }
            shell.pty_id()
        };
        // Releases a session and scrollback an exited process may still hold.
        let _ = host.stop(&pty_id);
        {
            let mut inner = guard(&self.inner);
            inner.shells.retain(|entry| entry.id != shell_id);
            self.notify(&inner);
        }
        self.persist();
        Ok(json!({ "removed": shell_id }))
    }

    fn shell_snapshot(&self, shell_id: &str) -> Result<Value, String> {
        guard(&self.inner)
            .shells
            .iter()
            .find(|entry| entry.id == shell_id)
            .map(Shell::snapshot)
            .ok_or_else(|| format!("unknown shell {shell_id}"))
    }
```

In `persist`, add to the `json!` payload after `"planners"`:

```rust
                "shells": inner.shells.iter().map(Shell::record).collect::<Vec<_>>(),
```

In `restore`, after the planners loop and before `self.notify(&inner);`:

```rust
        for record in value.get("shells").and_then(Value::as_array).unwrap_or(&vec![]) {
            let Some(shell) = Shell::from_record(record) else {
                continue;
            };
            inner.shell_counter = inner.shell_counter.max(trailing_number(&shell.id));
            inner.shells.push(shell);
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator`
Expected: every test passes.

- [ ] **Step 5: Commit (only with the owner's go-ahead)**

```bash
git add src-tauri/src/orchestrator_core.rs src-tauri/tests/orchestrator.rs
git commit -m "feat(orchestrator): stop, restart, remove and restore planner shells"
```

---

### Task 4: A shell that runs a command line

**Files:**
- Modify: `src-tauri/src/cli_resolver.rs:31-85` (`command_builder_for_terminal`) and its `#[cfg(test)] mod tests` (line 900)
- Modify: `src-tauri/src/pty.rs:231-246` (`spawn_pty` params), `:305` (builder call), `:763-812` (`restart_pty`)

**Interfaces:**
- Produces: `command_builder_for_terminal(initial_command: Option<&str>, resolved_launcher: Option<&str>, extra_args: &[String], command_line: Option<&str>) -> CommandBuilder`; `spawn_pty(…, env, command_line: Option<String>)`; `restart_pty(…, env, command_line: Option<String>)`. The frontend's `invoke('spawn_pty')` and `invoke('restart_pty')` omit `commandLine`, which Tauri reads as `None`, so every existing terminal is unchanged.

- [ ] **Step 1: Write the failing tests**

In `cli_resolver.rs`'s `mod tests`:

```rust
    fn argv_of(builder: &CommandBuilder) -> Vec<String> {
        builder
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn a_shell_given_a_command_line_runs_it_and_exits_with_it() {
        let argv = argv_of(&command_builder_for_terminal(None, None, &[], Some("npm run dev")));
        assert_eq!(argv.last().map(String::as_str), Some("npm run dev"), "{argv:?}");
        let flag = if cfg!(windows) { "-Command" } else { "-lc" };
        assert_eq!(argv[argv.len() - 2], flag, "{argv:?}");
    }

    #[test]
    fn a_plain_shell_stays_interactive() {
        let argv = argv_of(&command_builder_for_terminal(None, None, &[], None));
        assert!(!argv.iter().any(|arg| arg == "-Command" || arg == "-lc"), "{argv:?}");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib cli_resolver`
Expected: compile error, `command_builder_for_terminal` takes 3 arguments but 4 were supplied.

- [ ] **Step 3: Implement**

Add the parameter to the signature:

```rust
pub fn command_builder_for_terminal(
    initial_command: Option<&str>,
    resolved_launcher: Option<&str>,
    extra_args: &[String],
    command_line: Option<&str>,
) -> CommandBuilder {
```

Replace the `None =>` arm:

```rust
        None => {
            let shell = default_shell();
            let mut builder = CommandBuilder::new(&shell);
            if shell.eq_ignore_ascii_case("pwsh.exe")
                || shell.eq_ignore_ascii_case("powershell.exe")
            {
                builder.arg("-NoLogo");
            }
            // An orchestrator shell: the line runs through the shell and the PTY ends with it, so
            // the board can tell a running service from one that exited.
            if let Some(line) = command_line.map(str::trim).filter(|line| !line.is_empty()) {
                builder.arg(if cfg!(windows) { "-Command" } else { "-lc" });
                builder.arg(line);
            }
            builder
        }
```

In `pty.rs`, add the last parameter of `spawn_pty`, after `env`:

```rust
    env: Option<std::collections::HashMap<String, String>>,
    // Set only by orchestrator shells: the line the shell runs and exits with.
    command_line: Option<String>,
) -> Result<SpawnPtyResponse, String> {
```

pass it at line 305:

```rust
        let mut command = command_builder_for_terminal(
            requested_command.as_deref(),
            resolved_launcher.as_deref(),
            &extras,
            command_line.as_deref(),
        );
```

and in `restart_pty`, add `command_line: Option<String>,` after its `env` parameter and forward it as the last argument of the `spawn_pty(...)` call, after `env`.

- [ ] **Step 4: Run the tests to verify they pass, and the app compiles**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib cli_resolver`
Expected: all `cli_resolver` tests pass.
Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: `Finished`, no error.

- [ ] **Step 5: Commit (only with the owner's go-ahead)**

```bash
git add src-tauri/src/cli_resolver.rs src-tauri/src/pty.rs
git commit -m "feat(pty): a shell can be spawned to run one command line"
```

---

### Task 5: The app's shell host and the board's commands

**Files:**
- Create: `src-tauri/src/orchestrator_shell_host.rs`
- Modify: `src-tauri/src/orchestrator.rs` (`prepare`, new commands)
- Modify: `src-tauri/src/lib.rs` (`mod` next to `mod orchestrator;`, commands after `orchestrator::orchestrator_job_diff,`)

**Interfaces:**
- Consumes: `ShellHost` (Task 1), `Core::{set_shell_host, shell_output, stop_shell, restart_shell, remove_shell, shell_exited}` (Tasks 2-3), `spawn_pty(…, command_line)` (Task 4), `pty::{attach_pty, write_pty, kill_pty, PtySessions}`, `PtyExitPayload { code: Option<i32>, reason: &str }` (`pty.rs:199`).
- Produces: Tauri commands `orchestrator_shell_output(shellId, lines)`, `orchestrator_shell_stop(shellId)`, `orchestrator_shell_restart(shellId)`, `orchestrator_shell_remove(shellId)`, each returning the core's `Value`.

This task has no automated test: the host needs a running Tauri app. The core behaviour it serves is covered by Tasks 2-3; Task 9 exercises the host by hand.

- [ ] **Step 1: Write the host**

Create `src-tauri/src/orchestrator_shell_host.rs`:

```rust
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
        let _ = tauri::async_runtime::block_on(pty::write_pty(
            self.app.state::<PtySessions>(),
            pty_id.to_string(),
            "\u{3}".to_string(),
        ));
        let deadline = Instant::now() + STOP_GRACE;
        while Instant::now() < deadline {
            let gone = self
                .exited
                .lock()
                .map(|exited| exited.contains(pty_id))
                .unwrap_or(false);
            if gone {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // Also releases the session a finished process still holds, so the id can be reused.
        tauri::async_runtime::block_on(pty::kill_pty(
            self.app.clone(),
            self.app.state::<PtySessions>(),
            pty_id.to_string(),
        ))
    }
}
```

- [ ] **Step 2: Register the host and add the commands**

In `orchestrator.rs`'s `prepare`, after the `claude` launcher block:

```rust
    core.set_shell_host(Arc::new(crate::orchestrator_shell_host::PtyShellHost::new(
        app.clone(),
    )));
```

Add to `orchestrator.rs`:

```rust
/// The board's shell controls. Stopping waits up to five seconds for Ctrl+C to land, so the work
/// runs off the thread that received the command.
async fn on_shells<F>(app: AppHandle, work: F) -> Result<Value, String>
where
    F: FnOnce(&Core) -> Result<Value, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<OrchestratorState>();
        prepare(&app, &state);
        work(state.core())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn orchestrator_shell_output(
    app: AppHandle,
    shell_id: String,
    lines: usize,
) -> Result<Value, String> {
    on_shells(app, move |core| core.shell_output(&shell_id, lines)).await
}

#[tauri::command]
pub async fn orchestrator_shell_stop(app: AppHandle, shell_id: String) -> Result<Value, String> {
    on_shells(app, move |core| core.stop_shell(&shell_id)).await
}

#[tauri::command]
pub async fn orchestrator_shell_restart(app: AppHandle, shell_id: String) -> Result<Value, String> {
    on_shells(app, move |core| core.restart_shell(&shell_id)).await
}

#[tauri::command]
pub async fn orchestrator_shell_remove(app: AppHandle, shell_id: String) -> Result<Value, String> {
    on_shells(app, move |core| core.remove_shell(&shell_id)).await
}
```

In `lib.rs`, add `mod orchestrator_shell_host;` next to `mod orchestrator;`, and after `orchestrator::orchestrator_job_diff,` in `invoke_handler`:

```rust
            orchestrator::orchestrator_shell_output,
            orchestrator::orchestrator_shell_stop,
            orchestrator::orchestrator_shell_restart,
            orchestrator::orchestrator_shell_remove,
```

- [ ] **Step 3: Verify it compiles and nothing regressed**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: `Finished`, no error. If `once` is reported missing, the `tauri::Listener` import is absent.
Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator`
Expected: every test passes.

- [ ] **Step 4: Commit (only with the owner's go-ahead)**

```bash
git add src-tauri/src/orchestrator_shell_host.rs src-tauri/src/orchestrator.rs src-tauri/src/lib.rs
git commit -m "feat(orchestrator): run planner shells as app PTYs the board controls"
```

---

### Task 6: Frontend plumbing: types, detach, restart, stale views

**Files:**
- Create: `src/lib/orchestratorShells.ts`, `src/lib/orchestratorShells.test.ts`, `src/lib/terminalLifecycle.test.ts`, `src/lib/tauri/pty.test.ts`
- Modify: `src/lib/tauri/orchestrator.ts`, `src/lib/terminalLifecycle.ts`, `src/lib/tauri/pty.ts:90`, `src/lib/terminalFactory.ts:53-100`, `src/stores/projectsStore.ts:180-199`, `src/components/XTermView/useXtermSession.ts:903-907`, `src/components/OrchestratorPane/index.tsx:87-93`, `src/lib/i18n/messages/en.ts`, `src/lib/i18n/messages/pt-BR.ts`

**Interfaces:**
- Consumes: the Rust snapshot key `shells` and the commands from Task 5.
- Produces: `type OrchestratorShellStatus = 'running' | 'exited' | 'stopped'`; `type OrchestratorShell = { id; name; command; cwd; plannerId: string | null; status; exitCode: number | null; startedAtMs: number; ptyId: string }`; `OrchestratorSnapshot.shells: OrchestratorShell[]`; `orchestratorShellOutput(shellId, lines)`, `orchestratorShellStop(shellId)`, `orchestratorShellRestart(shellId)`, `orchestratorShellRemove(shellId)`; `isOrchestratorShellPty(ptyId): boolean`; `shellIdOfPty(ptyId): string`; `type ShellControl = 'stop' | 'restart' | 'play' | 'openTerminal' | 'remove'`; `shellControls(status): ShellControl[]`; `firstTab.ptyId?: string` on `makeDefaultTerminal` and `createTerminal`.

- [ ] **Step 1: Write the failing tests**

`src/lib/orchestratorShells.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { isOrchestratorShellPty, shellControls, shellIdOfPty } from './orchestratorShells'

describe('orchestrator shells', () => {
  it('recognises the PTY of an orchestrator shell and only that', () => {
    expect(isOrchestratorShellPty('orchestrator-shell-01')).toBe(true)
    expect(isOrchestratorShellPty('V1StGXR8_Z5jdHi6B-myT')).toBe(false)
    expect(shellIdOfPty('orchestrator-shell-01')).toBe('shell-01')
  })

  it('offers stop, restart and open terminal while running, run again and remove otherwise', () => {
    expect(shellControls('running')).toEqual(['stop', 'restart', 'openTerminal'])
    expect(shellControls('exited')).toEqual(['play', 'remove'])
    expect(shellControls('stopped')).toEqual(['play', 'remove'])
  })
})
```

`src/lib/terminalLifecycle.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { killPtys, ghosttyKill } = vi.hoisted(() => ({
  killPtys: vi.fn(() => Promise.resolve([] as string[])),
  ghosttyKill: vi.fn(() => Promise.resolve()),
}))
vi.mock('./tauri', () => ({ killPtys, ghosttyKill }))
vi.mock('./sessionDiscovery', () => ({ releaseSessionClaim: vi.fn() }))
vi.mock('./sessionResume', () => ({ removeSession: vi.fn() }))
vi.mock('../stores/terminalsStore', () => ({
  useTerminalsStore: { getState: () => ({ unregister: vi.fn() }) },
}))

import { cleanupPtys } from './terminalLifecycle'

describe('cleanupPtys', () => {
  beforeEach(() => {
    killPtys.mockClear()
    ghosttyKill.mockClear()
  })

  it('kills the PTYs of ordinary terminals once each', () => {
    cleanupPtys(['a', 'b', 'a', null])
    expect(killPtys).toHaveBeenCalledWith(['a', 'b'])
  })

  it('only detaches from an orchestrator shell, which keeps running', () => {
    cleanupPtys(['orchestrator-shell-01', 'a'])
    expect(killPtys).toHaveBeenCalledWith(['a'])
    expect(ghosttyKill).not.toHaveBeenCalledWith('orchestrator-shell-01')
  })
})
```

`src/lib/tauri/pty.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve({ id: 'x' })),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { restartPty } from './pty'

describe('restartPty', () => {
  beforeEach(() => invoke.mockClear())

  it('restarts a view of an orchestrator shell through the orchestrator', async () => {
    const restarted = await restartPty({
      id: 'orchestrator-shell-01',
      cols: 80,
      rows: 24,
    } as Parameters<typeof restartPty>[0])
    expect(invoke).toHaveBeenCalledWith('orchestrator_shell_restart', { shellId: 'shell-01' })
    expect(restarted).toEqual({ id: 'orchestrator-shell-01' })
  })

  it('restarts any other PTY as before', async () => {
    await restartPty({ id: 'abc', cols: 80, rows: 24 } as Parameters<typeof restartPty>[0])
    expect(invoke).toHaveBeenCalledWith('restart_pty', expect.objectContaining({ id: 'abc' }))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/orchestratorShells.test.ts src/lib/terminalLifecycle.test.ts src/lib/tauri/pty.test.ts`
Expected: `orchestratorShells.test.ts` fails to resolve `./orchestratorShells`; the detach test fails with `killPtys` called with `['orchestrator-shell-01', 'a']`; the orchestrator restart test fails with `restart_pty` invoked instead.

- [ ] **Step 3: Implement**

`src/lib/orchestratorShells.ts`:

```ts
import type { OrchestratorShellStatus } from './tauri/orchestrator'

/** The orchestrator's PTY ids; `pty_id_for` in `orchestrator_shells.rs` builds them. */
const PTY_PREFIX = 'orchestrator-'
const SHELL_PTY_PREFIX = `${PTY_PREFIX}shell-`

export function isOrchestratorShellPty(ptyId: string): boolean {
  return ptyId.startsWith(SHELL_PTY_PREFIX)
}

export function shellIdOfPty(ptyId: string): string {
  return ptyId.slice(PTY_PREFIX.length)
}

export type ShellControl = 'stop' | 'restart' | 'play' | 'openTerminal' | 'remove'

/** A finished shell has no PTY left to attach to, so it is never offered as a terminal. */
export function shellControls(status: OrchestratorShellStatus): ShellControl[] {
  return status === 'running' ? ['stop', 'restart', 'openTerminal'] : ['play', 'remove']
}
```

`src/lib/tauri/orchestrator.ts`: before `export type OrchestratorSnapshot`, add:

```ts
export type OrchestratorShellStatus = 'running' | 'exited' | 'stopped'

/** A long-running command a planner started, owned by Alethe rather than by the planner. */
export type OrchestratorShell = {
  id: string
  name: string
  command: string
  cwd: string
  plannerId: string | null
  status: OrchestratorShellStatus
  exitCode: number | null
  startedAtMs: number
  /** The PTY a terminal view attaches to. */
  ptyId: string
}

export type OrchestratorShellOutput = {
  shellId: string
  status: OrchestratorShellStatus
  exitCode: number | null
  output: string
}
```

add `shells: OrchestratorShell[]` to `OrchestratorSnapshot`, and after `orchestratorMessage`:

```ts
export async function orchestratorShellOutput(
  shellId: string,
  lines: number,
): Promise<OrchestratorShellOutput> {
  return invoke<OrchestratorShellOutput>('orchestrator_shell_output', { shellId, lines })
}

/** Ctrl+C first, the whole process tree after five seconds. */
export async function orchestratorShellStop(shellId: string): Promise<unknown> {
  return invoke<unknown>('orchestrator_shell_stop', { shellId })
}

/** Restarts a running shell, or runs one that exited or was stopped again. */
export async function orchestratorShellRestart(shellId: string): Promise<unknown> {
  return invoke<unknown>('orchestrator_shell_restart', { shellId })
}

export async function orchestratorShellRemove(shellId: string): Promise<unknown> {
  return invoke<unknown>('orchestrator_shell_remove', { shellId })
}
```

`src/lib/terminalLifecycle.ts`, whole file:

```ts
import { isOrchestratorShellPty } from './orchestratorShells'
import { releaseSessionClaim } from './sessionDiscovery'
import { removeSession } from './sessionResume'
import { ghosttyKill, killPtys } from './tauri'
import { useTerminalsStore } from '../stores/terminalsStore'

export function cleanupPtys(ptyIds: Array<string | null | undefined>): void {
  const uniqueIds = Array.from(new Set(ptyIds.filter((id): id is string => Boolean(id))))
  if (uniqueIds.length === 0) return

  const { unregister } = useTerminalsStore.getState()
  const owned: string[] = []
  for (const ptyId of uniqueIds) {
    unregister(ptyId)
    // The orchestrator owns these shells: closing a view of one only detaches it, and the service
    // keeps running until it is stopped from the board.
    if (isOrchestratorShellPty(ptyId)) continue
    removeSession(ptyId)
    releaseSessionClaim(ptyId)
    void ghosttyKill(ptyId).catch(() => {})
    owned.push(ptyId)
  }
  if (owned.length === 0) return
  void killPtys(owned).catch(() => {
    // The PTYs may already have exited or been killed by another action.
  })
}
```

`src/lib/tauri/pty.ts`: add `import { isOrchestratorShellPty, shellIdOfPty } from '../orchestratorShells'` to the imports, and make this the first statement of `restartPty`'s body, leaving the rest unchanged:

```ts
  // A view of an orchestrator shell restarts the service itself, so its command runs again rather
  // than an empty interactive shell taking over its id.
  if (isOrchestratorShellPty(args.id)) {
    await invoke('orchestrator_shell_restart', { shellId: shellIdOfPty(args.id) })
    return { id: args.id }
  }
```

`src/lib/terminalFactory.ts`: add `ptyId?: string` to `makeDefaultTerminal`'s `firstTab` argument type, and in the tab it builds replace `ptyId: null,` with:

```ts
        ptyId: args.firstTab.ptyId ?? null,
```

`src/stores/projectsStore.ts`: add `ptyId?: string` to `createTerminal`'s `firstTab` type (after `useRouter9?: boolean`). The slice spreads `args.firstTab` into `makeDefaultTerminal`, so nothing else changes.

`src/components/XTermView/useXtermSession.ts`: add `import { isOrchestratorShellPty } from '../../lib/orchestratorShells'`, and right after the `if (backendHasPty) { … return }` block (line 907):

```ts
        // Only the board starts an orchestrator shell. A view that outlived it, such as one left
        // open across an app restart, must not spawn an empty shell under its id.
        if (isOrchestratorShellPty(ptyId)) {
          terminal.write(`\r\n${translate(getLocale(), 'orchestrator.shell.viewGone')}\r\n`)
          setBootPhase('ready')
          return
        }
```

(`terminal` is the xterm instance the force-kill message at line 558 writes to; `translate` and `getLocale` are already imported.)

`src/components/OrchestratorPane/index.tsx`: add `shells: [],` to `const EMPTY` (line 87).

`en.ts`, after `'orchestrator.status.blocked': 'waiting on you',`:

```ts
  'orchestrator.shellsLabel': 'Shells',
  'orchestrator.shell.running': 'running',
  'orchestrator.shell.exited': 'exited ({code})',
  'orchestrator.shell.stopped': 'stopped',
  'orchestrator.shell.stop': 'Stop',
  'orchestrator.shell.restart': 'Restart',
  'orchestrator.shell.play': 'Run again',
  'orchestrator.shell.openTerminal': 'Open terminal',
  'orchestrator.shell.remove': 'Remove',
  'orchestrator.shell.failed': 'The shell did not respond',
  'orchestrator.shell.viewGone':
    'This shell is not running. Start it again from the orchestration board.',
```

`pt-BR.ts`, after its `'orchestrator.status.blocked'` entry:

```ts
  'orchestrator.shellsLabel': 'Shells',
  'orchestrator.shell.running': 'rodando',
  'orchestrator.shell.exited': 'encerrado ({code})',
  'orchestrator.shell.stopped': 'parado',
  'orchestrator.shell.stop': 'Parar',
  'orchestrator.shell.restart': 'Reiniciar',
  'orchestrator.shell.play': 'Rodar de novo',
  'orchestrator.shell.openTerminal': 'Abrir terminal',
  'orchestrator.shell.remove': 'Remover',
  'orchestrator.shell.failed': 'O shell não respondeu',
  'orchestrator.shell.viewGone':
    'Este shell não está rodando. Inicie de novo pelo quadro de orquestração.',
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run src/lib/orchestratorShells.test.ts src/lib/terminalLifecycle.test.ts src/lib/tauri/pty.test.ts`
Expected: all pass.
Run: `npm run build`
Expected: success. If `tsc` flags another `OrchestratorSnapshot` literal missing `shells`, add `shells: []` to it.

- [ ] **Step 5: Commit (only with the owner's go-ahead)**

```bash
git add src/lib/orchestratorShells.ts src/lib/orchestratorShells.test.ts src/lib/terminalLifecycle.ts src/lib/terminalLifecycle.test.ts src/lib/tauri/pty.ts src/lib/tauri/pty.test.ts src/lib/tauri/orchestrator.ts src/lib/terminalFactory.ts src/stores/projectsStore.ts src/components/XTermView/useXtermSession.ts src/components/OrchestratorPane/index.tsx src/lib/i18n/messages/en.ts src/lib/i18n/messages/pt-BR.ts
git commit -m "feat(orchestrator): frontend plumbing for planner shells"
```

---

### Task 7: Shells on the board

**Files:**
- Create: `src/components/OrchestratorPane/ShellCard.tsx`, `src/components/OrchestratorPane/ShellCard.module.css`, `src/components/OrchestratorPane/ShellCard.test.tsx`
- Modify: `src/components/OrchestratorPane/index.tsx` (imports at 17-85; state near line 913; memo after `plannerId` at line 1001; handlers before `send`; rail section before `{needsAttention.length > 0 && (` at line 1679)

**Interfaces:**
- Consumes: Task 6's types, wrappers, `shellControls`, `createTerminal(projectId, { …, firstTab: { …, ptyId } })`.
- Produces: `ShellCard({ shell, busy, onControl, t })`.

- [ ] **Step 1: Write the failing test**

`src/components/OrchestratorPane/ShellCard.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { orchestratorShellOutput } = vi.hoisted(() => ({
  orchestratorShellOutput: vi.fn(() =>
    Promise.resolve({ shellId: 'shell-01', status: 'running', exitCode: null, output: 'listening on :3000' }),
  ),
}))
vi.mock('../../lib/tauri/orchestrator', () => ({ orchestratorShellOutput }))

import type { TFunction } from '../../lib/i18n'
import type { OrchestratorShell } from '../../lib/tauri/orchestrator'
import { ShellCard } from './ShellCard'

afterEach(cleanup)

const t = ((key: string, vars?: Record<string, string | number>) =>
  vars ? `${key} ${Object.values(vars).join(' ')}` : key) as unknown as TFunction

function shell(status: OrchestratorShell['status'], exitCode: number | null = null): OrchestratorShell {
  return {
    id: 'shell-01',
    name: 'npm',
    command: 'npm run dev',
    cwd: 'C:\\app',
    plannerId: 'p1',
    status,
    exitCode,
    startedAtMs: 0,
    ptyId: 'orchestrator-shell-01',
  }
}

describe('ShellCard', () => {
  it('shows what a running shell printed, with stop, restart and open terminal', async () => {
    render(<ShellCard shell={shell('running')} busy={false} onControl={vi.fn()} t={t} />)
    await waitFor(() => expect(screen.getByText('listening on :3000')).toBeTruthy())
    for (const label of [
      'orchestrator.shell.stop',
      'orchestrator.shell.restart',
      'orchestrator.shell.openTerminal',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: 'orchestrator.shell.remove' })).toBeNull()
  })

  it('offers run again and remove once it has exited, with its code', () => {
    render(<ShellCard shell={shell('exited', 1)} busy={false} onControl={vi.fn()} t={t} />)
    expect(screen.getByText('orchestrator.shell.exited 1')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'orchestrator.shell.play' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'orchestrator.shell.remove' })).toBeTruthy()
  })

  it('passes the control that was clicked', () => {
    const onControl = vi.fn()
    render(<ShellCard shell={shell('running')} busy={false} onControl={onControl} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'orchestrator.shell.stop' }))
    expect(onControl).toHaveBeenCalledWith(expect.objectContaining({ id: 'shell-01' }), 'stop')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/OrchestratorPane/ShellCard.test.tsx`
Expected: FAIL, cannot resolve `./ShellCard`.

- [ ] **Step 3: Implement the card**

`src/components/OrchestratorPane/ShellCard.tsx`:

```tsx
import {
  type LucideIcon,
  Play,
  RotateCcw,
  Square,
  Terminal as TerminalIcon,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import type { MessageKey, TFunction } from '../../lib/i18n'
import { type ShellControl, shellControls } from '../../lib/orchestratorShells'
import { type OrchestratorShell, orchestratorShellOutput } from '../../lib/tauri/orchestrator'
import styles from './ShellCard.module.css'

const TAIL_LINES = 12
const TAIL_POLL_MS = 2000

const CONTROL_ICON: Record<ShellControl, LucideIcon> = {
  stop: Square,
  restart: RotateCcw,
  play: Play,
  openTerminal: TerminalIcon,
  remove: Trash2,
}

const CONTROL_LABEL: Record<ShellControl, MessageKey> = {
  stop: 'orchestrator.shell.stop',
  restart: 'orchestrator.shell.restart',
  play: 'orchestrator.shell.play',
  openTerminal: 'orchestrator.shell.openTerminal',
  remove: 'orchestrator.shell.remove',
}

type ShellCardProps = {
  shell: OrchestratorShell
  /** A control is on its way; opening the terminal stays available meanwhile. */
  busy: boolean
  onControl: (shell: OrchestratorShell, control: ShellControl) => void
  t: TFunction
}

export function ShellCard({ shell, busy, onControl, t }: ShellCardProps) {
  const [output, setOutput] = useState('')

  // A running shell is read every few seconds while its card is on screen; a finished one once.
  useEffect(() => {
    let cancelled = false
    const load = () => {
      void orchestratorShellOutput(shell.id, TAIL_LINES)
        .then((read) => {
          if (!cancelled) setOutput(read.output)
        })
        .catch(() => {})
    }
    load()
    const timer = shell.status === 'running' ? window.setInterval(load, TAIL_POLL_MS) : null
    return () => {
      cancelled = true
      if (timer !== null) window.clearInterval(timer)
    }
  }, [shell.id, shell.status])

  const status =
    shell.status === 'running'
      ? t('orchestrator.shell.running')
      : shell.status === 'exited'
        ? t('orchestrator.shell.exited', { code: shell.exitCode ?? '—' })
        : t('orchestrator.shell.stopped')

  return (
    <article className={styles.card} data-status={shell.status}>
      <header className={styles.head}>
        <span className={styles.dot} aria-hidden />
        <span className={styles.name}>{shell.name}</span>
        <span className={styles.status}>{status}</span>
      </header>
      <code className={styles.command} title={shell.cwd}>
        {shell.command}
      </code>
      {output ? <pre className={styles.output}>{output}</pre> : null}
      <div className={styles.controls}>
        {shellControls(shell.status).map((control) => {
          const Icon = CONTROL_ICON[control]
          const label = t(CONTROL_LABEL[control])
          return (
            <button
              key={control}
              type="button"
              className={styles.control}
              data-control={control}
              disabled={busy && control !== 'openTerminal'}
              title={label}
              aria-label={label}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onControl(shell, control)}
            >
              <Icon size={12} />
            </button>
          )
        })}
      </div>
    </article>
  )
}
```

`src/components/OrchestratorPane/ShellCard.module.css`:

```css
.card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elevated);
}

.card + .card {
  margin-top: 6px;
}

.head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--status-stopped);
}

.card[data-status='running'] .dot {
  background: var(--status-working);
}

.card[data-status='exited'] .dot {
  background: var(--status-offline);
}

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--fg);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status {
  color: var(--fg-muted);
  font-size: 11px;
}

.command {
  overflow: hidden;
  color: var(--fg-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.output {
  max-height: 132px;
  margin: 0;
  padding: 6px 8px;
  overflow: auto;
  border-radius: 6px;
  background: var(--bg-sunken);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}

.controls {
  display: flex;
  gap: 4px;
}

.control {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  transition:
    background var(--anim-fast),
    color var(--anim-fast);
}

.control:hover:not(:disabled) {
  background: var(--panel-hover);
  color: var(--fg);
}

.control[data-control='stop']:hover:not(:disabled),
.control[data-control='remove']:hover:not(:disabled) {
  color: var(--status-offline);
}

.control:disabled {
  cursor: default;
  opacity: 0.5;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/OrchestratorPane/ShellCard.test.tsx`
Expected: 3 passed.

- [ ] **Step 5: Put the shells in the rail**

In `src/components/OrchestratorPane/index.tsx`:

Add to the `'../../lib/tauri'` import list: `type OrchestratorShell`, `orchestratorShellRemove`, `orchestratorShellRestart`, `orchestratorShellStop`. Add `import type { ShellControl } from '../../lib/orchestratorShells'` and `import { ShellCard } from './ShellCard'`.

With the other store selectors (near `openTerminalWorkspace`):

```tsx
  const createTerminal = useProjectsStore((state) => state.createTerminal)
```

With the other `useState` hooks (near `diffLoading`):

```tsx
  const [shellBusy, setShellBusy] = useState<ReadonlySet<string>>(() => new Set())
```

After `const plannerId = activeGroup?.id ?? null`:

```tsx
  const shells = useMemo(
    () => (plannerId ? snapshot.shells.filter((shell) => shell.plannerId === plannerId) : []),
    [snapshot.shells, plannerId],
  )
```

Before `const send = async () => {`:

```tsx
  // A view onto the running shell, never a new one: the tab's PTY id is the shell's, so the
  // terminal attaches to it, and closing it only detaches.
  const openShellTerminal = (shell: OrchestratorShell) => {
    const existing = project?.terminals.find((term) =>
      term.tabs.some((tab) => tab.ptyId === shell.ptyId),
    )
    const terminalId =
      existing?.id ??
      createTerminal(projectId, {
        name: shell.name,
        cwd: shell.cwd,
        firstTab: { type: 'shell', cwd: shell.cwd, ptyId: shell.ptyId },
      }).id
    openTerminalWorkspace(projectId, terminalId)
    setActiveTerminal(projectId, terminalId)
    requestPaneFocus(terminalId)
    setActiveView('workspace')
  }

  const controlShell = async (shell: OrchestratorShell, control: ShellControl) => {
    if (control === 'openTerminal') {
      openShellTerminal(shell)
      return
    }
    if (shellBusy.has(shell.id)) return
    setShellBusy((prev) => new Set(prev).add(shell.id))
    try {
      if (control === 'stop') await orchestratorShellStop(shell.id)
      else if (control === 'remove') await orchestratorShellRemove(shell.id)
      else await orchestratorShellRestart(shell.id)
    } catch (error) {
      pushToast({
        title: t('orchestrator.shell.failed'),
        body: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setShellBusy((prev) => {
        const next = new Set(prev)
        next.delete(shell.id)
        return next
      })
    }
  }
```

Immediately before `{needsAttention.length > 0 && (`:

```tsx
                {shells.length > 0 && (
                  <div className={styles.railSection}>
                    <div className={styles.railLabel}>
                      <span>{t('orchestrator.shellsLabel')}</span>
                      <span className={styles.laneCount}>{shells.length}</span>
                    </div>
                    {shells.map((shell) => (
                      <ShellCard
                        key={shell.id}
                        shell={shell}
                        busy={shellBusy.has(shell.id)}
                        onControl={(target, control) => void controlShell(target, control)}
                        t={t}
                      />
                    ))}
                  </div>
                )}

```

- [ ] **Step 6: Typecheck and run the frontend tests**

Run: `npm run build`
Expected: success.
Run: `npx vitest run src/components/OrchestratorPane src/lib/orchestratorShells.test.ts src/lib/terminalLifecycle.test.ts src/lib/tauri/pty.test.ts`
Expected: all pass.

- [ ] **Step 7: Commit (only with the owner's go-ahead)**

```bash
git add src/components/OrchestratorPane
git commit -m "feat(orchestrator): planner shells on the board with stop, restart and open"
```

---

### Task 8: Teach the planner, the guide and the changelog

**Files:**
- Modify: `src-tauri/src/orchestrator_core.rs` (`PLANNER_INTRO`, `planner_instructions`)
- Modify: `src-tauri/assets/planner-guide.md` (Orchestration section)
- Modify: `docs/CHANGELOG.md` (`[Unreleased]` → `### Added`)
- Test: `src-tauri/tests/orchestrator.rs`

**Interfaces:**
- Consumes: `Core::has_shell_host` (Task 2).

- [ ] **Step 1: Write the failing test**

```rust
fn instructions_of(core: &Core) -> String {
    rpc(core, 1, "initialize", json!({}))["result"]["instructions"]
        .as_str()
        .expect("server instructions")
        .to_string()
}

#[test]
fn the_instructions_teach_shells_only_where_they_exist() {
    let bare = instructions_of(&Core::default());
    assert!(!bare.contains("alethe_open_shell"), "{bare}");

    let (core, _) = shell_core();
    let text = instructions_of(&core);
    assert!(text.contains("alethe_open_shell"), "{text}");
    assert!(text.contains("in two ways"), "{text}");
    assert!(text.contains("up -d"), "{text}");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator the_instructions_teach_shells_only_where_they_exist`
Expected: FAIL, the instructions do not mention `alethe_open_shell`.

- [ ] **Step 3: Implement**

Replace `const PLANNER_INTRO` with:

```rust
const PLANNER_OPENING: &str =
    "You are running inside Alethe, a desktop workspace that runs coding agents and shells side by side.";

const PLANNER_WORKERS: &str = "
Workers - other agents
- Work that splits into two or more independent units, each needing its own reading and
  judgement: send every unit in one alethe_delegate call instead of using your own subagents.
  Workers are separate processes on their own token budget, and they outlive your turn.
- Do not delegate what one command does, or what is quicker to do than to describe.
";

const PLANNER_SHELLS: &str = "
Shells - plain terminals
- For anything that should keep running where the person can see it (a dev server, a watcher,
  logs, a long build), open it with alethe_open_shell instead of running it hidden in your own
  shell. The person sees it on Alethe's board, can stop and restart it there, and it outlives
  you. Read what it printed with alethe_shell_output.
- Keep the command in the foreground (docker compose up, not up -d): a detached command returns
  at once, and the person can no longer stop it from the board.
- Pass the project's folder as cwd; without it the shell starts in Alethe's own directory.
";
```

and the last line of `planner_instructions` with:

```rust
    let shells = core.has_shell_host();
    let reach = if shells {
        "Alethe can run work for you in two ways."
    } else {
        "Alethe can run other agents as workers for you."
    };
    let shells_section = if shells { PLANNER_SHELLS } else { "" };
    format!(
        "{PLANNER_OPENING}\nThis session is a planner: besides your own tools, {reach}\n\
         {PLANNER_WORKERS}{available}{shells_section}{PLANNER_WORKING}"
    )
```

In `planner-guide.md`, add to the end of the **Orchestration** bullet list:

```markdown
- A planner can start long-running commands (a dev server, `docker compose up`) as **shells**.
  They are listed under **Shells** in the board's side rail, each with its last output and buttons
  to stop, restart, run again, open it as a terminal, or remove it. Closing that terminal only
  detaches from it; the command keeps running until it is stopped on the board.
```

In `docs/CHANGELOG.md`, at the top of `[Unreleased]` → `### Added`:

```markdown
- **Shells the lead agent starts now live on the orchestration board.** Ask it to run your dev
  server or `docker compose up` and it opens a shell Alethe owns: it keeps running when the project
  is off screen or the agent is done, the board lists it under **Shells** with its last lines, and
  you can stop it, restart it, run it again or open it as a terminal from there. Stopping sends
  Ctrl+C first, so `docker compose up` brings its containers down cleanly, and closing the terminal
  view never stops the service. The agent reads what the shell printed to react to it.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test orchestrator`
Expected: every test passes, including the earlier instruction tests.

- [ ] **Step 5: Commit (only with the owner's go-ahead)**

```bash
git add src-tauri/src/orchestrator_core.rs src-tauri/tests/orchestrator.rs src-tauri/assets/planner-guide.md docs/CHANGELOG.md
git commit -m "feat(orchestrator): teach planners to run long commands as board shells"
```

---

### Task 9: Manual verification in the DEV build

Run only when the owner is ready to reopen the app.

- [ ] **Step 1:** Owner opens `npm run app -- --no-watch` (never kill a running instance).
- [ ] **Step 2:** Create an orchestration for a project other than `alethe-agents` with a dev server (`npm run dev`). Ask the planner to start it and say when it is ready. Expected: it calls `alethe_open_shell` with that project's folder as `cwd`, then `alethe_shell_output`, and reports the address.
- [ ] **Step 3:** On the board, the **Shells** section shows the card running with its last lines refreshing.
- [ ] **Step 4:** **Open terminal** shows the live output in the grid. Close that pane: the card stays running and the server still answers.
- [ ] **Step 5:** **Stop**: the card shows stopped within 5 s, and the server no longer answers. Check in Task Manager that no `node` process from it is left. This is the spec's `Ctrl+C` through ConPTY risk; note whether it exited on Ctrl+C or only at the 5 s kill.
- [ ] **Step 6:** **Run again**: running again, same command. **Restart** while running: comes back running.
- [ ] **Step 7:** Start a command that fails at once (`npm run nope`). The card shows `exited` with a non-zero code, and `alethe_shell_output` returns the npm error.
- [ ] **Step 8 (if Docker is installed):** `docker compose up` in a folder with a compose file, then **Stop**. The containers are down (`docker ps`).
- [ ] **Step 9:** Close and reopen the app. The shell comes back stopped, with its last output; a terminal view left open says the shell is not running instead of opening a new shell.
