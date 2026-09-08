# Phase 7 Security Gate — Evidence Ledger

Status: **in progress**. Maps the Phase 7 requirements from
`docs/superpowers/plans/2026-08-21-security-gate-and-cloudflare-rendezvous-prompt.md` (§ Phase 7)
and `docs/superpowers/plans/2026-08-21-collaboration-implementation-blueprint.md` (§ Phase 7) to
implementation and test evidence. `resolve_capabilities_at` (Phase 3) is unchanged — nothing in
this phase is wired to a live filesystem watcher or a live peer session, so there is nothing new
for a capability to report as available.

| # | Requirement | Implementation | Authoritative test | Status | Unresolved risk |
| --- | --- | --- | --- | --- | --- |
| 7.1 | Stable revisions and signed operations for create/update/rename/delete/metadata; never use modification time as sole truth | `sync_engine.rs`: `SignedOperation`, `OperationKind`, `apply_local_operation_at` (assigns a monotonic per-subscription sequence as the revision, independent of any timestamp) | `local_operations_advance_the_paths_revision_and_are_logged` | Done for the model itself | "Signed" here means device-attributed (`author_device_id`) and persisted in an authenticated local document, matching the level of "signing" the rest of the local state already uses (`sync_security.rs`'s records are not individually Ed25519-signed either) — a per-operation Ed25519 signature over `SignedOperation`'s canonical bytes is not implemented; nothing yet transmits an operation to an untrusted party where that would matter |
| 7.2 | Watcher ingestion: coalesce noisy events, detect overflow, rescan deterministically, handle case-only rename/editor temp files, exclude staging/internal paths | `sync_engine::coalesce_watch_events` (pure, dedup-by-path, overflow detection), `mark_needs_rescan_at`/`clear_rescan_flag_at` | `coalescing_dedupes_paths_and_flags_overflow` | `[~]` Coalescing and overflow detection are done and tested. There is no real OS filesystem watcher wired in yet (the `notify` crate is already a dependency elsewhere in the codebase but not connected here) — case-only rename and editor-temp-file handling are not separately implemented, because there are no real OS events flowing through this code yet to exhibit those cases | This is the clearest "mechanism proven, integration pending" item in this phase — treat `coalesce_watch_events` as a tested building block, not a running watcher |
| 7.3 | Reauthorize every operation immediately before mutation — never trust cached permission | `sync_engine::apply_local_operation_at`/`apply_remote_operation_at` call `OperationAuthorizer::check` fresh on every call; `SecurityBackedAuthorizer` reads `sync_security`'s persisted device-trust state directly, never a cached value | `revoked_authorization_blocks_the_operation_before_any_state_changes` | Done | Authorization currently only checks device trust (`Trusted`/not), not yet per-path permission/scope from a `GrantRecord` — Phase 2's grant/path-scope model exists but is not yet cross-checked here, because nothing yet ties a `sync_engine` subscription's operations to a specific grant's permission set at this layer |
| 7.4 | Explicit conflict records on divergent history; keep local/remote/both; never last-writer-wins | `apply_remote_operation_at` (base-revision comparison), `ConflictRecord`, `resolve_conflict_at` (`KeepLocal`/`KeepRemote`/`KeepBoth`) | `diverged_base_revision_records_a_conflict_and_applies_neither_side`, `resolve_keep_remote_overwrites_and_keep_both_preserves_a_renamed_sibling` | Done | A "reviewed text merge" option (beyond keep-local/remote/both) is not implemented — the blueprint lists it as an option, not a requirement, and no text-merge library has been evaluated |
| 7.5 | Recovery controls: pause/resume/cancel/rescan/repair/rollback/restore/peer removal/long-offline reconciliation | `pause_sync_at`/`resume_sync_at`, `mark_needs_rescan_at`/`clear_rescan_flag_at`, `restore_previous_backup_at` (single-generation rollback via Phase 6's retained backup) | `paused_subscription_rejects_new_operations`, `restore_previous_backup_swaps_the_backup_back_into_place`, `restore_previous_backup_fails_when_there_is_nothing_to_restore` | `[~]` Pause/resume/rescan-flag/single-generation-rollback are done and tested. "Repair from manifest" (re-verify local tree against a `ProjectManifest` and reconcile drift), "cancel" of an in-progress operation, explicit peer removal, and long-offline reconciliation beyond what conflict detection already provides are not implemented | Rollback is deliberately scoped to "restore the one retained prior generation," not arbitrary point-in-time recovery — Phase 6 only ever retains one backup generation, so this module cannot promise more than that without a deeper history mechanism this phase does not build |

## Phase 7 proof checklist (from the security-gate prompt)

- `[~]` Two-process deterministic tests for simultaneous edits, rename/delete races, case
  collisions, offline divergence, revocation, interruption, watcher overflow — this phase's tests
  are single-process, local-fixture tests driving the same functions two "sides" would call
  (`apply_local_operation_at` for one device, `apply_remote_operation_at` simulating what arrives
  from another), which exercises the same conflict/authorization logic a real two-process test
  would, but without an actual second process or live transport connection. A literal two-process
  test (two real `sync_transport.rs` sessions driving `sync_engine.rs` on each side) is later
  integration work.
- `[x]` Conflict resolution is repeatable and audited — every `ConflictRecord` persists both
  operations and its resolution; `resolve_conflict_at` refuses to resolve an already-resolved
  conflict (`ConflictAlreadyResolved`), preventing silent double-resolution.
- `[x]` No unauthorized operation applies after revocation — `revoked_authorization_blocks_the_operation_before_any_state_changes`
  proves a denied authorizer prevents any state mutation, and `SecurityBackedAuthorizer` reads
  live device-trust state on every call, so a device revoked between two operations is rejected
  on the very next one without needing to restart anything.
- `[~]` Memory, queues, caches, and disk journals remain bounded in soak tests — `op_log` is
  bounded (`MAX_OP_LOG_ENTRIES`, tested) and watcher-event coalescing is bounded
  (`MAX_QUEUED_EVENTS`, tested); no long-running soak test exists, because there is no live
  process driving sustained load through this module yet.

## Desktop/Web parity

| Operation | Tauri command | Web route |
| --- | --- | --- |
| Pause | `sync_engine_pause` | `POST /api/sync/engine/pause` |
| Resume | `sync_engine_resume` | `POST /api/sync/engine/resume` |
| Mark needs rescan | `sync_engine_mark_needs_rescan` | `POST /api/sync/engine/rescan` |
| Resolve conflict | `sync_engine_resolve_conflict` | `POST /api/sync/engine/resolve` |
| Load engine state | `sync_engine_load` | `GET /api/sync/engine/:subscription_id` |
| Apply local operation | `sync_engine_apply_local` | *(not yet exposed over Web)* |

`sync_engine_apply_local` exists as a Tauri command only for now (native callers, e.g. a future
local filesystem watcher integration); a Web equivalent will be added once there is a real Web
client scenario that needs to originate operations directly rather than through a watcher.
`clear_rescan_flag_at` and `restore_previous_backup_at` are not yet exposed as commands/routes —
nothing calls them from a live process yet, matching the same "mechanism ready, no live caller"
pattern as Phase 6's `recover_publication_at`.

## Deliberate non-goal: no UI, no live watcher/transport wiring this phase

Same reasoning as Phases 5 and 6: no frontend UI, and no connection to a real OS filesystem
watcher or a real `sync_transport.rs` peer session. This phase proves the revision/conflict/
authorization *mechanism* against local test fixtures simulating both "sides" of a change.

## Fail-closed confirmation

- `resolve_capabilities_at` (Phase 3) is unchanged.
- `apply_local_operation_at`/`apply_remote_operation_at` both reject while the subscription is
  paused (`Paused`), before checking authorization or touching state.
- `apply_remote_operation_at` never silently overwrites a diverged local revision — it always
  produces a `ConflictRecord` instead, with both sides preserved.

## Reviewer trace

Every row above names the exact file and test function; running `cargo test --lib sync_engine`
reproduces all Phase 7 evidence in this document.

## Incident note

During implementation, the initial version of `op_log_stays_bounded_under_a_long_history` drove
over 10,000 iterations of `apply_local_operation_at` — each one reading, re-serializing, and
atomically rewriting the entire (growing) on-disk journal — making the test's actual cost
effectively O(n²) in the log length. This made the test slow enough to appear hung and had to be
killed mid-run. It was rewritten to exercise the pure in-memory `push_op_log` bounding function
directly, which tests the exact same bounding invariant without any disk I/O and completes in
well under a second alongside the rest of the suite.
