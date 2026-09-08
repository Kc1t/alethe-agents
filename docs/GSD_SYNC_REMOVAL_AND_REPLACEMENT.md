# Removing GSD Sync, replacing it with verified procedures

Status: **removal complete.** Nothing named GSD remains in the app. What is left of this document
is the record of how it went and what the replacement still needs. The blocker described under "Step 2 is not
mechanical" was resolved by a decision from the owner: **the child session is gone for good — only
the agents themselves run now.** That took the OpenCode plugin with it, and with the plugin gone
its readers had nothing left to read. The replacement's core is implemented (`src-tauri/src/procedure.rs`,
`src-tauri/src/change_trigger.rs`), plus the working-tree change stats and the fingerprint map that
feed it. None of it is wired to a UI yet.

## Picking this up later

Read this whole document before touching anything — the inventory below is the result of an audit
that already caught one wrong deletion, and redoing it from greps risks repeating that mistake.

Project rules that apply to every step here (`CLAUDE.md` § 5 and § 7):

- Update `docs/CHANGELOG.md` under `[Não lançado]` in the same change. Not optional.
- Every visible string goes through `t()` and must exist in **both** `en.ts` and `pt-BR.ts` — the
  build fails if one is missing. Removing UI means removing its keys from both.
- Never restart the app or the dev server; changes apply through HMR.
- Do not commit or push without the owner asking at that moment, and never add a co-author line.
- Repository content (code, comments, docs, commits) is written in English.

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
rather than deleting a module. *Outcome:* `gsdSyncViewer` is gone (step 4); `gsdWatcherEnabled`
stays, because it turned out to gate a feature that survives GSD Sync (step 5).

`gsdWatcherEnabled` is a **persisted field on `Project`** (`src/lib/types.ts:308`) with a migration
backfilling it (`projectsStore.migrations.ts:410`). Removing it from the type is not enough: every
project already saved in `projects.json` carries it. The migration must keep tolerating the field
so loading an existing `projects.json` does not fail — dropping the key from the type while the
data still has it is exactly the kind of change that breaks on the user's machine and not on ours.

`gsdSyncViewer` was a terminal kind. Terminals carrying it exist in saved state, and code branched
on it in the sidebar, the merge store and the terminal factory. *Resolved:* an already-saved
`gsdSyncViewer` terminal is dropped on load rather than becoming an ordinary terminal — see step 4.

## Order of work

Each step leaves the app working, and each is separately revertible. The order is chosen so that
the risky, wide-reaching parts happen last, when the replacement already exists.

1. **Delete what is genuinely dead.** `read_gsd_child_state` only. Zero callers, zero risk.
   `opencode_gsd_plugin.rs` is explicitly out of scope — it is in use (see above).
2. **Remove the child session and everything downstream of it.** *Done.* The OpenCode plugin
   (`opencode_gsd_plugin.rs` and `assets/opencode-plugins/alethe-gsd-state.ts`), the four sentinel
   reads, `useGsdSyncSessions`, `GsdSyncActivityView` and its mount, the GSD Sync tab, the
   `/sessions` route that opened it, and the orphaned i18n keys.

   **The `.planning/` watcher stays.** It is not part of the child session: project plans (a Keep
   feature) write into `.planning/`, and the watcher is the only producer of `PlanningUpdated`,
   which drives scheduler autotick and planning autocommit. Removing it is a separate change that
   needs another producer first — `change_trigger.rs` is the natural candidate.
3. **Remove the settings toggle** ("Monitorar arquivos de planejamento GSD") and its i18n keys.
   *Done*, together with step 5 — the two turned out to be the same change.
4. **Retire `gsdSyncViewer`.** *Done.* Saved terminals of that kind are **dropped** on load, not
   converted. Converting was the plan below, and it is the wrong call: the flag is what *hid*
   those terminals, so removing it surfaces panes the user never opened, pointing into agent
   worktrees that are usually gone. `migrateToV7` drops them and prunes every reference — pane
   groups, grid layouts, layout history, and the workspace containers/tabs/history, which hold
   pane ids of their own. The workspace rewrite only runs when something was actually dropped, so
   ordinary files take an unchanged path; both halves of that are covered by tests.
5. **Retire `gsdWatcherEnabled`.** *Done*, but not as "keep the migration tolerating the field".
   The owner's decision was that GSD goes completely, so the flag went with it — and the two things
   it gated were kept by being freed from it rather than deleted:

   - The **merge readiness check** (real diff against the target, validation commands pass) was
     opt-in behind this flag. Its first layer did read GSD's planning files, but that layer had
     already been removed earlier; what remained has nothing to do with planning. It now runs for
     every agent card.
   - The **`.planning/` watcher** is the only producer of `PlanningUpdated`, which drives the
     scheduler autotick and the planning autocommit. It is renamed
     (`start_planning_watcher`/`stop_planning_watcher`, `/api/planning/*`) and started for every
     project with a repository, from `App.tsx`. There is no toggle: the setting that gated it
     belonged to a feature that no longer exists, and a watcher two features silently depend on is
     not something to leave off by default.

   Planning autocommits are now subjected `planning(alethe): …` instead of `gsd(alethe): …`.
   Existing history keeps the old prefix; nothing reads it.

## The replacement

Already implemented and tested, not yet wired to any UI:

- **`change_trigger.rs`** — watches the project's source and fires when change has both accumulated
  (enough distinct files, counted as paths rather than events) and settled (a quiet period). It
  only emits an event; the frontend asks the user before spending tokens on a prompt. Now reachable
  from both transports (Tauri commands and `/api/change_trigger/*`), and it reports through the
  event bus rather than a window-only emit, so one path serves both.
- **`procedure.rs`** — a procedure is a claim about specific files. Each covered file records a
  fingerprint of its contents when it was covered, which is what separates "this file has a
  procedure" from "this file has a procedure that still describes it". Checking yields
  `uncovered` (changed, unmentioned), `stale` (covered, then changed — names the offending step so
  the agent can amend it) and `covered`.

**Delivery is settled**, by a decision from the owner: there are no child terminals and no
subagents. The prompt is typed into the PTY the agent already has open — the same mechanism the
branch reviewer uses — and its answer comes back in that same conversation. Nothing is ever
spawned.

Still to build:

1. **Popup with change stats** — changed files with `+/-` lines. The backend half is done:
   `git_working_tree_stats` (`git_control.rs`) returns the same `DiffSummaryEntry` shape as
   `git_show_commit_stats`, but for uncommitted work, and includes untracked files (a brand-new
   file is exactly the change most likely to go undescribed, and `git diff HEAD` does not show it).
   The popup is done too (`ChangeProcedureModal.tsx`), reached from an amber badge on the project
   row. It reads the working tree when it opens rather than trusting the trigger's event: that event
   carries a capped sample taken when it fired, and by the time the badge is clicked the tree has
   usually moved on. The proportion bar was extracted out of the commit detail into
   `components/ui/DiffStatBar.tsx` and is shared, not copied.
2. **The structured prompt** — *done* (`src/lib/changeProcedurePrompt.ts`). Built through `t()`
   rather than in English: it is typed into the user's own terminal, so it is text they watch
   appear, and the agent answers in the language it was addressed in. It states what changed rather
   than asking the agent to go find out, demands that no changed file go unmentioned while
   explicitly allowing one step to cover many, and asks for a verification per step — the part that
   separates a procedure from a changelog. Files whose existing step has gone stale are listed
   separately, with an explicit choice: amend that step, or add a new one.
3. **MCP tools** — *still to build.* How the agent registers steps bound to files
   (`"file X — to verify visually, go to such-and-such screen"`). The project already runs an MCP
   server (`alethe-orchestrator-mcp`), so there is somewhere to put them.
4. **Persistence + the `changed` map** — the `changed` map is done; storing procedures is not. — storing procedures, and computing each changed file's
   current fingerprint from the working tree. This is the glue between the core and everything
   else. The `changed` map half is done: `procedure::fingerprint_changed_files` hashes each changed
   path as it currently stands on disk, skipping paths that no longer exist (a deletion has no
   contents to fingerprint, so treating it as an ordinary changed file would leave a procedure
   permanently incomplete). Storing procedures is still to build.

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
