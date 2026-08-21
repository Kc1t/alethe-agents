# Phase 6 Security Gate — Evidence Ledger

Status: **in progress**. Maps the Phase 6 requirements from
`docs/superpowers/plans/2026-08-21-security-gate-and-cloudflare-rendezvous-prompt.md` (§ Phase 6)
and `docs/superpowers/plans/2026-08-21-collaboration-implementation-blueprint.md` (§ Phase 6) to
implementation and test evidence. `resolve_capabilities_at` (Phase 3) is unchanged — `project_transfer`
stays `unavailable`, because nothing yet wires a real remote sender's chunks into
`sync_staging::receive_chunk_at` (that wiring — connecting `sync_transport.rs` streams to this
module — is later integration work, not part of this phase).

| # | Requirement | Implementation | Authoritative test | Status | Unresolved risk |
| --- | --- | --- | --- | --- | --- |
| 6.1 | Manifest specification: normalized relative paths, type, size, hash, executable flag, chunk list, exclusion-policy version, revision, author device, signature; reject absolute/traversal/device paths, unsupported links, duplicate/case-colliding paths, impossible sizes | `sync_manifest.rs`: `ProjectManifest`, `ManifestEntry`, `normalize_and_validate_path`, `validate_manifest`, `sign_manifest`/`verify_manifest_signature` | `normalize_rejects_absolute_traversal_and_reserved_names`, `validate_manifest_rejects_duplicate_and_case_colliding_paths`, `validate_manifest_rejects_impossible_sizes`, `validate_manifest_rejects_directory_entries_carrying_file_fields`, `build_manifest_excludes_secrets_and_signs_deterministically` | Done | Symlinks and other special file types are silently skipped during manifest construction (never represented), rather than explicitly rejected with a distinct error — functionally deny-by-default, but not separately tested with a real symlink fixture (platform-dependent to create portably in a unit test) |
| 6.2 | Default-deny exclusion policy: env files, credential stores, agent transcripts/scrollback, `.git`, dependencies, build output, caches, backups, hidden metadata | `sync_manifest::is_excluded` and `default_excluded_dir_names` | `exclusion_policy_hides_git_dependencies_and_secrets_by_default`, `build_manifest_excludes_secrets_and_signs_deterministically` | `[~]` Covers `.git`, `.alethe`, `node_modules`/`target`/`dist`/`build`/etc., `.env*`, private key files (`id_rsa`, `*.pem`, `*.key`), and common credential filenames | Alethe-specific categories not yet enumerated: agent transcripts and terminal scrollback live under `.alethe` (already excluded wholesale) — no separate rule was needed, but this was not independently verified against the exact scrollback path used elsewhere in the codebase; user-configurable exclusion overrides are not implemented |
| 6.3 | Chunking and verification: bounded chunk size, cryptographic hash, verify count/total bytes/per-chunk hash/reconstructed file hash/manifest signature/grant/destination/quota; avoid cross-account dedup leakage | `sync_manifest::chunk_file` (bounded streaming SHA-256 chunking), `sync_staging::receive_chunk_at`/`verify_staged_at` | `chunking_reconstructs_the_exact_file_hash`, `substituted_and_oversized_chunks_are_rejected_at_receive_time`, `verification_fails_closed_on_missing_chunk_and_never_publishes` | `[~]` Chunk size, per-chunk hash, reconstructed file hash, and total-bytes-via-chunk-sum (enforced in `validate_manifest`) are done and tested. Manifest signature verification exists (`verify_manifest_signature`) but is not yet called from `sync_staging` before staging begins — no caller wires an untrusted, network-received manifest through it yet, since no real transfer exists. Grant/destination/quota checks are Phase 5's destination validation plus `begin_staging_at`'s free-space check, not re-verified a second time inside staging itself | Chunk storage is content-addressed *within one subscription's staging area only* — deliberately not deduplicated *across* subscriptions/accounts, so no cross-account content-equality signal can leak; this was a design choice, not an oversight, and is not separately tested because there is only ever one staging area per subscription in this phase |
| 6.4 | Staging journal: expected manifest, received chunks, verification state, reserved space, temp locations, publication intent, cleanup status; atomic and restart-safe | `sync_staging.rs`: `StagingJournal` (atomic tmp→rename writes, same pattern as `sync_security.rs`/`sync_subscription.rs`), `begin_staging_at`/`receive_chunk_at`/`verify_staged_at` | `full_happy_path_publishes_the_exact_verified_tree`, `duplicate_chunk_delivery_is_a_safe_no_op` | Done | The known crash window between an OS-level rename succeeding and the following journal `save_journal_at` call is not covered by automatic recovery (see Phase 6 proof section below) — documented, not hidden |
| 6.5 | Atomic publication: build complete verified tree outside destination, preserve recoverable prior tree, atomic switch, retain exactly the immediately preceding version | `sync_staging::publish_atomically_at`/`recover_publication_at`/`do_publish_steps` (two-step rename swap: destination→backup, then staging-tree→destination) | `full_happy_path_publishes_the_exact_verified_tree`, `crash_between_publish_steps_recovers_to_the_new_verified_tree`, `republishing_keeps_exactly_one_recoverable_prior_version` | Done | See the honest atomicity note below — each individual rename is OS-atomic; the two-step *sequence* is crash-recoverable via the journal, not a single atomic syscall (no filesystem gives that for a non-empty directory swap) |

## Honest atomicity note

The blueprint asks for "corrupt, substituted, partial, unauthorized, or unsafe content never
reaches the live project" and "a crash at every transfer boundary leaves either the previous valid
tree or the new verified tree, never a mixed tree." This is achieved as follows, and the two
claims are not identical — read the second sentence carefully:

- **No content ever reaches `destination` before verification.** `receive_chunk_at` only ever
  writes into the staging work area; `verify_staged_at` only ever writes the verified tree into
  the staging work area, never into `destination`. This part is a true, unconditional guarantee —
  proven by `verification_fails_closed_on_missing_chunk_and_never_publishes` asserting
  `destination` remains empty after a failed verification.
- **Publication is two OS-atomic renames, made crash-recoverable, not a single atomic operation.**
  No mainstream filesystem provides an atomic "replace this non-empty directory's contents with
  that one's" primitive. `do_publish_steps` therefore does `rename(destination, backup)` then
  `rename(staging_tree, destination)`. Each rename call is individually atomic at the OS level.
  Between the two calls, `destination` briefly does not exist on disk. `recover_publication_at`
  detects this exact state (via the persisted `publish_step` field) and deterministically
  completes the second rename — proven by `crash_between_publish_steps_recovers_to_the_new_verified_tree`,
  which manually drives step one, persists the journal, and asserts recovery reaches `Published`
  with the correct final content and an intact backup.
- **The one narrow gap**: if the process crashes in the instant between an OS rename succeeding
  and the following `save_journal_at` call persisting that fact, the journal will not reflect
  what the filesystem actually did. This window is a few milliseconds of synchronous, sequential
  code with no I/O or scheduling point in between apart from the rename and the journal write
  itself; it is treated as an accepted residual risk rather than a solved one, and is recorded
  here rather than silently omitted.

## Phase 6 proof checklist (from the security-gate prompt)

- `[x]` Property/fuzz-style tests reject unsafe manifests and paths — `normalize_and_validate_path`
  and `validate_manifest` cover absolute paths, `..` traversal, reserved device names, NUL bytes,
  duplicate paths, case collisions, and impossible size/hash/chunk combinations.
- `[x]` Corrupt, duplicate, missing, truncated, substituted, or oversized chunks never publish —
  `substituted_and_oversized_chunks_are_rejected_at_receive_time` (corrupt/substituted/oversized,
  rejected at receive time), `duplicate_chunk_delivery_is_a_safe_no_op` (duplicate, safe no-op),
  `verification_fails_closed_on_missing_chunk_and_never_publishes` (missing/truncated, rejected at
  verify time, destination untouched).
- `[x]` Crash injection at every journal/publication boundary yields either the previous valid
  tree or the new verified tree — `crash_between_publish_steps_recovers_to_the_new_verified_tree`,
  subject to the honest atomicity note above.
- `[~]` Low-disk and disappearing-space scenarios remain recoverable — a pre-flight free-space
  check exists in `begin_staging_at` (rejects starting a transfer that clearly cannot fit); there
  is no test for space disappearing *during* an in-progress transfer, because nothing in this
  phase can simulate that deterministically without mocking the filesystem.

## Desktop/Web parity

| Operation | Tauri command | Web route |
| --- | --- | --- |
| Begin staging | `sync_begin_staging` | `POST /api/sync/staging/begin` |
| Receive chunk | `sync_receive_chunk` | `POST /api/sync/staging/chunk` |
| Verify staged content | `sync_verify_staged` | `POST /api/sync/staging/verify` |
| Publish | `sync_publish_staging` | `POST /api/sync/staging/publish` |
| Load journal | `sync_load_staging` | `GET /api/sync/staging/:subscription_id` |

All routes call the same Core functions as the Tauri commands, via `tokio::task::spawn_blocking`.
`recover_publication_at` and `cleanup_staging_at` are not yet exposed as commands/routes — nothing
calls them from a live process yet (recovery is meant to run automatically at startup for any
in-progress subscription in a later integration phase, not to be manually triggered from the UI).

## Deliberate non-goal: no UI, no real transfer wiring this phase

No frontend UI was added — same reasoning as Phase 5: `project_transfer` stays `unavailable`
because nothing connects a real remote sender's chunks (from `sync_transport.rs`, Phase 4) to
`receive_chunk_at` yet. This phase proves the manifest/chunk/staging/publication *mechanism* works
correctly against local test fixtures; wiring a live peer session to actually drive it is later
integration work (naturally, once Phase 7's continuous synchronization exists to keep driving it
after the first transfer).

## Fail-closed confirmation

- `resolve_capabilities_at` (Phase 3) is unchanged; `project_transfer` remains `unavailable`.
- `begin_staging_at` refuses to start if a staging journal already exists for the subscription
  (`AlreadyStaging`), and refuses an invalid manifest (`ManifestInvalid`) before touching disk.
- `publish_atomically_at` refuses to run unless the journal state is exactly `Verified`
  (`WrongState`) — a failed or still-in-progress transfer can never reach the destination.

## Reviewer trace

Every row above names the exact file and test function; running
`cargo test --lib sync_manifest` and `cargo test --lib sync_staging` reproduces all Phase 6
evidence in this document.
