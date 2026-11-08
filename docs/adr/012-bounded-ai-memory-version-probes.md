# ADR-012: Bound ai-memory version probes

Status: accepted

## Context

ai-memory 3.x needs a token-aware stdio bridge, while 2.x keeps HTTP registration.
Choosing the transport runs the installed binary before an agent terminal launches.
An unresponsive version command must not block terminal launch or Preferences detection.

## Decision

Give each version probe a three-second deadline. Drain at most 4 KiB of stdout on a reader
thread while polling process completion, then kill and reap the child on timeout. Use this
probe for both transport selection and Preferences detection. Retain the per-command version
cache and the existing HTTP fallback when the version cannot be determined.

## Alternatives rejected

- An unbounded process output call can leave a terminal launch waiting forever.
- Timing out only the stdout read misses a process that closes stdout but keeps running.

## Consequences

A hung binary delays the caller by about three seconds before cleanup. Timeout and nonzero exit
are treated as detection failure. Successful detection still reports an installed binary when
its version output is empty. The 3.x bridge keeps the managed store path in generated MCP
configuration; user-facing preferences and synced workspace schemas do not change.

## Source references

- Version probe and deadline: [src-tauri/src/ai_memory.rs:169](../../src-tauri/src/ai_memory.rs#L169).
- Process completion and cleanup: [src-tauri/src/ai_memory.rs:180](../../src-tauri/src/ai_memory.rs#L180).
- Preferences detection: [src-tauri/src/ai_memory.rs:329](../../src-tauri/src/ai_memory.rs#L329).
