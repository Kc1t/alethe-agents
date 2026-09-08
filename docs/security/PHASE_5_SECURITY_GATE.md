# Phase 5 Security Gate — Evidence Ledger

Status: **in progress**. Maps the Phase 5 requirements from
`docs/superpowers/plans/2026-08-21-security-gate-and-cloudflare-rendezvous-prompt.md` (§ Phase 5)
and `docs/superpowers/plans/2026-08-21-collaboration-implementation-blueprint.md` (§ Phase 5) to
implementation and test evidence. `resolve_capabilities_at` (Phase 3) is unchanged by this phase —
`project_transfer` remains `unavailable`, because nothing in Phase 5 moves project content; it
only lets a recipient record where content would eventually go, once Phase 6 exists to send it.

| # | Requirement | Implementation | Authoritative test | Status | Unresolved risk |
| --- | --- | --- | --- | --- | --- |
| 5.1 | Persist versioned per-device subscription state (project/grant/destination/mode/scopes/revision/state/timestamps/error) | `sync_subscription.rs`: `SubscriptionRecord`, `SubscriptionDocument` (atomic tmp→rename writes, same pattern as `sync_security.rs`) | `sync_subscription::tests::state_survives_a_reload_from_disk` | Done | `exclusion_policy_version` is a fixed constant (`1`) — no real exclusion policy exists yet to version against (Phase 6) |
| 5.1b | Full state machine: `offered → configuring → awaiting_confirmation → staging → verifying → active`, plus `deferred/declined/paused/revoked/error/removing` | Same file: `offer_subscription_at`, `configure_destination_at`, `select_mode_at`, `confirm_subscription_at`, `mark_verifying_at`, `mark_active_at`, `pause_subscription_at`, `resume_subscription_at`, `defer_subscription_at`, `decline_subscription_at`, `reopen_subscription_at`, `revoke_subscription_at`, `mark_error_at`, `remove_subscription_at` | `sync_subscription::tests::full_state_machine_progression_is_available_for_later_phases_to_drive`, `revocation_ends_any_live_subscription_state`, `removal_is_restricted_to_terminal_states` | Done for the state machine itself; `Staging`/`Verifying`/`Active` transitions beyond `confirm` are extension points with no real caller yet — nothing in the product drives them until Phase 6 | Do not read "state machine is complete and tested" as "a real transfer runs" — no manifest/chunk protocol exists to actually populate `Staging`→`Verifying`→`Active` |
| 5.2 | Destination validation: containment, traversal, symlinks/junctions, path length, permissions, collisions, free space, existing-copy handling | `sync_subscription::validate_destination` | `destination_rejects_traversal_symlink_and_collision`, `destination_rejects_an_existing_non_empty_directory` | Done for traversal/symlink/collision/non-empty-directory/absolute-path/length; free space uses a coarse fixed 10 MB floor via the existing `sysinfo` dependency (no real transfer size exists yet to check against) | Filesystem-permission checks (writability) are not explicitly tested — `fs::create_dir_all` in `confirm_subscription_at` will surface a permission failure as an I/O error, but there is no dedicated pre-flight writability probe yet |
| 5.3 | Mode selection limited to modes with real runtime; show effective permissions/size/exclusions/direction/deletion before confirmation | `SubscriptionMode` (`ManualSnapshot`, `ReceiveAfterConfirmation`, `Bidirectional`) — all three are recorded, none has transfer runtime behind it yet (that's Phase 6/7) | `destination_and_mode_together_move_to_awaiting_confirmation` | `[~]` Backend records the mode choice; there is no UI confirmation screen yet (deliberately — see §5.4 non-goal below) | Mode is accepted today even though no mode has real transfer behavior; this is honest because `project_transfer` capability stays `unavailable`, so nothing can act on the recorded mode yet |
| 5.4 | Guarantee zero project-content writes before final confirmation | `offer_subscription_at`, `configure_destination_at`, `select_mode_at`, `defer_subscription_at`, `decline_subscription_at`, `reopen_subscription_at` never call any filesystem-write function; only `confirm_subscription_at` calls `fs::create_dir_all` | `offering_creates_no_filesystem_write_beyond_the_record`, `destination_and_mode_together_move_to_awaiting_confirmation` (asserts the directory does **not** exist after each step), `viewing_deferring_and_declining_never_touch_the_filesystem`, `confirmation_is_the_only_step_that_creates_the_destination_directory` | Done | The directory created on confirmation is empty — no project content is ever written, because Phase 6 (which would write it) does not exist yet |

## Desktop/Web parity

| Operation | Tauri command | Web route |
| --- | --- | --- |
| List subscriptions | `sync_list_subscriptions` | `GET /api/sync/subscriptions` |
| Offer subscription | `sync_offer_subscription` | `POST /api/sync/subscriptions/offer` |
| Configure destination | `sync_configure_subscription_destination` | `POST /api/sync/subscriptions/destination` |
| Select mode | `sync_select_subscription_mode` | `POST /api/sync/subscriptions/mode` |
| Confirm | `sync_confirm_subscription` | `POST /api/sync/subscriptions/confirm` |
| Defer | `sync_defer_subscription` | `POST /api/sync/subscriptions/defer` |
| Decline | `sync_decline_subscription` | `POST /api/sync/subscriptions/decline` |

All routes call the same Core functions as the Tauri commands (`sync_subscription.rs`), via
`tokio::task::spawn_blocking`, matching the existing `sync_security_routes.rs` pattern.

## Deliberate non-goal: no UI this phase

No frontend UI was added beyond the typed API client (`src/lib/api/syncSubscription.ts`). Per the
blueprint's cross-phase rule ("Add UI only when real capability exists"), building a recipient
setup screen now would let a user configure a subscription that can never actually receive
anything, because Phase 6 (manifest/staging/transfer) does not exist yet. The backend and its
Tauri/Web parity are real and tested; the UI is deliberately withheld until there is a real
transfer to drive it.

## Fail-closed confirmation

- `resolve_capabilities_at` (Phase 3) is unchanged; `project_transfer` remains `unavailable`.
- Every subscription-creating/mutating function requires an existing subscription record found by
  ID — there is no way to fabricate authorization by supplying arbitrary IDs.
- `confirm_subscription_at` is the only function that touches the filesystem, and only after the
  state machine has already required both an explicitly validated destination and an explicitly
  selected mode.

## Reviewer trace

Every row above names the exact file and test function; running
`cargo test --lib sync_subscription` reproduces all Phase 5 evidence in this document.

## Incident note

During implementation, two bugs were found and fixed before this ledger was finalized:

1. **Windows path-traversal detection gap**: the initial destination-validation logic searched for
   the nearest existing ancestor of a candidate path by walking `Path::parent()` while checking
   `.exists()` at each step. On Windows, `.exists()` normalizes `..` components at the OS-call
   level even through non-existent intermediate directories, which let the ancestor walk stop at a
   lexical path that still contained unresolved `..` segments — masking them from the subsequent
   "does the remainder contain `..`" check. Fixed by rejecting any literal `..` component in the
   original candidate path outright, before any existence-based resolution begins.
2. **Collision check compared un-normalized strings**: destination collision detection compared
   a fresh candidate's raw input string against already-canonicalized (and, on Windows,
   `\\?\`-prefixed) stored destinations, so two different textual spellings of the same real
   directory were never recognized as the same path. Fixed by normalizing (stripping the Windows
   verbatim prefix) before both storing and comparing destinations.

Both are covered by `destination_rejects_traversal_symlink_and_collision` and
`state_survives_a_reload_from_disk`.
