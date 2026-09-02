# Removing GSD Sync, replacing it with verified procedures

Status: **planned** — the replacement's core is implemented (`src-tauri/src/procedure.rs`,
`src-tauri/src/change_trigger.rs`); the removal has not started.

## Why

GSD Sync watches `.planning/` and reacts to the procedure file being written. That is backwards:
the file only changes *after* something already wrote it, so the system never knows whether a
procedure describes the work that was actually done, or how far the code has drifted from it since.
A procedure ages silently and nothing notices.

The replacement inverts the premise. It watches the **code** the procedure is meant to describe,
asks for a procedure once change has settled, and then holds that procedure to a verifiable claim
about specific files.

## What is being removed vs. kept

`planning.rs` is **not** all GSD. It also owns project plans, the planning audit log and planning
autocommit, which are separate features with their own callers. Removing "GSD Sync" must not take
those with it.

### Remove

| Symbol / surface | Where | Frontend uses |
|---|---|---|
| `start_gsd_watcher` / `stop_gsd_watcher` | `planning.rs` | 3 + 3 |
| `read_gsd_child_session` | `planning_gate.rs` | 8 |
| `read_gsd_child_busy` / `read_gsd_child_error` | `planning_gate.rs` | 3 + 3 |
| `read_gsd_procedure` | `planning_gate.rs` | 3 |
| `read_gsd_child_state` | `planning_gate.rs` | **0 — already dead** |
| `gsd_opencode_plugin_write` | `opencode_gsd_plugin.rs` (308 lines) | **2 — IN USE, see below** |
| `GsdSyncActivityView` | `src/components/GsdSyncActivityView/` | mounted in `App.tsx` |
| `useGsdSyncSessions` | `src/hooks/` | — |
| `gsdSyncViewer` terminal kind | 10 files | 22 |
| `gsdWatcherEnabled` project flag | 12 files | 37 |

### Keep

Everything else in `planning.rs` and `planning_gate.rs`:

- `list_project_plans`, `save_project_plan`, `patch_project_plan`, `append_plan_diagram`
- `planning_audit_record`, `planning_audit_history`
- `set_planning_autocommit`, `get_planning_autocommit`, `start_planning_autocommit_loop`
- `read_planning_status`

One command is genuinely dead: `read_gsd_child_state`, zero callers anywhere. It can be deleted
first, on its own, with no behavioural risk.

`gsd_opencode_plugin_write` is **not** dead, despite the "gsd" in its name. It is called from
`useXtermSession.ts` and `projectsStore.projectSlices.ts` to write the OpenCode plugin into a
worktree when an agent starts. It is named after GSD but does a job the replacement does not
cover — deleting it would break agent startup in worktrees. It stays until something establishes
whether that plugin is still wanted, which is a separate question from GSD Sync.

(An earlier pass of this document listed it as dead. That came from grepping
`gsdOpencodePluginWrite` instead of `gsdOpenCodePluginWrite` — a case-sensitivity slip that made a
live symbol look unused. Worth recording: "zero callers" from a single grep is not proof, and this
is the kind of mistake that deletes working code.)

## The two widespread symbols

`gsdWatcherEnabled` (37 uses) and `gsdSyncViewer` (22 uses) are what make this a large change
rather than deleting a module.

`gsdWatcherEnabled` is a **persisted field on `Project`** (`src/lib/types.ts:308`) with a migration
backfilling it (`projectsStore.migrations.ts:410`). Removing it from the type is not enough: every
project already saved in `projects.json` carries it. The migration must keep tolerating the field
so loading an existing `projects.json` does not fail — dropping the key from the type while the
data still has it is exactly the kind of change that breaks on the user's machine and not on ours.

`gsdSyncViewer` is a terminal kind. Terminals carrying it exist in saved state, and code branches
on it in the sidebar, the merge store and the terminal factory. Removal has to decide what an
already-saved `gsdSyncViewer` terminal becomes on load — most likely an ordinary terminal.

## Order of work

Each step leaves the app working, and each is separately revertible. The order is chosen so that
the risky, wide-reaching parts happen last, when the replacement already exists.

1. **Delete what is genuinely dead.** `read_gsd_child_state` only. Zero callers, zero risk.
   `opencode_gsd_plugin.rs` is explicitly out of scope — it is in use (see above).
2. **Remove the watcher and the child-state reads.** `start_gsd_watcher`/`stop_gsd_watcher`,
   `read_gsd_child_session`/`_busy`/`_error`/`read_gsd_procedure`, `useGsdSyncSessions`,
   `GsdSyncActivityView` and its mount in `App.tsx`.
3. **Remove the settings toggle** ("Monitorar arquivos de planejamento GSD") and its i18n keys.
4. **Retire `gsdSyncViewer`.** Migrate saved terminals of that kind to ordinary terminals; delete
   the branches.
5. **Retire `gsdWatcherEnabled`.** Keep the migration reading and discarding the field; remove it
   from `Project` and from the 37 call sites.

Steps 1–3 are mechanical. Steps 4–5 touch persisted state and deserve their own commits and their
own testing.

## The replacement

Already implemented and tested, not yet wired to any UI:

- **`change_trigger.rs`** — watches the project's source and fires when change has both accumulated
  (enough distinct files, counted as paths rather than events) and settled (a quiet period). It
  only emits an event; the frontend asks the user before spending tokens on a prompt.
- **`procedure.rs`** — a procedure is a claim about specific files. Each covered file records a
  fingerprint of its contents when it was covered, which is what separates "this file has a
  procedure" from "this file has a procedure that still describes it". Checking yields
  `uncovered` (changed, unmentioned), `stale` (covered, then changed — names the offending step so
  the agent can amend it) and `covered`.

Still to build:

1. **Popup with change stats** — changed files with `+/-` lines. The `numstat` parser and the
   proportion bar already exist from the commit-graph work (`git_show_commit_stats`); this needs the
   same against the working tree instead of a commit.
2. **The structured prompt** — what the agent is told to produce, including the file list and the
   expected shape of a procedure.
3. **MCP tools** — how the agent registers steps bound to files
   (`"file X — to verify visually, go to such-and-such screen"`). The project already runs an MCP
   server (`alethe-orchestrator-mcp`), so there is somewhere to put them.
4. **Persistence + the `changed` map** — storing procedures, and computing each changed file's
   current fingerprint from the working tree. This is the glue between the core and everything
   else.

Piece 4 (verification) is the point of the whole design; 1–3 exist to serve it.

## Deliberate design decisions

**A step may cover many files.** A forty-file refactor requiring forty steps produces filler text,
not a procedure. What is enforced is that no changed file goes *unmentioned* — grouping is a
supported outcome, not a workaround.

**A step naming a file nobody touched is reported but does not block.** It is almost always a
typo'd path. Reporting it matters (a procedure covering nothing would otherwise look complete), but
it does not mean real work went undescribed.

**The trigger waits for quiet, not just volume.** Firing the moment the file threshold is crossed
would interrupt mid-edit — precisely when the work is unfinished and any description of it would be
wrong.

**Nothing is sent to an agent without asking.** The trigger emits an event; the user decides. It
spends their tokens and interrupts whatever the agent is doing.
