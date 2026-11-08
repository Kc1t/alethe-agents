# ADR-014: Restore pane scroll after replay and live output

Status: accepted

## Context

Main catches up hidden panes from their missed output before falling back to a full replay.
PR #322 adds text anchors and cleanup of terminal modes left by dead TUIs. During fallback
replay, live bytes can arrive before xterm finishes parsing the history. Restoring the anchor
or resetting modes before those bytes are parsed can immediately undo the restoration.

## Decision

Keep the incremental catch-up path and initial-attach replay behavior. During fallback replay,
hold incoming live bytes until the replay has been parsed, then drain them through the existing
write queue. Only then reset dead-session modes and restore the text anchor, or follow the
bottom when the reader was already there. On a failed replay fetch, release captured live output
without clearing the current screen.

## Alternatives rejected

- Replaying on every reveal discards main's incremental catch-up behavior and redraws old frames.
- Restoring in the replay callback alone runs before queued live bytes have been parsed.
- Always scrolling to the bottom loses the reader's position.

## Consequences

Initial attach still follows output. Fallback replay preserves reading position after both
history and live data drain. Dead TUIs release their modes after their final output is parsed.
The renderer preference retains the PR's additive boolean migration and defaults.

## Source references

- `const doResync`: [src/components/XTermView/useXtermSession.ts:975](../../src/components/XTermView/useXtermSession.ts#L975).
- `const catchUpHiddenOutput`: [src/components/XTermView/useXtermSession.ts:1007](../../src/components/XTermView/useXtermSession.ts#L1007).
- `const afterQueuedWrites`: [src/components/XTermView/useXtermSession.ts:541](../../src/components/XTermView/useXtermSession.ts#L541).
- `claudeFullscreen`: [src/stores/projectsStore.migrations.ts:265](../../src/stores/projectsStore.migrations.ts#L265).
- `claudeFullscreen: false`: [src/lib/types.ts:1108](../../src/lib/types.ts#L1108).
