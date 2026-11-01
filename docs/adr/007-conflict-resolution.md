# 007 — Conflicts are resolved in an ephemeral merge environment

**Status:** Accepted (Merge Center UI removed in 1.6.0; the backend remains) ·
**Code:** `src-tauri/src/conflict_resolution.rs`

## Context

After the analyzer ([006](006-merge-analyzer.md)) finds a conflict, an agent resolves it. That agent
must not damage the user's branch, widen its scope, or leave conflict markers behind.

## Decision

- Provision an ephemeral worktree (`alethe/merge-<id>`) with the real merge applied, conflict
  markers included, plus a minimal prompt file (`ALETHE_CONFLICT.md`).
- The agent is ephemeral and provider-agnostic: the frontend spawns the configured CLI with
  `cwd` set to the environment. It never decides whether a conflict exists and never implements
  features; the prompt locks its scope.
- `merge_finalize` is the gate: no marker may remain, the validation pipeline (`validation.rs`)
  must pass, and only then does it commit and integrate with `--ff-only`, so the user's branch only
  ever advances cleanly.
- `merge_abort` destroys the environment without a trace.
- Cycle metadata lives outside the worktree (`merge-envs/<id>.json`) so it never enters the merge
  commit; the prompt file is removed before committing.

## Consequences

- A failed or abandoned resolution costs nothing but a deleted directory.
- Integration is always a fast-forward, so history stays linear and reviewable.
