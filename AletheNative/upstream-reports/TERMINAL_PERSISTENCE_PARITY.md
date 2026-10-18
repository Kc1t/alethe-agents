# Terminal persistence parity (x3)

Reference: `origin/main`, read without checkout. No terminal rendering or presentation changes.

| Web behavior / source | Native state |
| --- | --- |
| Pane layout, cwd, extra arguments and session ID (`terminalFactory.ts`, `sessionResume.ts`) | Existing versioned workspace document and atomic document store; unchanged schema. |
| Claude transcript and Codex rollout discovery (`sessionDiscovery.ts`, `useXtermSession.ts`) | Existing `ClaudeSessions` / `CodexSessions`; continuous reconciliation added through `SessionWatch`. Rollout fixtures exercise directory filtering and switching back to an existing file. |
| Latest conversation after `/new`, `/clear`, `/resume` (`claudeSessionTracking.ts`, `sessionWatch.ts`) | Existing pane-specific Claude hooks remain authoritative. Continuous polling now follows unambiguous file changes for Claude, Codex, OpenCode and Antigravity. Adoption uses `TerminalRegistry.apply` to update its claims and flushes the workspace immediately. |
| Multiple panes sharing an agent and cwd (`sessionDiscovery.test.ts`) | File reconciliation refuses to infer ownership while another matching pane runs. Claude hooks still identify panes. File timestamps alone cannot guarantee the owner's ALWAYS-last-conversation requirement for other agents, external CLI processes, or switches that never write a session file. |
| Shell cwd tracking (`tauri/pty.ts`: `getPtyCwd`) | Running shell panes now persist OSC 7 reports, falling back to `proc_pidinfo(PROC_PIDVNODEPATHINFO)` for shells without integration. No global keyboard automation. |
| Bounded disk scrollback and replay (`tauri/pty.ts`, `useXtermSession.ts`) | Existing per-tab raw files remain readable. Compaction/load now select UTF-8 and ANSI parser boundaries; pending data survives failed opens/writes and is bounded. Existing query stripping and mode-reset replay remain intact. |
| Prompt limits and cleanup (`XTermView/terminalWrite.ts`, `.test.ts`) | Existing 50-entry recall preserved; 4096-unit limit now uses UTF-16 like JavaScript. Loaded entries are sanitized; canceled input is discarded; literal reverse-search API added. |
| Agent resume flags and MCP preservation (`sessionLaunch.ts`, `paneResume.test.ts`) | Existing `AgentArguments`, `AgentLauncher` and restart wiring retained. No changes to conversation sheets. |
| Reset last session (`resetLastSession.ts`) | Existing `SessionResume.previous` retains newest-other-session selection with prelaunch-date preference; live reset remains in `TerminalRegistry`. |
| Inactive terminal lifetime (`terminalLifecycle.ts`, `ptyVisibility.ts`) | Existing registry-owned processes outlive detached views. Polling uses all running terminals, including hidden tabs. |
| Windows/WSL launch targeting (`ptyLaunchTarget.ts`) | Windows/WSL transport is not portable to macOS; native continues to use a local PTY and libghostty. |

## Integration gaps requiring files outside the assigned ownership

- `TerminalRegistry.swift`: explicit close deletes scrollback. Agent relaunch clears saved output.
  Its one-shot discovery task can race continuous reconciliation. Quit/close need a final synchronous
  cwd/session capture; a two-second poll cannot guarantee capturing a last-moment switch.
- `ShellLaunch.swift`: still selects the account-database shell without `$SHELL` precedence, does
  not explicitly add interactive flags, preserves a non-UTF-8 LANG, does not normalize LC_ALL or
  guarantee Homebrew/user PATH entries, and does not use the new missing-directory fallback.
- `TerminalPaneView.swift` / input routing: reverse search is exposed as a logic API but Ctrl+R is
  not connected to it. Existing history is per tab, rather than shared per project.
- Cursor, Grok and Codewhale do not have continuous native session readers here. Their CLI/storage
  support needs further work; the ALWAYS requirement is not met for all agents.
- The bootstrap currently lives in the assigned `AiMemoryController.start` entry point and runs
  independently of its optional MCP feature. Moving lifecycle ownership into the terminal registry
  would be preferable once that file is in scope.

## Validation and handoff memory

- `python3 AletheNative/Scripts/check-strings.py`: passed.
- `git diff --check`: passed before documentation update.
- Added Swift tests for repeated session switches, hook precedence, ambiguity, claimed IDs, temporary
  Codex rollout files, Unicode/ANSI truncation, disk failure recovery, loaded history cleanup,
  cancellation, literal reverse search, and a real `/bin/sh` PTY changing cwd.
- Swift tests/build were not executed: the task explicitly prohibits sandbox builds. The reviewer
  must compile and run AletheKit tests outside the sandbox; PTY behavior remains unverified until then.
- No user-facing strings, UI metrics/colors, accessibility identifiers, model schema, Ghostty backend,
  native `.mac` presentation, or shared component file changed.
- No ai-memory skill or callable ai-memory service is available in this session. This handoff records
  decisions, limitations and next steps in the existing versioned reports directory; it is not an
  assertion that an external ai-memory graph was updated.
- Changes are unstaged. No commit, push, app restart, or development-server restart.
