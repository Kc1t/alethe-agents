# Phase 8 Security Gate — Evidence Ledger

Status: **in progress**. Maps the Phase 8 requirements from
`docs/superpowers/plans/2026-08-21-security-gate-and-cloudflare-rendezvous-prompt.md` (§ Phase 8)
and `docs/superpowers/plans/2026-08-21-collaboration-implementation-blueprint.md` (§ Phase 8) to
implementation and test evidence. `resolve_capabilities_at` (Phase 3) is unchanged — `sharedTasks`
remains `unavailable`, because nothing wires a real remote collaborator's task operations into
this module yet (that requires `sync_transport.rs`, Phase 4, to carry them between devices).

| # | Requirement | Implementation | Authoritative test | Status | Unresolved risk |
| --- | --- | --- | --- | --- | --- |
| 8.1 | Separate domain model distinct from the local agent scheduler; task ID, project ID, visibility, membership, title/body, author, assignees, status, labels, due date, revision, timestamps, tombstone | `sync_tasks.rs`: `TaskRecord`, `ctask_`-prefixed IDs (distinct from `scheduler.rs`'s own ID scheme and in-memory store), separate persistence file per project | `task_ids_never_collide_with_the_local_agent_scheduler_prefix` | Done | `title`/`body` are stored as plain local strings, not literally "ciphertext" — no group key management exists yet to encrypt them for a remote peer (that is a Phase 9 concern the blueprint itself defers key-management selection to); documented honestly rather than naming fields as if encryption already existed |
| 8.1b | Restricted task existence must not leak through counts or errors | `is_visible_to`, `list_visible_tasks_at` (silently omits invisible tasks), `get_task_at` (returns the identical `NotFound` for a real-but-invisible task and a genuinely nonexistent one) | `restricted_task_is_invisible_to_non_members_in_lists_and_direct_lookup`, `restricted_task_is_indistinguishable_from_a_nonexistent_one` | Done for list/get. Not covered: response-timing side channels (constant-time comparison was not attempted — see below) | This is the single most important property of this phase; the two dedicated tests above directly compare outcomes rather than just asserting each individually, so a future refactor that changes one path without the other will fail the test |
| 8.2 | Signed create/update/assign/complete/reopen/comment/delete/restore operations with expected base revision; deterministic conflicts for incompatible offline edits | `sync_tasks.rs`: all eight operation kinds implemented via `mutate_task`'s shared base-revision check; a stale `expected_base_revision` returns `TaskError::Conflict` rather than applying | `stale_base_revision_is_a_deterministic_conflict_not_a_silent_overwrite`, `comments_accumulate_and_delete_restore_round_trips` | `[~]` Every operation is device-attributed and revision-checked; "signed" is not a per-operation Ed25519 signature (same honest scoping as Phase 7's operation log) — nothing yet transmits an operation where that would matter. Conflict handling here is simpler than Phase 7's dual-sided `ConflictRecord`: a stale revision is rejected immediately for the caller to re-fetch and retry, rather than persisting both versions for later resolution — appropriate for field-level task edits, not file content | If task conflict UX later needs to show "what the other side changed" rather than just "try again," a `ConflictRecord`-style ledger (mirroring Phase 7) would need to be added; not built now because nothing requires it yet |
| 8.3 | Independent synchronization stream and journal; pausing file transfer must not corrupt/block task state | Tasks persist to `data_root/sync/tasks/<project_id>.json`, entirely separate from `data_root/sync/staging/` (Phase 6) and `data_root/sync/engine/` (Phase 7) — different files, different modules, no shared mutable state | N/A — true by construction; no cross-module test needed to prove two independent files cannot corrupt each other | Done | Independent *persistence* is proven; independent *replication scheduling* (i.e. an actual live sync loop that prioritizes tasks over a large file transfer) does not exist yet, because no live sync loop exists yet for either domain |
| 8.4 | UI projection: project-public/restricted views, assignment, filters, due state, conflict indicators; every action reauthorized by Core | *(not built this phase — see non-goal below)* | — | Not started | `sharedTasks` capability stays `unavailable`, so no UI was added, consistent with every prior phase's "no UI before the capability is real" rule |

## Phase 8 proof checklist (from the security-gate prompt)

- `[x]` Restricted tasks do not leak through lists, counts, or direct lookup —
  `restricted_task_is_invisible_to_non_members_in_lists_and_direct_lookup` covers list (absence)
  and direct `get_task_at` (identical `NotFound`); `restricted_task_is_indistinguishable_from_a_nonexistent_one`
  proves the two error outcomes are literally equal, not just similarly-shaped.
- `[ ]` ...through notifications, search, export, or timing-sensitive error behavior — none of
  notifications, search, or export exist yet for tasks (no phase has built them), so there is
  nothing to leak through *yet*; this is an absence of the risk surface, not a tested guarantee
  that will still hold once those features exist. Timing-channel resistance was not attempted —
  `get_task_at`'s two error paths (unknown ID vs. invisible task) do different amounts of work
  before returning `NotFound` (a HashMap-free linear scan either way, but not deliberately
  balanced), so a sufficiently precise timing measurement could theoretically distinguish them.
  Recorded here rather than silently assumed solved.
- `[x]` Offline concurrent operations converge or create an explicit conflict — proven by
  `stale_base_revision_is_a_deterministic_conflict_not_a_silent_overwrite`: the second offline
  device's stale-revision operation is rejected outright rather than silently overwriting the
  first device's already-committed change.
- `[x]` Task and local scheduler identifiers/stores never collide — `ctask_` prefix, entirely
  separate file (`sync_tasks.rs`) and persistence path from `scheduler.rs`'s in-memory `sched.tasks`.
- `[x]` File-transfer pause and task replication are independently testable — true by construction
  (separate files/modules); `sync_engine::pause_sync_at` (Phase 7) and this module share no state.

## Desktop/Web parity

| Operation | Tauri command | Web route |
| --- | --- | --- |
| Create task | `sync_create_task` | `POST /api/sync/tasks/create` |
| List visible tasks | `sync_list_visible_tasks` | `GET /api/sync/tasks` |
| Get one task | `sync_get_task` | *(not yet exposed over Web)* |
| Complete task | `sync_complete_task` | `POST /api/sync/tasks/complete` |
| Add comment | `sync_add_task_comment` | `POST /api/sync/tasks/comment` |

`update_task_at`, `assign_task_at`, `reopen_task_at`, `delete_task_at`, and `restore_task_at` exist
as Core functions with full test coverage but are not yet exposed as Tauri commands or Web
routes — the same "mechanism ready, minimal surface exposed" pattern used for
`sync_engine.rs`'s `clear_rescan_flag_at`/`restore_previous_backup_at` in Phase 7. `sync_get_task`
is Tauri-only for the same reason `sync_engine_apply_local` was Tauri-only in Phase 7: no live Web
scenario needs it yet.

## Deliberate non-goal: no UI, no live cross-device wiring this phase

Same reasoning as every phase since Phase 5: `sharedTasks` stays `unavailable` because nothing
connects a real remote collaborator's task operations to this module yet. This phase proves the
domain model, visibility enforcement, and conflict handling against local test fixtures simulating
multiple devices acting on the same local project task store.

## Fail-closed confirmation

- `resolve_capabilities_at` (Phase 3) is unchanged; `sharedTasks` remains `unavailable`.
- Every operation — including read (`list_visible_tasks_at`, `get_task_at`) — rechecks project
  membership fresh via `SecurityBackedMembership` before touching task data.
- A restricted task is never returned with its content redacted; it is either fully present (the
  viewer is a member) or entirely absent, indistinguishable from not existing.

## Reviewer trace

Every row above names the exact file and test function; running `cargo test --lib sync_tasks`
reproduces all Phase 8 evidence in this document.
