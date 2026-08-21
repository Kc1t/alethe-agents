# Phase 11 Security Gate — Notifications and Access Center

## Status

Local notification projection and categorized settings UI implemented; complete product coverage
remains pending.

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

## Remaining product coverage

The access-center schema supports the control-plane events introduced in Phase 10B. Device approval,
local invitation lifecycle, synchronization conflicts/failures, shared-task events, and chat mentions
still need to publish the same records from their domain modules. The Home view currently renders the
generic notification history; a dedicated categorized access-center view with dismiss/defer/deep-link
publishers plus domain-specific retry and deep-link controls are still required before Phase 11 can
be marked complete.
