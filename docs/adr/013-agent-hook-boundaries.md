# ADR-013: Bound hook requests and settings to their intended scope

Status: accepted

## Context

The local agent listener carries a per-process token. Main already writes Claude settings
privately, but each planner and voice/orchestrator variant has its own file. Prefix routing and
an implicit hook fallback accept unintended request targets. Logging selected payload fields
still exposes untrusted content, even when tool inputs are omitted.

## Decision

Validate POST and exact route names at one request boundary before authentication or body
handling. Keep the existing MCP, spawn, Codex, OpenCode and hook handlers behind that boundary.
Log only the received byte count for hook payloads, with no event names, tool names or agent ids.
Track successfully written Claude settings paths under a process-local mutex. On ExitRequested
and Exit, stop further settings writes and remove only those tracked files, retrying failures
at the later exit event. Keep main's permission release, voice hooks and Codex configuration.

## Alternatives rejected

- Prefix matching or falling back to hooks lets unrelated paths trigger handlers.
- Redacting only known sensitive events misses session prompts, future events and metadata.
- Keeping one settings path misses files belonging to other planners or hook variants.
- Scanning or deleting the runtime directory risks other app instances' files; on Windows the
  existing directory is the user's shared temporary folder.

## Consequences

Clients must send POST to an exact supported path, without trailing slashes or query suffixes.
Authentication remains mandatory. Logs retain request size and fixed failure messages, reducing
content available for debugging. Cleanup is idempotent and cannot race a late tracked write.
Abnormal process termination can still leave settings files behind. This change does not alter
persisted workspace data or remove Codex's install-scoped forwarding scripts.

## Source references

- Route validation: [hook_route](../../src-tauri/src/agent_events.rs#L1077).
- Request boundary: [accept_hook_request](../../src-tauri/src/agent_events.rs#L1091).
- Redacted diagnostics: [hook_log_line](../../src-tauri/src/agent_events.rs#L214).
- Settings ownership: [HookSettingsFiles](../../src-tauri/src/agent_events.rs#L480).
- Settings writer: [agent_hooks_settings_path](../../src-tauri/src/agent_events.rs#L528).
- Exit cleanup: [cleanup_settings_files](../../src-tauri/src/agent_events.rs#L517) and
  [run event handling](../../src-tauri/src/lib.rs#L759).
