# Phase 11 Security Gate — Notifications and Access Center

## Status

Complete. Local notification projection, all six domain publishers (device approval, invitation
redemption, sync conflicts, task assignment, chat mentions, terminal staging-transfer failure), and
a dedicated categorized access-center view (`CollaborationSettings.tsx`) with read/defer/dismiss
actions are all implemented and localized (English + Portuguese). Domain-specific deep links (e.g.
"open this device's approval screen" instead of only the generic settings view) remain a possible
future enhancement, not a blocker — every action already re-validates current state via
`resolve_action_at` before doing anything.

`sync_access.rs` persists a bounded, atomic, profile-local access-center document. Records contain
only an event category, stable kind, opaque subject/action handles, unread/dismiss/defer state, and
timestamps. They contain no project name, path, bearer, ciphertext, task content, or chat text.

Remote rendezvous deliveries create a deduplicated access record before the UI is notified. The
frontend polls unread records, uses localized generic notification text, awaits native delivery,
falls back to the in-app notification history, and marks the record read only after delivery. A
record may be dismissed or deferred for at most 30 days.

Action handles are navigation hints, not capabilities. Resolving one re-reads the current document
and rejects dismissed, deferred, missing, or otherwise stale handles. No notification action can
accept an invitation, restore a grant, execute a command, or mutate project content.

## Evidence

- Persistence uses create-new temporary file, flush, fsync, and atomic replacement.
- The store is capped at 512 records and deduplicates a repeated event.
- Tests prove private-content field names are absent from serialized records.
- Tests prove dismissed and deferred actions fail current-state resolution.
- Native notification errors fall back to the existing in-app history.

## Domain publishers

Five domain modules now call `sync_access::record_at` directly, each with a dedicated test proving
the record's category/kind/subject handle and that publishing failure never fails the primary
operation it accompanies (every call site uses `let _ = ...`, since a notification is a side effect,
not a precondition):

| Domain event | Module / function | `AccessKind` | `AccessCategory` | Subject handle | Test |
| --- | --- | --- | --- | --- | --- |
| A new device registers and needs approval (not the account's first device) | `sync_security::complete_verified_identity` | `DevicePendingApproval` | `Security` | device ID | `a_second_pending_device_publishes_an_access_center_record_but_the_first_does_not` |
| A locally-issued invitation is redeemed | `sync_security::redeem_invitation` | `InvitationRedeemed` | `Collaboration` | invitation ID | `redeeming_an_invitation_publishes_an_access_center_record` |
| A continuous-sync operation diverges and a conflict is recorded | `sync_engine::apply_remote_operation_at` | `SyncConflict` | `Collaboration` | conflict ID | `diverged_base_revision_records_a_conflict_and_applies_neither_side` (extended) |
| A task is assigned | `sync_tasks::assign_task_at` | `TaskAssigned` | `Collaboration` | task ID | `assigning_a_task_publishes_an_access_center_record` |
| A chat message has at least one mention | `sync_chat::send_message_at` | `ChatMention` | `Collaboration` | message ID | `members_can_decrypt_a_message_sent_in_the_current_epoch` (extended) + `a_message_with_no_mentions_publishes_no_access_center_record` (negative case) |
| A staged transfer fails terminal verification (missing/corrupt chunk) | `sync_staging::verify_staged_at` | `TransferFailure` | `Collaboration` | subscription ID | `verification_failure_publishes_an_access_center_record` |

The terminal-vs-transient distinction for staging failures was decided explicitly: only
`verify_staged_at`'s `JournalState::Failed` transition (a missing or corrupt chunk — nothing local
can recover it, the recipient must re-request the transfer) publishes a record. A publish-step I/O
failure inside `do_publish_steps` does **not** publish one, because that state is resumable via
`recover_publication_at` on the next call rather than a state requiring user action — publishing a
notification for a condition the system already self-heals from would be a false alarm.

## UI coverage

`src/components/modals/preferences/CollaborationSettings.tsx` already contained a dedicated,
categorized access-center list (grouped display, unread highlighting, read/defer/dismiss actions
wired to `syncAccessUpdate`) — it was more complete than this gate's prior revision credited. What
was actually missing was localization coverage: the six new `AccessKind` variants added by the
domain publishers above had no `collaboration.access.kind.*` translation key, so they would have
rendered as raw i18n key fallbacks. Added all six keys (title + native-notification title/body) to
both `en.ts` and `pt-BR.ts`, and extended `useCollaborationAccess.ts`'s native-notification text
selector (`textFor`) to cover every new kind explicitly instead of falling through to the generic
"provider needs attention" text. `npm run build` (which fails the build on any i18n key present in
`en.ts` but missing from `pt-BR.ts`) passes, confirming full bilingual coverage.

Remaining, explicitly non-blocking: domain-specific deep links (e.g. "open this device's approval
screen" instead of the generic collaboration settings panel) are not implemented — every action
handle still only supports read/defer/dismiss, re-validated fresh via `resolve_action_at` before
anything happens. This is a UX enhancement opportunity, not a gap in the phase's required scope.
