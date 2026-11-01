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

New record: copy the shape of an existing one (Context, Decision, Consequences), take the next free
number, and cite it from the code it governs.
