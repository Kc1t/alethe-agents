# Orchestrator shells — Design

Date: 2026-09-15
Status: approved in conversation, pending spec review

## 1. Problem

A planner often needs something long-running next to its work: a dev server, `docker compose up`,
a watcher, a long build. Today it can only start one inside its own shell (Claude Code's
background Bash), where the person cannot see it, cannot stop or restart it, and it dies with the
planner. The orchestration board already shows those background shells as read-only entries, but
offers no control over them.

## 2. Goals

- The planner can start a long-running command as a **shell that Alethe owns**, and read its
  recent output to react to it ("listening on :3000", a build error).
- The person sees every such shell on the **orchestration board** and can **stop**, **restart**
  and **open** it from there, quickly.
- A shell keeps running when its project is off screen, and when the planner that started it ends.

## 3. Non-goals

- The planner does not type into a shell, stop it or restart it. It opens and reads. Writing to a
  shell would duplicate the command channel the planner already has in its own shell.
- Shells do not survive an app restart as running processes. They come back stopped, one click
  from running again.
- No project-level or per-user shell presets. The planner supplies the command each time.

## 4. Architecture

The design follows the existing launcher pattern: the orchestrator core stays Tauri-free, and the
app injects what it needs.

**`ShellHost`** is a trait the core calls and the app implements:

- `open(id, command_line, cwd) -> Result<(), String>`
- `output(id, max_bytes) -> Result<String, String>`
- `stop(id) -> Result<(), String>`
- `restart(id, command_line, cwd) -> Result<(), String>`

The app registers it with `Core::set_shell_host`, the same way `prepare` in
`src-tauri/src/orchestrator.rs:33-60` registers launchers today.

**The core owns the shell records.** Each shell has an `id` (`shell-01`, counted the way job ids
are), `name`, `command`, `cwd`, `planner_id`, `status` (`running` | `exited` | `stopped`),
`exit_code`, `started_at_ms`. The record is persisted with the rest of the orchestrator store, and
on restore every shell comes back as `stopped`.

`exited` means the command ended on its own, with the code it returned. `stopped` means the person
stopped it from the board, or it was running when the app closed. Both can be played again.

**The board reads shells from the snapshot it already receives.** `Inner::snapshot` gains a
`shells` array beside `jobs`, emitted on `orchestrator://jobs`. `OrchestratorSnapshot`
(`src/lib/tauri/orchestrator.ts:104`) gains the matching type.

**The app implements `ShellHost` on top of `pty.rs`,** which already has every primitive:
`spawn_pty` (`pty.rs:231`), `attach_pty` (`pty.rs:815`, returns the tail of the scrollback from
memory or disk), `restart_pty` (`pty.rs:763`), `write_pty` (`pty.rs:901`), `kill_pty`
(`pty.rs:1041`). The PTY is spawned by the backend with no view attached (120x30), so the
command runs even when its project is not on screen. Its PTY id is the shell id with an
`orchestrator-` prefix (`orchestrator-shell-01`); the prefix is how the frontend recognises a view
of an orchestrator shell without asking the backend.

## 5. Running a command line

The planner sends a shell line (`docker compose up && npm run dev`), not a program and its
arguments. Today the plain-shell branch of `command_builder_for_terminal`
(`cli_resolver.rs:75-84`) ignores `extra_args` and always opens an interactive shell.

`spawn_pty` and `restart_pty` gain an optional `command_line`. When it is set on a shell spawn,
the builder runs the line through the shell and exits with it:

- Windows: `pwsh -NoLogo -Command <line>` (or `powershell.exe` when `pwsh` is absent, matching
  `default_shell()`).
- POSIX: `$SHELL -lc <line>`.

The PTY therefore lives exactly as long as the command. When `npm run dev` crashes, the shell
reports `exited` with the exit code; restarting runs the same line again. Existing terminals never
pass `command_line`, so their behaviour is unchanged.

A detached command (`docker compose up -d`) returns at once, and the card correctly shows
`exited (0)` while the containers keep running under the Docker daemon. The planner instructions
say to use the foreground form when the person should be able to stop it from the board.

## 6. Planner tools

**`alethe_open_shell { command, name?, cwd? }`** registers a shell, opens it through the host and
returns `{ shellId, name, cwd, status }`. The core does not know the planner's folder, so, like
`alethe_delegate`, a missing `cwd` falls back to Alethe's own working directory; the tool
description and the instructions tell the planner to pass the project's folder. `name` defaults
to the first word of the command. Registered only when a shell host is set.

**`alethe_shell_output { shellId, lines? }`** returns `{ shellId, status, exitCode, output }`,
where `output` is the last `lines` lines (default 40, at most 200) with ANSI escape sequences
removed. An unknown `shellId` is an error.

The core strips ANSI with a small in-house function: no ANSI crate is a dependency today
(`src-tauri/Cargo.toml`), and escape removal for a tail read does not justify one.

## 7. Stopping, restarting, exit

**Stop is graceful.** The host writes `Ctrl+C` (`\x03`) to the PTY, waits up to 5 seconds for the
process to exit, then kills the whole process tree (`kill_pty`). Killing `docker compose up`
outright would leave its containers running; `Ctrl+C` lets it bring them down.

**Restart** stops as above, then spawns again with the stored command line and cwd.

**Exit detection.** The host listens on the Rust side for the PTY exit event (`pty://exit/{id}`),
whose payload is `PtyExitPayload { code, reason }` (`pty.rs:199`), and reports it to the core
with the run it belongs to. The core sets `exited` and the code, ignores a report for a shell the
person stopped or for an earlier run, and emits a snapshot.

**Last output.** Stopping releases the PTY and its scrollback. So when a shell leaves `running`,
by exiting or by being stopped, the core keeps its last lines, and `alethe_shell_output` and the
card read those from then on.

**The person's controls** are Tauri commands the board calls: `orchestrator_shell_stop`,
`orchestrator_shell_restart` (also the "play" of a stopped or exited shell) and
`orchestrator_shell_remove` (only for a shell that is not running).

## 8. The board

Shells appear in a **Shells** section of the board's side rail, for the selected planner, below its
runs. They are not canvas nodes: the canvas layout (`layoutPlannerBoard`) and `WorkerNode` are
built around delegated jobs (steering, diffs, approvals), none of which a shell has. A shell card
shows:

- name, command and cwd;
- status: running, exited with its code, or stopped;
- the last lines of output, refreshed while the card is on screen;
- **stop** while running; **restart** while running; **play** when exited or stopped;
  **open terminal** while running; **remove** when not running.

Open terminal is offered only while the shell runs: once it has exited there is no PTY left to
attach to, and the terminal view would spawn a fresh interactive shell under the same id, which
the card would then misreport. The last output of a finished shell stays readable on its card.

**Open terminal** adds a tab to the project grid whose `ptyId` is the shell id. The existing
attach path in `useXtermSession.ts:903-905` (`ptyExists` then `attachExistingPty`) connects it to
the running process. Closing it **only detaches**: `cleanupPtys` (`src/lib/terminalLifecycle.ts`),
the one place closing a terminal kills its PTY, skips ids with the `orchestrator-shell-` prefix.
The service keeps running until it is stopped from the board. Restarting from that tab goes
through the orchestrator (`restartPty` in `src/lib/tauri/pty.ts` routes the prefix to
`orchestrator_shell_restart`), so the command runs again instead of an empty shell taking over its
id. A view that outlives its shell, such as one left open across an app restart, never spawns a
PTY of its own under that id: it says the shell is not running and points to the board.

A shell belongs to its planner's project, so the board's existing per-project filtering applies
to shells unchanged.

## 9. Errors

- Opening fails (bad cwd, shell missing): the tool returns the error; no card is left behind.
- The command fails at once: the card shows `exited` with its code, and `alethe_shell_output`
  returns the error text.
- Unknown `shellId` on any tool or command: a clear error, never a panic.
- No shell host registered (the standalone `alethe-orchestrator-mcp` binary): the shell tools are
  not advertised.

## 10. Planner instructions

When this ships, the "Shells — plain terminals" section enters the instructions built by
`planner_instructions` in `orchestrator_core.rs`, with the foreground note from §5, and the
opening line returns to "Alethe can run work for you in two ways".

## 11. Testing

- **Rust, `tests/orchestrator.rs`**, with a fake `ShellHost` that records calls and serves canned
  output, in the style of `silent_launcher`:
  - opening registers a shell and returns its id; the snapshot lists it;
  - output is the tail, trimmed to `lines`, with ANSI removed;
  - an exit report moves the shell to `exited` with its code;
  - an unknown id is refused by both tools;
  - without a host the tools are not advertised;
  - restored shells come back `stopped`.
- **Rust unit test** for the ANSI stripper (colors, cursor moves, OSC titles, plain text intact).
- **Rust unit test** for the `command_line` shell builder (Windows and POSIX forms, quoting).
- **Vitest** for the card: which controls show for each status.
- **Manual, DEV build** (`npm run app -- --no-watch`): a planner opens `npm run dev` in another
  project; the card shows it running; stop, restart and open terminal work; closing the opened tab
  leaves the server running.

## 12. Risks

- **`Ctrl+C` through ConPTY.** Writing `\x03` should raise a console control event for the
  foreground process on Windows; this is verified on a real `npm run dev` and `docker compose up`
  before relying on it. The 5-second kill is the fallback either way.
- **Memory parking.** Alethe parks terminals it tracks in the project store when memory runs low.
  Backend-owned shells are not in that store, so parking does not reach them. They still count in
  the memory stats (`list_pty_processes`). Accepted for this version.
- **Shells outliving attention.** A shell keeps running after its planner ends. The card is the
  only place to stop it, so a planner that opens many shells leaves many cards; `remove` keeps the
  board clean once they are stopped.
