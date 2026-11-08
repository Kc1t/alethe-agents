# Architecture decision records

Short records of decisions that shape the codebase. Source comments cite them by number
(`RFC-003` in `worktrees.rs`, for example). Numbers follow those existing references, so gaps are
expected.

| # | Decision | Status |
|---|---|---|
| [003](003-worktree-manager.md) | Per-agent isolation with two worktree modes | Accepted |
| [004](004-graphify-integration.md) | Graphify stays an external tool that Alethe manages | Accepted |
| [006](006-merge-analyzer.md) | The app, not the agent, decides whether a merge conflicts | Accepted |
| [007](007-conflict-resolution.md) | Conflicts are resolved in an ephemeral merge environment | Accepted |
| [008](008-plugin-voice-api.md) | Plugins use typed core voice services without owning provider keys | Accepted |
| [009](009-voice-resource-preferences.md) | Voice keys, servers and models are managed in core Preferences | Accepted |
| [010](010-plugin-voice-conversations.md) | External voice conversations use capability-gated host services on API 3 | Accepted |
| [011](011-core-voice-hud-renderer.md) | The core renders the floating HUD while plugins control conversations | Accepted |
| [012](012-bounded-ai-memory-version-probes.md) | Bound ai-memory version probes before agent launch and detection | Accepted |
| [013](013-agent-hook-boundaries.md) | Exact hook request boundaries, redacted logs and process-owned settings cleanup | Accepted |

New record: copy the shape of an existing one (Context, Decision, Consequences), take the next free
number, and cite it from the code it governs.
