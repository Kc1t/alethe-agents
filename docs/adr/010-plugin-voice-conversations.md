# ADR-010: Host support for external voice conversations on plugin API 3

Status: Accepted

## Context

The conversation UI is moving to the external `alethe.voice` plugin. The host owns terminal sessions
in `terminalSessions` (`src/lib/plugins/terminals.ts:82`), Claude launch settings in
`claudeLaunchExtras` (`src/lib/claudeMcpConfigs.ts:54`), permission decisions in
`agent_permission_decide` (`src-tauri/src/agent_events.rs:416`), and transcript snapshots in
`agent_transcript_snapshot` (`src-tauri/src/handoff.rs:711`). Plugins need these behaviors without
reimplementing terminal internals or receiving PTY identifiers.

## Decision

Extend API 3 additively through `createPluginTerminals` (`src/lib/plugins/terminals.ts:140`),
`createPluginAgents` (`src/lib/plugins/agents.ts:28`), and `createPluginVoice`
(`src/lib/plugins/voice.ts:9`). Require capabilities before session lookup, listeners, or commands;
retain tracked subscription ownership in `createContext` (`src/lib/plugins/host.ts:119`).
Use opaque session ids for terminal operations and agent hooks.

Keep safe submission inside the mounted terminal, where rendered choice prompts, bracketed-paste
mode, and completion monitoring are available. Share the existing pane restart/resume behavior
through `restartAgentTab` (`src/lib/agentTabRestart.ts:13`).

Separate observation (`agent.observe`), permission decisions (`agent.approve`), restarts
(`terminal.restart`), and conversation hooks (`voice.converse`). Target selection also requires
approval capability because `voice_set_targets` (`src-tauri/src/agent_events.rs:428`) causes Rust
to hold permission requests. Trust labels plainly describe observation and approval.

Use transient per-plugin hook holds so new Claude launches carry the voice flag while any plugin
requests it. Existing processes require an explicit restart; a toggle never restarts them.
Appearance and keybinding holds need no capability. `ContributedSettings`
(`src/components/modals/preferences/ContributedSettings.tsx:7`) filters settings by page, retaining
Integrations as the default and placing Voice contributions beneath core Voice content.

## Alternatives rejected

- Importing the conversation UI or controller into core defeats the external plugin boundary.
- Raw PTY writes cannot inspect the mounted screen or safely arm prompt completion.
- Copying transcript parsing, permission handling, or resume logic duplicates host behavior.
- Persisting the hook switch leaves hooks enabled after a plugin is disabled or removed.
- Bumping the API version breaks the agreed additive API 3 scope.

## Consequences

Plugins must feature-detect these additions on older API 3 hosts. Observation and approval remain
separate powers. Hook flags and shortcut holds are released on failed activation or deactivation;
shared target cleanup releases held prompts. Voice targets, playback, and HUD state remain app-wide
resources whose writers must coordinate. No persisted or synced schema changes occur.

Screen guards recognize known CLI approval and startup menus, not arbitrary third-party TUI
semantics. Mounted screen reads and safe submission use the web terminal; the Swift Mac app hosts
no web plugins. Live Tauri interaction and external plugin compatibility remain unverified in
this environment.
