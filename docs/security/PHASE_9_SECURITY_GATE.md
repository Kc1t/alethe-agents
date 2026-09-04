# Phase 9 Security Gate — Evidence Ledger

Status: **in progress**. Maps the Phase 9 requirements from
`docs/superpowers/plans/2026-08-21-security-gate-and-cloudflare-rendezvous-prompt.md` (§ Phase 9)
and `docs/superpowers/plans/2026-08-21-collaboration-implementation-blueprint.md` (§ Phase 9) to
implementation and test evidence. `resolve_capabilities_at` (Phase 3) is unchanged — `projectChat`
remains `unavailable`, because nothing wires a real remote collaborator's messages into this
module yet (that requires `sync_transport.rs`, Phase 4, to actually carry them between devices).
See `docs/adr/ADR-0006-chat-group-key-management.md` for the group key management decision the
blueprint explicitly asked to document before enabling groups.

| # | Requirement | Implementation | Authoritative test | Status | Unresolved risk |
| --- | --- | --- | --- | --- | --- |
| 9.1 | Evaluate MLS (RFC 9420), document the decision | `docs/adr/ADR-0006-chat-group-key-management.md` — per-epoch symmetric key wrapped per member via X25519 ECIES-style construction, MLS explicitly rejected for this phase's scope, documented as the upgrade path before production | N/A — a documentation deliverable | Done | None; the ADR is explicit about what this construction does *not* provide (TreeKEM ratcheting, logarithmic-cost membership updates, formally analyzed post-compromise security) |
| 9.2 | Direct conversations, project channels, private groups; category label organizes, never authorizes | `sync_chat.rs`: `ConversationKind` (`Direct`/`ProjectChannel`/`PrivateGroup`), `Conversation.category: Option<String>` used only for UI grouping — every authorization check reads `members`, never `category` | `non_member_cannot_send_a_message` (authorization goes through `members`, independent of `category`, which is never even set in that test) | Done | None found |
| 9.3 | Per-epoch group key, wrapped per member, membership change rotates the epoch, removed member excluded from future epochs | `create_conversation_at` (epoch 0), `add_member_at`/`remove_member_at` (both push a new `Epoch` with a fresh random key, rewrapped only for the post-change member list) | `removed_member_cannot_decrypt_new_epoch_messages_or_attachments` — proves the removed member (a) has no wrap entry at all in the new epoch, (b) cannot decrypt a message sent in the new epoch even attempting with their last legitimately-held (old-epoch) key | Done | Forward secrecy holds across epochs; post-compromise security within a single still-active epoch does not (documented in the ADR as an accepted, non-goal trade-off for this phase) |
| 9.4 | Message content types include a non-executing "Command" type for shared shell commands | `MessageContentType::Command` — a plain enum variant, stored and decrypted exactly like `Text`; no code path in `sync_chat.rs` (or anywhere else in this session's work) executes message content on receipt, preview, or any other trigger | N/A — provable by absence: `grep` for any executor call in this file finds none; nothing in this module has access to `pty::spawn` or any process-spawning API | Done | The *frontend* review-before-run UX for `Command`-typed messages is not built this phase (no UI yet — `projectChat` is `unavailable`), so the guarantee proven here is "the backend never executes it," not yet "the UI always shows a confirmation step" |
| 9.5 | Edit, delete (tombstone), react, read cursors, duplicate-delivery idempotency | `edit_message_at`, `delete_message_at` (sets `deleted: true`, keeps the record — a tombstone, not a hard delete), `react_to_message_at`, `mark_read_at`, `record_incoming_message_at` (no-ops on a repeated `message_id`) | `edit_and_delete_are_reversible_via_tombstone`, `reactions_and_read_cursors_are_tracked`, `duplicate_message_delivery_is_idempotent` | Done | Edit re-encrypts with the message's original nonce (derived from `epoch`+`sequence`, both immutable per message) — reusing a nonce for a *replacement* ciphertext under the same key is safe here because the old ciphertext is discarded, never both retained under the same nonce; documented so a future refactor that starts persisting edit history does not silently reintroduce a nonce-reuse bug |
| 9.6 | Attachments, independently keyed from message/epoch keys | `upload_attachment_at` generates a fresh random 256-bit key per attachment (not derived from any conversation epoch key), wraps it per current member the same way as an epoch key, records `declared_size`/`actual_size`/`content_hash` | `attachment_declared_size_mismatch_is_rejected`, and the removed-member test's attachment assertion (`current_epoch_wrap_for(&reloaded, "route-mallory").is_none()` after upload) | Done | Attachments are stored inline as encrypted bytes in the conversation's JSON document (`MAX_ATTACHMENT_BYTES` = 8 MiB local-fixture cap) — a real deployment should reuse Phase 6's chunked staging protocol for large files instead; documented as a known scaling limitation, not attempted this phase |

## Phase 9 proof checklist (from the security-gate prompt)

- `[x]` MLS evaluated and the decision documented — `docs/adr/ADR-0006-chat-group-key-management.md`.
- `[x]` Removing a member rotates the group key and the removed member cannot decrypt anything
  sent after removal — `removed_member_cannot_decrypt_new_epoch_messages_or_attachments`.
- `[x]` A newly added member does not retroactively gain history access — by construction, `add_member_at`
  only ever wraps the *new* epoch for the new member; no code path in this module ever wraps an
  older epoch for a member not present in that epoch's original `Epoch.wraps` list. (Not covered by
  a dedicated adversarial test this phase — recorded as an honest gap below.)
- `[x]` `Command`-typed messages are never auto-executed — true by construction; see 9.4 above.
- `[x]` Duplicate/out-of-order message delivery does not create duplicate entries —
  `duplicate_message_delivery_is_idempotent`.
- `[x]` Attachment keys are independent of message/epoch keys — see 9.6; `upload_attachment_at`
  never reads or derives from any `Epoch.wraps` value.
- `[ ]` Live delivery through a real second device / relay — not attempted this phase, consistent
  with `projectChat` staying `unavailable` (no phase before Phase 10B wires a live relay).

### Honest gap: no dedicated "new member cannot read old history" test

The "no retroactive history access" property above is true by construction (traced through the
code) but does not have its own test the way the removed-member exclusion does. Added to the
Phase 9 backlog rather than asserted as fully proven; the existing `members_can_decrypt_a_message_sent_in_the_current_epoch`
and `removed_member_cannot_decrypt_new_epoch_messages_or_attachments` tests together imply it (a
member added in epoch N only ever receives a wrap for epoch N onward), but neither directly
constructs a "new member tries to read a pre-join message" adversarial scenario.

## Desktop/Web parity

| Operation | Tauri command | Web route |
| --- | --- | --- |
| Create conversation | `sync_create_conversation` | `POST /api/sync/chat/conversations/create` |
| Get conversation | `sync_get_conversation` | `GET /api/sync/chat/conversations/get` |
| Add member | `sync_add_conversation_member` | `POST /api/sync/chat/conversations/add-member` |
| Remove member | `sync_remove_conversation_member` | `POST /api/sync/chat/conversations/remove-member` |
| List messages | `sync_list_messages` | `GET /api/sync/chat/messages` |
| React to message | `sync_react_to_message` | `POST /api/sync/chat/messages/react` |
| Mark read | `sync_mark_conversation_read` | `POST /api/sync/chat/conversations/mark-read` |

`send_message_at`, `decrypt_message`, `edit_message_at`, `delete_message_at`,
`upload_attachment_at`, and `decrypt_attachment` are Core functions with full test coverage but are
**deliberately not exposed** as Tauri commands or Web routes this phase. Every one of them needs an
already-unwrapped raw epoch or attachment key as an argument; a device's X25519 agreement private
key lives only in the OS keyring (`sync_security::agreement_secret_entry_id`, Phase 3) and this
phase does not wire a live command that retrieves it and performs the unwrap server-side. Exposing
a command that instead accepted raw key bytes from the frontend as a parameter would mean
transmitting live key material over Tauri IPC/HTTP, which is a materially different (and worse)
trust boundary than every other command in this codebase — deliberately not done. Wiring an
authenticated "unwrap using this device's stored secret, then encrypt/decrypt" command is exactly
the kind of live wiring this phase's `unavailable` capability gate defers, consistent with every
prior phase since Phase 4.

## Deliberate non-goal: no UI, no live cross-device wiring this phase

Same reasoning as every phase since Phase 5: `projectChat` stays `unavailable` because nothing
connects a real remote collaborator's messages to this module yet, and — per the parity note above
— even the local send/decrypt path is not yet reachable from a live command surface. This phase
proves the domain model, epoch rotation, and forward-exclusion property against local test fixtures
simulating multiple devices acting on the same local conversation store.

## Fail-closed confirmation

- `resolve_capabilities_at` (Phase 3) is unchanged; `projectChat` remains `unavailable`.
- A removed member has zero wrap entries for any epoch created after their removal — not a
  redacted or empty wrap, no entry at all — so there is nothing to attempt to decrypt, by
  construction rather than by a runtime permission check that could be bypassed.
- `send_message_at` rechecks current membership (`document.conversation.members`) fresh on every
  call before accepting a message, via `authorizer.check_trusted` plus the membership scan.

## Reviewer trace

Every row above names the exact file and test function; running `cargo test --lib sync_chat`
reproduces all Phase 9 evidence in this document.
