# Orchestration board: shells on the canvas, details in an overlay — Design

Date: 2026-09-16
Status: approved in conversation, pending spec review

Follows [2026-09-15 orchestrator shells](2026-09-15-orchestrator-shells-design.md), whose backend
this design keeps and whose rail UI it replaces.

## 1. Problem

Two things on the orchestration board fight the person:

- **Shells live in the side rail, away from what opened them.** A shell the planner started is
  listed in a "Shells" section of the rail, while the planner, its runs and its workers are drawn
  on the canvas. Nothing connects the shell to the agent that opened it, and the rail competes for
  space with the run list.
- **Clicking a worker grows the card into a strip inside the canvas.** Plan, full markdown report,
  media, actions and the diff all render inside the node, which becomes a tall column the person
  has to read at canvas scale while the layout shifts around it.

## 2. Goals

- Shells appear **on the canvas**, connected by an edge to the agent that opened them, with their
  controls reachable from the node.
- Clicking any worker, native subagent or shell opens a **panel over the board** that is
  comfortable to read: a full report, a full diff, or a shell's live terminal.
- Worker actions stop being buttons that do things behind the person's back and become **shortcuts
  that write an instruction to the planner**, which the person edits before sending.
- Those shortcuts are **customizable per user**, with Alethe's own shipped ready to use.

## 3. Non-goals

- Workers do not get the orchestrator MCP server in this design, so they cannot open shells,
  delegate or orchestrate. The shell's owner is modelled generically so that a later design can add
  worker-owned shells without touching the board again.
- No new merge machinery. "Apply the worktree" becomes an instruction to the planner, which uses
  git as it already can.
- The planner still does not type into a shell. It opens and reads (see the shells design, §3).

## 4. The canvas

### 4.1 Node kinds

`src/lib/orchestratorGraph.ts` gains two `GraphNodeKind` values: `shellGroup` and `shell`.

A `shellGroup` node is laid out exactly like a run root, and its shells exactly like that run's
workers: same widths (`NODE_WIDTH`), same gaps (`SIBLING_GAP`, `LEVEL_GAP`, `TREE_GAP`), same
`workerTop` baseline, so shells line up with the workers beside them.

`layoutPlannerBoard(runs, heights, plannerId, mediaByJobId, shells)` gains the shells argument and
returns them in `BoardGraph` as `shellGroups` and `shells`, beside `roots` and `workers`. The
existing `trees` extent list gains one entry per shell group, so the rail's "bring into view" and
the canvas bounds keep working unchanged.

### 4.2 Where a shell hangs

Each shell carries its **owner**: a kind (`planner` or `worker`) and an id.

- **Owner on the board.** The group node hangs from the owner's node by an edge, and is always the
  last tree in the row, right of the runs. With the owner being a planner today, that means one
  "Shells" group under the planner node.
- **Owner gone.** A shell whose owner is not on the board — the planner's terminal was closed, or
  the shell belongs to a planner of another project window — is grouped into a detached "Shells"
  group with no incoming edge, placed after the planner's trees. This is what keeps a
  `docker compose up` reachable after its planner is gone, which the rail did before.

`shellsForBoard` (`src/lib/orchestratorShells.ts`) keeps deciding which shells this project shows;
it gains the owner shape and returns each shell tagged `attached` or `detached`, so the layout does
not repeat the decision.

### 4.3 The shell node

A card the size of a worker card: status dot, name, the command in the code font, and the last line
of output. Status colors are the existing `--status-*` tokens already used by `ShellCard`, through
`data-status`.

`ShellCard` is reshaped into this compact canvas node; the rail section it served is removed.

### 4.4 Hover

Hovering a node raises a small action bar over it:

- **shell:** stop, restart, play, open terminal, remove — exactly `shellControls(status)` today.
- **worker:** stop while the job is still live (`queued`, `running`, `blocked`), plus the message
  shortcuts that apply to that worker (§6).

Native subagents have no hover actions: Alethe cannot stop them and they have no worktree.

### 4.5 Click

Clicking a node opens the panel (§5). While its panel is open the node keeps a highlight ring, so
the person sees where the content came from.

### 4.6 What leaves the worker node

The `selected` detail block inside `WorkerNode` is deleted: plan, report, media strip, actions and
diff all move to the panel. Two things stay on the card, with no hover needed, because they cannot
wait:

- the approval request of a blocked worker (`ApprovalAsk`),
- the error bar of a failed worker.

Promoted media keeps its own node and its existing image preview.

## 5. The panel

A single component, `OrchestratorInspector`, rendered by the orchestration pane over the board.
Its shape follows `LinkViewerOverlay`: dimmed backdrop, rounded panel, closed by Escape (through
`useOnEscape`) or by a click on the backdrop. It reads live from the orchestrator snapshot, so a
worker that finishes or a shell that exits updates while the panel is open.

The pane holds `inspecting: { kind: 'worker' | 'shell', id: string } | null`.

### 5.1 Worker and native subagent

**Head:** agent glyph, job id, status, elapsed, tokens, context share and, when isolated, the
branch. On the right: stop (§7.2), the message shortcuts (§6), and close.

**Body, two tabs:**

- **Report** (default): the plan as a compact strip on top, the markdown report at a comfortable
  reading width, the media strip at the end. Clicking an image opens the existing image `Modal`
  over the panel.
- **Diff**: present only when the job has a diff. The full unified diff, scrolling on its own.

A native subagent gets the same panel with no stop and no Diff tab.

### 5.2 Shell

**Head:** name, command, cwd, status and exit code once it has exited; stop, restart, play, remove,
and close.

**Body:** the live terminal — `XTermView` bound to the shell's `ptyId`, which is the same attach
path "Open terminal" uses today. Colors, scrollback and search come with it, and the person can
type into it (answer an `npm` prompt, send Ctrl+C by hand).

**One process, one view.** Opening the terminal tab closes the panel first. If the shell is already
attached to a live terminal in this project, clicking its node activates that tab instead of
opening the panel. `shellTerminalPlan` already decides whether a terminal can be reused; that
decision is reused here.

## 6. Message shortcuts

A shortcut is a name, a text and a visibility rule. Placeholders the app substitutes: the job id,
the agent, the branch, the worktree path and the project path. The rule is one of `any`,
`finished`, `finishedIsolated`.

Alethe ships three, their default names and texts coming from the locale files so they arrive in
the person's language:

- **Apply** (`finishedIsolated`) — asks the planner to commit in the worker's worktree, merge
  `alethe/agent-<jobId>` into the current branch and report any conflict.
- **Review** (`finished`) — asks the planner to read that worker's report and diff before moving on.
- **Continue** (`any`) — asks the planner to send that worker more work on its existing thread.

**What a click does.** The panel closes, Alethe brings into view the terminal named by the job's
`plannerId` — the agent that asked for that work — and writes the rendered text into the agent's input **without Enter**, through
`writePtyChunked(ptyId, text, bracketedPasteMode)` — the path the app already uses to paste a
prompt into an agent. The person edits and presses Enter.

**No planner, no shortcuts.** When the owning planner's terminal is no longer alive, the shortcuts
are not rendered and the panel says why. Stop stays available: it talks to the orchestrator, not to
the agent.

**Customizing.** A new "Orchestration shortcuts" section on the Preferences → Multiagent page lists
them. The person edits name, text and rule of the shipped ones (each with "restore default"),
creates their own and deletes what they do not use. They are stored in `Preferences` as
`orchestratorShortcuts`, so they persist per user through the existing debounced, atomic
`projects.json` write and apply to every project. The available placeholders are listed beside the
text field.

Two pure helpers in `src/lib/orchestratorShortcuts.ts`:

- `shortcutsForJob(shortcuts, job)` — which shortcuts a job shows.
- `renderShortcut(shortcut, job, projectCwd)` — the text with placeholders substituted.

## 7. Backend

### 7.1 Shell owner

`orchestrator_shells.rs`: `planner_id: Option<String>` becomes
`owner: Option<ShellOwner>` where `ShellOwner { kind: ShellOwnerKind, id: String }` and
`ShellOwnerKind` is `Planner` or `Worker`. The snapshot emits
`"owner": { "kind": "planner", "id": "…" }`.

`from_record` reads both shapes: a record with `owner` uses it; a record with only `plannerId` —
every shell persisted before this change — comes back as a planner owner. `alethe_open_shell`
records the calling planner (the `X-Alethe-Planner` header) as a planner owner, unchanged in
behaviour.

`OrchestratorShell` in `src/lib/tauri/orchestrator.ts` gains the matching type.

### 7.2 Stopping a worker

Cancelling exists only inside `dispatch_tool`'s `alethe_cancel` arm. That body moves to
`Core::cancel_jobs(&self, ids: &[String]) -> Vec<String>`, and both the tool and a new
`orchestrator_cancel_job` Tauri command call it. The existing tool test covers the extracted path;
no behaviour changes.

`orchestratorCancelJob(jobId)` joins the other wrappers in `src/lib/tauri/orchestrator.ts`.

### 7.3 Nothing else

Writing into the planner's terminal, attaching a terminal view to a shell PTY and reading shell
output all use commands that already exist.

## 8. Testing

Decisions live in pure functions with unit tests; the components stay thin.

- `layoutPlannerBoard` with shells: attached group under the planner, detached group without an
  edge, and no shells at all (no group node, no layout shift).
- `shellsForBoard` with the owner shape: attached versus detached tagging.
- `shortcutsForJob` for each rule and each job status, and `renderShortcut` substitution including
  a job with no worktree.
- `shellControls` per status — the existing test, kept.
- Rust: `from_record` on a pre-change record (`plannerId` only) and on the new shape.
- Rust: `Core::cancel_jobs` through the extracted method.

Manual verification pending from the shells plan (Ctrl+C on `npm run dev` and `docker compose up`,
natural exit showing its error, shells surviving a closed planner, play then open terminal after an
app restart) is performed on this board instead of the rail.

## 9. i18n, changelog, house rules

Every new string goes into `en.ts` and `pt-BR.ts`, including the shipped shortcut names and texts.
`docs/CHANGELOG.md` gains, under `[Unreleased]`, the board change and the rail section's removal,
written from the person's point of view. Styling stays on theme tokens and CSS Modules; no
hardcoded colors, no gradients.
