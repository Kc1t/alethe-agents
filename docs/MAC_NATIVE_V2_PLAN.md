# Alethe for macOS — native rewrite plan (v2)

> Status: **Phases 0–7 implemented** (2026-09-26). Phases 0–3 tested (last run after P3-18: package
> 336/336, UI 67/67, smoke scripts pass). Phase 4 round 1 ran the package suite (498 green); Phase 4
> round 2 and all of Phases 5, 6 and 7 were compiled only (owner decision) — see **Test debt** below.
> Next: Phase 8 (Release). Before it: clear the test debt. Branch: `mac-native-v2` (created from
> `origin/main` @ `75083e2`, v1.7.0).
>
> **Published 2026-09-26** to the fork `HayatoG/alethe-agents` (`fork/mac-native-v2`); the PR to
> `Kc1t:main` is opened manually by the owner. Workflow and pre-push scan: [`FORK_WORKFLOW.md`](FORK_WORKFLOW.md).
>
> **Package suite run 2026-09-26: 1680/1680 green in one run** (17 targets). Fixes it forced: terminals
> spawn with `posix_spawn` instead of `forkpty` (fork deadlocked the multithreaded app in atfork
> handlers — `cae8ca9`), `PlanningGate`/`GraphifyRepository.repositoryRoot` looped forever outside a
> repository (`6834e1c`, `75b5bf8`), `ExternalCommand` no longer blocks the cooperative pool
> (`3a50cb3`), 9router plain paths/PWD (`365d2dc`), health-probe pipe close-on-exec (`6a23199`), and
> racy/wrong test expectations. The package items below are now cleared; UI, performance and manual
> items remain.
>
> **UI suite run 2026-09-26 (`Scripts/uitest.sh`): 124 passed, 35 failed** (smoke scripts not reached).
> Failing groups: Settings controls off screen at some zoom levels (Agents, Appearance, Data, Discord,
> Toolbar — the 720-wide Settings window / longer panes); app icon not restored after relaunch; menu
> queries matching both the project context menu and the History menu (Git Control, Merge Center —
> test-side); seeded jobs/`task.md` not loaded (Orchestrator Apply/Board/Worker actions, Multiagent,
> GSD Sync); board zoom buttons; Graphify two Cancel buttons; MCP manager; onboarding skip not
> remembered; Profiles create/rename/delete; 9router pill/settings with a stub install; terminal find
> bar; Todos; Worktrees; ExtensionKit sample not discovered (dev-signed; expected). Result bundle:
> `AletheNative/build/UITests-*.xcresult`. Owner's manual checklist lives in the Claude doc
> "Alethe nativo — testes que falharam e checagens manuais".
>
> **Test debt (2026-09-25).** Written and compiled, never run:
> - Package suite (`swift test`): new or changed tests since `b8f5ab7` in AletheIntegrationsTests (19
>   files), AletheModelTests (13), AletheFoundationTests (5), AletheMergeTests (4), AletheAgentsTests (2),
>   AletheGitTests (2), AletheTodosTests (2), AletheGitControlTests (1), AletheExtensionHostTests (1).
> - UI (`Scripts/uitest.sh`, not run since the P3 review): AgentLibrary, Appearance, CLIOpen,
>   CrashNotice, DataSettings, ExtensionKit, FeatureToggles, GitControl, GraphifyView, GSDSync,
>   McpManager, MergeCenter, Onboarding, OpenIn, Profiles, ProjectClone, ProjectSettings, SkillsBrowser,
>   Todos, ToolbarSettings, Worktrees — plus every earlier UI test, and the three smoke scripts.
> - Phase 6 (all compiled, never run): AletheOrchestratorTests (job model, store, workers, Codex and
>   Claude protocols, core goldens from `tests/orchestrator.rs`, follow-ups, fitness, board, scheduler,
>   helper), AletheFoundation event bus, AletheIntegrations planning audit, AletheMerge worktree apply,
>   UI OrchestratorEntry/Board/WorkerActions/Apply/Quota and MultiagentSettings.
> - Phase 7 (all compiled, never run): AletheRemoteTests (hub, transport, API, client bundle, sharing,
>   bridge, service, security checklist), Keychain/peripheral model, Discord IPC, 9router, Spotify, gist
>   sync, Now Playing; UI PeripheralSlots, Discord, NowPlaying, GistSync, Router9/Router9Routing,
>   RemoteControl, RemoteSettings, RemotePairing, RemoteEndToEnd.
> - Performance: GraphLayout at 3000 nodes (P5-23); board with 100 workers (P6-14); worker spawn (P6-3).
> - Manual (cannot be automated): dictation with a real microphone (P3-17), prompt redraw after resize
>   (P2-3), image paste and drops (P2-5), hibernation and resume (P2-24), a real ExtensionKit extension
>   loading and a contained crash (P4-19), profile switch / import / reset / erase relaunches (P5-9,
>   P5-10), `alethe .` cold and warm (P5-8), a real Claude Code and Codex orchestration run (P6), real Spotify/Discord/9router/GitHub
>   sync and a phone paired over LAN and Tailscale (P7), the owner's pass over
>   all Phase 4, 5 and 6 UI.
> - Known: a rare `AletheTerminalTests` hang (1-minute limit, root cause open); the workspace tab close
>   button's accessibility frame is off screen.
> This branch never merges into `main` or any release branch, and no PR targets them. The native app
> will later move to its own repository (see §9.4).

## 1. Executive summary

The first native attempt (`AletheMac/`, branch `mac-native`) proved that a native Alethe is viable, but
it bound itself to the Tauri codebase: one Rust crate compiled two ways (294 `cfg(feature)` gates),
61 ad-hoc `*_json` UniFFI wrappers, and three generators that re-derived themes, strings and
migrations from React sources. Every upstream merge became a porting project, and parity fell to
30 done / 15 open plus 11 new upstream features mostly absent.

v2 is a **separate macOS product**, written **entirely in Swift**, that uses the Tauri app at
`origin/main` as a **behavioral specification**, not as shared code.

| Decision | Choice |
|---|---|
| Relationship to the Tauri app | Independent product, independent data; optional one-shot, read-only import of `projects.json` v9 |
| Core logic | Ported to Swift services per domain (no Rust, no FFI) |
| Terminal | libghostty in `HOST_MANAGED` I/O mode (renderer + input) with a Swift-owned PTY host |
| UI | SwiftUI app shell + AppKit workspace pane host |
| Minimum OS | macOS 26 Tahoe; macOS 27 APIs behind `#available` |
| Plugins | Native Swift plugin API from day one; Git, Todos and Theme-pack are built on it |
| v1 scope | Full parity, including Orchestrator v2, Remote control, Spotify/Discord/9router, Graphify/ai-memory/GSD |
| Distribution | Outside the App Sandbox; Developer ID + notarization + Sparkle once the account exists |

Execution runs in 9 phases (§7). Phase 0 is a gated foundation + terminal spike; Phase 1 ships a
usable vertical skeleton; Phases 2–7 reach parity; Phase 8 is release engineering and extraction to
the new repository.

## 2. Source of truth and feature inventory

- **Reference:** `origin/main` @ `75083e2` (tag `v1.7.0`, 2026-09-20, plus README/CI commits). Recorded
  in `AletheNative/UPSTREAM_BASELINE` in Phase 0.
- **Size:** 290 commands in `src-tauri/src/lib.rs` `invoke_handler` across ~80 Rust modules; 13 Zustand
  stores (only `projectsStore` persists, to `projects.json` **v9**); ~110 user-facing features.
- `docs/FEATURES.md` lags the code (it lists 4 agents; the code has 11) — the matrix in §8 is built from
  the code, not from that file.

### 2.1 Persistence at upstream (the import contract)

- Root: `app_local_data_dir()`; `profiles.json` (`ProfilesIndex { version: 1 }`); per-profile folder
  `profiles/<id>/`.
- Per profile: `projects.json` (v9, migrations v2→v9 in `src/stores/projectsStore.migrations.ts`),
  `scrollback/<ptyId>.bin` (4 MiB cap), `activity-stats.json`, `orchestrator-jobs.json`, `spawn.log`,
  `spotify_tokens.json`, `github_sync.json`, `handoffs/`, `speech-models/`, `mcp/backups/`,
  `plugins/<id>/`, `plugin-data/<id>`, `plugins/state.json`.
- `projects.json` v9 top level: `version, groups, ungroupedOrder, projects, todos, activeProjectId,
  workspace{…}, preferences (~80 keys), cliPaths`. `Project`, `Terminal` (kinds: terminal, markdown,
  file, image, video, web, graphify, diff, orchestrator), `SubTab` and `Group` shapes are described in
  `src/lib/types.ts`.
- External files the app edits: `~/.claude.json`, `~/.claude/{agents,skills,projects}`,
  `~/.codex/config.toml` (comment-preserving), `~/.codex/sessions`, `opencode.json`, `.opencode/plugins`,
  `~/.cursor/mcp.json`, `~/.gemini`, `~/.agents`, and `.alethe/` inside repos.

### 2.2 Inventory by area

Each row: feature — upstream source (components/stores/libs) — commands — persisted data. Full IDs are
used in the parity matrix (§8).

**Home (HOME)**
- HOME-1 Dashboard (greeting, recent projects, quick actions, ASCII background) — `HomeView/index.tsx`,
  `ui/ascii-effect.tsx`, `lib/greeting.ts` — — — `preferences.alwaysStartOnHome`, `motionPreference`.
- HOME-2 Mini-terminal quick launch — `HomeView` → `createAgentTerminal` — `spawn_pty` — terminals.
- HOME-3 Activity graph / time analytics / usage strip — `ActivityGraph.tsx`, `TimeAnalytics.tsx`,
  `UsageStrip.tsx` — `get_activity_summary`, `get_multi_agent_activity` — `activity-stats.json`.
- HOME-4 Setup walkthrough — `SetupWalkthrough.tsx` — — — `preferences.setupWalkthrough*`.
- HOME-5 Notifications list — `uiStore.notifications` — — — memory.

**Workspace, panes and layouts (WS)**
- WS-1 Project containers (open many, collapse, fullscreen, reorder) — `WorkspaceView/*` —
  — — `workspace.containers`, `fullscreenContainerId`, `isolatedPaneId`.
- WS-2 Flat mode — `MainMenu` — — — `preferences.workspaceFlat`.
- WS-3 Layouts Auto/Spotlight/Sidebar/Custom grid — `lib/gridLayout.ts`, `lib/layoutPresets.ts`,
  `LayoutDesignerModal`, `GridCellHandles`, `useGridCellDrag`, `LayoutFooter` — — — `layoutMode`,
  `gridLayout`, `gridLayoutHistory` (project/group/workspace).
- WS-4 Named project grids (1.7) — `lib/projectGrids.ts`, `ProjectGrids.tsx`, `ProjectGridModal` — — —
  `project.grids`, `activeGridId`, `terminal.gridId`.
- WS-5 Workspace tabs, closed tabs, history (Ctrl+Tab, Alt+arrows) — `lib/workspaceNavigation.ts` — — —
  `workspace.tabs/closedTabs/history`.
- WS-6 Markdown pane — `MarkdownPane` — `read_text_file`, `write_text_file`, `watch_file` — file.
- WS-7 Image pane / WS-8 Video pane — `ImagePane`, `VideoPane` — — — `terminal.filePath`.
- WS-9 Diff pane — `DiffPane` — `git_diff` — —.
- WS-10 Focus mode — `FocusOverlay` — — — —.
- WS-11 Add content modal — `AddContentModal` — — — —.
- WS-12 Link viewer overlay — `LinkViewerOverlay` — `read_text_file`, `open_in_browser` — —.
- WS-13 Empty workspace launcher — `WorkspaceEmptyState.tsx` — — — —.
- WS-14 Disable terminal/project, suspend group — projectsStore slices — `suspend_pty` —
  `terminal.disabled`, `group.suspended`.

**Terminal (TERM)**
- TERM-1 Real PTYs (spawn/attach/write/resize/restart/kill, process tree) — `XTermView/useXtermSession.ts`,
  `TerminalPane`, `lib/terminalFactory.ts`, `terminalLifecycle.ts`, `spawnQueue.ts`, `mountQueue.ts` —
  15 `pty_*` commands + `get_pty_tree_info`, `kill_pty_tree_cmd` — `scrollback/*.bin`.
- TERM-2 Sub-tabs lane — `SubTabsLane`, `NewSubTabModal` — — — `terminal.tabs`, `laneVisible`.
- TERM-3 Search in terminal — `SearchAddon` — — — —.
- TERM-4 Smart copy/paste (text, images, files) — `read_clipboard_payload`, `write_clipboard_text` — —.
- TERM-5 Prompt history (Ctrl+↑/↓) — XTermView — — — localStorage `prompt-history:<ptyId>`.
- TERM-6 Clickable file/URL/image links (open in grid or browser pane) — `terminalLinks.ts` — — —.
- TERM-7 Terminal themes, font, unicode11 — `xtermThemes.ts`, `lib/themeTokens.ts` — — —
  `preferences.terminalTheme`.
- TERM-8 Restart overlay + "command not found" overlay — `TerminalPane` — `restart_pty` — —.
- TERM-9 Double Ctrl+C force-kill — `useXtermSession.ts` — `kill_pty` — —.
- TERM-10 Scrollback persistence + reattach — `pty.rs` — `attach_pty`, `clear_pty_scrollback` —
  `scrollback/*.bin`.
- TERM-11 `alethe` CLI shim (open a folder in the running app) — `lib/cliOpen.ts`,
  `useCliOpenRequests.ts` — `cli_shim_*`, `cli_take_pending_open` — —.

**Sidebar, projects and groups (SB)**
- SB-1 Project tree (groups, subgroups, projects, terminals), Normal and Clean styles —
  `ProjectSidebar/*`, `lib/sidebarDrag.ts` — — — groups, projects, `ungroupedOrder`.
- SB-2 New/edit project (clone from GitHub, restore from `.alethe/project.json`, git init, worktree
  settings, stack detection) — `NewProjectModal`, `EditProjectModal`, `EditProjectAgentSettings` —
  `clone_github_repo`, `read/write_project_marker`, `git_init`, `detect_project_stack`,
  `git_list_branches`, `worktree_*`, `discover_provider_models` — project fields.
- SB-3 Groups (new/edit/suspend, nested) — `NewGroupModal`, `EditGroupModal`, `SuspendGroupModal` —
  — — groups.
- SB-4 Export/import project config — `sidebarMenus.tsx` — `read/write_text_file` — file.
- SB-5 Live chat title + busy/done glyph — `useSidebarChatTitle.ts`, `agentCompletionMonitor.ts` —
  `get_claude_session_title`, `get_codex_session_title` — `SubTab.completionUnread`.
- SB-6 Open in VS Code / Finder / browser — `open_in_vscode`, `open_in_file_explorer`, `open_in_browser`.
- SB-7 Right sidebar (markdown docs/plans, GSD, MCP, PRs, plugin tabs) — `RightSidebar` — — —
  `rightSidebarVisible/Width`, `markdown-sidebar-history-v1`.
- SB-8 View placement of contributed tabs — `lib/viewPlacement.ts` — — — `viewPlacements`.

**Agents (AG)**
- AG-1 11 agent types (claude, codex, copilot, cursor, antigravity, opencode, mimo, freebuff, kiro,
  shell, wsl) — `lib/agentProviders.ts`, `agentCliPath.ts`, `agentRuntimeAdapter.ts`, `sessionLaunch.ts`.
- AG-2 Unrestricted flags per agent + `alwaysStartUnrestricted` — `UNRESTRICTED_FLAG`.
- AG-3 New-terminal modal (row stack, grid picker, 9router toggle, planner option, repeat last) —
  `NewTerminalModal` — — — `lastTerminalCreation`.
- AG-4 Launcher resolution + override — `find_cli_launcher`, `refresh_cli_launcher` — `cliPaths`.
- AG-5 Install/update/uninstall agent CLIs — `AgentInstall/*`, `useAgentInstall.ts` —
  `probe_install_toolchain`, `agent_cli_version` — —.
- AG-6 Enable/disable agents — Preferences → Terminal — — — `enabledAgents`.
- AG-7 Claude ↔ Codex handoff — `HandoffModal` — `prepare/materialize/complete_agent_handoff` —
  `handoffs/`, `SubTab.handoff`.
- AG-8 Agent hook bridge (Claude/Codex events) — `useAgentHookBridge.ts` — `agent_hooks_*`,
  `codex_hooks_config_write` — `~/.codex/config.toml`, Claude settings.
- AG-9 Model discovery per provider — `discover_provider_models`.

**Sessions (SE)**
- SE-1 Auto-resume Claude/Codex/OpenCode/Antigravity/Cursor sessions — `lib/sessionResume.ts`,
  `sessionDiscovery.ts`, `paneResume.ts`, `claudeSessionTracking.ts`, `sessionWatch.ts` —
  `snapshot_*_sessions`, `create_cursor_chat` — `SubTab.sessionId`, localStorage `active-sessions`.
- SE-2 Resume last session — `lib/resetLastSession.ts`.
- SE-3 Claude history + Recent chats — `ClaudeHistoryModal`, `RecentChatsModal` —
  `list_claude_sessions`, `snapshot_codex_sessions`.
- SE-4 Session/transcript cost — `get_session_cost`, `get_transcript_cost`, `get_model_pricing`.

**Git, diff and Merge Center (GIT)**
- GIT-1 Git Control (status, stage, commit ⌘↩, pull/push, discard) — `plugins/git-control/*` —
  `git_status/stage/unstage/commit/discard/pull/push/init`.
- GIT-2 Commit graph (cherry-pick, revert, reset, branch from commit) — `GitGraph*.tsx` —
  `git_log_graph`, `git_show_commit_*`, `git_cherry_pick_commit`, `git_revert_commit`,
  `git_reset_to_commit`, `git_create_branch_from_commit`.
- GIT-3 Incoming/outgoing — `IncomingOutgoing.tsx` — `git_incoming_outgoing`.
- GIT-4 Worktree isolation per agent — `worktree_provision/list/remove/cleanup/lock/unlock/…` —
  `autoWorktree`, `worktreeMode`, `worktreeAgentId`.
- GIT-5 Merge Center (analyze, prepare, validate, finalize, abort, rebase, force cleanup, health probe,
  contract check) — `SidebarMergePanel`, `MergeTree`, `MergeCenterModal`, `BranchTestingModal`,
  `ConfirmWorktreeCommitModal`, `mergeStore` — `merge_*`, `worktree_*`, `git_diff_summary`,
  `run_validation`, `health_probe`, `contract_check`, `read_gsd_procedure` — `validationCommands`,
  `healthCheck*`, `orphanWorktrees`, `mergePostAction`, `conflictAgentProvider/Model`.

**Pull requests (PR)**
- PR-1 Open PRs tab (`gh search prs --involves=@me`) + send to Todo — `PullRequestsSidebar` —
  `github_pr_list_mine` — todo `prUrl/prNumber/prRepo`.
- PR-2 PR AI review + squash merge with SHA guard — `PullRequestReviewModal`, `lib/pullRequestMerge.ts` —
  `github_pr_find`, `github_pr_merge` — `reviewAgentProvider/Model`.

**Files (FS)**
- FS-1 File explorer (tree, rename, delete, preview, drag into grid, git badges, icons) —
  `FileExplorer.tsx`, `fileExplorerGit.ts`, `FileIcon.tsx`, `lib/fileDrag.ts` — `list_directory`,
  `rename/delete_filesystem_entry`, `read_text_file`, `git_status`.
- FS-2 In-app folder browser — `FsBrowserModal` — `browse_directory` (native: `NSOpenPanel`).

**Browser (BR)**
- BR-1 Web pane (tabs, reload, resource modes) — `WebPane/*`, `lib/browserUrl.ts`,
  `browserResourcePolicy.ts` — `browser_pane_*` — `terminal.url`, `browserConfig`.
- BR-2 "Agent opened a page" offer — `useAgentBrowserOffers.ts`.
- BR-3 Playwright MCP shared/dedicated browser — `browser_session_*`, `playwright_mcp_config_path` —
  `playwrightBrowserMode`, `playwrightDedicatedHeadless`.

**MCP, Skills, Plugins, Agent library (EXT)**
- EXT-1 MCP manager (scan all agents incl. Cursor, add from registry, enable/disable, health, sync,
  reveal env, backups) — `McpPanel/*`, `McpManagerModal`, `mcp/AddServerFlow`, `McpIntroModal`,
  `mcpStore` — `mcp_*`, `mcp_registry_search`, `mcp_health_check` — `mcpDefaultScope`,
  `mcp/backups/`, `mcp/registry-cache.json`.
- EXT-2 Skills browser — `mcp/SkillsBrowser.tsx`, `lib/skills*.ts` — `skills_scan/detail/uninstall`.
- EXT-3 Plugin system (install, import dir, enable, catalogue, storage, capabilities) — `lib/plugins/*`,
  `PluginsPage`, `PluginCatalog`, `ContributedModals`, `ContributedView` — `plugins_*`, `plugin_*` —
  `plugins/`, `plugin-data/`, `catalog-cache.json`.
- EXT-4 Agent library (subagent templates) + economy agents — `lib/agentLibrary.ts`,
  `AgentLibraryPalette`, `useInstalledAgents` — `list_installed_agents`, `install_agent`,
  `uninstall_agent`, `economy_agents_enabled`, `set_economy_agents` — `~/.claude/agents`.
- EXT-5 Graphify (graph MCP, view, snapshots, rollback) — `graphifyStore`, `GraphifyView` — `graphify_*` —
  `project.graphifyEnabled`, `.alethe/`.
- EXT-6 ai-memory MCP wiring — `ai_memory_*`.
- EXT-7 GSD Sync (OpenCode child sessions feed, planning status) — `GsdSyncActivityView`,
  `useGsdSyncSessions.ts` — `opencode_export_session`, `read_gsd_child_*`, `start/stop_gsd_watcher`,
  `gsd_opencode_plugin_write`, `read_planning_status`, `list_project_plans` — `gsdSyncModelChain`.

**Orchestrator (ORC)**
- ORC-1 Planner board (workers, runs, approvals, steering, diffs, apply worktree, media cards, quota
  warnings, subagents) — `OrchestratorPane/index.tsx`, `lib/orchestrator*.ts`, `lib/agentFitness.ts`,
  `useOrchestratorQuotaWarnings.ts` — `orchestrator_*` — `orchestrator-jobs.json`,
  `project.paneGroups[kind=orchestration]`.
- ORC-2 MCP tools for agents (`alethe_delegate/check/status/steer/send/cancel/answer/diff/release`) —
  `src/bin/alethe-orchestrator-mcp.rs`, `orchestrator_core.rs` (2380 LOC).
- ORC-3 Scheduler, telemetry, planning audit (Preferences → Multiagent) — `MultiagentPage`,
  `schedulerStore` — `get_scheduler_tasks`, `trigger_scheduler_tick`, `cancel_task`, `publish_event`,
  `get_telemetry_*`, `planning_audit_*`, `get/set_planning_autocommit`.

**Usage, stats and resources (USE)**
- USE-1 Claude/Codex/Antigravity usage pills + AI Usage modal + Codex reset credit —
  `lib/*UsageCache.ts`, `AiUsageModal`, `ResetCreditModal`, `limitResetWatch.ts` — `get_*_usage`,
  `consume_codex_reset_credit`, `get_opencode_usage_summary` — `topbarShow*Usage`, `notifyOnLimitReset`.
- USE-2 Activity tracking — `activityTracker.ts`, `activityCache.ts` — `record_activity_samples`,
  `get_claude_activity`, `clear_activity_stats` — `activity-stats.json`.
- USE-3 RAM indicator, memory analytics, resource supervisor (hibernate idle, priorities, pressure) —
  `useResourceSupervisor.ts`, `MemoryAnalyticsModal`, `lib/ptyVisibility.ts` — `get_memory_stats`,
  `get_runtime_snapshot`, `get_resource_metrics`, `set_resource_policy`, `update_pty_runtime_meta`,
  `set_pty_visible/priority` — `resourcePolicy`, `spawnConcurrency`.
- USE-4 Crash watch / last crash report — `get_last_crash_report`, `get_job_guard_status` —
  `last_session.json`.

**Appearance (UI)**
- UI-1 16 built-in themes + 4 theme-pack themes, ~87 CSS tokens — `lib/themes.ts`, `themeTokens.ts`,
  `ThemePickerModal`, `AppearancePage` — `uiTheme`.
- UI-2 Visual style normal/clean — `visualStyle`.
- UI-3 Motion preference (animated/reduced) — `motionPreference`.
- UI-4 App icon themes (4) — `appIconTheme`.
- UI-5 UI zoom (⌘+/−/0) — `uiZoom`.
- UI-6 Window opacity — `set_window_opacity` (Win32 only upstream).
- UI-7 Title bar / topbar config (RAM, usage pills, remote counter, pomodoro, 9router, profile) —
  `TitleBar`, `TopbarSettingsModal` — `topbarStyle`, `topbarShow*`.
- UI-8 i18n EN + pt-BR — `lib/i18n/*` — `language`.

**Settings, profiles, backup (SET)**
- SET-1 Preferences (10 pages) — `PreferencesModal` + `preferences/*`.
- SET-2 Feature toggles (browser, graphify, mcp, playwright, orchestrator, gsdSync, aiMemory, prs) —
  `lib/features.ts` — `enabledFeatures`.
- SET-3 Profiles — `ProfilesModal`, `UserProfile`, `lib/profile.ts` — `list/create/rename/delete/…
  _profile(s)`, `export_profile_backup` — `profiles.json`.
- SET-4 Backup/import, reset, factory wipe, logs — `export_backup`, `import_backup`, `reset_app_data`,
  `wipe_all_app_data`, `export_logs`, `open_logs_folder`, `open_data_folder`, `open_spawn_log`.
- SET-5 GitHub gist sync — `SyncModal` — `github_sync_*` — `github_sync.json`.
- SET-6 Cloud sync — `lib/cloudSync.ts` — `cloud_sync_*` (server default `127.0.0.1:8787`).
- SET-7 Onboarding (profile/GitHub, style, agents, features, 9router, MCP) + Welcome — `OnboardingModal`,
  `onboarding/*`, `WelcomeModal` — `onboardingDone`, `accountCreated`, `displayName`.
- SET-8 Updater + What's New — `lib/updater.ts`, `UpdateModal`, `WhatsNewModal`, `changelogData.ts`.
- SET-9 Notifications (desktop + toasts, 5 s dedupe, actionable) — `lib/notifications.ts`.
- SET-10 Find/Jump (commands + terminals) — `FindJumpModal`.
- SET-11 Audit center (errors, export JSON) — `AuditModal`, `lib/auditLogger.ts` —
  `record_frontend_error`, `record_app_event`.
- SET-12 Close confirmation + quit coordination — `useCloseConfirmation.ts`, `closeCoordinator.ts` —
  `quit_app`.
- SET-13 Keyboard shortcuts (see §6.3 for the Mac mapping).

**Widgets and peripherals (PER)**
- PER-1 Todo list (tags, per-project, PR links) — `plugins/todos/*` — `ensure_todo_template` — plugin
  storage / external `todos.jsonc`.
- PER-2 Pomodoro (todo panel + title pill, focus todo) — `PomodoroWidget`, `pomodoroStore` —
  `pomodoro*Minutes`, `pomodoroSession`.
- PER-3 Spotify Now Playing — `useNowPlaying.ts`, `NowPlayingWidget`, `SidebarNowPlaying` —
  `spotify_*` — `spotify_tokens.json`.
- PER-4 Discord Rich Presence — `useDiscordPresence.ts` — `set/clear_discord_presence`.
- PER-5 9router routing — `Router9/*`, `useRouter9*.ts` — `router9_*` — `preferences.router9`,
  `SubTab.useRouter9`.
- PER-6 Dictation (Parakeet, ⌘E, toggle/hold) — `DictationButton`, `lib/speech/*`,
  `VoiceDictationSection` — `speech_*` — `dictation*`, `speech-models/`.
- PER-7 Remote control (QR pairing, read-only, shell input, device limits, Tailscale, PWA client) —
  `RemoteControlModal`, `RemoteControlPage`, `useRemoteControlService.ts`, `src-tauri/src/remote/` —
  `remote_control_*` — `remote*`, `terminal.remoteShared`.

**Experimental / gated upstream (EXP)**
- EXP-1 Agent Canvas POC + TokenHud — `AgentCanvasPOC/*`, `TokenHud`, `agentCanvasStore`.
- EXP-2 Agent Sandbox (disabled: `AGENT_SANDBOX_ENABLED=false`) — `codex_app_server_*`.
- EXP-3 Native Ghostty backend in the Tauri app — `GhosttySurface`, `ghostty_*`.

## 3. Lessons from the first attempt

Evidence is from `git log main..mac-native` and the old docs (`PLANO_MIGRACAO_MAC_SWIFT.md`,
`MAC_PARITY_BACKLOG.md`, `MAC_PARITY_POS_MERGE.md`, `MELHORIAS_MAC.md`, `PROMPT_CONTINUACAO_MAC.md`).

**What worked**
1. The Phase-0 gate: Ghostty inside SwiftUI plus an FFI throughput benchmark before building features.
   Batching output before crossing any boundary mattered (14 MB/s unbatched vs 315 MB/s batched).
2. Hosting Ghostty in a real view hierarchy fixed focus and backing-scale bugs that the Tauri overlay had.
3. Pure-logic models with XCTests (GridMath, WorkspaceLayout, SessionLaunch, PromptHistory,
   WorkTimeTracker…) — the bulk of 142 tests; several real parity bugs were caught this way
   (`3269464` extraArgs dropped, `f7ab37d` double-credited work time).
4. Failing the strings build on pt-BR drift.

**What went wrong, and the rule v2 adopts**
1. `scaleEffect` zoom displaced AppKit hit-targets (`07406f2`) → zoom scales **font and metric tokens**
   only; hit-target UI tests guard it (§7 P0-9). On macOS 27 the displacement no longer reproduces
   (P0-9 pins that); the rule stays.
2. Global shortcuts stole terminal keys: Esc (`99fa717`), Shift+Tab (`8a4f067`) → app shortcuts only as
   ⌘ key equivalents (§6.3).
3. ⌘W lost to the shim's local key monitor (`937d324`, a 35-file debugging commit) → no local event
   monitors in the terminal layer; key routing designed and tested up front (P0-6).
4. An overlay swallowed clicks because a gesture was attached after `.position()` (`490aa64`) →
   hit-target tests for every overlay.
5. Two instances reaped each other's terminals → single-instance guard + per-instance PTY ownership.
6. Keychain prompts from unstable dev signing blocked the UI (`cb6f6ec`) → one stable local signing
   identity from Phase 0.
7. Generated artifacts (themes, strings, `migrations.js`) went stale after the merge (`31de59b`) → no
   continuous generation from React; Swift is the source of truth.
8. FFI grew ad hoc to 61 stringly `*_json` exports → no FFI at all; typed Swift services.
9. Orphan strings (2256 keys shipped, ~21% referenced; 169 `merge.*`) → strings land only with code;
   an orphan-key test fails the build.
10. Merge tax on Rust (294 `cfg` gates, modules made Tauri-only) → no shared code with upstream.
11. The plan said "PTY stays in Rust", but Ghostty silently took ownership → no scrollback, hibernation
    or remote. v2 uses `HOST_MANAGED` I/O so the app owns the PTY (ADR-2).
12. Terminal theming was never wired (Ghostty defaults) → theme → Ghostty config is a Phase 1 acceptance
    criterion.
13. Debug residue and committed `xcuserstate` → `.gitignore` from P0-1; no disabled-code comments.
14. Docs drift (`Scripts/` vs `scripts/`, contradictory commit rules) → one plan doc, one backlog.
15. A browser pane that claimed to honor config but had an empty `updateNSView` → acceptance criteria
    name observable behavior.
16. Spawn allow-list disagreed with the agent map → one `AgentRegistry` is the only source.
17. Scope creep: shallow showcase features (canvas, ASCII backdrop, token HUD) shipped while Cmd+F,
    scrollback and IME stayed open → phases order depth before breadth.
18. Three paths to read one schema (`ProjectsDocument`, `ProjectsFile`, JSC) → one Codable model per
    schema version.
19. Tests depended on a prebuilt Rust staticlib → the test suite runs from a clean checkout with
    `xcodebuild test` only.

## 4. Asset reuse decisions

| Asset (branch `mac-native`) | Decision | Justification |
|---|---|---|
| Rust core + UniFFI (`ffi.rs`, `host.rs`, `core_events.rs`, `core_runtime.rs`, generated bindings) | **Discard** | Swift-only product; this layer caused the merge tax. |
| Ghostty ObjC shim (849 LOC) + `AletheGhostty` (171) | **Rewrite in Swift**, keep the knowledge | Keep dead-key handling (UCKeyTranslate), clipboard callbacks, OPEN_URL, focus handling. Fix the global 60 Hz timer (use `NSView.displayLink` per surface), the global app/config, the missing theme/search, and test hooks mixed into the production API. |
| libghostty binary (prebuilt `Lakr233/libghostty-spm` `storage.1.2.5`) | **Keep the API, replace the supply** | Its header exposes `GHOSTTY_SURFACE_IO_BACKEND_HOST_MANAGED`, `ghostty_surface_write_buffer`, `receive_buffer`/`receive_resize` callbacks and search actions. Built locally from pinned sources by `Vendor/ghostty/build.sh` (P0-5, done). |
| `generate-themes.mjs` | **Discard as a generator; use once** | One-shot conversion (P0-3) of `theme.css` + `themes.ts` + `xtermThemes.ts` ANSI palettes into Swift; the output becomes hand-owned source. |
| `generate-strings.mjs` | **Discard** | Strings are added with each feature into `.xcstrings`; no bulk import. |
| `generate-migrations-bundle.mjs` + `LegacyMigration.swift` (JSC) | **Discard** | Replaced by a Swift `TauriImporter` for v9 only (P1-12). |
| `PomodoroState` (174 LOC, 7 tests) | **Rewrite**; reuse tests as spec | Its persisted shape diverged from upstream (no `focusTodoId`, different fields). |
| `UIZoom` + `BrandFonts` | **Rewrite** | Keep the principle; replace the `nonisolated(unsafe)` static with an environment value that scales fonts **and** metric tokens (fixed widths did not scale before). |
| Kit pure-logic models (GridMath, WorkspaceLayout, SessionLaunch, AgentCommand, PromptHistory, WorkTimeTracker, NavigationHistory, JumpSearch) | **Reuse selectively** | Copy, review against the v1.7.0 TS, adapt to the new schema; keep their tests. |
| `AppStore` (1400), `ContentView` (1025), `WorkspaceAreaView` (599) | **Discard** | God objects. |
| `make-app.sh`, `make-dmg.sh`, `sign-dev.sh` | **Rewrite** | `xcodebuild archive` → export → DMG, hardened runtime, entitlements, later `notarytool` + staple + Sparkle. |
| `smoke-clicks` (AX + CGEvent helpers) | **Reuse the technique** | Becomes an XCUITest hit-target suite (P0-9); the AX script stays as a release smoke check. |
| Core-spike targets (`AletheMacSpike`, `CoreSpikeSmokeTest`, `core-spike/`) | **Discard** | Dead weight. |

## 5. Architecture decisions

### ADR-1 — Core/UI boundary: Swift everywhere
- **Options:** (a) shared Rust core via UniFFI; (b) extract a Rust core crate shared with Tauri;
  (c) port everything to Swift.
- **Decision:** (c), by owner choice. Swift 6 language mode, strict concurrency.
- **Consequences:** the Rust/React code is a specification. Each port task cites the upstream module
  and ports its tests as golden cases. Services are `actor`s by domain; UI stores are `@MainActor`.
- **Library mapping:** git/gh → `Subprocess` wrapper around `Process` with async streams; rusqlite
  (read-only) → system SQLite3; keyring → Security.framework; notify → FSEvents; sysinfo → libproc /
  `host_statistics64`; reqwest → `URLSession`; tiny_http/tungstenite → Network.framework
  (`NWListener`, WebSocket); zip → Apple Archive or `ditto`; qrcode → `CIQRCodeGenerator`;
  toml_edit → a small comment-preserving TOML table editor with golden tests; sherpa-onnx → Apple
  SpeechAnalyzer (owner decision, §11); OAuth callbacks → `ASWebAuthenticationSession` or loopback
  `NWListener`.
- **Third-party dependencies (allow-list):** libghostty and libghostty-spm's `GhosttyKit` +
  `GhosttyTerminal` (MIT, built from pinned sources by `Vendor/ghostty/build.sh`), its transitive
  `MSDisplayLink` (MIT, pinned `exact: 2.2.0`), Sparkle, Apple's `swift-markdown` + `swift-cmark`
  (Apache-2.0, pinned `exact: 0.9.0`, ADR-11). Anything else needs an ADR.

### ADR-2 — Terminal: libghostty (HOST_MANAGED) + Swift PTY host
- **Options:**
  - libghostty surface owning its PTY (first attempt): best rendering, but no scrollback persistence,
    hibernation or remote tap.
  - SwiftTerm: pure Swift, trivially host-fed, but a CPU/CoreText renderer and weaker throughput.
  - libghostty in `HOST_MANAGED` mode: Metal renderer, Ghostty's input/IME/search, and the host owns
    I/O.
- **Decision (confirmed by the P0-6 gate):** libghostty in `HOST_MANAGED` mode, driven through
  libghostty-spm's `GhosttyTerminal` Swift wrapper (AppKit view, `NSTextInputClient`, key handling,
  host-managed session bridge) — adopted instead of writing our own ~1k-LOC shim, since it passed every
  gate. Alethe owns everything around it (`AletheTerminal`). SwiftTerm stays only as a documented
  fallback.
- **Design:**
  - `PTYHost` (actor): `forkpty` with a clean environment, login shell resolution, process group,
    `kqueue` `NOTE_EXIT`, a ring buffer (4 MiB) flushed to `scrollback/<id>.bin`, hibernation
    (terminate and later resume the agent session), priorities, and a tap API for remote control and
    the orchestrator.
  - Output is batched (≥ 16 KiB or one frame) before `ghostty_surface_write_buffer`.
  - Input from `receive_buffer` goes to the PTY; `receive_resize` drives `TIOCSWINSZ`.
  - One `ghostty_app` per process, one config per theme; per-surface rendering driven by
    `NSView.displayLink`.
  - IME/CJK via a real `NSTextInputClient`; ⌘F search via the header's search actions; links via
    OPEN_URL + hover.
  - Terminal theme: the Alethe theme's ANSI palette + font are written into a Ghostty config.
- **Risk:** `HOST_MANAGED` is a patch maintained by `Lakr233/libghostty-spm` (MIT), not upstream
  Ghostty. P0-5 builds it from pinned sources (libghostty-spm `b7f888e` + Ghostty `3c47ca1`); moving the
  pin forward is a deliberate task that re-runs the P0-6 checks.

### ADR-3 — UI: SwiftUI shell + AppKit pane host

| Area | Technology | Why |
|---|---|---|
| App lifecycle, menus, shortcuts, Settings | SwiftUI `App`, `Commands`, `Settings` scene | Standard Mac behavior for free |
| Sidebar | `NavigationSplitView` + `List(.sidebar)`, `Transferable` drag & drop (incl. Finder) | Source-list material, keyboard navigation, VoiceOver |
| Toolbar, pills, search | `.toolbar` (NSToolbar, Liquid Glass) | Integrated title bar |
| Inspector (agent details) | `.inspector` | Native trailing column |
| Sheets, popovers, Home, Git/MCP/PR/Orchestrator panels | SwiftUI | Fast iteration |
| Workspace pane area | **AppKit** `PaneHostView` (NSView) owning terminal/web surfaces; SwiftUI headers via `NSHostingView` | Metal surfaces are never recreated by SwiftUI identity changes; splits/reorder animate with interruptible Core Animation springs |
| File explorer tree | SwiftUI `List` with `OutlineGroup`; `NSOutlineView` if it misses the performance budget | Large trees |
| Web pane | `WKWebView` (SwiftUI `WebView` on 26+ where it fits) | Replaces the CDP engine |

Known SwiftUI-on-macOS limits the design avoids: representable identity churn, weak first-responder
control, key-equivalent conflicts, and large-list performance.

### ADR-4 — State and persistence
- Observation: `@Observable @MainActor` stores per domain (`ProjectsStore`, `WorkspaceStore`,
  `PreferencesStore`, `TerminalsStore`, `GitStore`, `UsageStore`, …). No god object; stores talk
  through services, not through each other's internals.
- `DocumentStore<Document: Codable & Versioned>`: load → migrate through a chain of pure
  `(vN) -> vN+1` functions → validate. Before migrating, back up to `<name>.v<N>.bak`. Writes are
  debounced (300 ms), sequence-guarded, and atomic (`Data.write(options: .atomic)`, i.e. tmp → rename).
- Data layout: `~/Library/Application Support/<bundle-id>/profiles/<id>/workspace.json`,
  `preferences.json`, `scrollback/`, `activity-stats.json`, `orchestrator-jobs.json`, … Secrets in the
  Keychain. `UserDefaults` only for per-machine window state.
- No compatibility with Tauri data, except `TauriImporter`: reads v9 from the Tauri data dir,
  read-only, maps groups/projects/terminals/preferences it understands, and reports what it skipped.
  Fixture tests with anonymized v9 files.

### ADR-5 — Design system
- `AletheDesign` module: `Theme` (semantic tokens from `theme.css` — bg/fg/accent/agent-*/status-*…
  plus a 16-color ANSI palette, cursor and selection), `Typography` (size → tracking/leading table,
  SF Pro for UI, the Alethe mono for terminals), `Metrics` (spacing/radius/sizes, all scaled by
  `uiScale`), `Motion` (named springs, §6.1), `Materials`.
- Themes: 16 built-ins stored as JSON resources in `AletheDesign` (every token resolved, no runtime
  cascade), decoded into `Theme` and validated at load and by tests; the 4 theme-pack themes ship the
  same JSON format as a data plugin (P4). Keeping hex values in data rather than Swift literals keeps
  the color lint simple: only `ThemeColor` may build colors from channels.
- Chrome (sidebar, toolbar, popovers) uses system materials/Liquid Glass tinted by the theme accent;
  content surfaces (panes, terminal, lists) use theme tokens. No gradients; a contrast test runs per
  theme.
- Lint (unit test over sources): no `Color(red:…)`, `Color(hex:)`, `#colorLiteral`, `LinearGradient`,
  `RadialGradient` or `AngularGradient` outside `AletheDesign`.

### ADR-6 — Internationalization
- String Catalogs (`.xcstrings`) with generated symbols (Xcode 26+); EN is the source language, pt-BR
  required.
- Keys are dotted identifiers (`sidebar.projects.title`) with an explicit `en` value, used as
  `Text("key", bundle: .module)` / `String(localized: "key", bundle: .module)`. Non-translatable text
  (product names, agent CLI names, user data) uses `Text(verbatim:)`.
- `Scripts/check-strings.py` runs as the app's first build phase and in `Scripts/test.sh`. It fails on:
  a key without a translated `en` and `pt-BR` value, an orphan key (never referenced by its module's
  Swift sources), a dotted key used in code but missing from the catalog, and plain-text literals passed
  to `Text`/`Label`/`Button`/`help`/… The app target sets `ENABLE_USER_SCRIPT_SANDBOXING = NO` because
  the gate reads every catalog and Swift source.

### ADR-7 — Project structure and build
- `AletheNative/` (self-contained; no symlinks or paths into `src-tauri/`):
  - `AletheNative.xcodeproj` with folder-synchronized groups.
  - `Packages/AletheKit` — local SwiftPM package with targets: `AletheFoundation` (subprocess, FS
    watch, atomic files, Keychain, logging), `AletheModel` (Codable domain + migrations),
    `AletheDesign`, `AletheTerminal` (PTYHost, TerminalEngine, Ghostty engine), `AletheAgents`,
    `AletheGit`, `AletheIntegrations` (MCP, skills, graphify, ai-memory, Spotify, Discord, 9router),
    `AletheOrchestrator`, `AlethePluginKit`, `AletheRemote`.
  - App target `Alethe` (feature UI in folders: Home, Workspace, Sidebar, Git, PRs, Files, MCP,
    Orchestrator, Settings, Onboarding, HUD).
  - CLI targets: `alethe` (open-folder shim) and `alethe-orchestrator-mcp` (stdio MCP server).
  - `Vendor/` (libghostty build script + checksum), `Scripts/`, `Tests/` (unit, UI, performance),
    `CHANGELOG.md`, `UPSTREAM_BASELINE`.
- Toolchain: Xcode 27, Swift 6.4, deployment target macOS 26.0. APIs from macOS 27 behind
  `if #available(macOS 27, *)`, adopted after a P0 audit of the SDK diff.
- `Scripts/build.sh`, `Scripts/test.sh` wrap `xcodebuild`; the suite runs from a clean checkout.

### ADR-7a — macOS 27 APIs adopted (P0-7 audit of the Xcode 27 SDK)

Many new APIs are annotated `@available(anyAppleOS 27, *)` rather than `macOS 27`; both forms were
searched. Every adoption is behind `if #available(macOS 27, *)` (or `anyAppleOS 27`) with the macOS 26
behavior as fallback — a 27-only API may improve a feature but never be required for it.

| API (macOS 27) | Use in Alethe | Task | macOS 26 fallback |
|---|---|---|---|
| `reorderable()`, `reorderContainer(for:itemID:in:isEnabled:move:)`, `ReorderDifference` | Sidebar reorder across groups, tab/pane lists | P1-4, WS-5 | `onMove` + `Transferable` drop delegates |
| `ToolbarItemVisibilityPriority(lowerThan:/higherThan:)`, `contentMarginsRemoved(_:)` | Dense toolbar: which pills overflow first; custom pill chrome | P1-1, UI-7 | default priorities; standard margins |
| `View.alert(error:actions:)` | Surfacing process/agent errors from optional `Error` state | P1 onward | `alert(isPresented:)` + stored error |
| `GeometryProxy.concentricCornerRadii`, `NSView.cornerConfiguration` / `NSViewCornerRadius.containerConcentric` | Panes and cards concentric with the window's glass corners | P1-6 | fixed `Metrics.Radius` |
| `NSGlassEffectView.effectIsInteractive` | Interactive glass on HUD pills that host controls | P3 USE-1, P2 | non-interactive glass |
| `NSToolbarItemGroup.role = .tabs`, `NSSegmentedControl.role` | Mode switchers (Home/Workspace, inspector modes) | P1-1 | plain segmented control |
| `NotificationCenter.MainActorMessage` typed notifications (`NSWindow.DidBecomeKeyMessage`, `NSSplitView.DidResizeSubviewsMessage`, …) | Concurrency-safe window/split observation in the pane host | P1-6 | selector/closure observers |
| Observation `withContinuousObservation(options:apply:)` | Bridging `@Observable` stores to AppKit views (pane host) | P1-6 | re-registering `withObservationTracking` |
| `withTaskCancellationShield(operation:)` | Guaranteed PTY teardown / scrollback flush on cancellation | P2 TERM-10 | detached cleanup task |
| System `FileDescriptor.pipe(options:)` (`O_NONBLOCK`, `O_CLOEXEC`) | Pipes for `git`/`gh`/agent CLI subprocesses | P3–P4 | `pipe()` + `fcntl` |
| Foundation `ProgressManager` / `Subprogress` | Progress trees: agent installs, Merge Center stages, model downloads | P3–P4 | `Progress` |
| `EnvironmentValues.systemPrefersReducedResourceUsage` | Resource supervisor: throttle polling/animation | P2 USE-3 | own policy only |
| Speech `CaptureInputSequenceProvider`, `AnalyzerInputConverter` | Dictation: mic → SpeechTranscriber without manual AVAudioEngine | P3 PER-6 | AVAudioEngine tap + format conversion |
| `NSStatusItem` expanded interface (`expandedInterfaceDelegate`) | Optional menu-bar agent monitor (post-v1 idea) | backlog | — |
| `NSRefreshController` (`NSScrollView.refreshController`) | Pull-to-refresh on PR/session lists (touch/trackpad) | P4 PR-1 | refresh button only |
| `NSScrollView.isTouchScrollingEnabled` and touch-gesture APIs | Verify terminal/list scrolling on touch-capable Macs | P2 | n/a |

Not adopted: the new SwiftUI document model (Alethe is not document-based), `TabView` sidebar
additions (the sidebar is a `NavigationSplitView` list), FoundationModels (no on-device agent in
scope), WebKit JS-handle/DOM-snapshot APIs (revisit with BR-3 browser automation). Nothing new in
CoreTransferable, ExtensionKit, UserNotifications or `NSTextInputClient`; there is no `Subprocess`
module in the SDK (P3 wraps `Process`/`posix_spawn` itself).

### ADR-8 — Distribution
- **No App Sandbox:** the app spawns arbitrary CLIs with `forkpty`, reads/writes `~/.claude`, `~/.codex`
  and arbitrary repos, and runs local servers (hooks, MCP, remote). Not a Mac App Store product.
- Hardened runtime from day one. Entitlements: none beyond hardened-runtime defaults unless proven
  necessary; usage strings for microphone and speech recognition.
- Until a Developer ID account exists: one stable, self-signed local signing identity (keeps Keychain
  ACLs stable), and a dev flag that disables Keychain reads.
- Release (Phase 8): Developer ID, `notarytool` + staple, Sparkle 2 (EdDSA; appcast on the new
  repository's releases), DMG.

### ADR-9 — Native plugin API
- `AlethePluginKit`: versioned Swift protocols. `AlethePlugin` (manifest: id, version, capabilities)
  with `activate(context:)`. Contribution points mirror upstream: sidebar tab (view), command (palette
  and menu), theme, pane kind, sheet/modal, agent provider, settings page, storage.
- Capabilities are declared and enforced by the host API surface (e.g. no raw PTY write or filesystem
  delete without a capability).
- Built-ins (Git Control, Todos + Pomodoro, Theme-pack) are registered statically and use only the
  public API (dogfooding).
- Third-party loading: **ExtensionKit** app extensions (owner decision, §11): out-of-process,
  sandboxed, remote UI via `EXHostViewController`, crash-isolated. Rejected: in-process bundles (they
  require `disable-library-validation` and share the app's address space and permissions). The P4
  spike validates the flow end to end.
- **P4-19 spike outcome (2026-09-25, `docs/SPIKE_P4-19_EXTENSIONKIT.md`):** the choice holds. The SDK
  exposes everything needed: the host declares its point with `@AppExtensionPoint.Definition` (macOS 26.0),
  extensions bind with `@AppExtensionPoint.Bind(host:name:)` (26.2), discovery via
  `AppExtensionPoint.Monitor`, enable UI via `EXAppExtensionBrowserViewController`, remote UI via
  `EXHostViewController`, XPC via `AppExtensionProcess`, crash signals via `onInterruption`. A scratch host +
  extension type-checked at 26.0/26.2; a real signed extension loading end to end and a contained crash
  are still unverified. Risk: the self-signed dev identity may be refused; production needs Developer ID +
  notarization. `AletheExtensionHost` maps declared capabilities to `PluginCapability` and keeps the
  first-enable consent ledger (U 10).

### ADR-10 — Keyboard routing
- App shortcuts only through SwiftUI `Commands` / menu key equivalents using ⌘ (mapping in §6.3).
- Never bind Esc, Shift+Tab, Option+arrows, or Ctrl+letter as global key equivalents. Esc closes an
  overlay only when the first responder is not a terminal.
- No local `NSEvent` monitors in the terminal layer; the terminal view handles `keyDown`,
  `performKeyEquivalent` and `NSTextInputClient` itself. Ghostty's own keybinds are cleared
  (`keybind = clear`): a bound chord is claimed by the view before the menu bar sees it. Key routing is covered by UI tests (vim, Claude
  Code Shift+Tab, ⌘W, ⌘F, dead keys, IME).

### ADR-11 — Markdown rendering: swift-markdown (owner decision, 2026-09-24)
- **Context:** the Markdown pane (WS-6, P2-9) renders READMEs and plans with GFM (tables, task
  lists, strikethrough) like upstream's react-markdown + remark-gfm, plus Mermaid diagrams.
- **Options:** (a) Apple's `swift-markdown` (cmark-gfm) parsed into blocks laid out in SwiftUI;
  (b) a small in-app GFM parser, no dependency; (c) a WKWebView with bundled marked.js + mermaid.js.
- **Decision:** (a). A spec-compliant parser maintained by Apple, no JavaScript in the app, theme
  tokens and text selection native. `AletheDocuments` owns the dependency; the rest of the app sees
  `MarkdownBlock`. Pinned `exact: 0.9.0` (its `swift-cmark` resolves to 0.9.0, in `Package.resolved`).
- **Consequences:** Mermaid blocks show as code until a web-based renderer exists (P2-12 brings
  WKWebView; revisit then). Raw HTML shows as source, as upstream (no rehype-raw).

## 6. Interaction and motion guide

Principles from the apple-design guidance, translated to SwiftUI/AppKit.

### 6.1 Rules
- **Response:** visual feedback on mouse-down (pressed styles via `ButtonStyle` `isPressed`); no
  artificial delays or debounces on the input path.
- **Direct manipulation:** drags track 1:1 and keep the grab offset; continuous updates during split
  resize, pane reorder and sidebar drag — never animate only at the end.
- **Springs by default:** `Motion.standard = .spring(response: 0.35, dampingFraction: 1.0)`;
  `Motion.quick = .spring(response: 0.25, dampingFraction: 1.0)`; `Motion.momentum =
  .spring(response: 0.35, dampingFraction: 0.8)` only after a gesture with momentum. In AppKit:
  `CASpringAnimation` built from the same response/damping. No fixed durations on user-interruptible
  interactions.
- **Interruptibility:** every transition can be grabbed and reversed; animate from the presentation
  value (CA `presentation()` layer; SwiftUI springs retarget from the current value). Input is never
  blocked during an animation.
- **Velocity handoff and projection:** on drag end, pass the release velocity into the spring and
  choose the snap target from `current + (v / 1000) * d / (1 − d)`, `d = 0.998`; the reverse/commit
  decision uses the velocity sign.
- **Rubber-banding** at bounds (min pane size, sidebar width limits, list ends):
  `(x * dim * 0.55) / (dim + 0.55 * |x|)`.
- **Spatial consistency:** panels and popovers leave the way they came, anchored to their origin
  (`.popover(attachmentAnchor:)`, sheets from the window, inspector from the trailing edge).
- **Materials and depth:** sidebar in the sidebar material, toolbar in Liquid Glass, popovers in their
  system material; hierarchy by material weight; scroll edge effects instead of 1 pt dividers; never
  stack translucent layers.
- **Typography:** SF Pro with size-specific tracking (tight for large titles, ~0 for body), leading
  inverse to size; zoom (⌘+/−/0) scales font and metric tokens together.
- **Accessibility:** Reduce Motion → cross-fades and no bounce; Reduce Transparency → solid surfaces;
  Increase Contrast → defined borders; VoiceOver labels for every control; full keyboard navigation
  (sidebar, panes, lists, sheets).
- **Mac-ness (Familiarity, Flexibility, Simplicity, Craft):** standard menus (File, Edit, View, Window,
  Help), standard shortcuts, multiple windows, Settings scene, Finder drag and drop, Quick Look,
  services, state restoration. Confirmation dialogs only for destructive, irreversible actions;
  otherwise undo.

### 6.2 Behavior per area
- **Home:** real data only (activity, usage, recent projects). Short staggered entrance (≤ 3 steps),
  none under Reduce Motion. Quick launch is a text field that expands in place.
- **Workspace / panes:** split resize is live and rubber-bands at min size; reorder lifts the pane
  (shadow + slight scale on mouse-down-and-move), neighbors reflow with `Motion.standard`, drop target
  chosen by projection. Focus mode zooms from the pane's frame and returns to it. Closing a pane
  collapses toward its neighbor; ⌘⇧T restores along the same path.
- **Sidebar:** reorder with a spring and an insertion gap; hover reveals row actions without layout
  shift; a folder dropped from Finder becomes a project with an anchored confirmation popover;
  busy/done glyphs change with a cross-fade, not motion.
- **Git / Merge Center:** stages (analyze → prepare → validate → finalize) show continuous status; long
  steps are cancelable; destructive steps (reset, discard, force cleanup) ask once.
- **PRs:** list updates in place; "send to Todo" animates the row toward the Todo tab (the direction of
  the outcome); review opens as a sheet from the row.
- **File explorer:** disclosure animates with `Motion.quick`; Space opens Quick Look; drag to a pane
  opens it there; rename inline.
- **MCP / Skills / Plugins:** list + detail; toggles apply instantly with undo; health checks show live
  status per server.
- **Orchestrator:** worker cards update live; approvals inline on the card; diffs open in the trailing
  inspector.
- **Settings:** the standard Settings window with toolbar tabs; changes apply immediately.
- **Onboarding:** short, skippable, keyboard-first; includes the optional Tauri import with a summary
  of what was imported.
- **HUDs (RAM, usage, pomodoro, remote, 9router):** toolbar pills; details in anchored popovers; values
  animate with numeric content transitions.

### 6.3 Shortcut mapping (upstream → Mac)

| Upstream | Mac | Action |
|---|---|---|
| Ctrl+T / Ctrl+Alt+T / Ctrl+Shift+T | ⌘T / ⌥⌘T / ⇧⌘T | New terminal / repeat last / reopen closed tab |
| Ctrl+W | ⌘W | Close pane (window when last) |
| Ctrl+P | ⌘K | Find/Jump + commands (P2-25) |
| Ctrl+Shift+P / Ctrl+Shift+G | ⌘N / ⇧⌘N | New project / new group |
| Ctrl+Shift+A | ⇧⌘A | Add content |
| Ctrl+Shift+H | ⇧⌘H | Home ↔ workspace |
| Ctrl+1…9 | ⌘1…9 | Jump to project N |
| Alt+← / Alt+→ | ⌘[ / ⌘] | History back/forward |
| Ctrl+Tab / Ctrl+Shift+Tab | ⌃Tab / ⌃⇧Tab | Cycle workspace tabs (Mac-standard; delivered to terminal when it has focus and no tab exists) |
| Shift+Tab, Ctrl+PgUp/PgDn | ⌥⌘← / ⌥⌘→ | Cycle terminals (Shift+Tab is left to the terminal; ⌥⌘↑/↓ went to prompt history in P2-6) |
| Ctrl+B | ⌃⌘S | Toggle sidebar (standard) |
| Ctrl + / − / 0 | ⌘+ / ⌘− / ⌘0 | UI zoom |
| Ctrl+E | ⌘E is "Use Selection for Find" on Mac → dictation uses ⌥⌘E (⌥⌘D is macOS's Dock hiding shortcut; Fn-Fn is system Dictation) | Dictation |
| Ctrl+Enter (git) | ⌘↩ | Commit |
| Ctrl+↑/↓ (prompt history) | ⌥⌘↑ / ⌥⌘↓ | Prompt history (P2-6; ⌃↑/⌃↓ belong to Mission Control) |
| — | ⌘↑ / ⌘↓ | Previous / next prompt mark (P2-3) |
| — | ⌘F / ⌘G / ⇧⌘G | Terminal search |
| — | ⇧⌘↩ / ⌥⌘↩ | Show the pane / the project alone (P2-16) |
| — | ⇧⌘F, Esc | Focus mode on / off (P2-21) |
| — | ⌘, | Settings |

## 7. Execution plan

**Workflow (non-negotiable, per task):** Implement → Test → Validate → Update docs + ai-memory → Commit → next task.
After every piece of work (including decisions and investigations), update the affected docs — this
plan's checkboxes, parity matrix (§8) and ADRs, `AletheNative/CHANGELOG.md`, feature docs — and record
the outcome in ai-memory (decisions, work state, gotchas, next steps). One task per
commit; tick its checkbox in the same commit. Commits have no co-author or tool signature. No push,
tag or release without the owner's explicit authorization at that moment. Every user-facing change
updates `AletheNative/CHANGELOG.md` `[Unreleased]` (owner decision, §11).

**Test cadence (owner decision, 2026-09-22):** per task, run only what the change touches — the
affected package suites (`swift test --filter …`, all package tests are cheap), the affected UI test
classes (`Scripts/uitest.sh -only-testing:AletheUITests/<Class>`), the strings gate and the app build
when the project changes. Run the full suite (`Scripts/test.sh` + `Scripts/uitest.sh`, which includes
the real-mouse smoke scripts) every 3 tasks, at the end of each phase, and when a change reaches
widely shared code. Last full run: after P2-5 (2026-09-24, also the Phase 1 end-of-phase run): 159
package tests, 27 UI tests, both smoke scripts, all passing. `AppearanceTests
.testAppearanceControlsReceiveClicksAtThreeZoomLevels` failed once in the full run (the theme picker
did not appear after clicking the Appearance tab) and passed on a rerun: flaky, not a regression.

**UI-testing gotchas (learned in Phase 1):**
- XCUITest `typeText` drops lowercase "c" under the owner's Brazilian - Pro layout (real key events
  are fine) — tests avoid typing it.
- XCUITest's synthesized drags never reach AppKit `mouseDragged` nor start SwiftUI drag sessions:
  drags are covered by `Scripts/smoke/*.sh` with `Scripts/dev/mousedrag.swift` (real mouse events).
- A plain `NSView` is invisible to accessibility: set `setAccessibilityElement(true)` + a role before
  giving it an identifier.
- Manual checks: launch the Debug app with `-AletheDataRoot <tmp> -AletheUITestSeed <seed>`
  (`sidebar`, `terminals`, `panes`, `prompt`), drive it with `Scripts/dev/keypost.swift`, and capture
  only its window (`screencapture -l <window id>`); never send global System Events keystrokes.
- Localized strings with arguments: dotted key + positional placeholders (`%1$@`) through
  `String(format:)`; the strings gate rejects interpolated keys.
- A SwiftUI `Text` whose string changes keeps its old accessibility value, so tests (and VoiceOver)
  read stale text; give it `.id(value)`. Check a screenshot before blaming a "missed" click.
- The Settings window reopens on the last tab used, stored in the app's real defaults and shared by
  every test run: tests select their tab explicitly.

Sizes: **S** ≤ half a day, **M** 1–2 days, **L** 3–5 days (split anything larger).
Test kinds: **U** unit (Swift Testing), **UI** XCUITest, **HT** hit-target UI test, **P** performance
(XCTest metrics/signposts), **G** golden files ported from upstream tests.

### Phase 0 — Foundations and terminal spike (gate)

- [x] **P0-1 (S) Scaffold.** `AletheNative/` with Xcode project, `Packages/AletheKit`, app target,
  `Scripts/build.sh`/`test.sh`, `.gitignore` (xcuserdata, DerivedData, build outputs), `CHANGELOG.md`,
  `UPSTREAM_BASELINE` = `75083e2`. *Accept:* `Scripts/test.sh` passes from a clean clone; the app
  launches an empty window. *Tests:* U smoke.
  *Done:* hand-written `project.pbxproj` (objectVersion 77, folder-synchronized `Alethe/` group, local
  package reference); `AletheKit` starts with `AletheFoundation` (`AppIdentity`) and gains targets as
  their tasks begin; bundle id `com.kc1t.alethe.mac`, deployment target 26.0, string-catalog symbol
  generation on. Verified: 2 unit tests pass, the app launches a 900×532 "Alethe" window and quits.
  Finding for P0-2: ad-hoc signing (`CODE_SIGN_IDENTITY = -`) does not apply the hardened runtime.
- [x] **P0-2 (S) Stable dev signing.** Script to create/use one local identity; hardened runtime on
  (ad-hoc signing skips it — see P0-1). *Accept:* two consecutive builds keep the same designated
  requirement (`codesign -d -r-`) and `codesign -dv` shows the `runtime` flag.
  *Done:* `Scripts/dev-signing.sh` resolves the identity (`Alethe Dev Signing`, overridable with
  `ALETHE_SIGN_IDENTITY`; `--create` makes one; falls back to ad hoc with a warning) and `build.sh`
  passes it to `xcodebuild`. Verified: `flags=0x10000(runtime)`, identical designated requirement across
  rebuilds, `codesign --verify --strict` ok, app launches. *Gotcha:* a self-signed identity has no Team
  ID, so hardened-runtime library validation rejects any separately signed dylib — Xcode's
  `Alethe.debug.dylib` included. `ENABLE_DEBUG_DYLIB = NO` and all modules link statically; embedded
  frameworks (e.g. Sparkle) must wait for Developer ID signing (Phase 8).
- [x] **P0-3 (M) Design tokens + themes.** One-shot conversion of `theme.css`, `themes.ts`,
  `xtermThemes.ts` into `AletheDesign` (16 themes, tokens, ANSI); `Typography`, `Metrics`, `Motion`.
  Conversion script is kept under `Scripts/oneshot/` for audit, not run in the build. *Accept:* every
  upstream token has a Swift counterpart (U test with a token list); color lint test fails on a
  literal. *Parity:* UI-1 (data).
  *Done:* `Scripts/oneshot/convert-themes.py` → 16 `Resources/Themes/*.json` (71 color tokens, 3
  shadows, terminal palette with 16 ANSI colors; palettes that upstream leaves to xterm.js get its
  Tango defaults) + `ThemeToken.swift`. `ThemeColor`, `Theme`, `ThemeCatalog` (picker order, default
  `elite-indigo`, fallback `dark`), `Metrics` (UI scale 0.8–1.5 applied to space/radius/size/fonts),
  `TextStyle` (system font), `AletheFonts` (bundled Caskaydia Cove Nerd Font Mono, family
  `CaskaydiaCove Nerd Font Mono`), `Motion` (springs, projection, rubber-band, snap). Tests: 18
  (completeness, WCAG AA text contrast per theme, round-trip, motion math, font registration, lint for
  color literals and gradients — both verified to fail on a probe file). The app window paints
  `theme[.bg]`. *Gotcha:* passing `CODE_SIGN_IDENTITY` on the `xcodebuild` command line also signs the
  package resource bundle, which then demands a team; the app target reads `ALETHE_SIGN_IDENTITY`
  instead.
- [x] **P0-4 (S) i18n pipeline.** `.xcstrings` in app and packages; build-phase + U test for missing
  pt-BR and orphan keys. *Accept:* adding an EN-only key fails the build.
  *Done:* `Alethe/Localizable.xcstrings` + `Scripts/check-strings.py` as a build phase and in
  `test.sh`. Verified with probes: an EN-only key fails the build (`** BUILD FAILED **`); an orphan
  key, a missing key and a plain-text `Text("Hello there")` are reported; a complete key compiles into
  `en.lproj`/`pt-BR.lproj` and renders "Boas-vindas" when launched with `-AppleLanguages (pt-BR)`.
  Package-module catalogs are covered by the same checker and get validated when the first package
  string lands (P1).
- [x] **P0-5 (M) libghostty from source.** `Vendor/ghostty/build.sh`: pinned revision, `zig` build to
  an xcframework, checksum verification; confirm `HOST_MANAGED` API and whether upstream Ghostty has it.
  *Accept:* reproducible build; checksum recorded.
  *Done:* `HOST_MANAGED` is **not** in upstream Ghostty; it is `Patches/ghostty/0002-host-managed-io.patch`
  of `Lakr233/libghostty-spm` (MIT, actively maintained, Zig 0.16 pipeline). `Vendor/ghostty/build.sh`
  checks out libghostty-spm `b7f888e` and Ghostty `3c47ca1` (verified against libghostty-spm's
  `Ghostty.ref`), runs its macOS build, verifies the header carries `HOST_MANAGED`, copies
  `Vendor/GhosttyKit.xcframework` (universal arm64 + x86_64 `libghostty.a`, ~40 MB, gitignored) and
  writes `Vendor/ghostty/BUILD_INFO`. Requires Zig 0.16.0 and the Xcode Metal Toolchain
  (`xcodebuild -downloadComponent MetalToolchain`; the script checks both). Build time ≈ 5 min.
  *Finding:* the output is not bit-reproducible (differs across builds even with `ZERO_AR_DATE`), so
  inputs are pinned by commit and the recorded sha256 only identifies a build. Also found:
  libghostty-spm ships a Swift wrapper (`GhosttyTerminal`: AppKit view, `NSTextInputClient`, key
  routing via `performKeyEquivalent`, host-managed session bridge; ~8k LOC; depends on
  `MSDisplayLink`); P0-6 evaluates adopting it against writing our own.
- [x] **P0-6 (L) Terminal spike.** `PTYHost` (`forkpty`, batching, ring buffer) + Swift Ghostty view in
  `HOST_MANAGED` mode, `displayLink` rendering, `NSTextInputClient`, search action, theme → config.
  *Gate:* input latency ≤ 1 frame at 120 Hz; `cat` of 100 MB within 1.25× of Ghostty.app; vim, htop,
  Claude Code (Shift+Tab), dead keys (´ + e) and Japanese IME work; ⌘F finds text; no key stolen by the
  app. If any gate fails and cannot be fixed in the spike → switch `TerminalEngine` to SwiftTerm and
  record an ADR. *Tests:* P throughput, UI key-routing.
  *Done — gate PASSED with libghostty (HOST_MANAGED) + libghostty-spm's `GhosttyTerminal` wrapper;
  SwiftTerm fallback not needed.* Implemented `AletheTerminal`: `CAlethePTY` (C `forkpty` + exec —
  only async-signal-safe calls after fork), `PTYProcess` (64 KiB batched reads on a private queue,
  process-group signals, exit via `DispatchSource`), `ScrollbackRing` (4 MiB), `TerminalIOTap`,
  `ShellLaunch` (login shell, `TERM=xterm-ghostty` + bundled terminfo), `TerminalAppearance` (theme →
  Ghostty config), `TerminalPaneView`. Measured:
  | Gate | Result |
  |---|---|
  | Throughput, `cat` 101 MB | Alethe (Release) 1.02 s / 0.91 s vs Ghostty.app 1.05 / 1.06 / 1.05 s |
  | Input latency (Debug) | key → PTY write median 0.48 ms (p95 0.63); key → shell echo median 0.74 ms (p95 1.03) |
  | Key routing | Shift+Tab → `ESC[Z`, Esc → `ESC`, ⌥← → `ESC b`, ^C, ⌘W closes the window (menu) |
  | Dead keys (Brazilian - Pro) | `'`+`e` → é, `~`+`a` → ã |
  | IME | marked text + commit → 日本語 |
  | TUIs | vim (insert, Esc, `:wq` saved the file), htop (alternate screen, colors, `q`) |
  | Search | `search:<text>` highlights every match, including a soft-wrapped one |
  Findings: (1) the wrapper's default `TerminalTheme` renders after the terminal configuration and
  overrode our colors → Alethe's theme is passed as the controller's `TerminalTheme` (regression
  test); (2) Ghostty's default keybinds (⌘W/⌘T/⌘N/⌘K/⌘F/⌘±) are claimed in `performKeyEquivalent`
  before the menu bar → `keybind = clear`, copy/paste/select-all go through the Edit menu and the
  view's `copy:`/`paste:`/`selectAll:` (regression test); (3) synthetic `NSEvent`s do not compose
  dead keys — hardware-faithful tests use `Scripts/dev/keypost.swift` (`CGEvent.postToPid`, delivered
  to the app's process only; never global keystrokes); (4) gaps for P2 TERM-3: the wrapper does not
  surface search totals/selection and the selected match is not visually distinct. Debug-only spike
  hooks (`-AletheSpikeScript/Dump/Command`) live in `Alethe/Spike/`.
- [x] **P0-7 (S) macOS 27 SDK audit.** List of APIs adopted behind `#available(macOS 27, *)`, recorded
  in this doc (§5 ADR-7).
  *Done:* ADR-7a — 16 APIs mapped to tasks with macOS 26 fallbacks; audit read the SDK's
  `.swiftinterface`/header availability annotations (`macOS 27` and `anyAppleOS 27`).
- [x] **P0-8 (S) upstream-watch.** `Scripts/upstream-watch.py` (§9). *Accept:* running it against
  `75083e2..origin/main` produces a report.
  *Done:* reports commands, i18n keys, release sections/[Unreleased] bullets, new component dirs,
  `types.ts` changes and schema bumps into `AletheNative/upstream-reports/<date>-<sha>.md`. Validated
  on `v1.6.0..v1.7.0` (78 commits, 89 new commands, 851 new keys, 9 new component dirs, schema v7 → v9)
  and on the live range (0 commits since the baseline).
- [x] **P0-9 (M) Hit-target harness.** XCUITest helpers that click each control at its drawn frame and
  assert the effect, at zoom 0.9/1.0/1.2. *Accept:* a deliberately broken `scaleEffect` fixture fails.
  *Done:* `AletheUITests` target + shared `Alethe` scheme + `Scripts/uitest.sh`; debug fixture
  `-AletheUITestFixture hit-targets` (toggle, button, segmented picker, text field, NSView-backed
  button) clicked at the drawn (accessibility) frame at UI scale 0.9/1.0/1.2 — all land.
  *Finding — acceptance adjusted:* on macOS 27 `scaleEffect` no longer displaces hit areas, not even
  for an `NSButton` far from the transform anchor, so a `scaleEffect` fixture cannot fail; that fact is
  pinned by `testScaleEffectHitTestingOnThisOS` (fails if the platform regresses). The harness's
  sensitivity is proven instead with the first attempt's other real bug (lesson 4): an invisible
  full-window view taking clicks is detected. Zoom still scales metrics, never `scaleEffect`. The UI
  runner cannot take screenshots (no Screen Recording permission); use `screencapture -l` outside.

### Phase 1 — Usable vertical skeleton

- [x] **P1-1 (M) App shell.** Main window, `NavigationSplitView`, toolbar, standard menus, Settings
  scene, single-instance guard, state restoration. *Tests:* UI, HT.
  *Done:* single `Window` scene (⌘N stays free for New Project) with `NavigationSplitView`, unified
  toolbar, `SidebarCommands`, View › Zoom In/Out/Actual Size (metrics scale, persisted), `Settings`
  scene (General: start agents unrestricted), `AppEnvironment` composition root loading the active
  profile's documents, single-instance guard (activates the running copy), flush on quit
  (`applicationShouldTerminate` → `.terminateLater`), sidebar visibility via `@SceneStorage`, theme
  and `preferredColorScheme` from the active theme. Debug `-AletheDataRoot <path>` isolates data;
  UI tests use `/private/tmp/alethe-uitest-*` (a sandboxed runner's container is not writable by the
  app) and verify persistence by relaunching and reading the UI, never files. 4 UI tests.
- [x] **P1-2 (M) Model v1 + DocumentStore.** `Workspace`, `Group`, `Project`, `Pane`, `SubTab`,
  `Preferences`; migrations chain; atomic debounced writes; backup before migrate. *Tests:* U, G
  (round-trip, corrupted file, concurrent save). *Parity:* data layer for SB/WS.
  *Done:* `AletheFoundation.DocumentStore` (actor; `schemaVersion` + JSON-level migration chain;
  `<name>.v<N>.bak` before migrating; unreadable files moved to `<name>.corrupt-<time>` and the app
  starts fresh; files from a newer build are never written; debounced atomic writes ordered by a
  caller-owned revision). `AletheModel`: typed `Identifier`s (nanoid strings, compatible with imported
  ids), `WorkspaceDocument` v1 (groups with nesting and ordered project ids, ungrouped order, projects
  → panes → tabs, workspace state), `PreferencesDocument` v1, pure `WorkspaceOperations` (keeps every
  project placed exactly once; no group cycles; `repair()`), `DocumentModel` (`@Observable
  @MainActor`). Tests: 7 store + 12 model (incl. corruption, newer-version protection, migration with
  backup, debounce, out-of-order revisions, round-trip). Phase 1 runs in dependency order: P1-2, P1-3,
  then P1-1.
- [x] **P1-3 (M) Profiles folder layout.** Default profile; paths service. *Parity:* SET-3 (base).
  *Done:* `ProfileIndexDocument` (`profiles.json`: profiles, active id, built-in `default` profile
  whose name is localized) and `DataLocations` (`profiles/<id>/{workspace,preferences}.json`,
  `scrollback/`; ids sanitized so they cannot escape the folder). 5 tests.
- [x] **P1-4 (M) Sidebar tree.** Groups (nested), projects, terminals; reorder; context menus; Finder
  drop and `NSOpenPanel` to add a project. *Tests:* U reorder math, UI drag, HT. *Parity:* SB-1, SB-3.
  *Done:* `List(.sidebar)` tree with `DisclosureGroup` groups (collapse persisted), colored project
  dots (theme `project*` tokens), terminal rows per project, selection → open/focus; File › Add
  Project Folder… (⌘O, `NSOpenPanel`, multiple), New Group (⇧⌘N), Finder folder drop; context menus
  (Show in Finder, Move to Group, Remove, New Subgroup, Delete Group); every structural change is
  undoable (`DocumentModel.update(undoManager:actionName:)`, ⌘Z/⇧⌘Z) instead of confirmation
  dialogs. Drag and drop uses the outline view's own mechanism (`.itemProvider` rows, `onMove`,
  `onInsert`, row `onDrop`). *Finding:* XCUITest's synthesized drags never start a SwiftUI drag
  session on macOS (no drop handler runs), while real mouse events work — drags are verified by
  `Scripts/smoke/sidebar-drag.sh` (real events via `Scripts/dev/mousedrag.swift`, AX-located
  rows, asserts `workspace.json`), run by `uitest.sh`. UI tests: tree nesting, Move to Group + undo,
  delete group keeps projects, add-project panel; debug seed `-AletheUITestSeed sidebar`.
- [x] **P1-5 (M) New/edit project and group.** Name, color (tokens), folder, default cwd. *Parity:*
  SB-2 (basic), SB-3.
  *Done:* `Alethe/Editors/` — `EditorRequest` (held by `AppEnvironment.editorRequest`, presented as a
  sheet by `MainWindow`), `ProjectEditor` (folder field + Choose…, name auto-filled from the folder,
  color swatches, group picker; validation: name, existing folder, duplicate folder), `GroupEditor`
  (name, optional color, parent picker excluding itself and descendants), `ColorSwatchPicker`. File
  menu: New Project… (⌘N), New Group… (⇧⌘N), Add Project Folder… (⌘O); context menus: Edit Project…,
  Edit Group…, New Project in Group…, New Subgroup…. Editors register undo on the **main window's**
  undo manager (passed in by `MainWindow`; the sheet's own `\.undoManager` dies with the sheet) and
  focus their first field on appear. *Tests:* `AletheUITests/EditorTests` (3). Lesson: XCUITest
  `typeText` drops lowercase "c" under the Brazilian - Pro layout — real CGEvents reach the field
  (checked with `Scripts/dev/keypost.swift`), so UI tests avoid typing it.
- [x] **P1-6 (L) PaneHostView.** AppKit host with split layout (Auto), live resize, reorder, close,
  Motion springs, rubber-banding. *Tests:* U layout math (reuse GridMath), UI, HT. *Parity:* WS-1, WS-3
  (Auto).
  *Done:* `AletheModel/WorkspaceLayout.swift` — `AutoLayout.rows` (upstream `PaneArea` Auto: 1 full,
  2 side by side, then rows of two with an odd last pane spanning), `TrackMath` (weighted tracks,
  boundary drag clamped at a minimum, rubber-band injected as a function so the model does not
  depend on `AletheDesign`), `PaneGridGeometry` (pane frames + divider hit areas). App
  `Workspace/PaneHost/`: `PaneHostView` (open projects as containers sized by `containerWeights`,
  container dividers, click-to-focus through a local mouse monitor that lets the click through),
  `ContainerView` (SwiftUI header, Auto grid from `gridWeights[project]`, live split drag with
  rubber-band then a spring back on release, header drag-to-reorder with a lifted pane using the
  theme's `lg` shadow, empty-project state), `PaneView` (header, re-parented registry terminal,
  overlay only when needed), `DividerView`, `FrameAnimator` (critically damped `Motion.standard`
  spring on `NSView.displayLink`, interruptible, skipped under Reduce Motion), `PaneHostContext`.
  Close pane / close project are undoable; resizes and focus are not (as upstream).
  `PTYProcess.resizeCoalesced` sends only the last size of a burst (80 ms quiet) so a live drag is
  one SIGWINCH, not one per frame. *Tests:* `AutoLayoutTests`, `TrackMathTests`,
  `PaneGridGeometryTests`, `coalescedResizeAppliesOnlyTheLastSize`, UI `PaneHostTests` (layout, close
  + undo), `Scripts/smoke/pane-drag.sh` (real-mouse split resize, container resize, reorder — run by
  `uitest.sh`; XCUITest's synthesized drags never reach AppKit `mouseDragged`).
  *Follow-up (Phase 2, TERM):* zsh still leaves a `%`/prompt fragment after a resize because Ghostty
  cannot clear the old prompt without its shell integration (OSC 133 marks). In `HOST_MANAGED` mode
  Ghostty does not spawn the shell, so Alethe must inject the integration itself (ZDOTDIR for zsh,
  equivalents for bash/fish).
- [x] **P1-7 (L) Terminal panes.** `PTYHost` + Ghostty engine productionized: spawn, resize, restart,
  kill, exit handling, theme and font from the app theme. *Parity:* TERM-1, TERM-7, TERM-8.
  *Done:* `Alethe/Terminals/` — `TerminalRegistry` (one live `TerminalPaneView` per tab, owned outside
  the view tree so processes survive project switches; start via `AgentLauncher`, restart, close,
  prune deleted tabs, terminate all on quit, live theme + font updates; font = 13 pt × `uiScale`),
  `TerminalHost` (re-parents the registry's view; overlays for ended process → Restart, CLI not found
  → Choose CLI… (validated with `LauncherResolver.path(_:matches:)`, saved to `cliPaths`), spawn
  failure). `PTYProcess.terminate(grace:)` = SIGHUP to the group, SIGKILL after 2 s.
  `WorkspaceView` shows the selected project's focused pane (splits: P1-6); "New Terminal" menu in
  the project context menu and empty state (the full sheet is P1-9); tab rows get Restart / Close
  Terminal (`WorkspaceDocument.closeTab`, undoable). Claude session ids are only resumed when their
  transcript exists (`ClaudeTranscripts`), since a minted id with no message cannot be resumed.
  Ghostty's own "Process exited. Press any key" line is suppressed (the session is not `finish`ed).
  Localized strings with arguments use a dotted key + `String(format:)` with positional
  placeholders (the strings gate rejects interpolated keys). *Tests:* `terminateKillsAChildThatIgnoresHangup`,
  `closingTheLastTabClosesItsPane`, `ClaudeTranscriptsTests`, UI `TerminalTests.testShellLifecycle`;
  checked visually with Claude Code (theme, trust prompt, exit overlay, no orphan processes).
- [x] **P1-8 (M) AgentRegistry + launch.** Claude, Codex, OpenCode, Cursor, shell; launcher resolution
  (PATH, Homebrew, npm/pnpm/volta/fnm/asdf/mise), unrestricted flags, cwd. *Tests:* U, G (ported from
  `cli_resolver.rs` and `sessionLaunch` tests). *Parity:* AG-1 (subset), AG-2, AG-4.
  *Done:* new `AletheAgents` target (no Ghostty dependency): `AgentKind`/`AgentRegistry` (the only
  agent list), `AgentArguments` (port of `buildAgentLaunch`), `LauncherResolver` + `LauncherCache`
  (PATH, `~/.local/bin`, `~/.claude/local`, `~/.opencode/bin`, cargo, bun, npm-global,
  `NPM_CONFIG_PREFIX`, Volta, pnpm, mise, asdf, nvm/fnm newest first, Homebrew; overrides; hits
  re-checked on disk), `AgentLauncher` → `AgentCommand` (a `$SHELL -l -c` line that puts the CLI's
  folder first on PATH so `#!/usr/bin/env node` finds its node, scrubbed editor/Claude variables).
  `PreferencesDocument.cliPaths` holds overrides (Settings UI comes with AG-5/AG-6).
  `AppEnvironment.agentLauncher` composes it; `AgentCommand.ptyLaunch(size:)` feeds P1-7. 27 tests,
  including a real-shell quoting test; checked on this Mac with a minimal PATH (`claude --version`
  ran through `zsh -l`).
- [x] **P1-9 (M) New-terminal sheet.** Agent picker, folder, restricted/unrestricted, prompt; ⌘T.
  *Parity:* AG-3 (basic).
  *Done:* `Editors/NewTerminalSheet` (enabled agents as a radio group with agent colors, project
  picker, folder with validation + Choose…, unrestricted toggle showing the real flag and defaulting
  to `alwaysStartUnrestricted`, optional first prompt; `lastAgent` preselected). File › New
  Terminal… (⌘T) and New Terminal… on projects and empty containers (replaces P1-7's quick submenu).
  `AletheTerminal/PromptDelivery` ports upstream `sendInitialInput` + `deliverOpenCodePrompt`:
  ready after ≥ 1.5 s (OpenCode 4 s) and 700 ms of quiet or 4 s; bracketed paste + Enter (+ a late
  second Enter) for Claude/Codex/Cursor; OpenCode typed in 6-char chunks, confirmed on the rendered
  screen (letters/digits match, retype only into an empty box), Enter resent only while the screen
  is unchanged. The registry clears `initialPrompt` once sent so relaunch never resends it.
  *Tests:* `PromptDeliveryTests` (virtual clock), UI `TerminalTests.testNewTerminalSheet`; checked
  live: `/help` as first prompt opened Claude Code's help.
- [x] **P1-10 (M) Session resume for Claude and Codex.** Snapshot sessions from `~/.claude/projects` and
  `~/.codex/sessions`, bind to sub-tabs, resume on relaunch. *Tests:* G with fixture transcripts.
  *Parity:* SE-1 (subset).
  *Done:* `AletheAgents/SessionDiscovery` ports `snapshot_claude_sessions` (cwd folder encoding, exact
  then case-insensitive match) and `snapshot_codex_sessions` (recursive walk, first-line
  `session_meta` only, cwd compared after resolving symlinks so `/tmp` ≡ `/private/tmp`), plus
  `SessionClaims` (port of `sessionDiscovery.ts`: one owner tab per conversation, discovery binds only
  the single new unclaimed session). `SessionResume` holds the decisions: Claude resumes only with a
  transcript, Codex only while its rollout for that folder exists, others are trusted; a resumed
  agent exiting within 4 s is relaunched once without the id; new Codex sessions are polled every
  3 s ×10, then 15 s. `TerminalRegistry` snapshots Codex before the spawn, skips ids held by another
  tab, persists whatever id the process ends up with (minted, resumed, discovered or dropped) on the
  tab, and cancels discovery on close/restart. Also scrubs the parent Claude Code session variables
  (`CLAUDE_CODE_CHILD_SESSION` turns transcript saving off, which silently broke resume when Alethe
  was started from a Claude terminal).
  *Tests:* `SessionDiscoveryTests` (fixture homes: Claude folders, Codex rollouts with a 100 KB
  `session_meta`, symlinked cwd; claim ports of the upstream cases; retry window; poll schedule with a
  fake sleep; cancellation), UI `TerminalTests`. Checked live: relaunch ran `claude --resume <id>` and
  restored the conversation; a resume that fails exited in ~2 s and fell back to a fresh
  `--session-id`, saved on the tab. Codex not checked live (CLI not installed on this Mac).
  *Not ported yet:* Codex "active writer" conflict detection, session titles, hook-driven Claude id
  changes (`/clear`, `/resume` inside the CLI; AG-8).
- [x] **P1-11 (M) Themes + zoom + language in Settings.** Theme picker, UI zoom via `uiScale`, EN/pt-BR.
  *Tests:* HT at three zoom levels. *Parity:* UI-1, UI-5, UI-8.
  *Done:* Settings › Appearance (`Settings/AppearanceSettings`): the 16 built-in themes as swatch
  tiles in upstream picker order with upstream names/descriptions (`ThemeLabels`, tooltip = summary),
  applied live to every window and terminal; interface size with − / + / Actual Size (same rounding
  and 80–150 % bounds as the View menu); language System / English / Português (Brasil). Language is
  the app's own `AppleLanguages` default (`AletheFoundation/AppLanguage`: the key System Settings ›
  Language & Region › Applications writes too), so it applies at launch: Settings shows "Applies
  after restarting" + Restart Now (`App/AppRelaunch`: a helper shell waits for the app to quit and
  flush, then reopens it with the same arguments minus `-AppleLanguages`/`-AppleLocale`). Not in
  preferences.json: the language is app-wide, not per profile. Settings also follows the theme's
  light/dark scheme.
  *Tests:* `AppLanguageTests` (3); UI `AppearanceTests`: theme applies and survives a relaunch; HT at
  90 %, 100 % and 120 % (zoom in/out/reset, a theme tile, the language picker and its restart note).
  Checked live: launched in pt-BR the whole Settings window is Portuguese; Restart Now reopened the
  app with the data root kept and the language back to System.
- [x] **P1-12 (M) TauriImporter.** Read-only import of `projects.json` v9 (groups, projects, terminals,
  core preferences), summary sheet. *Tests:* G with anonymized fixtures, including the v2–v8 shapes the
  upstream migration accepts (import requires v9; older files show a clear message).
  *Done:* `AletheModel/TauriImport` reads v2–v9, not only v9: the imported fields (group tree, project,
  terminal and sub-tab basics, theme/zoom/language/agents) kept their shape across the upstream v2 → v9
  migrations, which only added fields the importer ignores. v1 shows "older" and anything above v9
  shows "newer". Groups are recreated parents first (same name under the same parent is reused, parent
  cycles become top-level); projects follow the sidebar order (`projectIds`, then `ungroupedOrder`),
  take their folder from `defaultCwd` or the first absolute terminal/tab cwd, and map hex colors to the
  nearest of the ten accents. Skipped and listed: archived projects, projects with no folder or already
  in the workspace, non-terminal panes, agents the native app does not run. Preferences (optional):
  theme, interface size, enabled agents, always unrestricted, CLI paths that exist on this Mac, and the
  language (app-wide, offers a restart). `TauriDataLocation` finds the Tauri profiles
  (`profiles.json` + `profiles/<id>/projects.json`, active first). File › Import from Alethe (Tauri)…
  (`Editors/TauriImportSheet`) previews a dry run on copies of the documents, then imports as one
  undoable change; the Tauri files are never written.
  *Tests (run and passing in the full run after P2-5):* `TauriImportTests` with
  anonymized v1/v2/v5/v7/v9/v10 fixtures (v9 import, idempotent re-import, existing folders, optional
  preferences, v7, v5 + v2, refused versions, hex color mapping, profile discovery); UI
  `TauriImportTests.testPreviewImportAndUndo` (`-AletheTauriProjectsFile` fixture).
- [x] **P1-13 (S) Changelog + phase review.** Update the parity matrix statuses; run upstream-watch.
  *Done:* `AletheNative/CHANGELOG.md` covers every Phase 1 task. Matrix (§8) updated: AG-2 Done, FS-2
  Replaced; SB-1, SB-2, SB-3, AG-1, AG-4, SET-1, SET-3, SET-13 Partial; UI-2 and UI-3 (never scheduled
  in a P1 task) moved to Phase 2. upstream-watch `75083e2..2f3e5ed`
  (`upstream-reports/2026-09-24-2f3e5ed.md`): 4 commits, no new commands, i18n keys, persisted
  fields or schema bump (still v9); the only user-facing change, the startup loading screen following
  the theme, has no native counterpart (the app draws its themed window at launch). Baseline advanced
  to `2f3e5ed`.
  *Phase 1 exit check:* features for every criterion are in (folders as projects, sidebar, the five
  agents in panes, restore on relaunch, both languages, all themes). Tests for P1-12 and
  the end-of-phase full run (owner decision 2026-09-24: tests only on request); both ran after P2-5
  and pass.

**Phase 1 exit criteria:** open existing folders as projects, organize them in the sidebar, run Claude/
Codex/OpenCode/Cursor/shell terminals in panes, quit and relaunch with everything restored, in both
languages and all themes.

### Phase 2 — Terminal and workspace depth
Order: terminal depth on the existing pane model first, then non-terminal pane kinds (one schema
bump, P2-8), then workspace navigation and layouts, then lifecycle and resources. Each task adds its
own `workspace.json` migration when it changes the shape. *Tests* list what the task must ship;
they run per the test cadence above.

- [x] **P2-1 (M) Sub-tabs lane.** Vertical lane on each pane (upstream `SubTabsLane`): switch, new
  sub-tab (agent picker reusing the New Terminal sheet), close (undoable), show/hide the lane per pane.
  *Tests:* U (tab operations), UI + HT (lane controls at three zoom levels). *Parity:* TERM-2.
  *Done:* `Pane.laneVisible` (optional, so v1 files decode unchanged: no migration) and
  `isLaneVisible` (upstream rule: always shown with several tabs). `WorkspaceOperations` gains
  `addTab`, `activateTab`, `tab(_:from:)`, `setLaneVisible`, `updatePane`, `paneHolding`; `closeTab`
  now shows the next tab, or the previous one when the last closes (upstream `closeSubTab`).
  `Workspace/PaneHost/SubTabsLane` (36 pt, `shapeTabsLane*` tokens): agent icon per tab, accent bar on
  the active one (muted when the pane is unfocused), close on hover when there is more than one tab,
  context menu Restart / Close, + at the bottom. `PaneView` lays it out left of the terminal, starts a
  tab's process when it is first shown and hands focus to the new terminal on a switch. The pane
  header's context menu and the sidebar tab menu add New Sub-tab… and Show/Hide Sub-tabs;
  `NewTerminalSheet(targetPane:)` is upstream's `NewSubTabModal` (no project picker, folder of the
  pane's active tab). Selecting a tab in the sidebar now shows it in its pane.
  *Deviations from upstream:* close does not ask first (it is undoable with ⌘Z); no rename or reorder
  (upstream has neither). No keyboard shortcut: upstream has none, and ⌃Tab / ⌘1…9 are taken (§6.3).
  *Tests (written 2026-09-24, run and passing in the full run after P2-5):* `SubTabOperationsTests` (8), UI
  `SubTabsTests` (switch/add/close/undo, lane visibility, HT at 90/100/120 %), seed `subtabs`.
- [x] **P2-2 (S) Double ^C force-kill.** Two ⌃C within the upstream window kill the process tree; an
  overlay offers restart. *Tests:* U (timing on a virtual clock), UI. *Parity:* TERM-9.
  *Done:* `AletheTerminal/ForceKill`: `DoubleInterrupt` (upstream 1.5 s window; the first ⌃C always
  reaches the program, anything typed in between starts over; ETX or the kitty keyboard `CSI 99;5u`)
  and `ProcessTree` (descendants from `sysctl(KERN_PROC_UID)`, SIGKILL children first, then the
  group: agents start workers in their own process groups). `TerminalPaneView` checks keyboard input
  before it reaches the PTY: the second ⌃C is swallowed, a yellow notice is printed (upstream's line,
  localized) and the tree is killed. `TerminalRegistry` records `.forceKilled` (overlay "Terminated
  with a double ⌃C." + Restart) and skips the early-exit fresh retry, which would otherwise relaunch
  a resumed agent killed within 4 s. Mac mapping: ⌃C only; ⌘C stays Copy.
  *Tests (written 2026-09-24, run and passing in the full run after P2-5):* `ForceKillTests` (7, one spawns a child that
  leaves its process group), UI `TerminalTests.testDoubleInterruptForceKills`.
- [x] **P2-3 (S) Shell integration marks.** OSC 133 prompt marks for zsh/bash/fish (injected rc, no
  user files touched) so resize reflows without the leftover prompt fragment and search/scroll can
  jump by prompt. *Tests:* U (sequence parser), manual resize check. *Parity:* TERM-1 (follow-up).
  *Done:* `AletheTerminal/ShellIntegration` ports libghostty's `shell_integration.zig` injection, which
  host-managed mode skips, onto the MIT integration GhosttyKit already bundles: zsh through `ZDOTDIR`
  (the user's own kept in `GHOSTTY_ZSH_ZDOTDIR`), bash through `--posix` + `ENV` (`GHOSTTY_BASH_*`
  contract, `HISTFILE` fix), `GHOSTTY_SHELL_FEATURES=cursor,title`. Applied by
  `ShellLaunch.loginShell` to interactive shells only; agents (`-c`) are untouched. The scripts emit
  OSC 133 A/B/C/D and OSC 7. New Terminal menu: Previous Prompt ⌘↑ / Next Prompt ⌘↓ on the focused
  terminal (`jump_to_prompt`; `AppEnvironment.focusedTerminal`, reused by P2-4).
  *Deviations:* no fish (GhosttyKit bundles no fish integration; Ghostty's own is GPL) and no
  macOS `/bin/bash` 3.2 (Ghostty skips it too). No sequence parser was needed: Ghostty parses the marks.
  *Tests (written 2026-09-24, run and passing in the full run after P2-5):* `ShellIntegrationTests` (5, one runs an
  interactive zsh and checks OSC 133 A and D). The manual resize check (prompt fragment gone) is owed
  with the other tests.
- [x] **P2-4 (L) Terminal search.** ⌘F find bar on Ghostty search actions: next/previous, match count,
  case toggle, highlight all, Esc closes. *Tests:* U, UI, HT. *Parity:* TERM-3.
  *Done:* GhosttyKit's wrapper drops Ghostty's search actions, so `Vendor/ghostty/patches/
  0001-search-delegate.patch` adds `TerminalSurfaceSearchDelegate` (start/end search, total,
  selected); `build.sh` applies `patches/*.patch` idempotently, on a fresh build and to an existing
  package. `AletheTerminal/TerminalSearch` (observable state + "n of m" status) and
  `TerminalPaneView` as the delegate: `showSearch`, `updateSearch` (`search:`), next/previous
  (`navigate_search`), `searchSelection`, `closeSearch` (`end_search`, focus back to the terminal).
  `Terminals/TerminalFindBar` sits over the terminal's top trailing corner (search as you type, ↩ / ⇧↩,
  Esc, count, buttons); `PaneView` follows the active tab's search through observation, so Ghostty's
  own ⌘F (`start_search`) opens the same bar. Terminal menu: Find… ⌘F, Find Next ⌘G, Find Previous
  ⇧⌘G, Use Selection for Find ⌘E.
  *Deviation:* no case toggle: Ghostty's search is always case-insensitive and has no option for it.
  Highlight all comes from Ghostty.
  *Tests (written 2026-09-24, run and passing in the full run after P2-5):* `TerminalSearchTests` (2), UI
  `TerminalSearchTests` (find/count/next/Esc; HT at 90/100/120 %).
- [x] **P2-5 (M) Smart copy/paste.** Paste images (saved to a temp file, path typed in), files from
  Finder (quoted paths), large text with bracketed paste; copy on select optional. *Tests:* U (payload
  mapping), UI. *Parity:* TERM-4.
  *Done:* Already native before this task (GhosttyKit + Ghostty): text paste with bracketed paste and
  newline handling, and files copied in Finder pasting as escaped paths. Added:
  `AletheTerminal/SmartPaste` (upstream priority files → image → text; paths escaped like Ghostty's
  macOS app, with upstream's trailing space; images saved as PNG under
  `$TMPDIR/Alethe/Pasted Images`, TIFF/JPEG/HEIC converted). `TerminalPaneView.pasteImageIfNeeded`
  pastes a saved image's path through `paste(text:)`; `Terminals/ImagePasteMonitor` (local key
  monitor installed at launch) routes ⌘V there only when a terminal has focus and the pasteboard holds
  just an image. The terminal accepts drops: Finder files paste as paths, dragged images are saved
  first, with an accent border while dragging.
  *Deviations:* paths are backslash-escaped, not double-quoted (the macOS convention Ghostty and
  Terminal use; upstream quotes for Windows). Edit › Paste clicked with the mouse still pastes text
  only (the monitor sees ⌘V). No copy on select (upstream has none; Ghostty's option can come with
  terminal settings).
  *Tests (written 2026-09-24, run and passing in the full run after P2-5):* `SmartPasteTests` (5). No UI test: the
  terminal's text is not readable through accessibility; image paste and drops are owed as a manual
  check.
- [x] **P2-6 (M) Prompt history.** Per-tab history of submitted prompts, ⌃↑/⌃↓ to recall, persisted per
  profile with a cap. *Tests:* U (port of upstream cases), UI. *Parity:* TERM-5.
  *Done:* `AletheTerminal/PromptHistory` ports `applyPromptHistoryInput` + `navigateHistory` (lines of
  2+ characters, no consecutive duplicates, last 50, pastes over 4 KiB never kept, ⌃U and backspace
  followed; recall writes ⌃U + the entry; past the newest comes an empty line), reusing the first
  attempt's port with two fixes: `"\r\n"` is one Swift `Character`, and escape sequences (arrow keys,
  Ghostty's bracketed-paste markers) are skipped instead of landing in the line as `[A`.
  `TerminalPaneView` records keyboard input on the session's write path and exposes `recallPrompt`;
  `AletheModel/PromptHistoryDocument` persists every tab's history in the profile's
  `prompt-history.json` (debounced atomic `DocumentModel`, pruned of closed tabs at load).
  Terminal menu: Older / Newer Prompt from History, ⌥⌘↑ / ⌥⌘↓.
  *Deviation:* ⌃↑/⌃↓ are Mission Control and App Exposé on macOS; the binding is ⌥⌘↑/⌥⌘↓ (§6.3).
  *Tests (written, not run — owner decision 2026-09-24):* `PromptHistoryTests` (7),
  `PromptHistoryDocumentTests` (1); package and app build compile. No UI test: the terminal's text is
  not readable through accessibility.
- [x] **P2-7 (L) Scrollback persistence + reattach.** Ring buffer flushed to `scrollback/<tab>.bin`
  (bounded, debounced, atomic), replayed on relaunch before the resumed process draws; clear
  scrollback action. *Tests:* U (file format, truncation), P (flush cost with 10 busy terminals).
  *Parity:* TERM-10.
  *Done:* `AletheTerminal/ScrollbackFile` follows upstream `pty.rs`: 4 MiB per terminal, output
  appended in 250 ms batches on a private serial queue, the file compacted to its last 4 MiB once it
  passes 8 MiB (appends stay appends; only compaction rewrites, atomically), `load` returns the tail.
  `TerminalPaneView(scrollback:)` replays the saved output into the session before the new process
  starts, then `replayReset` (leave the alternate screen, mouse reporting and bracketed paste off,
  cursor shown, colors reset) so a dead TUI's modes do not leak into the new process; every output
  chunk is appended. `TerminalRegistry` keeps one file per tab (ordering on one queue): restart clears
  it (upstream `restart_pty`), closing the tab deletes it, quitting flushes it. `AppEnvironment`
  removes files of tabs that no longer exist at launch. Terminal › Clear Scrollback ⌥⌘K (Ghostty
  `clear_screen` + the file).
  *Limits:* GhosttyKit buffers at most 1 MiB for a surface not yet attached, so a replay shows the last
  1 MiB of the saved 4 MiB. ⌘K stays free for Find/Jump (P2-25).
  *Tests (written, not run — owner decision 2026-09-24):* `ScrollbackFileTests` (4), P
  `ScrollbackFilePerformanceTests.testTenBusyTerminalsFlushCost` (10 terminals × 1 MiB). Manual check
  owed: quit with output on screen, relaunch, output is back above the new prompt.
- [x] **P2-8 (M) Pane kinds + Add Content.** Model v2: `Pane.content` (terminal | markdown | image | video
  | diff | web) with a migration from v1; Add Content sheet listing the kinds (unavailable kinds
  hidden until their task lands). *Tests:* U (migration golden), UI. *Parity:* WS-11.
  *Done:* `AletheModel/PaneContent` (upstream `PaneKind` minus `file`, `graphify`, `orchestrator`,
  which arrive with their features), stored as `{kind, path|url}`. `WorkspaceDocument` v2: the
  migration gives every v1 pane `content: {kind: terminal}` (the store backs the v1 file up first).
  Non-terminal panes have no tabs (`Pane.init` drops them, `addTab` refuses them, no lane);
  `addPane(to:content:)` adds one. `Editors/AddContentSheet` (File › Add Content… ⇧⌘A) lists
  `options`, empty until P2-9, so the menu item stays disabled rather than offering kinds that do not
  work yet.
  *Tests (written, not run — owner decision 2026-09-24):* `PaneContentTests` (3: round trip, v1
  golden migration through `DocumentStore`, content panes). UI test comes with P2-9, the first option.
- [x] **P2-9 (M) Markdown pane.** Rendered view of a file with live reload (`DispatchSource` file
  watch), edit/preview toggle, save. *Tests:* U (watcher), UI. *Parity:* WS-6.
  *Done:* new `AletheDocuments` target (ADR-11). `MarkdownBlocks` turns swift-markdown's tree into
  blocks (headings, paragraphs, standalone images, code, quotes, ordered/unordered/task lists, GFM
  tables with alignment, rules, raw HTML as source) with inline `AttributedString` (emphasis, strong,
  code, strikethrough, links); relative links and images resolve against the file's folder.
  `FileWatcher` (`DispatchSource`, coalesced, reopens after an atomic replace or delete).
  `MarkdownFile` (observable): parse off the main actor, reload on change but never over a draft,
  edit/save (atomic) /cancel. App: `Workspace/ContentPanes/` (`MarkdownBlocksView` with theme
  tokens and selectable text, `MarkdownPaneView` with header Reload / Copy Source / Edit / Save ⌘S /
  Cancel / Show in Finder / Close and drag-to-reorder, `ContentPaneRegistry` keeping one model per
  pane, pruned when panes go). `PaneView` hosts any non-terminal pane as one SwiftUI view.
  Add Content gains "README or Markdown" (file panel at the project folder), which enables ⇧⌘A.
  *Deviations:* Mermaid shows as a code block (ADR-11). Content panes are not listed in the sidebar
  yet (it lists terminal tabs); upstream lists them — with WS-11's remaining kinds.
  *Tests (written, not run — owner decision 2026-09-24):* `MarkdownBlocksTests` (5),
  `MarkdownFileTests` (4, incl. atomic replace twice), UI `MarkdownPaneTests` (render/edit/save/close
  + undo; HT at 90/100/120 %), seed `markdown`. Package, app and UI-test targets compile.
- [x] **P2-10 (S) Image and video panes.** Image with fit/actual size; video on AVKit. *Tests:* UI.
  *Parity:* WS-7, WS-8.
  *Done:* `PaneContent.forFile` ports upstream `classifyPaneKind` (video/image/Markdown extensions,
  `:line[:col]` suffix dropped; nil for other files) and `filePath`. `ContentPanes/ContentPaneHeader`
  is now shared by every file pane (icon, name, the pane's actions, Show in Finder, Close,
  drag-to-reorder); the Markdown pane moved onto it. `MediaPaneViews`: `ImagePaneView` (fitted, or
  actual size with scrolling; `ImageFile` rereads the bytes when the file changes, NSImage's URL
  cache would show the old one) and `VideoPaneView` (AVKit `VideoPlayer` with system controls; the
  `AVPlayer` lives in `ContentPaneRegistry`, so layout changes never restart playback, and it is
  paused when the pane goes). Add Content gains "Image or Video" (images and movies, kind by
  extension).
  *Tests (written, not run — owner decision 2026-09-24):* `PaneContentForFileTests` (2), UI
  `MediaPaneTests` (fit/actual/close, HT at 90/100/120 %), seed `media`. No UI test for video (no
  movie fixture); compiled.
- [x] **P2-11 (M) Diff pane.** `git diff` for the project or one file, unified/split, refresh.
  *Tests:* U (diff parser golden), UI. *Parity:* WS-9.
  *Done:* `PaneContent.diff(path:staged:)` (upstream `terminal.staged`; stored only when true).
  `AletheDocuments/GitDiff`: `GitDiff.run` (upstream `git_diff`: `git diff [--staged] [-- path]`, no
  color/pager/external diff, pipe drained before waiting, 2 MiB cap, binary and not-a-repository
  errors) and `DiffParser` (files, headers incl. renames, hunks with old/new line numbers, "\ No
  newline" notes; `split` pairs removals with the additions after them). `ContentPanes/DiffPaneView`
  + `DiffModel`: file and hunk headers, colored lines with both line numbers, unified or side by side
  (not persisted), working tree / staged toggle (persisted in the pane, not undoable), reload.
  Add Content gains "Git Changes" (the whole project, working tree).
  *Deviation:* side-by-side is native (upstream only shows the unified text).
  *Tests (written, not run — owner decision 2026-09-24):* `DiffParserTests` (3), `GitDiffTests` (real
  git in a temporary repository), UI `DiffPaneTests` (layouts, staged, close; HT at 90/100/120 %),
  seed `diff`. Compiled.
- [x] **P2-12 (L) Web pane.** WKWebView with tabs, address bar, back/forward/reload, resource modes,
  persisted URL. *Tests:* U (URL normalization port), UI, HT. *Parity:* BR-1.
  *Done:* `AletheModel/WebPane`: `WebAddress.normalize` (port of `normalizeBrowserUrl`),
  `WebResourceMode` with `hiddenEvictionDelay` (port of `browserHiddenEvictionDelay`: 1 s, 30 s,
  never; 0 under memory pressure) and `WebPaneOptions` (mode, JavaScript, zoom; upstream
  `BrowserPaneConfig` without the CDP engine), stored in `PaneContent.web(url:options:)` only when not
  default. App: `ContentPanes/WebPageModel` (a private WKWebView on a non-persistent data store,
  KVO-observed title / loading / back / forward, failures kept for an overlay, `target=_blank`
  opened in place, non-web schemes handed to the system; released after the mode's delay once hidden,
  recreated on the last address when shown) and `WebPaneView` (back, forward, reload/stop, address
  field with validation, Private badge, options menu: JavaScript, zoom, While Hidden mode; Open in
  Browser, Close; toolbar drag reorders). `ContentPaneRegistry` keeps the pages and releases hidden
  ones on a system memory-pressure event; the address a page settles on is persisted. Add Content
  gains "Website" (address prompt, localhost:3000 prefilled).
  *Deviation:* no tabs inside a web pane: upstream has none either (one page per pane).
  *Tests (written, not run — owner decision 2026-09-24):* `WebPaneTests` (5: URL and policy ports,
  options decoding), UI `WebPaneTests` (failure overlay, refused address, options, close; HT at
  90/100/120 %), seed `web` (closed local port, no network). Compiled.
- [x] **P2-13 (M) Clickable links.** ⌘-click file/URL/image links in terminals: open in a pane of the
  right kind, in the web pane or the default browser. *Tests:* U (link detection port), UI.
  *Parity:* TERM-6.
  *Done:* Detection stays Ghostty's (URLs, rooted and relative paths, OSC 8 hyperlinks).
  `AletheTerminal/TerminalLink.resolve` decides what a clicked link is: web page, other scheme, file
  (with the `:line[:col]` an agent printed), folder, or nothing; relative paths resolve against the
  shell's folder from OSC 7 (P2-3), else the tab's or project's folder; `~`, percent-encoding and
  trailing punctuation handled. `TerminalPaneView` is Ghostty's open-URL and pwd delegate
  (`onOpenLink`, `reportedDirectory`). `Terminals/TerminalLinkRouter`: Markdown, images and videos
  open as panes of the project (an existing pane on the same file is focused instead, adding one is
  undoable), other files in their default app, folders in Finder, pages in the default browser, or
  in a web pane with ⌥⌘-click; a missing path beeps.
  *Deviations:* the line number is not passed to an editor yet (SB-6, "open in VS Code"). The link
  actions menu came with P2-14.
  *Tests (written, not run — owner decision 2026-09-24):* `TerminalLinkTests` (4). No UI test: a
  link's position in the terminal is not exposed to accessibility; ⌘-click and ⌥⌘-click are owed as
  a manual check. Compiled.
- [x] **P2-14 (S) Link viewer overlay.** Quick preview of a clicked file or URL without adding a pane.
  *Tests:* UI. *Parity:* WS-12.
  *Done:* ⇧⌘-click on a terminal link opens the link actions menu (upstream's, native `NSMenu` at the
  mouse): Open in Browser / Open in Pane / Preview / Open with Default App / Show in Finder / Copy
  Link, per link kind ("Not found" when it resolves to nothing). Preview is
  `Terminals/LinkPreviewSheet` (upstream `LinkViewerOverlay`): Markdown rendered, images, videos,
  pages in a private throwaway web view, other files as text (first 512 KB, binary refused); Open and
  Close (Esc). `EditorRequest.previewLink`.
  *Deviation:* a sheet over the window instead of a custom overlay (the Mac idiom; same content).
  *Tests (written, not run — owner decision 2026-09-24):* UI `LinkPreviewTests` (Markdown preview
  renders, Esc closes) through a debug-only `-AletheUITestPreview` launch argument, since a link's
  position in the terminal is not reachable from XCUITest. Compiled.
- [x] **P2-15 (S) Agent page offer.** When an agent prints a local server URL, offer to open it in a web
  pane. *Tests:* U (detection), UI. *Parity:* BR-2.
  *Done:* Upstream offers pages an agent opens in its shared CDP browser, which the native app does
  not have (CDP: Won't port); the native offer comes from the terminal instead.
  `AletheTerminal/LocalServerDetector` scans output for local server addresses (localhost,
  127.0.0.1, 0.0.0.0 and [::] mapped to localhost, a port), ignoring escape sequences, catching an
  address split across chunks, reporting each once. `TerminalPaneView.onLocalServer` (scan on the
  PTY queue, report on the main actor); `TerminalRegistry.pageOffers` holds one offer per tab until
  taken or dismissed. `Terminals/PageOfferBar` over the terminal's top: "localhost:5173 is ready" —
  Open in Pane (web pane in the project) / Open in Browser / dismiss; `PaneView` follows the visible
  tab's offer through observation.
  *Tests (written, not run — owner decision 2026-09-24):* `LocalServerDetectorTests` (5), UI
  `PageOfferTests` (offer → web pane; dismissed once per address). Compiled.
- [x] **P2-16 (M) Container controls.** Collapse, fullscreen and reorder of project containers; isolate
  a pane. *Tests:* U, UI, HT; drag smoke script. *Parity:* WS-1.
  *Done:* `WorkspaceState` gains `collapsedProjectIDs`, `fullscreenProjectID`, `isolatedPaneID`
  (upstream `container.collapsed`, `fullscreenContainerId`, `isolatedPaneId`), decoded with defaults
  so v2 files load unchanged (no schema bump). Operations: `moveContainer` (its width moves with it),
  `setCollapsed`, `setFullscreen`, `isolate` (also shows the pane's project alone); closing a pane or
  project and `repair` clear stale state. `PaneHostView`: only the fullscreen container when set;
  collapsed containers are a 40 pt strip and the width is shared by the expanded ones (dividers only
  between expanded neighbors; collapsed ones keep their stored weight); dragging a container header
  (or strip) moves it, placed on release. `ContainerView`: collapsed strip
  (`CollapsedContainerStrip`: color, vertical name, click to expand), isolated pane filling the area.
  `ContainerHeader`: Collapse / Show This Project Alone ↔ Show All / Close. Pane header menu: Show
  This Pane Alone ↔ Show All Panes. View menu: Show Pane Alone ⇧⌘↩, Show Project Alone ⌥⌘↩. Not
  undoable (layout, like resizing).
  *Tests (written, not run — owner decision 2026-09-24):* `ContainerOperationsTests` (5), UI
  `ContainerControlsTests` (collapse/expand, project alone, pane alone, ⇧⌘↩). Owed: HT for the new
  header buttons at three zoom levels and a container-reorder case in `Scripts/smoke/pane-drag.sh`.
  Compiled.
- [x] **P2-17 (M) Workspace tabs and history.** Tabs of open workspaces, reopen closed tab (⇧⌘T), back
  and forward (⌘[ / ⌘]). *Tests:* U (port of `workspaceNavigation` cases), UI. *Parity:* WS-5.
  *Done:* `AletheModel/WorkspaceNavigation` ports upstream `workspaceNavigation.ts` and the navigation
  slices: `WorkspaceSnapshot` (open containers, widths, focus, selection, collapsed, fullscreen,
  isolated pane), `WorkspaceTab` (project or composition, pinned) and `WorkspaceHistoryEntry`.
  `WorkspaceState` gains `tabs`, `closedTabs`, `activeTabID`, `history`, `historyIndex`, decoded with
  defaults (no schema bump). Operations: `openInTab` (a project's own tab, reused; a project already in
  the view is only selected), `activateWorkspaceTab`, `workspaceTab(_:)` (wrapping), `togglePinned`,
  `moveWorkspaceTab`, `closeWorkspaceTab` (to the reopen list; next tab shown), `reopenClosedWorkspaceTab`,
  `navigateHistory`, `syncActiveTab` (the live view is written back to the active tab and the current
  history entry; a project tab showing more becomes a composition; with no tab, a non-empty view
  becomes the first one), `repairNavigation`. Limits 10 tabs (oldest unpinned dropped) and 50 history
  entries. `Workspace/WorkspaceTabBar` above the panes: back/forward, tabs with color, name and "+N",
  close on hover, pin/close menu, drag to reorder. Sidebar: a click opens the project's tab; ⌥-click
  adds it to the current tab (upstream `addProjectToWorkspace`). New History menu (Safari idiom): Back
  ⌘[, Forward ⌘], Show Next/Previous Tab ⌃Tab / ⌃⇧Tab, Close Workspace Tab, Reopen Closed Tab ⇧⌘T.
  *Deviation:* no terminal or group tabs yet (groups open with SB-3 work); composition tabs cover them.
  *Tests (written, not run — owner decision 2026-09-24):* `WorkspaceNavigationTests` (12, port of the
  upstream cases plus tab operations), UI `WorkspaceTabsTests` (tab per project, ⌘[ / ⌘], close,
  ⇧⌘T). Compiled.
- [x] **P2-18 (M) Spotlight and Sidebar layouts.** Layout picker per project; Auto stays the default.
  *Tests:* U (geometry), UI, HT. *Parity:* WS-3 (part).
  *Done:* `PaneLayoutMode` (auto, spotlight, sidebar) and `Project.layoutMode` (optional; nil is Auto,
  so older files decode unchanged). `PaneGridGeometry(mode:)`: Spotlight puts the first pane on the
  left (65 %) and stacks the others on the right (35 %); Sidebar stacks them on the left (22 %) with
  the first pane on the right (78 %), upstream's default panel sizes. The main/stack split is
  `.column(row: 0)` and the stack splits are `.row(i)`, so the existing live resize, rubber band and
  commit code works unchanged. `setLayoutMode` resets the project's custom track sizes. The Tauri
  import carries `layoutMode`. Container header: layout picker menu (icon of the current mode);
  View › Project Layout for the selected project. Switching modes animates the panes to their places.
  *Tests (written, not run — owner decision 2026-09-24):* `PaneLayoutModeTests` (5), UI
  `LayoutModeTests` (Spotlight/Sidebar/Auto frames; HT: picker at three zoom levels). Compiled.
- [x] **P2-19 (L) Custom grid + layout designer.** Cell merge/split, drag handles, per-scope layout
  history. *Tests:* U (port of `gridLayout` cases), UI; drag smoke script. *Parity:* WS-3.
  *Done:* `AletheModel/CustomGrid` ports `lib/gridLayout.ts` (`auto`, `reconciled`, `occupancy`,
  `freeCells`, `freeSpan`, `expanding`, `fillingFreeSpace`, `moving`, plus `resized` for the steppers)
  and `lib/layoutPresets.ts` (`CustomGridPreset`: balanced, columns, rows, focus left, focus top). Named
  `CustomGrid` because SwiftUI already has a `GridLayout`. `PaneLayoutMode.grid`; `Project.gridLayout`
  (cells keyed by pane id) and `gridLayoutHistory` (8 most recent, same grid kept once), optional
  fields. `setGridLayout(recordHistory:)`, `setTrackWeights` (a grid keeps its track sizes in the grid,
  the other layouts in `gridWeights`), `moveGridCell`, `fillFreeSpace`. `PaneGridGeometry` grid mode:
  spanning frames, dashed free slots, and dividers only where a boundary separates two cells
  (`.gridColumn` / `.gridRow` per run), so a spanning pane is never crossed by a handle; the live
  resize code is shared through `Divider.track`. `ContainerView`: free slots drawn (highlighted under
  a dragged pane); dropping a pane on another pane or a slot moves its cell (swap when occupied).
  `Editors/LayoutDesignerSheet` (upstream `LayoutDesignerModal`): column/row steppers (1…8), Auto
  Arrange, Fill Free Space, presets and recent grids, a canvas where boxes are selected, grown or
  shrunk from their edges (+/− only where it applies) and dragged onto slots; Save is undoable.
  Layout menu: Custom Grid and Design Grid…; pane header menu: Fill Free Space. The Tauri import keeps
  terminal ids as pane ids and carries `gridLayout`.
  *Deviations:* the group and workspace scopes of the designer are not ported (no group workspace
  yet; a workspace-wide grid of containers is left for later — WS-3 stays Partial). Upstream's live
  edge-drag handles on grid cells are replaced by the designer's edge buttons, Fill Free Space and
  track dividers.
  *Tests (written, not run — owner decision 2026-09-24):* `CustomGridTests` (14: the upstream cases,
  presets, geometry, document operations), UI `CustomGridTests` (preset + save + ⌘Z; grow from an
  edge), smoke `Scripts/smoke/grid-drag.sh` (pane onto a free slot, grid divider), `grid` UI seed.
  Compiled.
- [x] **P2-20 (M) Named project grids.** Several grids per project, switch and assign panes.
  *Tests:* U, UI. *Parity:* WS-4.
  *Done:* `AletheModel/ProjectGrids`: `ProjectGrid` (id, name, its own layout mode, custom grid and
  recent grids), `Project.grids` / `activeGridID`, `Pane.gridID` (all optional: older files decode
  unchanged). Panes with no grid form the main grid, whose layout stays in the project's own fields;
  `Project.activeArrangement` reads and writes the shown grid's layout, so every layout operation
  (P2-18, P2-19) works on the shown grid; `visiblePanes`, `weightsKey` (track sizes per grid).
  Operations: `gridNameProblem` (empty, taken case-insensitively, or a main-grid name in either
  language — upstream `validGridName`), `createGrid` (shown, empty), `renameGrid`, `activateGrid`,
  `movePane(toGrid:)` (its cell dropped so it lands in the first free slot), `deleteGrid(closingPanes:)`
  (keep → main grid, or close), `reveal` (activating a tab or isolating a pane shows its grid). New
  panes join the shown grid. UI: container header grid menu (shown grid's name; switch, New / Rename /
  Delete Grid…) once a project has a named grid, New Grid… in the layout menu before that; pane menu
  Move to Grid; sidebar project menu Grids. Prompts are alerts with a validated name field; deleting
  asks Keep Terminals / Close Terminals. The Tauri import carries grids, `activeGridId` and
  `terminal.gridId` (the mirrored layout fields go to the main grid only when it is the active one).
  *Deviations:* the sidebar does not list grids as tree nodes (upstream `ProjectGrids` rows); grids are
  switched from the container header and the project menu. The active grid is per project, not part
  of a workspace tab's snapshot.
  *Tests (written, not run — owner decision 2026-09-24):* `ProjectGridsTests` (6), UI `ProjectGridsTests`
  (create, switch, move a pane). Compiled.
- [x] **P2-21 (S) Flat mode and focus mode.** Flat workspace (no containers) and a focus overlay on one
  pane. *Tests:* UI. *Parity:* WS-2, WS-10.
  *Done:* Flat: `WorkspaceState.flat` (and in `WorkspaceSnapshot`, so each workspace tab keeps it;
  both decode without it). `PaneHostView` shows one header-less container holding every open project's
  shown panes in Auto (upstream `flat` → one `PaneArea`), each pane configured with its own project
  (`ContainerView` `owners`); a project shown alone still wins. Track sizes under
  `gridWeights["flat"]`. View › Flat Workspace. Focus mode (upstream `FocusOverlay`): the pane floats
  over a blurred, dimmed backdrop (`FocusBackdropView`, `NSVisualEffectView` + theme `bg` at 55 %) with
  32 × 24 pt margins; its container is raised above the backdrop and hides everything else of its own.
  Enter by double-clicking a pane header, its menu or View › Focus on Pane (⇧⌘F); leave with Esc (taken
  before the terminal, like upstream), a click on the backdrop or the same commands. Focus mode is
  `AppEnvironment.focusModePaneID` (not saved, like upstream's UI store) and ends when its pane closes.
  *Tests (written, not run — owner decision 2026-09-24):* UI `FlatAndFocusTests` (flat on/off; focus by
  double-click, Esc, ⇧⌘F, backdrop click). Compiled.
- [x] **P2-22 (S) Empty workspace launcher.** Quick actions when nothing is open. *Tests:* UI, HT.
  *Parity:* WS-13.
  *Done:* `Workspace/WorkspaceLauncher` replaces the empty state once the workspace is loaded
  (upstream `WorkspaceEmptyState` and the no-project card). With projects: rows with their shortcut
  keycaps — Open <selected project> (its workspace tab), New Terminal ⌘T, New Project ⌘N, Add Content
  ⇧⌘A, Reopen Closed Tab ⇧⌘T when there is one. Before the first project: agent chips (enabled agents,
  last one preselected), Open Folder as Project… (the folder's existing project is reused; the agent
  starts in a new pane, unrestricted when the preference says so; undoable) and a link to the New
  Project form. Find/Jump joins the rows with P2-25.
  *Deviation:* upstream's Graphify toggle on the card is left for Graphify's own task.
  *Tests (written, not run — owner decision 2026-09-24):* UI `WorkspaceLauncherTests` (first run, quick
  actions, HT at three zoom levels). Compiled.
- [x] **P2-23 (M) Disable and suspend.** Disable a terminal or project, suspend a group (SIGSTOP/SIGCONT),
  shown in the sidebar. *Tests:* U, UI. *Parity:* WS-14, SB-3.
  *Done:* `Pane.disabled`, `ProjectGroup.suspended` (optional; older files decode unchanged).
  `AletheModel/Suspension`: `setDisabled`, `setProjectDisabled` (every pane; disabling closes the
  container), `suspendGroup` / `resumeGroup` (every project of the group and its subgroups),
  `isProjectDisabled`, `isSuspended`, `projectIDs(inGroupTree:)`, `disabledTabIDs`. Runtime: a
  disabled pane starts nothing and shows `DisabledPaneOverlay` (Enable); `WorkspaceView` suspends the
  tabs of newly disabled panes through `TerminalRegistry.suspend` (process tree ended, saved output
  kept), so enabling replays the output and resumes the agent session like a relaunch. UI: pane menu
  Disable Terminal; sidebar tab menu Disable/Enable Terminal, project menu Disable/Enable Project,
  group menu Suspend Group… (confirmation alert, upstream `SuspendGroupModal`) / Resume Group; disabled
  terminals and projects dimmed with a pause icon, suspended groups marked. All undoable.
  *Deviation:* the plan said SIGSTOP/SIGCONT; upstream ends the processes (`suspend_session` kills the
  PTY tree and keeps the scrollback), which is what frees memory, so the native app does the same.
  *Tests (written, not run — owner decision 2026-09-24):* `SuspensionTests` (4), UI `DisableTests`
  (disable, enable, ⌘Z). Compiled.
- [x] **P2-24 (L) Resources: hibernation, priorities, RAM.** Memory per process tree, idle hibernation
  (scrollback kept, process resumed on focus), priorities, pressure handling, memory indicator.
  *Tests:* U (policy), P (memory per hibernated terminal). *Parity:* USE-3.
  *Done:* `AletheModel/ResourcePolicy` ports `resources.rs`: `ResourcePolicy` (modes manual — the
  default, never ends a terminal —, pressure — upstream `smart-lru`, one idle hidden terminal per check
  under critical pressure — and idle — native: every hidden terminal past its idle limit; idle limits
  and spawn grace clamped to upstream's ranges), `MemoryPressure.level` (5 % / 10 % of RAM with 1.25×
  hysteresis), `ResourceSupervision.candidates` (never mounted, focused, in spawn grace or recently
  active; shells first, then least recently used, then largest), `WorkspaceDocument.mountedTabIDs`.
  `PreferencesDocument.resourcePolicy` (optional). `AletheTerminal/SystemResources`: available memory
  (`host_statistics64`), physical footprint per process (`proc_pid_rusage`) and per process tree,
  background band for off-screen trees (`PRIO_DARWIN_BG`, undoable without privileges, unlike `nice`).
  `TerminalPaneView` exposes `processID`, `quietFor`, `startedAt`. `Terminals/ResourceMonitor`: every
  5 s and on macOS memory-pressure events (`DispatchSource.makeMemoryPressureSource`) it measures each
  running terminal's tree, rates pressure, moves off-screen terminals to the background band and back,
  and hibernates candidates when the policy allows. `TerminalRegistry.hibernate` ends the process and
  keeps the output; a hibernated terminal starts again — replaying its output and resuming its agent
  session — as soon as it is shown (upstream leaves a parked terminal for a manual restart). UI:
  toolbar memory indicator (terminals' total, tinted by pressure) with a popover (pressure, free of
  total, terminals and app memory, the 8 largest terminals, hibernated count, policy picker, Resource
  Settings…); Settings › Resources (policy, idle limits); sidebar marks hibernated terminals.
  *Deviations:* no memory history chart (upstream `MemoryAnalyticsModal` samples); spawn throttling
  (`spawnConcurrency`) is not ported — terminals start only when shown.
  *Tests (written, not run — owner decision 2026-09-24):* `ResourcePolicyTests` (9, the upstream cases
  plus idle mode and mounted tabs), P `SystemResourcesTests` (memory sane; a spawned process tree is
  measured and gives everything back once ended). Compiled.
- [x] **P2-25 (M) Find/Jump (⌘K).** Fuzzy search over projects, terminals and commands. *Tests:* U
  (ranking port), UI, HT. *Parity:* SET-10.
  *Done:* `AletheModel/FuzzyMatch`: every query character in order (spaces ignored), the match
  tightened to its shortest window, scored for consecutive runs, word starts (space, `-`, `_`, `/`, `.`,
  camelCase), the text start and exact case, minus spread, late start and length; `rank` keeps the best
  field per item and is stable, so an empty query keeps the given order. Upstream filters by substring;
  ranking is the native improvement the plan asked for. `Editors/FindJumpSheet` (History › Find or
  Jump… ⌘K, also a launcher row): one field over terminals (title, project, folder), projects and
  commands (`JumpCommand`: new terminal/project/group, add content, reopen tab, flat workspace, focus
  pane, layouts and Design Grid for the selected project, Tauri import, Settings — each with its
  shortcut shown, only when it applies); ↑/↓ move, ↩ or a click jumps (a terminal's project opens in its
  tab, the terminal is shown and focused), Esc closes, 50 results.
  *Tests (written, not run — owner decision 2026-09-24):* `FuzzyMatchTests` (5), UI `FindJumpTests` (jump
  to a project, run a command, nothing found + Esc, HT at three zoom levels). Compiled.
- [x] **P2-26 (S) Resume last session and close confirmation.** Reopen the last workspace or start
  clean; confirm quitting with running agents. *Tests:* UI. *Parity:* SE-2, SET-12.
  *Done:* Launch: the last workspace (tabs, view, terminals with their output and sessions) comes back
  by default; `PreferencesDocument.startClean` (Settings › General › Open with an empty workspace;
  upstream `alwaysStartOnHome`, there being no Home yet) runs `WorkspaceDocument.startClean` — nothing
  open, no active tab, the tab bar kept to pick from. Resume last session (upstream `resetLastSession`):
  Terminal › Resume Previous Conversations restarts every running agent on the conversation before its
  current one — `SessionResume.previous` (upstream `pickSessionId`: the newest other session,
  preferring those written before the current process started) over `SessionResume.sessions` (Claude
  Code, Codex); confirmation when several agents restart, a report of how many were resumed. Quit
  (upstream `useCloseConfirmation`): `applicationShouldTerminate` asks while terminals run — agents and
  shells counted — with a “Don't ask again” box; `PreferencesDocument.confirmQuit` (Settings › General).
  Debug instances on a throwaway data root skip it unless `-AletheConfirmQuit YES` (smoke scripts quit
  them with AppleScript).
  *Tests (written, not run — owner decision 2026-09-24):* `PreviousSessionTests` (3), UI
  `LaunchAndQuitTests` (quit asks and Cancel keeps the app; start clean after relaunch). Compiled.
- [x] **P2-27 (S) Visual style and motion.** Normal/clean style (sidebar Clean mode included) and the
  motion preference, which also follows Reduce Motion. *Tests:* UI, HT. *Parity:* UI-2, UI-3, SB-1.
  *Done:* `AletheDesign/VisualStyle` (normal, clean; upstream `visualStyle`): `Theme.styled(.clean)`
  neutralizes the accent-colored selection chrome (`accentSoft`/`accentFaint` → `panelHover`,
  `accentBorder` → `borderStrong`, `accentBorderSoft`/`borderAccent` → `border`, `accentRing` clear) and
  drops shadows, keeping the accent and status colors (upstream `visual-clean.css`); `Metrics` carries
  the style (Clean radii 3 / 4 / 6, still scaled) and `reducesMotion`. `PreferencesDocument.visualStyle`
  and `reducedMotion` (optional). `AppEnvironment` styles the theme and builds metrics from them, and
  follows macOS Reduce Motion live (`accessibilityDisplayOptionsDidChangeNotification`). Clean focused
  panes use a strong neutral border (`--clean-focus-border`); the sidebar goes compact
  (`sidebarRowSize` small; upstream `CleanProjectSidebar`). Reduced motion: `FrameAnimator` jumps,
  the sub-tabs lane and the focus backdrop stop animating. Settings › Appearance › Style and motion:
  Normal / Clean and Reduce motion (it says when macOS already reduces it).
  *Deviation:* upstream's motion preference drives the Home/loading ASCII animation, which the native
  app does not have yet; here it governs the app's own motion.
  *Tests (written, not run — owner decision 2026-09-24):* `VisualStyleTests` (4), UI `VisualStyleTests`
  (Clean compacts the sidebar and persists with reduced motion; HT at three zoom levels). Compiled.
- [x] **P2-28 (S) Changelog + phase review.** Parity matrix statuses; run upstream-watch; full test run.
  *Done:* `AletheNative/CHANGELOG.md` covers every Phase 2 task. Matrix (§8): every row scheduled for
  Phase 2 is Done except WS-3, Partial — the designer's group and workspace scopes (a workspace-wide
  grid of containers) are left open. §6.3 gains ⇧⌘↩ / ⌥⌘↩ and ⇧⌘F; ⌘K is Find/Jump without the ⇧⌘P
  alias. upstream-watch `2f3e5ed..origin/main` (2026-09-24): 0 commits — nothing to triage, baseline
  stays `2f3e5ed` (the run rewrote the same-day report with an empty range; the original was kept).
  *Full test run* (owner request, after P2-28): package 272/272 once two bugs were fixed (`./path` links
  lost their leading dot; git's capitalized “Not a git repository” was not recognized). UI first run 40/55:
  a container `accessibilityIdentifier` without `.accessibilityElement(children: .contain)` hid its
  children's identifiers (layout designer, Find/Jump, link preview, memory popover), a lazy stack hid
  Find/Jump rows, and `DocumentModel.update` woke observers (and rebuilt hosted pane views) even when a
  change left the document equal — now dropped; the rest were test queries (ambiguous menu items,
  Settings reopening on its last tab, header vs pane frames). Final: UI 53/55, three smoke scripts pass.
  The web address field “losing” the `c` of `/etc` was XCUITest, not the app: with the Brazilian - Pro
  layout, `typeText` sends `c` as ⌘C (a key probe saw the Command flag on every synthesized `c`); tests
  now enter such text through the pasteboard (`paste(_:into:)`). `AppearanceTests` could not screenshot
  `app.windows.firstMatch` (an invisible helper window); it captures the screen now. Final: UI 55/55.
  Open: tab close button accessibility frame off screen (VoiceOver).
  *Phase 2 exit check:* terminal and workspace rows at parity (WS-3's two scopes aside); terminals
  survive relaunch with their scrollback (P2-7); idle hidden terminals hibernate when the policy
  allows, resuming when shown (P2-24). Everything compiled; nothing verified by running tests.

**Phase 2 exit criteria:** every terminal and workspace feature of the parity rows above works at
parity, terminals survive relaunch with their scrollback, and idle terminals hibernate.

### Phase 3 — Agent ecosystem
Order: the agent roster and its settings first (everything else keys on agent kinds), then sessions
(resume, history, cost), then live agent state (hook bridge → titles, glyphs, notifications, handoff),
then usage and activity, then the Home dashboard that shows them with real data, then dictation.
Each task keeps older files decoding (optional fields or a migration). *Tests* list what the task must
ship; they run per the test cadence above.

- [x] **P3-1 (M) Remaining agent types.** Copilot, Antigravity, MiMo, Freebuff and Kiro (upstream
  `agentProviders.ts`): CLI command, unrestricted flag, resume arguments, launcher lookup, agent
  tokens and icons, New Terminal sheet, Tauri import. `wsl` stays Won't port. *Tests:* U (descriptors,
  arguments), UI (sheet lists them). *Parity:* AG-1.
  *Done:* `AgentRegistry.builtin` now lists upstream's agents in its order (`ALL_AGENT_TYPES`):
  Claude Code, Codex, GitHub Copilot (`copilot`, `--allow-all`), Cursor, Antigravity (`agy`,
  `--dangerously-skip-permissions`), OpenCode, Mimo (`mimo`, no unrestricted flag), Freebuff (`freebuff`,
  none), Kiro CLI (`kiro-cli`, `--trust-all-tools`), Shell. `AgentArguments`: Antigravity resumes with
  `--conversation <id>` (stale `--conversation`/`--continue`/`-c` dropped), Kiro runs everything under
  `chat` (its flags are rejected bare); Copilot, Mimo and Freebuff pass arguments through. The launcher,
  New Terminal sheet, Find/Jump and Tauri import read the registry, so they offer the new agents as they
  are; `AgentLabels` now reads the registry's display names; agent color tokens for Antigravity, Mimo,
  Freebuff and Kiro (Copilot has none upstream and uses the shell's). Resume of Antigravity sessions on
  disk comes with P3-6.
  *Tests (written, not run — owner decision):* `AgentRegistryTests` (roster, flags), `AgentArgumentsTests`
  (+3), UI `AgentRosterTests` (the sheet offers all ten). Compiled.
- [x] **P3-2 (M) Settings › Agents.** Per-agent row: enable/disable (hidden from sheets and Find/Jump
  when off), detected CLI path and version, Choose… / Reset override. *Tests:* U, UI, HT. *Parity:*
  AG-6, AG-4.
  *Done:* Settings › Agents (`Settings/AgentSettings`; upstream Preferences › Terminal enabled agents
  and CLI paths): one row per agent with an on/off toggle, its color and the version its CLI reports,
  the CLI path it will run (or “not found” in the status color), Custom + Reset when overridden, and
  Choose… (the same name check as the terminal's Choose CLI; the launcher cache is invalidated after a
  change). `AgentRegistry.enabled(_:setting:on:)` stores all-on as nil so agents added later start on;
  the shell cannot be turned off. `AletheAgents/CLIVersion` ports upstream `parse_version` and
  `cli_version_at`: `--version`, `-v`, `version` in turn, stdout and stderr, the CLI's folder first on
  PATH, a 5 s watchdog. Turned-off agents leave New Terminal and the launcher's first-project chips;
  their existing terminals keep working.
  *Tests (written, not run — owner decision):* `CLIVersionTests` (2), `AgentRegistryTests` (+1), UI
  `AgentSettingsTests` (an agent turned off leaves New Terminal; HT at three zoom levels). Compiled.
- [x] **P3-3 (L) Install, update and uninstall agent CLIs.** Toolchain probe (npm, Homebrew, pipx,
  curl installers per upstream `AgentInstall`), install/update/uninstall with a live log, version
  check against the latest release. *Tests:* U (recipes, probe parsing), UI (dry-run seed). *Parity:*
  AG-5.
  *Done:* `AletheAgents/AgentInstall` is the macOS edition of upstream `agentInstall.ts` and
  `agentVersions.ts`. Upstream's catalog is Windows-only (`irm … | iex`, WinGet, Scoop, Chocolatey), so
  each command is the one the vendor documents for macOS, checked on 2026-09-24: install scripts for
  Claude Code, Codex, Cursor, Antigravity, OpenCode, MiMo and Kiro; Homebrew for Claude Code, Codex,
  Copilot and OpenCode; npm for Claude Code, Codex, Copilot, OpenCode, MiMo and Freebuff.
  `InstallToolchain` (node version, npm, brew). Methods are filtered by the toolchain and ordered script
  → Homebrew → npm; uninstall is derived for Homebrew and npm only (install scripts document none —
  upstream's rule); `needsNode` and Node via `brew install node` or the download page;
  `AgentVersions.isOutdated` and `latest` (npm registry, GitHub releases for Antigravity; nil on any
  failure); `InstallLog.clean` (escapes out, CR to newline, 12 000-character tail).
  `Settings/AgentInstaller` runs one operation at a time app-wide, in the user's login shell (PATH as
  they have it, Alethe's inherited variables scrubbed, `NONINTERACTIVE=1` for Homebrew), streams the
  log, can stop the run (process tree), and verifies by looking the CLI up again — gone for uninstall,
  the version moved for an update. `Settings/AgentInstallSheet` (upstream `AgentInstallModal`): the
  methods this Mac can run with their exact commands, the log, the result, the vendor's install page.
  Settings › Agents: Install… when the CLI is missing; a menu with Update… (npm, when a newer release
  exists — upstream's rule) and Uninstall…; “x.y available” next to the version.
  *Tests (written, not run — owner decision):* `AgentInstallTests` (6), UI `AgentInstallTests` (the sheet
  in a debug dry-run mode that prints the command instead of running it). Compiled.
- [x] **P3-4 (M) New Terminal sheet completion.** Repeat last (⌥⌘T, upstream `lastTerminalCreation`),
  named-grid picker (P2-20), planner option; 9router moves with Phase 5 integrations. *Tests:* U, UI.
  *Parity:* AG-3.
  *Done:* `PreferencesDocument.lastTerminalCreation` (`TerminalCreation`: agent, a folder other than the
  project's, unrestricted, extra arguments; optional) is written by every New Terminal. File › New
  Terminal Like Last (⌥⌘T, upstream Ctrl+Alt+T) adds that terminal to the selected project without the
  sheet; with nothing to repeat, or the agent since turned off, it opens the sheet. The sheet gains a
  Grid picker when the project has named grids (P2-20): the chosen grid is shown first, so the pane
  joins it.
  *Deviation:* upstream's planner option is the orchestration mode (a canvas and its MCP wiring); it
  moves to Phase 6 with the Orchestrator (ORC). 9router moves to Phase 5.
  *Tests (written, not run — owner decision):* `TerminalCreationTests` (2), UI `NewTerminalLikeLastTests`
  (⌥⌘T repeats a shell without the sheet). Compiled.
- [x] **P3-5 (M) Model discovery.** Models each provider offers (upstream `discover_provider_models`),
  a model picker in the New Terminal sheet passed as the agent's model flag. *Tests:* U (parsers), UI.
  *Parity:* AG-9.
  *Done:* `AletheAgents/ModelDiscovery`: the model flag each agent documents (`--model` for Claude Code,
  Codex, OpenCode, Cursor and Copilot), `isValidModelID` and the `models` listing parser (first word of
  each line, prose and flags rejected — upstream `is_valid_model_id`), `discover` (the CLI's own
  `models` for Cursor, OpenCode and Antigravity, as upstream runs it, with an 8 s limit; Claude Code's
  documented aliases sonnet, opus, haiku, opusplan) and `arguments` (the model into the tab's extra
  arguments, replacing an earlier one). `CLIOutput` factors the short CLI call out of `CLIVersion`.
  New Terminal: a Model field (empty is the agent's default) with a menu of the discovered models,
  looked up off the main thread when the agent changes; the model rides in `extraArguments`, so it is
  resumed with the tab and repeated by ⌥⌘T.
  *Deviation:* upstream falls back to fixed lists when a CLI lists nothing, naming retired models
  (Claude 3.x, GPT-4o); the native picker leaves them out and takes any typed id instead.
  *Tests (written, not run — owner decision):* `ModelDiscoveryTests` (4), UI `ModelPickerTests`. Compiled.
- [x] **P3-6 (M) Resume for OpenCode, Antigravity and Cursor.** Session discovery on disk and resume
  arguments for the three (Cursor chat creation, upstream `create_cursor_chat`), joining Claude Code and
  Codex. *Tests:* U (fixtures per provider). *Parity:* SE-1.
  *Done:* `AletheAgents/MoreSessions`: `OpenCodeSessions` (`opencode session list --format json
  --max-count 50` run in the folder; entries of other directories skipped, `updated` in ms),
  `AntigravitySessions` (`~/.gemini/antigravity-cli/cache/conversation_metadata.json`: conversations whose
  `WorkspaceURIs` are the folder, inside it or around it; `UpdatedAt` or `last_modified_time`; preview
  kept for P3-7), `CursorChats` (`status` must show a login — `create-chat` otherwise waits forever —
  then `create-chat`, the id taken from the last line and accepted only as 16…64 hex characters and
  dashes, since it becomes a spawn argument). `CLIOutput.run` gains a working directory. `SessionResume`:
  Antigravity sessions are checked on disk before resuming; new sessions are discovered for Codex,
  OpenCode and Antigravity (`snapshot(_:cwd:executable:)`), and `sessions` covers Antigravity, so Resume
  Previous Conversations reaches it too. `TerminalRegistry`: a new Cursor tab first creates its chat
  (off the main thread, the tab waiting in `preparing`), stores the id and launches with `--resume`, so
  it resumes after relaunch; without a chat it starts as before. OpenCode's before-snapshot needs its
  CLI and runs alongside the launch — OpenCode records a session only with the first message.
  *Tests (written, not run — owner decision):* `MoreSessionsTests` (4, including upstream's Cursor id
  cases). Compiled.
- [x] **P3-7 (M) Conversation history and recent chats.** A sheet per project listing Claude Code and
  Codex conversations (title, date, size), opening one in a new tab that resumes it; recent chats
  across projects. *Tests:* U (listing), UI. *Parity:* SE-3.
  *Done:* `AletheAgents/ConversationHistory`: `JSONLReader` streams a JSONL file in 256 KB chunks,
  skipping lines past 4 MB whole and stopping when asked (transcripts run to many MB). Claude Code
  (upstream `list_claude_sessions`): every transcript of the project folder, with its `ai-title`, first
  user prompt (240 characters) and user + assistant message count — byte probes on each line, a full
  parse only for the lines that matter, as upstream avoids building every record. Codex: rollouts whose
  `session_meta` names the folder, titled by the first real user turn (injected `<tag>` blocks skipped,
  200 lines at most — upstream `get_codex_session_title`). `Editors/ConversationsSheet` (History ›
  Conversations… ⌘Y, the project's sidebar menu, Find/Jump): Claude Code or Codex, this project or all
  projects (upstream's recent chats), filter, newest first with relative date, messages and size, a mark
  on conversations already open in a tab. Open (↩, double-click, menu) shows the tab holding the
  conversation, or opens the project's tab with a new terminal resuming it (unrestricted toggle).
  Loading runs off the main thread.
  *Tests (written, not run — owner decision):* `ConversationHistoryTests` (4, fixture homes), UI
  `ConversationsTests`. Compiled.
- [x] **P3-8 (M) Session cost.** Token usage from transcripts with a pricing table (upstream
  `get_model_pricing`), OpenCode from `opencode.db` (SQLite, read-only), shown per tab and in history.
  *Tests:* U (fixtures, pricing). *Parity:* SE-4.
  *Done:* `AletheAgents/SessionCost` ports `agent_cost.rs`: `ModelPricing` (USD per million tokens by
  family — opus 5/25, sonnet 3/15, haiku 1/5 — cache writes 1.25× for 5 minutes and 2× for 1 hour, cache
  reads 0.1×; the table upstream ships), `SessionCost` (priced per model and summed, nil when nothing
  could be priced; the model with the most output named), `SessionCosts.claude` (every `message.usage`
  per model, the 5 m / 1 h cache split or the older single count), `codex` (the last cumulative
  `token_count`; tokens without a price), `openCode` (the `session` row of `opencode.db` through the
  system SQLite, opened read-only; OpenCode's own cost kept), `openCodeDatabase` (`opencode db path`, then
  its data folders), `transcript` (a Codex rollout found by file name, not by opening each). UI:
  `SessionCostView` (total, tokens, per-model table), Terminal › Session Cost… and the pane menu for the
  shown tab (`SessionCostSheet`, refreshable), and the selected conversation's cost under the
  Conversations list. All reading runs off the main thread.
  *Tests (written, not run — owner decision):* `SessionCostTests` (4, including a real SQLite fixture).
  Compiled.
- [x] **P3-9 (L) Agent hook bridge.** A local HTTP endpoint on Network.framework (loopback, random port,
  per-launch token) receiving Claude Code hooks and Codex notifications, wired per launch without
  touching the user's own settings where the CLI allows it (upstream `agent_hooks_*`,
  `codex_hooks_config_write`); events become each tab's state (working, waiting for input, done).
  *Tests:* U (event parsing, config writing), P (endpoint round trip). *Parity:* AG-8.
  *Done:* `AletheAgents/AgentHookServer`: the bridge endpoint on Network.framework (`NWListener` bound to
  127.0.0.1, a port the system picks — upstream tries 9123…9143 — and a per-launch token); a minimal
  HTTP/1.1 reader (`HTTPRequest`: request line, headers, `Content-Length` body up to 1 MB); `POST
  /hook/<agent>` with `X-Alethe-Token` and `X-Alethe-Tab` reaches the handler, anything else gets 401,
  404, 413 or 400. `AletheAgents/AgentHooks`: `AgentActivity` (idle, working, needs input, done),
  `AgentHookEvent` (Claude Code `SessionStart` / `UserPromptSubmit` carry the session — upstream
  `claudeSessionFromHook` — and mean idle / working; `Stop` is done; `Notification` is needs-input, except
  Claude's 60 s idle reminder; Codex `agent-turn-complete` is done), `AgentHookWiring` (a Claude settings
  file layered with `--settings`, which leaves the user's own settings alone — upstream
  `agent_hooks_settings_path`; Codex `-c notify=[…]` running a forwarder script that curls the event
  back, instead of upstream's edit of `.codex/config.toml`), `ActivityMonitor` (port of upstream
  `AgentCompletionMonitor`: a submitted prompt arms it, real output beyond the echo makes it working,
  4.5 s of quiet ends the turn). `AgentLaunchRequest.hooks` places `--settings` after Claude's session
  flags and the Codex override before `resume`. App: `Terminals/AgentHookHub` starts the endpoint before
  any terminal launches, writes the per-tab files in a private (0700) temporary folder and removes it on
  quit; `TerminalRegistry.activity` per running agent tab, from hooks and from `ActivityWatch` (the
  monitor fed by the terminal tap, ticking once a second; it does not end Claude's turns, whose `Stop`
  hook does); hook sessions rebind the tab's conversation after `/clear` or `/resume` (upstream
  `trackClaudeSessionHook`); `onActivityChange` for notifications (P3-11). Shown in P3-10.
  *Tests (written, not run — owner decision):* `AgentHooksTests` (7, including a P loopback round trip).
  Compiled.
- [x] **P3-10 (M) Live titles and busy/done glyphs.** Chat titles from the sessions (upstream
  `get_*_session_title`) in the sidebar, lane and tab bar; working / waiting / done glyphs with unread
  completion (upstream `completionUnread`). *Tests:* U, UI. *Parity:* SB-5.
  *Done:* `ConversationHistory.title` (upstream `get_claude_session_title` / `get_codex_session_title`:
  Claude's generated title or first prompt, Codex's first prompt; ids with a slash refused).
  `TerminalRegistry`: `titles` per agent tab, read off the main thread when a tab starts with a session
  and whenever it finishes or asks something; `displayName(of:)` (the tab's own title, else the
  conversation's, else the agent) used by the sidebar, the sub-tabs lane and the pane header; `unread`
  (upstream `completionUnread`): set when an agent finishes or asks while its tab is not the focused
  pane's shown tab in the active app, cleared when that tab comes to the front or the app becomes
  active on it. `Terminals/AgentStatusGlyph`: a pulsing dot while working (static with reduced motion),
  a question bubble when it waits for an answer, a dot when it finished unseen — next to the name in the
  sidebar and the pane header, and on the lane item.
  *Deviation:* unread completions are kept for the session, not saved (upstream persists the flag).
  *Tests (written, not run — owner decision):* `ConversationHistoryTests` (+1). Compiled.
- [x] **P3-11 (M) Notifications.** UserNotifications when an agent finishes or waits for input while its
  pane is not in view, 5 s dedupe, clicking jumps to the tab; an in-app list for Home. *Tests:* U
  (dedupe, routing), UI. *Parity:* SET-9, HOME-5 (data).
  *Done:* `AletheModel/NotificationLog` (upstream `uiStore.notifications`: 12 newest, the same title
  and body within 5 s dropped, an unseen count). `Terminals/AgentNotifier` follows
  `TerminalRegistry.onActivityChange`: when an agent finishes or needs an answer and its tab is not the
  focused pane's shown tab in the active app, an entry ("Claude Code finished", the hook's message or
  "<tab> in <project>") joins the list; with Alethe in the background it also goes to macOS through
  UserNotifications (permission asked on first use, threaded per tab). Clicking the macOS notification
  or an entry opens the tab's project, shows the tab and reads its completion. Toolbar bell (badged while
  there are unseen entries) with `NotificationList`, which Home reuses (P3-15). Settings › General › Notify
  me when agents finish or need an answer (`PreferencesDocument.notifyAgents`, on by default).
  *Deviation:* no transient in-app toasts (the Mac idiom is the bell and Notification Center); limit-reset
  and Pomodoro notifications arrive with their features (P3-13, Phase 7).
  *Tests (written, not run — owner decision):* `NotificationLogTests` (2), UI `NotificationsTests`. Compiled.
- [x] **P3-12 (L) Claude Code ↔ Codex handoff.** Prepare a handoff from one agent's conversation,
  materialize it for the other and continue in a new sub-tab (upstream `HandoffModal`,
  `prepare/materialize/complete_agent_handoff`, `handoffs/`). *Tests:* U (handoff documents), UI.
  *Parity:* AG-7.
  *Done:* `AletheAgents/Handoff` ports `handoff.rs`: events from Claude Code transcripts (side chains
  left out) and Codex rollouts — user and assistant text (8 000 / 5 000 characters), tool calls (1 200),
  tool output (800); the capsule (original task, latest request, up to 12 more user instructions, the
  last 18 events, the workspace's git state, what was lost; 48 000 characters at most) with upstream's
  wording, so the receiving agent reads the same packet; secret redaction (API keys, JWTs, private keys,
  auth headers, `*TOKEN=` style assignments); the source transcript (the tab's session, or the folder's
  newest, flagged); `materialize` writes the reviewed capsule atomically to
  `<profile>/handoffs/<id>/context.md` (64 KB at most); capsules older than 7 days are pruned at launch.
  `Editors/HandoffSheet` (upstream `HandoffModal`): counts of included, omitted and redacted events, the
  capsule to review and edit with its size, the privacy note, the unrestricted toggle; Continue in <agent>
  opens a new terminal of the other agent in the same project whose first prompt is upstream's bootstrap
  prompt pointing at the capsule. Entry points: Terminal › Continue in the Other Agent… and the pane menu,
  for Claude Code and Codex tabs.
  *Deviation:* upstream removes a capsule when its handoff completes; here capsules age out after 7 days
  (the agent may re-read it). Remote-question extraction (for remote control, Phase 7) is not ported.
  Also fixes a P3-11 test that did not compile.
  *Tests (written, not run — owner decision):* `HandoffTests` (5). Compiled.
- [x] **P3-13 (L) AI usage.** Claude Code, Codex and Antigravity usage (limits, windows, resets) with
  their caches, usage pills in the toolbar, the AI Usage sheet, Codex reset credit and a notification
  when a limit resets (upstream `*UsageCache.ts`, `AiUsageModal`, `ResetCreditModal`). Tokens are read
  where the CLIs keep them and never logged. *Tests:* U (parsers, cache), UI. *Parity:* USE-1.
  *Done:* `AletheAgents/AIUsage` ports the three usage readers: Claude Code (`/api/oauth/usage` with the
  OAuth token from `CLAUDE_OAUTH_TOKEN`, `~/.claude/.credentials.json` or Claude Code's Keychain item; 5h,
  7d and 7d Opus windows), Codex (`account/rateLimits/read` over `codex app-server` JSON-RPC: windows
  named from their length, plan, available reset credits; `account/rateLimitResetCredit/consume`),
  Antigravity (`fetchAvailableModels` with the token from its Keychain item, refreshed through `agy models`
  on 401; models bucketed by remaining quota and reset, named by family), and `resets(from:to:)` for
  windows that were at the limit and came back. Tokens are never logged. App: `UsageMonitor` refreshes
  the providers shown in the toolbar every 5 minutes (none until the user turns a pill on, since reading
  the Keychain can prompt) and all of them when AI Usage opens, keeping the last good figures on a
  failure; `UsagePills` in the toolbar (busiest window, tinted with the status tokens); `AIUsageSheet`
  with every window, when it resets, the Codex plan and reset credits (with confirmation), per-provider
  pill toggles and the limit-reset notification toggle; resets post through `AgentNotifier`.
  *Deviation:* the figures are cached in memory only (upstream persists them); a relaunch fetches again.
  *Tests (written, not run — owner decision):* `AIUsageTests` (6; ran once while writing them). Compiled.
- [x] **P3-14 (M) Activity tracking.** Active time per agent and project sampled into
  `activity-stats.json` (upstream `activityTracker.ts`), summaries by day and agent, clear.
  *Tests:* U (sampling, summaries). *Parity:* USE-2.
  *Done:* `AletheModel/ActivityStats` ports `activity_stats.rs`: samples (duration capped at 15 s, app in
  front, user active, the project and terminal in front, each agent's working/waiting state) added into
  per-day totals — app open/focused, user active/idle, agent wall time vs. summed time, background agent
  time, parallel time and peak concurrency, per agent and per project — in `activity-stats.json`
  (version 1, upstream's camelCase keys, atomic writes); summaries over any set of days; `lastDays`.
  App: `ActivityTracker` samples every 5 s (user active = input in Alethe in the last 5 minutes; agent
  working from the hook bridge / heuristic activity, P3-10), writes every 30 s, when Alethe goes to the
  background and before quitting, off the main thread through `ActivityStore`; a failed write keeps the
  last 360 samples. Settings › General › Clear Statistics (with confirmation).
  *Tests (written, not run — owner decision):* `ActivityStatsTests` (4; ran once while writing them). Compiled.
- [x] **P3-15 (L) Home dashboard.** Greeting, recent projects, quick actions, a mini-terminal quick
  launch, activity graph and time analytics (P3-14), usage strip (P3-13), notifications (P3-11); ⇧⌘H
  toggles Home ↔ workspace and a preference opens on Home. The ASCII background only if it passes the
  motion and accessibility rules. *Tests:* U (greeting, summaries), UI, HT. *Parity:* HOME-1, HOME-2,
  HOME-3, HOME-5.
  *Done:* `Home/HomeView` (upstream `HomeView`), all real data: greeting by hour (`Greeting`) with the
  macOS user's first name and the date; the quick launch (a prompt field that grows while focused, agent,
  project and permission mode; ⌘↩ opens a new terminal of that agent in the project with the prompt as its
  first input and shows the workspace); recent projects (`WorkspaceDocument.recentProjectIDs`: navigation
  history newest first, then open and tab-bar projects, then sidebar order; up to 6 cards that open the
  project in its tab); start actions (new terminal, project, group, Find/Jump); the usage strip (P3-13 —
  providers without a toolbar pill are read only on request, since the Keychain may prompt); the activity
  graph (`AletheAgents/ActivityDays`, upstream `get_multi_agent_activity`: Claude Code messages, Codex
  rollouts and OpenCode messages per UTC day over 13 weeks, intensity in quartiles of the busiest day,
  streak); time analytics (P3-14: today / 7 / 30 days / all — active, agents working, background, idle,
  by agent, top projects; includes samples not yet written); the notifications list (P3-11); repository
  links. ⇧⌘H (View › Show Home / Show Workspace) and a toolbar house button switch; opening a terminal
  from Home returns to the workspace; Settings › General › Open on Home. Entrance in three staggered
  steps, none under reduced motion; colors from theme tokens only.
  *Deviation:* the ASCII background is not ported — decorative, animated, and it would compete with the
  text under reduced transparency and contrast settings; no avatar (the name comes from macOS); Now
  Playing waits for Spotify (Phase 7).
  *Home visual parity (2026-10-16):* owner chose a hybrid look — native window, toolbar and sidebars,
  web styling inside the content area. Home now follows the web layout (centered hero, 940 pt content
  cap, 620 pt terminal-style launcher, two-column recent cards) on the shared `AletheDesign` controls,
  and a startup screen covers the window until `AppEnvironment.load()` returns. Remaining differences:
  no ASCII backdrop or avatar, SF Symbols instead of Lucide, system menus, opaque surfaces instead of
  backdrop blur, and a launcher prompt that grows past 42 pt while focused.
  *Tests (written, not run — owner decision):* `HomeDataTests` (2), `ActivityDaysTests` (2) (ran once
  while writing them); UI `HomeTests` (⇧⌘H toggles; quick launch opens a terminal). Compiled.
- [x] **P3-16 (M) Setup walkthrough.** First-run steps on Home (agents found, a first project, a first
  terminal), dismissible and resumable (upstream `SetupWalkthrough`). *Tests:* UI. *Parity:* HOME-4.
  *Done:* `AletheModel/SetupWalkthrough` (`SetupStep`: agents, project, terminal, appearance; `SetupProgress`
  completes steps from what exists — an enabled agent's CLI resolves, a project, a terminal pane — plus
  those marked by hand in `PreferencesDocument.setupDone`). `Home/SetupWalkthroughView` on Home under
  the quick launch (upstream `SetupWalkthrough`): progress, each step opens what does it (Settings ›
  Agents, New Project, New Terminal, Settings › Appearance — which marks the step), Hide
  (`setupHidden`); Help › Show Setup Steps brings it back and shows Home. Settings now opens on a given
  pane (`AppEnvironment.settingsTab`).
  *Deviation:* upstream has two steps (project, appearance); the agents and first-terminal steps are the
  plan's.
  *Tests (written, not run — owner decision):* `SetupProgressTests` (1; ran once while writing it), UI
  `SetupWalkthroughTests` (hide, then Help brings it back). Compiled.
- [x] **P3-17 (L) Dictation.** Apple SpeechAnalyzer (ADR-7a) instead of Parakeet: microphone permission,
  toggle and hold (⌥⌘E, §6.3), text into the focused terminal or field, language from the
  interface language. *Tests:* U (state machine), UI (permission-denied path). *Parity:* PER-6.
  *Done:* `AletheFoundation/DictationMachine` (idle → starting → listening → finishing; toggle on a short
  press, hold past 0.4 s stops on release, Esc cancels, failures: microphone denied, language
  unsupported, unavailable). `Dictation/DictationEngine`: `AVAudioEngine` tap converted with
  `AVAudioConverter` to `SpeechAnalyzer.bestAvailableAudioFormat`, `SpeechTranscriber` with volatile
  results, the language's model installed on first use through `AssetInventory`; stop finalizes through
  the end of input. `DictationController`: ⌥⌘E down/up through a local event monitor (Edit › Dictate for
  clicks), microphone permission via `AVCaptureDevice`, the target captured at start — a terminal gets
  the words typed without Enter (`TerminalPaneView.type`), a text field through `NSTextInputClient` —
  final segments inserted with a separating space; language = interface language in the user's region.
  `DictationHUD` at the bottom of the window: words so far, model download, the failure with Open System
  Settings (microphone) and Dismiss; the pulse stops under reduced motion. The app is now signed with
  `com.apple.security.device.audio-input` (`Alethe/Alethe.entitlements`) and has a localized
  `NSMicrophoneUsageDescription` (`InfoPlist.xcstrings`; the strings gate skips code-key rules there).
  Debug flag `-AletheDictationDenied YES` simulates a denied microphone.
  *Deviation:* no Fn-Fn — macOS owns it for system Dictation, which also works in Alethe's fields; ⌥⌘E
  only (⌥⌘D, the plan's first choice, is macOS's global Dock hiding shortcut — found by the UI test). No `CaptureInputSequenceProvider` yet (ADR-7a lists it as a macOS 27 option).
  *Tests (written, not run — owner decision):* `DictationMachineTests` (3; ran once while writing them),
  UI `DictationTests` (denied path). Compiled. Needs a manual check with a real microphone.
- [x] **P3-18 (S) Changelog + phase review.** Parity matrix statuses; run upstream-watch; full test run.
  *Done:* `AletheNative/CHANGELOG.md` covers every Phase 3 task. Matrix (§8): every row scheduled for
  Phase 3 is Done (HOME-1 without the ASCII background or avatar; PER-6 without Fn-Fn). upstream-watch
  `2f3e5ed..origin/main` (2026-09-25): 0 commits, baseline stays `2f3e5ed`.
  *Full test run* (2026-09-25): package 336/336 once three bugs were fixed — the control-sequence
  regexes of `InstallLog.clean` and `ActivityMonitor.stripControls` used `\u{1B}`, which ICU rejects, so
  nothing was stripped (and the no-hook activity heuristic counted escape codes as output); the JSONL
  reader let through a line that ended just past its size limit; a Handoff test expected one redaction
  where the capsule repeats the request. UI 66/67 on the first full run: the dictation test found that
  ⌥⌘D is macOS's global Dock hiding shortcut and never reaches the app — dictation moved to ⌥⌘E; its HUD
  moved into the detail column (over the whole split view AppKit took the clicks) with a larger dismiss
  button. Then UI 67/67 for the changed test; smoke sidebar-drag, pane-drag and grid-drag pass (grid-drag
  failed twice right after pane-drag and passed alone — intermittent, the app from the previous script
  likely still quitting). Two earlier attempts stopped at a Touch ID prompt: Automation Mode had reverted
  to requiring authentication. Also fixed from a screenshot: the empty-workspace agent chips were squeezed
  into one row and broke letter by letter — they now wrap (`FlowLayout`).
  *Phase 3 exit check:* all agents upstream supports on macOS are in the registry, install (P3-3) and
  resume (P3-6); working / needs-input / done, cost and usage show live with notifications (P3-8 – P3-13);
  Home shows real data (P3-15). Open: dictation with a real microphone and the earlier manual checks.

**Phase 3 exit criteria:** every agent upstream supports on macOS runs, installs and resumes; agents'
state (working, waiting, done, cost, usage) shows live with notifications; Home shows real data.

**After Phase 3 — relaunch fix (`cc34697`).** Owner report: after relaunch an agent terminal showed the
previous run's screen stacked over the new one. Agent terminals now start clean (the resumed agent
redraws its own conversation); only shells replay saved output (P2-7). The PTY spawns at the pane's real
size (deferred spawn), focus reports are dropped while the TTY is cooked and echoing, and an exit that
happens before the process source registers is still reaped (it hung eight PTY tests). Package suite
green, app builds.

### Phase 4 — Plugins, Git and review
Order: the plugin API and its host surfaces first (Git, Todos and the theme pack are built-in plugins on
the public API, ADR-9), then Git — a `git` CLI layer, Git Control, the graph, incoming/outgoing — then
the file explorer, then worktrees and the Merge Center that builds on them, then pull requests, then
Todos + Pomodoro and the theme pack, then the ExtensionKit spike for third-party plugins. Git runs the
user's `git` and `gh` (no libgit2), off the main thread, cancelable. Destructive steps (discard, reset
--hard, force cleanup, delete) ask once; the rest is undoable or reversible. Upstream's JavaScript
plugins (catalog, local install, `plugin_*` storage for JS) stay Won't port; third parties go through
ExtensionKit (§11.4). *Tests* list what each task must ship; they run per the test cadence above.

- [x] **P4-1 (L) `AlethePluginKit` v1.** Versioned Swift API (ADR-9): `AlethePlugin` with a manifest (id,
  version, name, capabilities) and `activate(context:)`; contribution points — sidebar tab (left or
  right), command (menu and Find/Jump), theme, pane kind, sheet, settings page, agent provider; declared
  capabilities enforced by the context (git, filesystem read/write, terminal input, network, storage);
  per-plugin storage (`plugin-data/<id>.json`, atomic, debounced); a host registry with enable/disable
  that survives relaunch and isolates a failing plugin. Built-ins register statically.
  *Tests:* U (registry, capabilities, storage). *Parity:* EXT-3 (partial).
  *Done:* target `AlethePluginKit`: `@MainActor` `AlethePlugin` with a static `PluginManifest` (id,
  version, name, capabilities, `apiVersion` 1.0, `enabledByDefault`) and `activate`/`deactivate`;
  `PluginContext` collects contributions (views referenced by `viewID`, no UI in the package); services
  in `PluginServices` throw `undeclaredCapability` unless declared; `PluginStorage` actor writes
  `plugin-data/<id>.json` debounced via tmp + rename; `PluginHost` persists enable/disable in
  `plugins.json` and marks a plugin failed (invalid/duplicate id, incompatible API, `activate` throws)
  without affecting others. U 16/16. App wiring comes with P4-2.
- [x] **P4-2 (M) Plugins settings and view placement.** Settings › Plugins (upstream `PluginsPage`):
  each plugin with version, capabilities, enabled toggle and its error; plugin settings pages. View
  placement (upstream `viewPlacement.ts`): move a contributed tab between the left sidebar and the
  right one and reorder it, persisted (`viewPlacements`). *Tests:* U (placement), UI. *Parity:* SB-8,
  EXT-3.
  *Done:* the app owns a `PluginHost` of built-ins (Theme Pack), state in the profile's `plugins.json`,
  loaded before preferences publish so a saved pack theme shows on the first frame; the theme picker lists
  built-ins then plugin themes. Settings › Plugins: name, version, capabilities, enable toggle, load error.
  `ViewPlacements` (side + order of contributed tabs) persisted in `plugins.json`, U 7; the drag UI comes
  with P4-3. Open: plugin settings pages, Tauri import still validates built-in theme ids only.
- [x] **P4-3 (M) Right sidebar.** An inspector column (⌥⌘0, width persisted; upstream `RightSidebar`)
  showing contributed tabs plus the project's Markdown docs and plans (list, open in a pane, recent
  history). GSD and MCP tabs arrive with Phase 5. *Tests:* UI, HT. *Parity:* SB-7.
  *Done:* right sidebar (⌥⌘0, View menu; open state and width persisted) shows right-side plugin tabs in
  `ViewPlacements` order through an app `viewID` registry. `TodosPlugin` registered: Todos tab (project and
  global lists, add with `#tag`, done, inline rename, delete, drag reorder) with a Pomodoro pill (1 s tick);
  View › New Todo reveals it. Markdown lists the project's files (3 levels, 200 files, skips
  hidden/build/deps), opens them inside the inspector with closable tabs, file drops, refresh, source
  copying, path, Back and Close; Open in pane remains undoable. Strip order follows the web: Markdown,
  available GSD, contributed right tabs, feature-gated MCP, PRs and Agents, then Mac Todos and extensions.
  Files is removed from the inspector; Close hides it and MCP Maximize opens its manager. Agents reads
  orchestrator snapshots and native subagents, scopes to the focused terminal or all jobs, sorts by
  status and supports approval answers, Stop and opening the board. PR rows show Send to Todo or
  Already added. No persistence changes.
  Open: Claude plans, Jev history and Plugins catalog need backend support. Agent model/effort chips
  need fields absent from native `JobSnapshot`; only the known agent is shown. Existing tab placement,
  tag editing, focus todo and phase-end notification gaps remain. Validation: strings gate, Swift
  syntax parsing and diff checks pass; Debug build and UI harness are blocked before compilation by
  sandbox-denied SwiftPM/Clang cache writes. Runtime behavior still needs review outside the sandbox.
  ai-memory recording unavailable in this worktree/session (no CLI or connected memory tool).
- [x] **P4-4 (L) Git layer.** `AletheGit` over the `git` CLI (upstream `git_control.rs`): repository
  discovery, status (porcelain v2 incl. renames, conflicts, submodules), diff and diff summary,
  branches, stage/unstage/discard, commit, pull/push/fetch with progress and credentials left to git,
  init, log graph, show commit files/message, cherry-pick, revert, reset, branch from commit,
  incoming/outgoing; typed errors, cancellation, one queue per repository, a file watcher to refresh.
  *Tests:* G (temporary repositories, upstream's cases). *Parity:* groundwork for GIT-1…5.
  *Done:* target `AletheGit` runs the user's `git` (PATH, `/opt/homebrew/bin`, `/usr/local/bin`,
  `/usr/bin`) off the main thread; task cancellation terminates it; `GIT_TERMINAL_PROMPT=0`, no stdin.
  One `GitRepository` actor per root (shared via `GitRepositories`) chains calls in order. Discovery,
  init (upstream seeding), porcelain-v2 status (renames, conflicts, submodules, ahead/behind), diff +
  numstat, branches, stage/unstage/discard, commit/amend, fetch/pull/push with streamed progress,
  paginated decorated log, commit files/message, cherry-pick, revert, reset, branch from commit,
  incoming/outgoing; typed `GitError` (+ `invalidArgument` for unsafe paths/hashes/branches);
  `GitWatcher` (FSEvents, debounced, ignores objects/locks). Pure parsers. G+U 26/26.
- [x] **P4-5 (L) Git Control.** Built-in plugin (upstream `plugins/git-control`): changes grouped
  staged/unstaged/conflicts, stage or discard per file or all (discard asks), commit message with ⌘↩,
  amend, branch switcher, pull/push/fetch with status, diff of a file in the diff pane (P2), init for a
  folder without a repository. *Tests:* U, UI. *Parity:* GIT-1.
  *Done:* Git Control is a sheet (project context menu, History menu): staged / unstaged+untracked /
  conflicts, stage/unstage per file and all, discard behind a confirmation, commit (⌘↩) with amend, branch
  switcher, fetch/pull/push with progress, refresh via `GitWatcher`, Initialize Repository, inline errors,
  a file's diff in a new diff pane (repository paths made folder-relative, `7369910`). Not a PluginHost
  plugin yet; no branch creation; no U/UI tests yet.
  *Done (plugin, `b8f5ab7`):* target `AletheGitControl`: `GitControlPlugin` (`com.alethe.git-control`,
  `git` capability) contributes the "Git Control…" command and sheet; the app opens plugin sheets via
  `.pluginSheet(viewID:project:)`, and disabling the plugin hides its menu entries. Branch switcher › New
  Branch… (git naming rules + exists check, optional switch). Pure helpers (grouping, folder-relative
  paths, branch names) moved to the package. Tests written and compiled, NOT run: U (helpers, plugin
  contributions), UI `GitControlTests` (seed `git`). Open: plugin commands in Find/Jump.
- [x] **P4-6 (L) Commit graph.** Lanes laid out like upstream `GitGraph` (merges, branch and tag
  labels, HEAD), a lazy list for long histories, commit detail (message, files, diff), actions:
  cherry-pick, revert, reset soft/mixed/hard (hard asks), branch from commit, copy SHA.
  *Tests:* U (lane layout, golden against upstream fixtures), UI. *Parity:* GIT-2.
  *Done (model):* `GitGraphLayout` in `AletheGit` ports upstream `buildGraphRows`: first parent keeps the
  lane, extra parents open the first free lane, round-robin color per branch; rows carry lanes before/after,
  top/bottom edges, pass-throughs, refs; `append(_:hasMore:)` paginates with open lanes. Deliberate
  difference: a merge into an already-open lane draws its curve. U 11. Graph view, detail, actions owed.
  *Done (UI, `65fe7e6`):* Git Control › History: Canvas lanes (edges, pass-throughs, merge curves; dot or
  ring for merges), lane colors from agent/status tokens with lane 0 on the accent, up to 2 ref badges + "+N",
  pages of 200 via `append`, commit detail (SHA, message, files), actions Copy SHA, Cherry-pick, Revert,
  Branch from Commit, Reset Soft/Mixed/Hard (Hard asks). Open: a past commit's file diff (the diff pane
  only diffs the working tree); U/UI tests.
- [x] **P4-7 (S) Incoming/outgoing.** Commits ahead of and behind the upstream branch with fetch, as a
  Git Control section (upstream `IncomingOutgoing`). *Tests:* G, UI. *Parity:* GIT-3.
  *Done:* incoming/outgoing sections in Git Control (up to 50 each), refreshed after fetch.
- [x] **P4-8 (L) File explorer.** A sidebar tab (upstream `FileExplorer`): lazy tree with file-type
  icons, git badges (P4-4), rename, move to Trash (confirmation only when the Trash is unavailable),
  new file/folder, Quick Look on Space, open in a pane (Markdown, media, text, web), drag to a pane or
  grid slot, reveal in Finder, live refresh (FSEvents). *Tests:* U (tree model, badges), UI.
  *Parity:* FS-1.
  *Done (model):* target `AletheFiles`: lazy `FileTree` (folders first, case-insensitive, flat visible
  rows, refresh re-reads open folders, debounced watcher via `GitWatcher`), SF Symbol icon map and pane
  kind per file (upstream map; HTML/PDF open in the web pane), git badges with upstream priorities and
  folder aggregation, validated rename/new/Trash (`.trashUnavailable` lets the UI confirm a permanent
  delete). Upstream hides nothing; only `.DS_Store` is hidden by default. U 13. Sidebar tab UI owed.
  *Done (UI, `32cecdb`, `f4a1148`):* right sidebar Files tab: lazy tree, icons, git badges on status
  tokens, live refresh, click opens the matching pane (else the default app), menu Open / Open with Default
  App / Quick Look / Reveal in Finder / inline Rename / New File / New Folder / Move to Trash (confirms only
  without a Trash); Space = Quick Look. Open: badges miss git-only changes when the repository root is above
  the project folder (watcher is on the folder); drag to a pane; UI tests.
- [x] **P4-9 (L) Worktrees.** Worktree isolation per agent (upstream `worktrees.rs`): provision, list,
  remove, lock/unlock, fetch branch, commit pending changes, cleanup; `autoWorktree` / `worktreeMode` /
  `worktreeAgentId` on new terminals and the New Terminal sheet; the sidebar marks worktree terminals.
  *Tests:* G, UI. *Parity:* GIT-4.
  *Done (model):* `GitWorktrees` in `AletheGit` ports `worktrees.rs`: `<repo>/.alethe/worktrees/<id>/` on
  `alethe/agent-<id>` as a linked worktree or `clone --local`; provision, list (porcelain parser), remove
  (refused while locked), lock/unlock, fetch branch, pending changes, commit pending (skips `.planning/`,
  `.opencode/`, `opencode.json`), cleanup (drops orphan dirs, then prune); typed `GitWorktreeError`;
  `WorktreeSettings` (`autoWorktree`, `worktreeMode`, agent id; shells never). U+G 10. New Terminal /
  sidebar UI owed.
  *Done (UI, `869c499`):* New Terminal › "Run in its own worktree" (agents only; worktree or local copy)
  provisions before the tab exists (the tab id is the agent id), inline errors; `PaneTab.worktreeAgentID`
  / `worktreeBranch` (optional, old `workspace.json` decodes, U 2); sidebar branch symbol + tooltip; tab
  menu Commit Worktree Changes… / Remove Worktree (asks once). Open: project `autoWorktree`/`worktreeMode`
  settings, lock/cleanup in the UI, UI tests.
  *Done (settings + sheet, `9b2cd9a`):* `Project.autoWorktree` / `worktreeMode` (`ProjectWorktreeMode`,
  optional, old `workspace.json` decodes, imported from Tauri) edited in the project editor and used as
  the New Terminal defaults. Project menu › Worktrees…: branch, mode, path, lock state/reason; Lock…/Unlock,
  Fetch Branch (local copies), Commit Pending…, Remove (asks once, refuses locked; tabs go back to the
  project folder), Clean Up Stale (asks once). Tests written and compiled, NOT run: U 4
  (`ProjectWorktreeSettingsTests`), UI `WorktreesTests` (seed `worktrees`).
- [x] **P4-10 (L) Merge Center — analyze.** `merge_analyzer` port (path classes, strategies), the
  sidebar merge panel and merge tree (upstream `SidebarMergePanel`, `MergeTree`), the Merge Center
  sheet shell with its stages. *Tests:* U (golden against upstream fixtures), UI. *Parity:* GIT-5.
  *Done (model):* target `AletheMerge` ports `merge_analyzer.rs`: 12 path classes (Sentinel before
  Planning) with upstream's strategy text; `MergeAnalyzer.analyze` trial-merges in a throwaway detached
  worktree `.alethe/merge-envs/analyze-<id>`, always removed; `MergeAnalysis` keeps upstream field names;
  `MergeCenterStage` (clean analysis skips to validate). U+G 7. Event Bus events, panel/tree/sheet UI owed.
  *Done (sidebar + resume, `2ddd409`):* each project row lists its in-progress merges from
  `.alethe/merge-envs/` (re-read every 4 s, no git): source → target, stage, conflict count, conflicts as a
  tree by folder or class. Clicking reopens the Merge Center on that environment at its stage with its last
  validation (`MergeMeta` gained optional `stage`, `lastValidation`, `contractWarnings`; upstream metadata
  still decodes). Resolve with Agent offers installed enabled agents (last used, else Claude Code).
  Tests written and compiled, NOT run. Open: live conflict count; Event Bus events.
- [x] **P4-11 (L) Merge Center — prepare.** Prepare and rebase onto the target (upstream
  `conflict_resolution.rs`), conflicts listed with open-in-diff and agent-assisted resolution in a
  terminal, cancelable long steps. *Tests:* G (conflict scenarios), UI. *Parity:* GIT-5.
  *Done (model):* `ConflictResolution` in `AletheMerge` ports `conflict_resolution.rs`: `prepare` builds
  worktree `alethe/merge-<id>` under `.alethe/merge-envs/`, `merge --no-commit --no-ff`, lists conflicts,
  writes `<id>.json` + `ALETHE_CONFLICT.md` (upstream prompt verbatim); `rebaseOntoTarget`, `preflightAbort`,
  `abort`; progress via `MergePrepareStep`; cancellation stops git and tears down (force-remove + prune).
  G+U 6. Sheet stage UI, agent terminal launch, Event Bus events owed.
- [x] **P4-12 (L) Merge Center — validate.** Validation (build/test commands per project), health
  probe, contract check, branch testing (upstream `BranchTestingModal`), results kept per merge.
  *Tests:* G, UI. *Parity:* GIT-5.
  *Done (model):* `MergeValidation` (per-project commands + suggested ones from `package.json`,
  `Cargo.toml`, `Package.swift`, `go.mod`; sequential `/bin/sh -c`, stops at first failure, cancelable, no
  commands = "unverified"; results Codable per merge) and `HealthProbe` (free port, poll URL, always kills).
  G+U with P4-13. Open: upstream's contract check and the probe's terminal step are not ported; the probe
  kills the shell but not servers it spawned (use the process-tree kill when wired in the app).
  *Done (`a861721`):* Test Branch… sheet (project menu, History menu, Analyze): temporary worktree under
  `.alethe/branch-tests/`, validation + optional health probe + contract check, always cleaned up; last 10
  results per branch in `results.json`. Contract check ported from `contract_check.rs` (4 upstream golden
  tests); Validate/Finish show structured results. The health probe runs as a process-group leader and kills
  its whole tree. Tests written and compiled, NOT run. Open: `terminalVerified`, saved per-project
  validation commands, BranchTestingModal's manual checklist and "send feedback to agent".
- [x] **P4-13 (L) Merge Center — finish.** Finalize, abort, preflight abort, force cleanup (asks once),
  confirm worktree commit (upstream `ConfirmWorktreeCommitModal`), worktree removal after merging.
  *Tests:* G, UI. *Parity:* GIT-5.
  *Done (model):* `MergeFinish`: finalize (blocks on markers/unresolved files, validation + optional
  probe, commit, fast-forward the checked-out target, reports nothing-to-integrate/diverged, removes the
  env only on success), abort, preflight abort, force cleanup (only under `.alethe/merge-envs`, flagged to
  confirm once), pending worktree changes committed with a confirmed message, worktree removal after
  merging (only under `.alethe/worktrees`). 16 tests (12 G). Sheets UI owed.
  *Done (Merge Center UI, `02124a5`, `e6bb660`, `cc89cb4`):* sheet from the project menu and History menu
  with the Analyze → Prepare → Validate → Finish header. Analyze trial-merges two local branches (progress,
  cancel forwarded to git) and lists conflicts with class + strategy; Prepare builds the environment (a clean
  merge still prepares, since Validate/Finish need it), Resolve with Agent, refresh, rebase onto target, abort
  (asks once); Validate runs per-run editable commands with output; Finish merges; force cleanup asks once.
  Open: Resolve with Agent always uses Claude Code; results are plain text; a closed sheet does not resume;
  the sidebar merge panel/tree and branch testing sheet; U/UI tests.
- [x] **P4-14 (M) Open pull requests.** A sidebar tab with the user's PRs (`gh search prs
  --involves=@me`; upstream `PullRequestsSidebar`): status and checks, open in the browser, send to a
  Todo (P4-16); a clear state when `gh` is missing or signed out. *Tests:* U (parsing), UI. *Parity:*
  PR-1.
  *Done (model):* `GitHubPullRequests` in `AletheGit`: locates `gh`, typed ready/missing/signed-out from
  `gh auth status`, upstream's `gh search prs` list parsed purely; review decision, checks and head SHA come
  from a per-PR `gh pr view` (search cannot return them) merged in; `squashMergeArguments(pr:headSHA:)`
  builds the P4-15 guard. U 11. Sidebar tab, per-row details, send-to-Todo owed.
  *Done (UI, `05c7d16`):* right sidebar Pull Requests tab: list off main, per-row checks/review/draft
  loaded lazily, badges on status tokens, click opens the browser, menu Open / Copy URL / Send to Todo;
  states for gh missing (`brew install gh`), signed out (`gh auth login`), no PRs, errors. Open: per-row
  details are not cached across refreshes; UI tests.
- [x] **P4-15 (L) PR review and squash merge.** Review a PR with an agent in a terminal (upstream
  `PullRequestReviewModal`; review agent and model preferences), squash merge guarded by the reviewed
  head SHA (`gh pr merge --squash --match-head-commit`). *Tests:* U, UI. *Parity:* PR-2.
  *Done (UI, `c8452bd`):* PR row › Review with Agent… fetches the current head SHA, picks an installed
  agent (last used, else Claude Code) and optional `--model`, opens a terminal in the selected project with
  upstream's review prompt (reads the PR with `gh pr diff`/`gh pr view`, never commits/pushes/merges) and
  records the reviewed SHA. Squash Merge… is enabled only after a review, confirms PR + SHA, runs
  `gh pr merge --squash --match-head-commit`; a moved head shows gh's error and asks to review again.
  Open: reviewed SHAs and agent/model choice are in memory only; U tests for the prompt.
- [x] **P4-16 (L) Todos.** Built-in plugin (upstream `plugins/todos`): global and per-project lists,
  tags, PR links, reorder, the external `todos.jsonc` template (`ensure_todo_template`) and settings.
  *Tests:* U (store, file round-trip), UI. *Parity:* PER-1.
  *Done (model):* target `AletheTodos`: `Todo`, `TodoScope`, `TodoRules`, `TodoSettings`; `@Observable`
  `TodoStore` (upstream ordering: active above done, drags never cross) persisted via `PluginStorage`;
  `ensure_todo_template` port (`alethe-todo.template.jsonc`) with a JSONC reader/writer; `TodosPlugin`
  (`com.alethe.todos`, right tab `todos`, `todos.new`). Also P4-17's `PomodoroTimer` (Codable, injected
  dates, `focusTodoId`). U 16. Views, app registration and string localization owed.
  *Done (UI, `ce1a0ff`):* todo menu › Edit Tags, Move to Global / <project>, Open Pull Request; Todo
  Settings (template folder Choose/Clear creates `alethe-todo.template.jsonc`, Open/Import/Export, Pomodoro
  lengths 1–120 min, Reset to Default List; destructive steps ask once). Template I/O now goes through the
  plugin's declared `filesystemRead`/`filesystemWrite` services. Tests written and compiled, NOT run.
- [x] **P4-17 (M) Pomodoro.** Timer in the Todos panel and a toolbar pill (upstream `PomodoroWidget`),
  focus todo (`focusTodoId`), work/break lengths, the session surviving relaunch, a notification at the
  end (P3-11). *Tests:* U (timer state), UI. *Parity:* PER-2.
  *Done (UI, `5b5c514`):* focus todo from the todo menu (cleared when done/deleted); app-wide
  `PomodoroController` ticks every second; phase-end notification through the P3-11 notifier (a phase that
  ended while closed is reported once after relaunch); toolbar pill while running/paused opens Todos. Also
  `84c4dbe` (Files badges watch the repository `.git` above the project folder) and `3bf13d2` (reviewed PR
  SHAs + review agent/model in `pull-request-reviews.json`). Tests written and compiled, NOT run
  (U + UI `TodosTests`).
- [x] **P4-18 (S) Theme pack.** Upstream's four theme-pack themes as a data plugin on the theme
  contribution point, in the picker with the built-ins. *Tests:* U (tokens complete), HT. *Parity:* UI-1.
  *Done (package):* target `AletheThemePack`: `ThemePackPlugin` (`alethe.theme-pack`) contributes Dark
  Lemon, Orca, Ember and Golden Premium (converted by `convert-themes.py --theme-pack`, upstream layering
  over the dark base); `ThemeCatalog.merging(_:)` appends valid contributed themes, dropping id clashes.
  U 5/5. App registration + picker come with P4-2.
- [x] **P4-19 (M) ExtensionKit spike.** The app's extension point, a sample third-party extension in
  its own signed app (a sidebar tab rendered remotely with `EXHostViewController`, a command, storage
  through the host), capability prompts on first enable, crash isolation. Outcome recorded in ADR-9;
  in-process bundles stay rejected unless the spike fails. *Tests:* UI (sample loads, a crash is
  contained). *Parity:* EXT-3.
  *Done (spike, `141ad74`, `25e0edc`):* API verdict recorded in ADR-9; `AletheExtensionHost` bridge
  (capability mapping, API version check, third parties start disabled, Codable consent ledger that re-asks
  only for new capabilities, `isAllowed` for XPC requests), U 10. Open: an Xcode extension-point + sample
  extension target, the load and crash-containment UI tests.
  *Done (host + sample, `5d35af4`, `681da4d`, `360a2dc`):* the app declares its extension point
  (`com.kc1t.alethe.mac.sidebar-tab`, `EX_ENABLE_EXTENSION_POINT_GENERATION = YES`), discovers extensions,
  lists them in Settings › Plugins with first-enable consent, renders an enabled extension's right-sidebar
  tab with `EXHostViewController`, and serves storage + commands over XPC (`AletheExtensionSDK` message
  types, requests checked by the consent ledger); an interruption shows a stopped state with Reload. Sample
  `Samples/AletheSampleExtension` (sandboxed app + appex: tab, command, storage, debug Crash button) builds
  and signs; `exutil` drops the generated binding with several inputs, so the sample declares it in its
  Info.plist. UI `ExtensionKitTests` compiled, NOT run. Open (needs a real run): whether macOS accepts the
  self-signed extension without approval, XCUITest reaching controls inside the remote view, the crash
  signal reaching the host; auto-disable after repeated crashes.
- [x] **P4-20 (S) Changelog + phase review.** Parity matrix statuses; run upstream-watch; full test run.
  *Done (review, 2026-09-25):* all Phase 4 tasks implemented. Round 1 ran the package suite (498 green);
  round 2 (owner: compile only) added tests that are written and compiled but NOT run: package
  `swift build --build-tests`, app `build.sh Debug` and UI `build-for-testing` all succeed. upstream-watch:
  0 upstream commits since `2f3e5ed`. Parity rows updated below. Still owed: running the package suite and
  `Scripts/uitest.sh`, a manual pass of all Phase 4 UI, and the rare `AletheTerminalTests` hang
  (time-limited, root cause open).

**Phase 4 exit criteria:** Git Control, the graph and the Merge Center cover upstream's flows on real
repositories; the file explorer, worktrees and PRs work from the sidebar; Todos, Pomodoro and the theme
pack run as built-in plugins on the public API; a sample ExtensionKit plugin loads and is isolated.

### Phase 5 — Integrations
Order: groundwork first — the `AletheIntegrations` target with its config-file primitives, the
comment-preserving TOML editor, feature toggles (every Phase 5 surface is gated by one) and per-launch
MCP wiring — alongside the self-contained project, app-data and chrome tasks (clone and marker, project
config export, open in, CLI shim, profiles, backup, logs and crash report, app icon, toolbar); then the
integration services (MCP model and adapters, skills, agent library, Graphify, ai-memory, Playwright
browser, GSD Sync); then the MCP store, health and registry and the Graphify and GSD views; last the MCP
manager UI and onboarding, which show everything before them. Principles: every file read, CLI call and
network request runs off the main thread and is cancelable, with a timeout for external CLIs (the user's
`graphify`, `ai-memory`, `npx`, `opencode`, `claude`/`codex mcp`); config files outside the profile
(`~/.claude.json`, `.mcp.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`, `opencode.json(c)`,
`~/.gemini/…`, `.claude/agents`) are written atomically (tmp → rename) after a backup (10 per file,
upstream `MAX_BACKUPS`), keep every key and comment Alethe does not own, and are re-read before each
write so an outside edit is never overwritten blind; per-launch wiring (`--mcp-config`, `-c` overrides,
as P3-9 did for hooks) is preferred over editing the user's or the project's files; destructive steps
(uninstall, remove, rollback, reset, wipe, import over existing data) ask once, the rest applies at once
with undo; secrets (MCP env values, tokens) are masked in the UI, revealed only on request, never
logged (OSLog `.private`) and never written into backups outside the profile. Files the Tauri app wrote
(`gerado pelo Alethe` markers, `.alethe/project.json`, `.alethe/graph-snapshots/`) stay recognized.
Out of Phase 5: 9router (PER-5, Phase 7), planning audit and autocommit (ORC-3, Phase 6), the Agent
Canvas palette (EXP-1, Won't port). *Tests* list what each task must ship; they run per the test
cadence above.

- [x] **P5-1 (M) `AletheIntegrations` target and config-file primitives.** New package target (ADR-7)
  with `ConfigFileWriter`: read with modification date, atomic write that refuses when the file changed
  since it was read, backup first into `<profile>/config-backups/<agent>-<kind>/` pruned to 10 (upstream
  `mcp_store.rs` `backup`/`prune_backups`/`atomic_write`), list and restore a backup; a JSON editor that
  changes one key path and keeps the rest (upstream `json_upsert`/`json_remove` over `serde_json::Value`,
  key order kept); the JSONC reader moved from `AletheTodos` (`TodoTemplate`) to `AletheFoundation` and
  shared; `Secret.mask` (upstream `mask_secret`). No UI. *Tests:* U (write conflicts, backup rotation,
  JSON edits keep unknown keys, JSONC). *Parity:* groundwork for EXT-1, EXT-4, EXT-5, EXT-6, EXT-7.
  *Done:* (`e9008db`) target `AletheIntegrations`: `ConfigFileWriter` (refuses if contents or mtime
  changed since read, atomic write keeping permissions and symlink targets, owner-only backups in
  `<profile>/config-backups/<agent>-<kind>/` pruned to 10, list/restore that backs up first),
  `OrderedJSON` + `JSONConfigEditor` (key order and number spelling kept, managed-key upsert, throws
  `notAnObject` instead of replacing), `Secret.mask`; the JSONC reader moved to `AletheFoundation`
  (`TodoTemplate` uses it). Tests written and compiled, NOT run.
- [x] **P5-2 (L) Comment-preserving TOML editor.** In `AletheFoundation` (§10 risk): a table-level
  document model that keeps comments, blank lines, key order and formatting byte for byte outside the
  edited table; read tables, arrays, inline tables and strings; upsert and remove a table
  (`[mcp_servers.<name>]` with its `env` subtable and inline forms), set one key (`enabled`). Upstream
  uses `toml_edit` (`mcp_agents.rs` `codex_upsert`/`codex_remove`/`codex_set_enabled`,
  `graphify_codex_config_write`). *Tests:* G (upstream's Codex cases plus `toml_edit` round-trip cases:
  a file edited and edited back is unchanged; untouched tables byte-identical), U (malformed input is an
  error with a line, never a partial write). *Parity:* groundwork for EXT-1.
  *Done:* (`6a8a2a2`) `AletheFoundation/TOML`: parser that records every header, key line, blank line
  and comment and enforces redefinition rules (errors give line/column, never quote the file);
  `TOMLDocument` `upsertTable`/`removeTable`/`setValue`/`removeValue`: untouched text byte-identical,
  changed values keep key spacing and trailing comments, tables keep section or inline form, new tables
  after siblings, removal takes subtables and the comment above; each edit re-parses its result or
  throws unchanged; arrays of tables refused. Tests (upstream Codex cases and
  `graphify_codex_config_write` as goldens, round trips, CRLF, malformed input) written and compiled,
  NOT run.
- [x] **P5-3 (S) Feature toggles.** `PreferencesDocument.enabledFeatures` (browser, graphify, mcp,
  playwright, orchestrator, gsdSync, aiMemory, prs; upstream `lib/features.ts` defaults: browser,
  graphify, mcp and prs on), `Features.isOn(_:)`, Settings › Features (upstream `FeaturesPage`: title,
  description, secondary ones under “Show more”, a slot under each feature for its options, used by
  P5-17…P5-19). The web pane entry points and the Pull Requests tab are gated now; later tasks gate their
  own surfaces. Imported from Tauri. *Tests:* U (defaults, decoding without the key), UI (turning PRs
  off hides the tab). *Parity:* SET-2.
  *Done:* (`13f81a7`) `PreferencesDocument.enabledFeatures` with upstream defaults (browser, graphify,
  mcp, prs on); `Features.isOn(_:)`; unknown upstream keys kept on save; imported from Tauri. Settings ›
  Features: one toggle each, Graphify / GSD Sync / AI Memory under Show 3 More, `FeatureOptions` slots
  for P5-17/18/19/24. Browser off hides web-pane entry points (Add Content › Web, ⌥-click, link menu and
  page bar Open in Pane, HTML in Files); PRs off hides the Pull Requests tab. Open web panes are not
  closed. Tests (U + UI `FeatureTogglesTests`) written and compiled, NOT run.
- [x] **P5-4 (M) Per-launch MCP wiring.** `AgentLaunchRequest.mcpServers` (name, command, arguments,
  environment): Claude Code gets one `--mcp-config` file per launch in the P3-9 private folder (upstream
  `graphify_mcp_config_path`, `ai_memory_mcp_config_path`, `playwright_mcp_config_path`); Codex gets
  `-c mcp_servers.<name>.command=…`/`args=[…]` overrides instead of upstream's `.codex/config.toml`
  write; OpenCode gets `OPENCODE_CONFIG` pointing at a per-launch file if it merges with the project's
  config, otherwise upstream's `opencode.json` `mcp` entry through P5-1. Providers register with an
  app-side `McpLaunchWiring` (Graphify, ai-memory, Playwright plug in later). *Tests:* U (arguments per
  agent, ordering next to `--settings` and `resume`, quoting). *Parity:* groundwork for EXT-5, EXT-6,
  BR-3.
  *Done:* (`f3d67d9`) `AletheAgents/McpLaunch.swift`: server model, Claude/OpenCode config formats,
  Codex `-c mcp_servers.<name>.*` args (names sanitized to letters/digits/_/-). Claude gets `--mcp-
  config=<file>` before `--settings`; Codex args before `resume`; OpenCode `OPENCODE_CONFIG` (verified
  in the installed 1.18.26 bundle: global → OPENCODE_CONFIG → project, deep-merged, so no
  `opencode.json` fallback; a user-set OPENCODE_CONFIG is replaced for that launch). App
  `McpLaunchWiring` registry (providers from P5-17/18/19) writes per-launch files 0600 in the P3-9
  private folder. Tests written and compiled, NOT run.
- [x] **P5-5 (M) New project: clone, marker, git init, stack.** Project editor (upstream
  `NewProjectModal`, `EditProjectModal`): Clone from GitHub (`normalize_github_url`, `git clone` with
  progress through `AletheGit`, cancel removes the partial folder); `.alethe/project.json` read when a
  folder is picked (offers to restore the saved name, color, agents and worktree settings) and written on
  save (upstream `read/write_project_marker`, same shape); Initialize Git for a folder without a
  repository; stack detection (`project_detector.rs`: web, desktop, backend, fullstack, CLI, unknown)
  shown in the editor and feeding the Merge Center's suggested validation. *Tests:* U (URL
  normalization, marker round-trip against an upstream file), G (stack fixtures from upstream's tests),
  UI (clone of a local bare repository). *Parity:* SB-2.
  *Done:* (`2986e4c`) project editor Local Folder / Clone from GitHub (`owner/name`, GitHub or git URLs,
  local paths; into `~/Alethe` or a chosen folder; progress; Cancel removes the partial folder). Picking
  a folder reads `.alethe/project.json` (upstream shape) and offers to restore it; saving writes it back
  keeping unknown keys and leaving out machine-local ids. Initialize Git for non-repositories; stack
  detection keeps upstream's five kinds (web, cli, desktop, fullstack, unknown — a backend-only project
  is `cli` like upstream) and feeds the Merge Center's suggested validation. Optional
  `Project.githubURL` (old workspace.json loads). Tests (U + UI `ProjectCloneTests`, seed `clone`)
  written and compiled, NOT run.
- [x] **P5-6 (S) Export/import project config.** Project menu › Export Settings… / Import Settings…
  (upstream `sidebarMenus.tsx`): the project's settings (not terminals or scrollback) as JSON through the
  save/open panels; import shows what changes and applies with undo. *Tests:* U (round-trip, unknown
  keys ignored), UI. *Parity:* SB-4.
  *Done:* (`a81f089`) project menu › Export Settings… / Import Settings…: name, color, worktree
  settings, layout and repository URL (no terminals or scrollback) with upstream's key names, so files
  move both ways with the Tauri app; import ignores unknown keys, lists the changes, asks once and is
  undoable. Tests (U + UI `ProjectSettingsTests`) written and compiled, NOT run.
- [x] **P5-7 (S) Open in VS Code, Finder, browser.** Project and terminal menus: Open in VS Code (the
  `code` CLI through the launcher resolver, else `NSWorkspace` by bundle id; upstream `open_in_vscode`),
  Reveal in Finder (exists for projects; add terminals' folders), Open in Browser for the project's web
  URL (upstream `open_in_browser`); a clear message when VS Code is missing. *Tests:* U (resolution),
  UI (menu items). *Parity:* SB-6.
  *Done:* (`4ff98d8`) Open in VS Code (`code`, else VS Code / Insiders / VSCodium app, else a message)
  in the project and sidebar terminal menus (not the sub-tab lane menu); Show in Finder for a terminal's
  folder; Open in Browser uses the cloned URL, else the `origin` remote, else a message. Tests (U + UI
  `OpenInTests`) written and compiled, NOT run.
- [x] **P5-8 (M) `alethe` CLI shim.** Settings › General › Command Line Tool: install, reinstall when
  stale, uninstall, status (path, on PATH or not) — upstream `cli_shim.rs`: a POSIX script in
  `~/.local/bin` that opens the app with the folder, marked so a
  stale shim is detected. The app takes the target on cold start and while running
  (`application(_:open:)`, arguments; upstream `cli_launch.rs` `resolve_target_dir`: `.`, relative paths,
  a file → its folder, `-psn_` skipped) and shows the matching project or offers New Project prefilled.
  A compiled `alethe` target (ADR-7) only if the script cannot cover it. *Tests:* U (shim text, quoting,
  target resolution with upstream's cases), UI (open request for a known folder selects the project).
  *Parity:* TERM-11.
  *Done:* (`6b7c921`) Settings › General › Command Line Tool installs, reinstalls (stale: app path or
  format marker changed) and removes `~/.local/bin/alethe`, asking first, no admin rights, never
  deleting a file Alethe did not write; PATH checked against the login shell (5 s) with a copyable
  `export` line. The shim runs `open -a <App> "$target"` (not `-na`: a second instance quits itself).
  The app takes folder opens via `application(_:open:)` / `--open-path` (folders declared as an
  Alternate document type in `Alethe-Info.plist`), showing the project or a prefilled New Project.
  `CLIShim`/`CLILaunch` in `AletheFoundation` with upstream's target-resolution cases. Tests (U + UI
  `CLIOpenTests`) written and compiled, NOT run.
- [x] **P5-9 (M) Profiles UI.** Settings › Profiles (upstream `ProfilesModal`, `profiles.rs`): list with
  summaries (projects, terminals, size on disk), create, rename, duplicate, delete (asks once; never the
  active one), switch (saves, then relaunches through `AppRelaunch` into the new profile); the toolbar
  profile menu (UI-7). Model from P1-3. *Tests:* U (index operations, name normalization), UI (create,
  rename, delete). *Parity:* SET-3.
  *Done:* (`6e510c8`) profile index create/rename/delete/switch/duplicate (names trimmed, 64 chars,
  case/accent-insensitive uniqueness; active or last profile not deletable). Settings › Profiles lists
  projects, terminals and size on disk; delete asks once and moves to the Trash; switch asks once, saves
  and relaunches. Toolbar `ProfileToolbarMenu` (reused by P5-13). The app now keeps the profile it
  launched with, so quit-time scrollback/handoff files never land in the new profile. Tests (U 12, UI 2)
  written and compiled, NOT run.
- [x] **P5-10 (M) Backup, import, reset.** Settings › General › Data (upstream `backup.rs`,
  `diagnostics.rs`): Export Backup (the active profile as a `.zip` through `ditto`/Apple Archive,
  skipping runtime files as upstream `is_excluded_from_backup`), Import Backup (validates the archive,
  shows what it holds, asks once, replaces the profile and relaunches), Reset Profile Data and Erase All
  Alethe Data (ask once, relaunch), Open Data Folder. *Tests:* U (export/import round-trip in a temporary
  root, exclusions, a corrupt archive is refused before anything is removed), UI (dialogs, no action
  without confirmation). *Parity:* SET-4.
  *Done:* (`3a11a19`) Settings › General › Data: export the active profile as a `.zip` (`ditto`, skips
  temp/logs/caches, `alethe-backup.json` manifest, never inside the profile); import validates first
  (unsafe paths and symlinks refused, staging folder, Finder archives accepted, Tauri or newer backups
  explained) and shows the contents; Import / Reset Profile Data / Erase All Alethe Data ask once, save
  a safety backup to `<data root>/safety-backups/` (10 kept) and relaunch; the operation applies at next
  launch before anything loads (runs before diagnostics start). Tests (U 12, UI 2) written and compiled,
  NOT run.
- [x] **P5-11 (L) Logs, diagnostics and crash report.** `os.Logger` per domain (terminal, agents, git,
  integrations, persistence; values `.private`); errors shown to the user are also recorded (upstream
  `logging.rs` `record_app_event`, `AuditModal`) and listed in Help › Diagnostics… (recent errors, export
  as JSON — SET-11 replaced); Export Logs (this run from `OSLogStore`, earlier runs from a small rotating
  file of warnings and errors, the spawn log; upstream `export_logs`), Open Logs Folder. Crash report
  (upstream `crash_watch.rs`): a clean-exit marker in `last_session.json`; after an unclean exit the next
  launch offers the newest `DiagnosticReports/Alethe-*.ips` and MetricKit crash diagnostics to view or
  export. *Tests:* U (marker states, export assembly, secrets absent), UI (the after-crash notice with a
  seeded marker). *Parity:* SET-4, SET-11, USE-4.
  *Done:* (`ac91d10`) `AletheFoundation/Diagnostics`: `os.Logger` per domain with private values;
  warnings/errors kept in memory (300) and in rotating `alethe.log`; `spawn.log` records env names only;
  `SecretRedactor` strips keys/tokens (sk-, GitHub, Slack, AWS, Google, JWT), Bearer headers, URL
  passwords and secret-named `key=value` from logs and exports. Help › Diagnostics… (list, JSON export,
  Clear), Export Logs… (zip with this run's OSLog entries), Open Logs Folder (`<data root>/logs/`,
  shared by profiles). A clean-exit marker (`last_session.json`) drives an after-crash notice offering
  the newest `Alethe-*.ips` and MetricKit data to view or save; never sent. User-visible errors across
  Git, Files, Merge, PR review, Todos and web panes are recorded. Tests (U + UI `CrashNoticeTests`)
  written and compiled, NOT run.
- [x] **P5-12 (S) App icon themes.** Upstream's four (`elite-original`, `elite-pure-black`,
  `elite-indigo`, `elite-blush`; `src/assets/theme-icons/`) as app resources, picked in Settings ›
  Appearance and applied with `NSApp.applicationIconImage` (the bundle is never modified: it would break
  the signature); `appIconTheme` imported from Tauri. *Tests:* U (preference), HT (picker at three zoom
  levels). *Parity:* UI-4.
  *Done:* (`ebe8cfe`) new `Alethe/Assets.xcassets` with upstream's four icons copied unchanged from
  `src/assets/theme-icons/`; the Dock icon is set at runtime (`NSApp.applicationIconImage`), the bundle
  is never modified (so the icon shows only while running); Settings › Appearance › App Icon, default
  elite-indigo with upstream fallback; imported from Tauri. Tests (U + UI in `AppearanceTests`) written
  and compiled, NOT run.
- [x] **P5-13 (M) Toolbar configuration.** The window toolbar becomes customizable (SwiftUI
  `.toolbar(id:)`, View › Customize Toolbar…; upstream `TopbarSettingsModal`): usage pills per provider,
  memory, Pomodoro, notifications, profile, Home; visibility priorities on macOS 27 (ADR-7a).
  P3-13's `usagePills` maps onto the pill items so AI Usage's toggles keep working; upstream `topbarShow*`
  imported. Remote and 9router items arrive with Phase 7. Needs P5-9. *Tests:* U (migration of `usagePills`), UI
  (hide and restore an item), HT. *Parity:* UI-7.
  *Done:* (`f10b473`) the main toolbar is customizable (`.toolbar(id: "main")`, `ToolbarCommands` ›
  Customize Toolbar…) with nine items: Home, Pomodoro, Claude/Codex/Antigravity usage pills, AI Usage,
  Notifications, Memory, Profile (P5-9 `ProfileToolbarMenu`); pills overflow first (visibility
  priorities on 26.1+, `lowerThan:` on 27). Settings › Toolbar toggles each item (a separate tab so
  Appearance stays within the screen at 120 % zoom); `toolbarItems` stores differences only; preferences
  v2 migrates P3-13's `usagePills` (older builds open v2 read-only); upstream `topbarShow*` imported.
  Tests (U + UI `ToolbarSettingsTests`) written and compiled, NOT run.
- [x] **P5-14 (L) MCP model and agent adapters.** `AletheIntegrations` port of `mcp_model.rs` and
  `mcp_agents.rs`: `McpServer` (stdio, HTTP, SSE; command, arguments, env with literal or `${VAR}`
  entries, headers, timeouts, enabled), scopes (global, project) and source kinds (user, local, project),
  per-agent capabilities and unsupported fields; five adapters reading and writing their files — Claude
  Code (`~/.claude.json` user and `projects.<folder>` local, `.mcp.json`), Codex (`~/.codex/config.toml`
  and `.codex/config.toml` through P5-2), Cursor (`~/.cursor/mcp.json`, `.cursor/mcp.json`), OpenCode
  (`opencode.json`/`.jsonc` `mcp`), Antigravity (`~/.gemini/config/mcp_config.json`, imports) — with
  upstream's managed-key lists. Needs P5-1, P5-2. *Tests:* G (upstream's adapter cases and fixture
  files per agent), U (unsupported fields, masking). *Parity:* EXT-1.
  *Done:* (`bcaba4f`) `AletheIntegrations/MCP`: port of `mcp_model.rs` (scopes, source kinds,
  capabilities, unsupported fields, masked views; `description`/`dump` never show a secret; converts to
  and from P5-4's `McpLaunchServer`) and five text-only adapters: Claude Code (user, `projects.<folder>`
  local, `.mcp.json`), Codex through `TOMLDocument` (inline entries keep their form), Cursor, OpenCode
  (`.jsonc` read-only) and Antigravity (import ownership as pure functions for P5-21), with upstream's
  managed-key lists; a non-object where the server map belongs throws instead of being replaced.
  Upstream cases as goldens with per-agent fixtures; written and compiled, NOT run.
- [x] **P5-15 (M) Skills browser.** Service (upstream `skills.rs`): scan `~/.claude/skills`,
  `~/.codex/skills` (bundled system skills marked, not removable), `~/.config/opencode/skill`,
  `~/.gemini/skills` and the shared `~/.agents/skills` (symlinks resolved), frontmatter, file tree,
  `.skill-lock.json` source; uninstall (asks once, bundled refused). Sheet (upstream `SkillsBrowser`):
  agents, filter, detail with the `SKILL.md` rendered (AletheDocuments) and the files; P5-25 embeds it.
  Needs P5-1, P5-3 (gated by mcp). *Tests:* U (frontmatter shapes, scan fixtures, name validation), UI.
  *Parity:* EXT-2.
  *Done:* (`2023270`) `SkillStore` (port of `skills.rs`) scans Claude Code, Codex, OpenCode, Antigravity
  and `~/.agents/skills` off main (cancelable), resolves links, treats Codex `.system`/marker skills as
  bundled (never removed), parses frontmatter, the capped file tree and `.skill-lock.json`; names
  validated, paths proven inside the root; uninstall removes a link only, sends a real folder to the
  Trash (upstream deleted), and keeps a shared copy while any agent links it. History › Skills… (mcp
  feature) opens the embeddable `SkillsBrowser` (P5-25 reuses it). Debug `-AletheIntegrationsHome` for
  test homes. Tests (U + UI `SkillsBrowserTests`) written and compiled, NOT run.
- [x] **P5-16 (M) Agent library and economy agents.** Service (upstream `agent_library.rs`,
  `economy_agents.rs`, `lib/agentLibrary.ts`): the library templates and the economy (Haiku) agents as
  data, listed, installed and removed under a project's `.claude/agents` or `~/.claude/agents`; only
  files carrying the Alethe marker (upstream's wording or the new English one) are removed without asking.
  Surface: Project menu › Agent Library… (upstream shows it only in the Agent Canvas POC, EXP-1): cost
  and category, installed state, the economy toggle. Template text in English. Needs P5-1. *Tests:* U
  (install/uninstall, marker detection, economy toggle), UI. *Parity:* EXT-4.
  *Done:* (`4e0b665`) library templates and economy (Haiku) agents as English data in
  `AletheIntegrations/AgentLibrary`, installed/removed under a project's `.claude/agents` or
  `~/.claude/agents` through `ConfigFileWriter` (new `remove(over:backupSlot:)` with the same checks and
  backup). Files with the Alethe marker (upstream or English wording) go without asking; others ask
  once; economy on never overwrites a user file with the same name. Economy agents renamed to English
  (`haiku-summarizer`, `haiku-mechanic`), upstream files removed when marked; the guard now carries the
  marker; user scope uses `$HOME/.claude/agents/codex-only-guard.cjs`. Project menu › Agent Library…
  with scope, cost, category, installed state, economy toggle, Undo of the last change. Tests (U + UI)
  written and compiled, NOT run.
- [x] **P5-17 (L) Graphify service.** Port of `graphify.rs`: detect the CLI (`--version`, command
  override in Settings › Features › Graphify), generate the graph (one run per repository at a time,
  cancelable), read `graphify-out/graph.json` into nodes and edges off the main thread, snapshots in
  `.alethe/graph-snapshots/` (snapshot, list, diff by node and edge sets, rollback asks once, prune);
  `project.graphifyEnabled` in the project editor; the `graphify <root> --mcp` server added to launches
  through P5-4. Needs P5-1, P5-3, P5-4. *Tests:* G (upstream graph fixtures and snapshot cases), U
  (diff, prune). *Parity:* EXT-5.
  *Done:* (`8ee5505`, reconciled in `0305be9`) `AletheIntegrations/Graphify`: CLI detection, one
  generation per repository (cancelable, 15 min), `graph.json` read off main (3000-node cap, source file
  kept, numeric communities), snapshots in `.alethe/graph-snapshots/` compatible with the Tauri app
  (create, list, diff, rollback, prune). App `GraphifyController` adds `graphify <root> --mcp` via
  `McpLaunchWiring` for Claude Code, Codex and OpenCode when the feature and `project.graphifyEnabled`
  are on (only if the CLI is found), generating a missing graph; no writes to the project's agent
  configs; outside a repository the folder is the root. Settings › Features › Graphify command + status;
  project editor toggle; imported from Tauri. Tests written and compiled, NOT run.
- [x] **P5-18 (M) ai-memory wiring.** Port of `ai_memory.rs`: detect (`ai-memory --version`, endpoint
  health), command override, the `ai-memory mcp` server added to Claude Code, Codex and OpenCode launches
  through P5-4 when the aiMemory feature is on; status and a link to its docs in Settings › Features ›
  ai-memory. Needs P5-3, P5-4. *Tests:* U (detection parsing, wiring on/off). *Parity:* EXT-6.
  *Done:* (`8511733`) `AletheIntegrations/AiMemory.swift`: detection (`--version` with timeout and
  cancel; loopback health on 127.0.0.1:49374) and the rule adding `ai-memory mcp` to a launch while the
  feature is on and the CLI is on disk (skipped only if detection found that executable broken —
  launches never wait for detection). App `AiMemoryController` registers the provider with
  `McpLaunchWiring` (Claude, Codex, OpenCode); command override in `cliPaths["ai-memory"]`. Settings ›
  Features › AI Memory: path, Choose…/Reset, version, server state, Check Again, docs link (no toast
  system, so no one-time missing-CLI toast). Tests (U) written and compiled, NOT run.
- [x] **P5-19 (L) Playwright MCP browser session.** Port of `browser_session.rs`: resolve a
  Chromium-family browser (Chrome, Chromium, Edge, Brave; explicit path), launch it on a free loopback
  debugging port with its profile inside the Alethe profile, ready when `/json/version` answers, killed
  (process tree) on quit and when stale at launch — matched by executable, never by command line; status.
  `playwrightBrowserMode` shared or dedicated and dedicated headless (Settings › Features › Playwright);
  `npx -y @playwright/mcp@latest` with `--cdp-endpoint` (shared) or its own browser added through P5-4.
  *Deviation:* the shared browser is not shown in the web pane (CDP engine Won't port, BR-1); it runs as
  its own window unless headless. Needs P5-3, P5-4. *Tests:* U (arguments, loopback-only endpoint,
  stale matching), P (start to ready). *Parity:* BR-3.
  *Done:* (`0212719`) `AletheIntegrations`: `BrowserLaunch` (Chrome/Chromium/Edge/Brave or a path,
  loopback port, profile in `<profile>/browser-session`, `--use-mock-keychain`), `BrowserSession` actor
  (ready on `/json/version` within 20 s, shared concurrent starts, cancelable, process group SIGTERM
  then SIGKILL), stale sweep only when both the executable is a browser and the exact profile argument
  matches, `PlaywrightMcp` args. App `PlaywrightBrowser` registers with `McpLaunchWiring` for all three
  agents; shared mode attaches only while the shared browser runs (agents never start it); dedicated
  mode optionally headless. Settings › Features › Playwright Browser: mode, headless toggles, path,
  status, Start/Stop; stops on quit and when turned off. No CDP pane (own window unless headless). Tests
  written and compiled, NOT run.
- [x] **P5-20 (L) GSD Sync service.** Ports of `planning_gate.rs` (planning status from
  `.planning/status.md` and roadmap checkboxes; `.gsd-child-session`/`-busy`/`-error`/state; procedure),
  `opencode_gsd_plugin.rs` (the `alethe-gsd-state.ts` plugin from upstream's asset, version marker, never
  over a user-edited file; `opencode.json` plugin entry merged; `.opencode/alethe-gsd-config.json` model
  chain from `gsdSyncModelChain`), the `.planning/` watcher (FSEvents; upstream `start/stop_gsd_watcher`),
  `list_project_plans`, and `opencode export <child>` parsed into messages and parts. Needs P5-1.
  *Tests:* G (upstream's plugin-write and status cases), U (export parsing). *Parity:* EXT-7.
  *Done:* (`50d2d8c`) `AletheIntegrations/GSDSync`: `PlanningGate` (status.md Status over Progress,
  task.md checkboxes, plan.md notes, child-session id/busy/error files — error deleted once read;
  repository root found without git), `GSDOpenCodePlugin` (upstream `alethe-gsd-state.ts` v12 verbatim
  as a resource, never over a user-edited or newer copy; model-chain file from `gsdSyncModelChain`;
  `opencode.json` plugin entry merged with a backup via `ConfigFileWriter`, untouched when unparsable),
  FSEvents `.planning/` watchers, `list_project_plans`, `opencode export` parsing with a cancelable
  timed runner (`ExternalCommand`). Tests (upstream cases) written and compiled, NOT run.
- [x] **P5-21 (L) MCP store.** Port of `mcp_store.rs`: scan all agents and scopes with an mtime cache,
  config paths, upsert, remove and enable/disable into the right source (upstream `pick_source`), sync a
  server to other agents with a report of skipped fields, reveal env values on request (never logged),
  every write through P5-1 with its backup; restore a backup. Needs P5-14. *Tests:* G (upstream's store
  cases in temporary homes), U (source picking, sync report). *Parity:* EXT-1.
  *Done:* (`9b1fcd4`) `McpStore` (port of `mcp_store.rs`): scans every agent and scope with an
  mtime+size cache, lists config paths and capabilities; add/remove/enable write into the server's own
  source (`pick_source`) after validation, unsupported-field refusal, `.jsonc` rejection and a check
  that no other server changed, all through `ConfigFileWriter`; sync copies servers between agents
  without the UI (per target: written, skipped, blocked with fields, failed; cancel stops before the
  next target); reveal returns one env/header value per request, never logged; backups list/restore
  (repository files get per-file hashed backup folders; restore checks agent/file and parseability and
  backs up first); grouping and Sync All helpers for P5-25/26. Remove, restore and overwriting sync are
  flagged to confirm once. Tests (upstream cases in temp homes) written and compiled, NOT run.
- [x] **P5-22 (M) MCP health and registry.** Health (upstream `mcp_health.rs`): `claude mcp list`,
  `codex mcp list --json`, `opencode mcp list` parsed per server, 45 s timeout, none for Antigravity and
  Cursor (config only), no command or URL in the result. Registry search (upstream `mcp_catalog.rs`):
  `registry.modelcontextprotocol.io/v0/servers` with cursor paging, cached in
  `<profile>/mcp/registry-cache.json`, entries mapped to install options (npm → `npx`, PyPI → `uvx`,
  OCI → `docker`, NuGet → `dnx`, remote → HTTP with headers, env hints with the secret flag). Needs P5-14. *Tests:* U (upstream's
  parser cases for both). *Parity:* EXT-1.
  *Done:* (`1aaed49`) `McpHealthParser` parses `claude mcp list`, `codex mcp list --json` and `opencode
  mcp list` into name + status (Antigravity and Cursor are config-only); `McpHealthChecker` runs them
  through `ExternalCommand` (45 s, cancelable, injectable runner/resolver). `McpRegistry` actor searches
  `registry.modelcontextprotocol.io/v0/servers` with cursor paging (URLSession, 8 s), caches first pages
  atomically in `<profile>/mcp/registry-cache.json` (20 newest queries) served with `staleSince` offline
  (never for a cancellation); entries map to npx/uvx/docker/dnx or HTTP/SSE install options with
  env/header hints flagged secret; `McpInstallOption.server(named:values:)` builds a writable server.
  Upstream parser cases as goldens; tests stub CLIs and the network; written and compiled, NOT run.
- [x] **P5-23 (L) Graphify view.** Pane kind `graphify` (upstream `GraphifyView`, Cytoscape): a Canvas
  graph with a force layout computed off the main thread, pan, zoom, search, node detail with its source
  file opened in a pane, a snapshot timeline with the diff highlighted and rollback; Add Content › Graph
  and the project menu; generate when no graph exists. Needs P5-17. *Tests:* U (layout determinism for a
  seed), UI (open, search, select), P (layout of upstream's largest fixture). *Parity:* EXT-5.
  *Done:* (`af5ccfa`) pane kind `graphify` (`{"kind":"graphify"}`; old workspace files unaffected).
  Canvas graph with a seeded force layout off main (cancelled on reload/close), pan, pinch and button
  zoom, nodes colored by community from project color tokens; search lists matches and dims the rest;
  node detail opens its source in a pane or the default app; snapshot timeline: take, compact (asks —
  upstream did not), compare with added nodes/edges highlighted, rollback after asking once; generate
  (cancelable) when no graph exists. Entry points Add Content › Code Graph and the project menu, gated
  by the graphify feature. Tauri `graphify` panes are still skipped on import; no scroll-wheel zoom.
  Tests (U layout determinism/cancel/communities/search, P layout at 3000 nodes, UI) written and
  compiled, NOT run.
- [x] **P5-24 (M) GSD Sync UI.** Right sidebar GSD Sync tab, only when gsdSync is on and the project
  runs OpenCode (upstream `useGsdSyncAvailable`): child sessions from one app-wide 5 s poll, busy and
  error glyphs, planning status on the sidebar merge panel; the activity view (upstream
  `GsdSyncActivityView`: messages, text, tool and reasoning parts, sticks to the bottom); model chain in
  Settings › Features › GSD Sync. Needs P5-3, P5-20. *Tests:* UI (seeded `.planning/` folder), HT.
  *Parity:* EXT-7.
  *Done:* (`c3c601e`) app-wide 5 s poll in `GSDSyncController` via `GSDSyncService.sessions(for:)` (off
  main, cancelable, one read per checkout); right sidebar GSD Sync tab only while gsdSync is on and the
  selected project has an OpenCode tab (busy/error/idle glyphs, roadmap progress); planning status rows
  under the project in the left sidebar; `GSDSyncActivitySheet` polls `opencode export` every 5 s and
  follows the bottom; Settings › Features › GSD Sync edits the model chain; `TerminalRegistry` installs
  the plugin before an OpenCode tab starts; child errors go to the notification list. Deviation: no per-
  project `gsdWatcherEnabled` (the feature switch plus an OpenCode tab is the gate). Tests (U + UI + HT
  at 90/100/120 %) written and compiled, NOT run.
- [x] **P5-25 (L) MCP manager UI.** Right sidebar MCP tab (upstream `McpPanel`: scope switch, server
  rows per agent, live health) and the MCP manager sheet (upstream `McpManagerModal`: list and detail,
  edit, per-agent enable with undo, sync to agents, reveal env, backups with restore, Skills from P5-15);
  Add Server (upstream `AddServerFlow`: registry search or manual, env hints, target agents and scope);
  first-use intro (`mcpOnboardingSeen`), `mcpDefaultScope`. Needs P5-3, P5-15, P5-21, P5-22. *Tests:* UI
  (add, disable, sync on seeded temporary homes), HT. *Parity:* EXT-1.
  *Done:* (`ad86ab5`) right sidebar MCP tab (mcp feature): Servers/Skills switch, search, agent filter,
  Project/Global scope (`mcpDefaultScope`), rows with agents, disabled/imported badges and health dots
  (checked once per launch, then on request; off under a test home), unusable configs with the reason.
  MCP manager sheet (row, add button or History › MCP Servers…): per-agent cards with health,
  enable/disable with Undo (⌘Z), edit that never shows a stored secret, backups with restore and remove
  (ask once), Show in Finder, Copy here / Copy to all missing (never overwrites), masked env with
  explicit Reveal dropped on scope change or close; Skills (P5-15) embedded. Add Server from the
  registry (stale/offline fallback, load more) or by hand, env hints with secrets in secure fields,
  target agents greyed when they cannot hold it; undoable. One-time intro (`mcpOnboardingSeen`, marked
  seen when the onboarding shows). Preferences imported from Tauri. Not ported: paste-JSON add, rename
  on edit, overwriting sync. Tests (U `McpDraftTests`, UI/HT `McpManagerTests` on a seeded temp home)
  written and compiled, NOT run.
- [x] **P5-26 (L) Onboarding and welcome.** First-run sheet (upstream `OnboardingModal`, keyboard-first,
  skippable): name (the profile's display name, macOS first name as default), style and theme, agents
  (detected, install through P3-3), features (P5-3), MCP (upstream `McpStep`: servers found per agent,
  gaps, Sync All through P5-21), and the optional Tauri import with its summary (P1-12); `onboardingDone`;
  Welcome back after an update or long absence (upstream `WelcomeModal`); hands over to the P3-16
  walkthrough. Needs P5-3, P5-9, P5-21. *Tests:* UI (complete, skip, import offered only when Tauri data
  exists), HT. *Parity:* SET-7.
  *Done:* (`98cd0b8`) `AletheModel/Onboarding` (`OnboardingStep.steps`,
  `PreferencesDocument.recordLaunch` → onboarding, or welcome back after an update or ≥ 7 days away;
  `onboardingDone`, `firstLaunchAt`, `lastLaunchAt`, `lastSeenVersion`; profiles that already have
  projects skip it). `Home/OnboardingSheet`: name (profile name; macOS first name by default), Tauri
  import (only with Tauri data; summary after), style and theme, agents (Settings rows, install via
  P3-3), features, MCP (per agent, gaps, Sync All via `McpStore`; mcp feature only); Return / ⌘[ / Esc;
  choices apply as you go; finishing shows Home with the P3-16 steps; Help › Show Onboarding….
  `WelcomeBackSheet` (upstream `WelcomeModal`, not on every launch). Deviation: import right after the
  name. UI tests only see it with `-AletheUITestOnboarding`/`-AletheUITestWelcome`. Tests (U 7, UI 3)
  written and compiled, NOT run.
- [x] **P5-27 (S) Changelog + phase review.** Parity matrix statuses; run upstream-watch; full test run.
  *Done (review, 2026-09-25):* all Phase 5 tasks implemented by parallel agents and integrated into
  `mac-native-v2`. Owner rule for this phase: compile only — package `swift build --build-tests`, app
  `build.sh Debug` and UI `build-for-testing` succeed and the strings gate passes; every Phase 5 test is
  written and compiled but NOT run (nor are Phase 4 round-2 tests). Parity rows updated. Notable merges:
  `0305be9` (two `ExternalCommand` runners unified). Owed: run the package suite and `Scripts/uitest.sh`,
  a manual pass of all Phase 5 UI, and the open points in each task's Done note.

Parallel waves (a task starts when everything it needs is committed; tasks in a wave share no files
beyond menus, Settings panes and string catalogs — rebase on conflicts):
1. P5-1, P5-2, P5-3, P5-4, P5-5, P5-6, P5-7, P5-8, P5-9, P5-10, P5-11, P5-12 — no dependencies.
2. P5-13 (needs P5-9 for its profile item), P5-14, P5-15, P5-16, P5-17, P5-18, P5-19, P5-20.
3. P5-21, P5-22, P5-23, P5-24.
4. P5-25, P5-26.
5. P5-27.

**Phase 5 exit criteria:** MCP servers of all five agents are listed, added from the registry, edited,
enabled, synced and health-checked, with every external config written atomically after a backup and
Codex's TOML comments intact; skills, the agent library, Graphify (view and snapshots), ai-memory,
Playwright and GSD Sync work behind their feature toggles and reach agents through per-launch wiring;
projects clone, restore from their marker, export and open in other apps; the `alethe` command opens
folders; profiles, backup/import/reset, logs, crash report, app icon, toolbar and onboarding are in place;
no secret appears in logs or exports.

### Phase 6 — Orchestrator v2
Order: groundwork first — the `AletheOrchestrator` target with the job model and the MCP transport, the
job store, the worker process host and the two worker protocols (Codex `app-server`, Claude Code
`stream-json`) — then the core that queues, runs and settles workers, with steering, approvals, worktree
isolation and agent fitness on top; then the app service that hosts the core behind the P3-9 loopback
endpoint and wires planners per launch, and the `alethe-orchestrator-mcp` stdio binary; then the board
(pure model, pane kind and entry points, canvas, worker actions, apply, spend and quota). ORC-3 (event
bus and telemetry, scheduler, planning audit, Settings › Multiagent) runs alongside: it shares nothing
with the board. Upstream keeps the core (`orchestrator_core.rs`) free of the app so the desktop app and
the stdio binary host the same code; the port keeps that split — `AletheOrchestrator` has no UI and no
app types. Principles: every process, pipe, git call and file read runs off the main thread and is
cancelable; one stuck worker never blocks another (writes to a worker's stdin happen outside the core's
isolation, as upstream `stage_rpc`); job state is written on transitions, not on streamed tokens,
atomically (tmp → rename), and a crash restores it with in-flight work marked interrupted, never shown
as running; worker processes run in their own process group and are always terminated and reaped — on
cancel, release, timeout, the parked limit, quit, and at the next launch after a crash; irreversible
steps (applying a worktree into a branch, cancelling a running worker) ask once; what a worker asks for
approval is answered only by an explicit choice of the planner or the person, never automatically; the
loopback token, the per-launch configs (0600) and worker environments are never logged (OSLog
`.private`, `SecretRedactor` on exports) nor passed as arguments, and task text is user data (private).
Every surface is gated by the `orchestrator` feature (P5-3). No new preference keys: the orchestration
mode turns on the existing feature. *Tests* list what each task must ship; they run per the test cadence
above.

- [x] **P6-1 (M) `AletheOrchestrator` target, job model and MCP transport.** New package target (ADR-7;
  depends on AletheFoundation, AletheGit, AletheAgents, AletheIntegrations) with the types every later
  task uses: `JobStatus` (queued, running, blocked, done, failed, cancelled, released, interrupted;
  `settled`), `Job` with its snapshot and record in upstream's camelCase JSON (`Job::snapshot`,
  `Job::record`), `Planner`, `Delivery` (sequence, type, job, outcome, text), `Launcher` (kind, program,
  arguments, environment), ids `job-NN` / `run-NN` with `trailing_number`, `tail` (a report's end, 1200
  characters in snapshots), token counts (`claude_token_count`, `add_token_counts`); the MCP transport
  (upstream `handle_mcp_body`: `initialize` echoing the protocol version, `tools/list`, `tools/call` →
  text content or `isError`, `ping`, unknown method -32601, notifications get no answer) over an
  `OrchestratorToolHandler` protocol, and the nine tool schemas (`tools()`) verbatim as a JSON resource.
  No processes, no UI. *Tests:* G (upstream `the_handshake_advertises_every_tool`,
  `a_notification_gets_no_response_body`,
  `the_delegate_schema_points_at_the_live_reading_instead_of_quoting_numbers`), U (snapshot and record
  against upstream JSON). *Parity:* groundwork for ORC-2.
  *Done:* (`b5f31c1`) target `AletheOrchestrator` (depends on Foundation, Git, Agents, Integrations):
  limits, `WorkerAgent`, `JobStatus` (+`settled`), `Planner`, `Delivery`, `Launcher`, `job-NN`/`run-NN`
  ids, `orchestratorTail`, `TokenCounts`; `Job` as plain data (process handles live in the P6-6 core)
  with `snapshot`/`record` in upstream camelCase JSON and restore turning running/queued work into
  interrupted (`approvalPolicy` kept as JSON text so Tauri files load; an unknown status reads as done);
  MCP transport `OrchestratorMCP.handle` over `OrchestratorToolHandler` (initialize, tools/list,
  tools/call with `isError`, ping, -32601, no reply to notifications) with the nine tool schemas
  verbatim as a resource. `OrderedJSON` gained compact rendering, literals and unsigned/double helpers.
  Tests (3 upstream goldens + model units) written and compiled, NOT run.
- [x] **P6-2 (S) Job store.** `OrchestratorJobStore` (upstream `set_store`/`restore`/`persist`):
  `<profile>/orchestrator-jobs.json` in upstream's v2 shape (`version`, job records, planners), so a
  file from the Tauri app loads; restore turns `running`/`queued` into `interrupted`, moves the job and
  run counters past every restored id and keeps the planners; writes are atomic, serialized and
  coalesced, requested on transitions only; an unreadable file is set aside (`.bak`) and the store
  starts empty instead of failing. Needs P6-1. *Tests:* G (upstream
  `history_outlives_the_process_and_in_flight_work_is_not_reported_as_running`,
  `a_new_id_never_collides_with_a_restored_one`), U (corrupt file, coalesced writes). *Parity:* ORC-2.
  *Done:* (`2c1f443`) `OrchestratorJobStore` (`<profile>/orchestrator-jobs.json`) and
  `OrchestratorJobsFile` in upstream's v2 shape (Tauri files load; records without an id skipped; a
  repeated job id skipped; a repeated planner id replaces the earlier). `restore()` never fails:
  running/queued jobs come back interrupted and `nextJobID`/`nextRunID` move past every restored id; an
  unreadable file or non-object root moves to `.bak`. `persist` returns at once, coalesces pending
  writes into one atomic write of the latest state on a serial queue; `flush()` waits for disk; a failed
  write is dropped (the next transition rewrites everything), as upstream. P6-6 wires
  restore/persist/flush. Tests (upstream goldens ported at store level + file shape, corrupt file,
  coalescing) written and compiled, NOT run.
- [x] **P6-3 (M) Worker process host.** `WorkerProcess` actor: spawns a `Launcher` in the job's folder
  with a clean environment (the login-shell PATH the P3 launcher resolver builds) in its own process
  group; stdin/stdout pipes (`O_CLOEXEC`), stderr discarded like upstream; an ordered line writer that
  never runs inside the core's isolation (upstream `stage_rpc` + `send_rpc`: a full pipe blocks only its
  own worker); stdout as an `AsyncStream` of JSON lines (invalid lines skipped, EOF ends it);
  `terminate()` sends SIGTERM to the group, SIGKILL after 2 s, and reaps (upstream `teardown` kill +
  wait; `withTaskCancellationShield` on 27, ADR-7a). Live workers are recorded (pid, group, executable,
  start time) in `<profile>/orchestrator-workers.json`; after an unclean exit the next launch terminates
  groups whose executable and start time still match — never matched by command line (as P5-19).
  Launchers for `codex app-server` and Claude Code's headless `stream-json` mode (upstream
  `Launcher::codex_app_server`, `claude_headless`), resolved once through `LauncherResolver`; a missing
  CLI is an error only for the job that needs it. Adds the `orchestrator` log domain (spawns go to
  `spawn.log` with environment names only, P5-11). Needs P6-1. *Tests:* U (arguments, a child ignoring
  SIGTERM is killed and reaped, a full pipe does not block another worker, stale-worker matching), P
  (spawn to first line). *Parity:* ORC-2.
  *Done:* (`c8effd2`) `AletheOrchestrator/Worker`: `WorkerProcess` actor (posix_spawn in the job folder
  as its own process group; close-on-exec pipes that never raise SIGPIPE; stderr to /dev/null; stdout as
  an `AsyncStream` of JSON lines; `WorkerLineWriter` one ordered queue per worker; `terminate()` SIGTERM
  to the group, SIGKILL to the tree after 2 s, then reap). `WorkerRegistry` records workers in
  `<profile>/orchestrator-workers.json`; `terminateLeftovers()` matches pid, executable (recorded at
  spawn and after the first line), start time and boot — never the command line.
  `Launcher.codexAppServer`/`claudeHeadless` (+`--resume`), `WorkerLaunchers` (a missing CLI fails only
  its jobs: "no worker launcher configured for agent X"), scrubbed `WorkerEnvironment`. New
  `orchestrator` log domain; spawns in `spawn.log` with env names only. P6-9 calls
  `terminateLeftovers()` at launch. Tests written and compiled, NOT run.
- [x] **P6-4 (L) Codex app-server worker protocol.** A pure state machine from JSON lines to worker
  events and back (upstream `spawn_worker` handshake, `on_worker_message`, `on_worker_request`):
  `initialize` with `experimentalApi`, `initialized`, `thread/start` (approval policy `never` or the
  granular form, `approvalsReviewer: user`, sandbox `workspace-write`, web search live or disabled) or
  `thread/resume` for an interrupted job; `turn/start`, `turn/interrupt`; events `turn/started`,
  `item/agentMessage/delta` (live reply), `item/completed` (report), `turn/plan/updated`,
  `turn/diff/updated`, `thread/tokenUsage/updated`, `turn/completed` / `turn/failed`; the requests
  `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` become a pending ask
  (kind, command, folder, reason, rpc id) and anything else is refused with -32601 so a worker never
  hangs; answers `accept`, `acceptForSession`, `decline`, `abort`; request ids per job. Needs P6-1.
  *Tests:* G (Codex transcripts recorded from upstream's fake-launcher cases,
  `the_handshake_offers_a_way_to_answer_a_blocked_worker`), U (every event, unknown request refused,
  resume vs. start). *Parity:* ORC-2.
  *Done:* (`b3d49d1`) `CodexWorkerProtocol.swift`: `CodexWorkerSession` state machine turns app-server
  JSON lines into worker events and replies (handshake; `thread/start` or `thread/resume` for
  interrupted jobs; approval requests become a pending ask answered on the asking id; anything else gets
  -32601; `turn/steer` for P6-7); `CodexApprovalPolicy` (never or granular, sandbox workspace-write);
  `Job.apply(_:)` (settling on turn end is the core's job). Independent of the P6-3 host:
  `pump(lines:handle:write:)` writes one compact JSON message per call (framing is the host's). P6-6
  must copy `session.nextRequestID` back to the job and may ignore `requestFailed` like upstream. Tests
  (upstream goldens incl. a recorded transcript + units) written and compiled, NOT run.
- [x] **P6-5 (M) Claude Code stream-json worker protocol.** The same contract for Claude workers
  (upstream `on_worker_message_claude`): the first user message is the first turn (no handshake),
  `--resume <session>` for an interrupted job; `system` `init` (session id) and `permission_denied`
  (reported: the stream has no approval channel, upstream runs `bypassPermissions`), `assistant` text
  blocks, `rate_limit_event` (live quota), `result` (report, usage → tokens, `total_cost_usd` summed per
  turn); steering interrupts and the aborted `result` is not announced (upstream `awaiting_steer`);
  after a turn the worker's uncommitted `git diff HEAD` in its folder is its diff (through `AletheGit`).
  Needs P6-1. *Tests:* G (upstream `a_claude_worker_reports_its_result_and_tokens`,
  `a_claude_worker_picks_up_its_own_uncommitted_changes_as_a_diff`,
  `steering_a_running_claude_worker_interrupts_instead_of_waiting_out_the_turn`,
  `steering_a_settled_claude_worker_queues_the_next_turn` as transcript fixtures). *Parity:* ORC-2.
  *Done:* (`d0b7073`) `ClaudeWorkerProtocol`: pure functions over `Job` (no handshake — the first user
  message is the first turn; interrupted jobs resume with `--resume <session>`); `system` init (session
  id) and `permission_denied`; assistant text (reply keeps the last 16 000 chars); `rate_limit_event` as
  live quota; `result` (running and last-turn tokens, `total_cost_usd` summed, reply as fallback
  summary). Steering queues the correction then interrupts (the aborted result is not announced); cancel
  interrupts with `cancel_queued`; diff is `git diff HEAD` via `GitRunner`; `line(_:)` frames stdin.
  Fixtures: 4 upstream transcripts + 1 hand-written. Tests (4 goldens + 13 units) written and compiled,
  NOT run.
- [x] **P6-6 (L) Orchestrator core: queue and lifecycle.** `OrchestratorCore` actor (upstream `Core`):
  launchers by kind, concurrency limit (default 4, clamped 1…16), a FIFO queue drained as slots free,
  workers spawned through P6-3 with the P6-4/P6-5 protocol, deliveries with a sequence number,
  `finish`/`finish_turn` (a completed turn keeps the process parked for follow-ups; at most 4 parked,
  the oldest released — upstream `PARKED_LIMIT`), a watchdog per job (900 s default, 0 for none;
  interrupt, then outcome `timeout`), `snapshot()` (jobs, planners, running, queued, limit) published
  through an `AsyncStream` that never holds up the core (upstream observer channel), persistence through
  P6-2 on transitions, `shutdown()` terminating every worker. Tools: `alethe_delegate` (tasks, agent,
  folder, label; one call is one run), `alethe_check` (wait, `untilAllSettled`, 300 s default, 600 s
  cap), `alethe_status`, `alethe_cancel`, `alethe_release`; an unconfigured agent fails its job cleanly
  through the normal delivery path. Needs P6-2, P6-3, P6-4, P6-5. *Tests:* G (upstream
  `a_settled_worker_reports_its_own_outcome`, `delegating_nothing_is_an_error`,
  `checking_with_no_work_returns_at_once`, `a_job_fails_cleanly_when_no_launcher_is_configured`,
  `the_observer_sees_every_state_change`, `two_workers_overlap_and_check_waits_for_both`,
  `the_queue_never_breaches_the_concurrency_limit`,
  `delegating_to_an_unconfigured_agent_fails_cleanly_like_any_other_agent`,
  `a_worker_that_never_finishes_is_stopped_by_its_budget`, with upstream's fake launchers as shell
  scripts), U (parked limit, no process left after `shutdown()`). *Parity:* ORC-2.
  *Done:* (`ffdbf44`) `OrchestratorCore` actor (`AletheOrchestrator/Core`): launchers by agent, limit 4
  (1…16), FIFO queue drained as slots free (slots per job, so a cancelled queued or released blocked job
  frees its slot), workers spawned off the actor through `WorkerProcess` with the Codex session (replies
  via `WorkerLineWriter`, `nextRequestID` copied back, `requestFailed` ignored) or the Claude protocol,
  sequenced deliveries, `finishTurn` parks finished workers (≤4, earliest let go), per-job watchdog (900
  s, 0 = none, outcome `timeout`), `snapshots()` stream, restore/persist/flush via the P6-2 store
  (release also persists), `shutdown()` interrupts in-flight/queued jobs, reaps every worker and refuses
  new work. Tools: `alethe_delegate`, `alethe_check`, `alethe_status`, `alethe_cancel` (lists only what
  it cancelled), `alethe_release`. State is `internal` for the P6-7/P6-8 extensions. Tests (9 upstream
  goldens with fake shell workers, 2 store goldens, units) written and compiled, NOT run.
- [x] **P6-7 (M) Steering, follow-ups, approvals and isolation.** On the P6-6 core, in its own files:
  `alethe_steer` (interrupt the running turn and deliver the correction next, context kept),
  `alethe_send` (an inbox: a busy worker takes it as its next turn, a parked one at once, a released or
  interrupted one is started again on its thread), `alethe_answer` plus `answer(job:decision:)` for the
  board (only while an ask is pending; the ask clears and the worker resumes), `alethe_diff` /
  `jobDiff`; delegate options `askForApproval` (granular policy, sandbox kept writable — upstream's
  reasoning), `webSearch`, `timeoutSeconds` and `isolate`: one worktree per job through `GitWorktrees`
  (P4-9) with upstream's path and branch (`<repo>/.alethe/worktrees/<job>/`, `alethe/agent-<job>`), made
  outside the core's isolation; a batch is accepted whole or not at all (worktrees already made are
  removed on failure). Needs P6-6. *Tests:* G (upstream `answering_is_refused_when_nothing_is_waiting`,
  `steering_an_unknown_job_is_refused`, `isolating_outside_a_repository_says_so`,
  `isolating_gives_each_worker_its_own_worktree`), U (inbox order, a half-made batch rolled back).
  *Parity:* ORC-2.
  *Done:* (`510d2b3`) `OrchestratorCore+FollowUps`: `alethe_steer` (Codex `turn/steer`; Claude
  interrupts and runs the correction next), `alethe_send` (a busy or starting worker gets it in its
  inbox, a parked one runs it now, a job with no process is revived on its thread), `alethe_answer` /
  `answer(job:decision:)` (only while an ask is pending and the worker is alive), `alethe_diff` /
  `jobDiff`. `OrchestratorCore+Isolation`: `isolate` makes one `GitWorktrees` worktree per job
  (`.alethe/worktrees/<job>`, `alethe/agent-<job>`) off the actor; a half-made batch is rolled back with
  its branches (ids of a refused batch stay used, as upstream). `delegate` is async; `askForApproval`
  (granular policy, sandbox workspace-write) and `webSearch` reach the job. Tests (4 upstream goldens +
  9 units, fake workers, temp repos) written and compiled, NOT run.
- [x] **P6-8 (M) Agent fitness and routing.** `AgentFitness` from P3-13's usage readings (upstream
  `lib/agentFitness.ts`: worst window, used %, reset, plan, rate-limited) pushed into the core
  (`setAgentFitness`); every tool response carries the fitness block with `headroom` (agents sorted, so
  a tie resolves the same way on every call); `alethe_delegate` adds `headroomHint` when the requested
  side is at 80 % or rate-limited (`bothStrained` when the other is too) and records a routing note on
  each job (`chosen` or `ignored`, the most strained agent, its window) — upstream `strain_of`,
  `strained_agent`, `routing_note`, `headroom_hint`, `call_tool`. In its own files on the core. Needs
  P6-6. *Tests:* G (upstream's eight fitness cases, `every_tool_response_carries_the_current_headroom`
  through `a_rate_limited_agent_outranks_any_percentage`; `agentFitness.test.ts`). *Parity:* ORC-2,
  ORC-1 (quota warnings).
  *Done:* (`4ec3cd1`) `AgentFitness` (upstream `agentFitness.ts`) from P3-13 `ProviderUsage`: worst
  window (`5h`, `week`, `opus`), used %, reset, plan (Codex only), rate-limited (never for Claude, as
  upstream). Pure `FitnessRouting`: agents sorted by name, `headroom`, most strained (≥80 % or rate-
  limited), `routingNote`, `headroomHint` incl. `bothStrained`. Core `setAgentFitness` (by agent or from
  a usage reading; empty readings keep the previous) in `OrchestratorCore+Fitness`; every tool response
  carries `fitness`; `alethe_delegate` adds `headroomHint` and a chosen/ignored routing note per job.
  Readings are fed by P6-17. Tests (9 upstream Rust goldens, 4 TS goldens, 16 units) written and
  compiled, NOT run.
- [x] **P6-9 (L) App orchestrator service, MCP endpoint and Claude Code planners.**
  `OrchestratorService` (`@MainActor`, upstream `orchestrator.rs`): one core per profile, prepared on
  first use (store path, restore, launchers resolved once — a missing CLI never delays launch),
  snapshots republished for views, `answer`, `diff` and `message(steer:)` for the board, `shutdown()`
  from `flush`. `POST /mcp` on the P3-9 `AgentHookServer` (same loopback listener and token,
  `X-Alethe-Planner` header, 202 for notifications, the body limit kept). An `McpLaunchWiring` provider
  (`OrchestratorWiring`) registers each Claude Code tab as a planner (id: the tab; label: its display
  name) and adds an `alethe` HTTP server to its `--mcp-config` file — `McpLaunchServer` gains an HTTP
  form (URL and headers) written only to the private per-launch file. Only while the feature is on.
  Files: `AgentHookServer.swift`, `McpLaunch.swift`, `AgentHookHub.swift` (the MCP handler),
  `AppEnvironment` (start and `flush`), new `Alethe/Orchestrator/`. Needs P6-6. *Tests:* U (`/mcp`
  routing, 401 without the token, the HTTP server config, planner registration), P (a tool call round
  trip over loopback). *Parity:* ORC-2.
  *Done:* (`e4199ce`) `OrchestratorService` (one core per profile, prepared on first use: store
  restored; codex/claude launchers resolved once via `LauncherCache` with CLI overrides;
  `terminateLeftovers()` off main at launch when the workers file exists; snapshots republished;
  `answer`/`message(steer:)` through the P6-7 tools; `diff`; `setConcurrencyLimit`; `shutdown()` from
  `flush`). `AgentHookServer` serves `POST /mcp` on the P3-9 listener (token first → 401, `X-Alethe-
  Planner` passed through, 202 for notifications, 404 while the feature is off). `OrchestratorWiring`
  registers each Claude Code tab as a planner (tab id, display name) and adds an `alethe` HTTP server to
  its private `--mcp-config` while the feature is on; `McpLaunchServer.http` (Claude `http`, OpenCode
  `remote`, never in Codex arguments). Plugin and extension events attached to the bus in
  `AppEnvironment` (temporary Settings attach removed). Tests (U + P loopback round trip) written and
  compiled, NOT run.
- [x] **P6-10 (M) `alethe-orchestrator-mcp` stdio binary and Codex planners.** A SwiftPM executable in
  AletheKit (ADR-7), embedded in the app under `Contents/Helpers/` and signed with it. Two modes: bridge
  (`--bridge <file>`: a private per-launch file with endpoint, token and planner; stdin lines are posted
  to the app's `/mcp` and the answers written back — replacing upstream's generated PowerShell bridge,
  `write_codex_mcp_bridge`) and standalone (upstream `bin/alethe-orchestrator-mcp.rs`: its own core,
  Codex from `ALETHE_CODEX` or PATH, `ALETHE_MAX_WORKERS`), so any MCP client can delegate without
  Alethe open. Codex tabs become planners through `-c mcp_servers.alethe.command=<helper>` /
  `args=["--bridge", <file>]` (P5-4) instead of upstream's `.codex/config.toml` block
  (`codex_mcp_config_write`); the token never appears in arguments or logs. Files: `Package.swift`, the
  app target's copy phase, `OrchestratorWiring`. Needs P6-7, P6-8, P6-9. *Tests:* U (bridge framing, no
  line for a notification, the standalone handshake, the built helper against a stub endpoint).
  *Parity:* ORC-2.
  *Done:* (`91570da`) SwiftPM executable `alethe-orchestrator-mcp`, built by SwiftPM in an "Embed
  orchestrator helper" script phase (a package-product dependency would make the app's package links
  dynamic), copied to `Contents/Helpers` and signed with hardened runtime (runs every build; SwiftPM is
  incremental). Bridge mode (`--bridge <0600 file>` with endpoint/token/planner; a world-readable file
  is refused, exit 66) posts each stdin line to `/mcp` with token and planner headers; notifications get
  no line; a failed request gets JSON-RPC -32603 instead of silence. Standalone mode runs its own in-
  memory core (`ALETHE_CODEX` or PATH, `ALETHE_MAX_WORKERS`) and reaps workers at EOF/SIGTERM.
  `OrchestratorMCP` finds its resource bundle next to the helper before `Bundle.module`.
  `OrchestratorWiring` makes Codex tabs planners via `-c mcp_servers.alethe.command/args` pointing at
  the helper (token only in the bridge file). Tests (U + built helper against a stub endpoint) written
  and compiled, NOT run; a real Codex run is owed.
- [x] **P6-11 (M) Planner subagents.** Claude Code's own subagents and teammates reach the board
  (upstream `agent_hooks_settings_path(orchestrator: true)`, `agent_events.rs`, `agentCanvasStore`,
  `lib/orchestratorSubagents.ts`): with the feature on, P3-9's per-launch Claude settings add
  `SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse`, `TeammateIdle`, `TaskCreated`,
  `TaskCompleted` and `teammateMode: in-process`; `SubagentTracker` keeps the nodes per planner tab
  (type, prompt, status, background or not) with their session cost (P3-8) and maps them to job
  snapshots in one "Subagents" run per planner (`nativeSubagentJobs`). Codex subagent hooks only through
  a per-launch `-c` override if Codex accepts one (upstream's Codex hook command is a no-op outside
  Windows). Files: `AgentHooks.swift`, `AgentHookHub.swift`, new
  `Alethe/Orchestrator/SubagentTracker.swift`. Needs P6-12. *Tests:* G
  (`orchestratorSubagents.test.ts`), U (hook parsing, settings with and without the feature). *Parity:*
  ORC-1 (subagents).
  *Done:* (`ec079a4`) with the orchestrator feature on, P3-9's per-launch Claude settings add
  SubagentStart/Stop, Pre/PostToolUse, TeammateIdle, TaskCreated/Completed (task events ignored) and
  `teammateMode: in-process`; Codex planners get per-launch `-c hooks.SubagentStart/Stop` through a
  stdin forwarder (not `.codex/config.toml`; replaces the user's own Subagent hooks for that launch
  only; unverified without Codex installed). `SubagentLedger` (package) builds subagent, teammate
  (`teammate:<planner>/<name>`) and background-shell nodes per planner tab; the app's `SubagentTracker`
  feeds it from the bridge and reads a finished node's cost from its absolute `.jsonl` transcript off
  main; the board gets them via `NativeSubagents.jobs` as one "Subagents" run per planner. Nodes are
  never pruned (as upstream). Tests (U `SubagentLedgerTests` 5, `AgentHooksTests` +3) written and
  compiled, NOT run.
- [x] **P6-12 (M) Board model.** Pure ports in `AletheOrchestrator/Board`: runs and planners
  (`lib/orchestratorRuns.ts`: lanes and their order, counts, worst state, attention, `groupRuns`,
  `groupPlanners` with declared, orphaned and planner-less groups in a stable order,
  `aggregateAgentSpend`), the canvas layout (`lib/orchestratorGraph.ts`: one tree per run, planner → run
  → workers, media nodes, connectors and their labels, `fitView`, `zoomAt`, `focusView`, scale
  0.35…1.6), media extraction (`lib/orchestratorMedia.ts`: at most 4 image paths and links from a
  report; POSIX paths instead of drive letters), context share, elapsed time and token formatting. Needs
  P6-1. *Tests:* G (upstream `orchestratorRuns.test.ts` 25, `orchestratorGraph.test.ts` 30,
  `orchestratorMedia.test.ts` 5, Windows paths rewritten as POSIX). *Parity:* ORC-1.
  *Done:* (`3e9a32e`) pure `AletheOrchestrator/Board`: `RunLane`/`RunCounts`/`RunAttention`,
  `BoardRun.group`, `PlannerGroup.group` (declared planners with fixed en_US_POSIX collation, then gone
  planners, then no planner), `AgentSpend.aggregate`; `BoardLayout` (media cards, `ConnectorStep` +
  upstream SVG `d`, label point, fit/zoom/focus, scale 0.35…1.6, JavaScript rounding and number
  printing); `BoardMedia` (≤4 items, POSIX `/` and `~/` paths); `BoardFormat`; `NativeSubagents.jobs`
  (upstream `nativeSubagentJobs`, ready for P6-11). Tests (runs 25, graph 30, media 5, subagents 2 +
  units) written and compiled, NOT run.
- [x] **P6-13 (M) Orchestrator pane and entry points.** Pane kind `orchestrator`
  (`{"kind":"orchestrator"}`; old workspace files unaffected) in `ContentPaneRegistry` with
  `OrchestratorPaneView` (an empty state until P6-14); Add Content › Orchestration and project menu ›
  Add Orchestrator (upstream `AddContentModal`, `sidebarMenus.tsx`, `createOrchestratorPane`); the New
  Terminal sheet's Orchestration mode (upstream `NewTerminalModal` `SessionMode`: planner agents Claude
  Code and Codex, a goal sent as the first prompt, the feature turned on before the terminal starts, the
  board opened beside the planner — AG-3's planner option). *Deviation:* upstream stacks the two in a
  `paneGroups[kind=orchestration]` group; there are no pane groups here, so the board is placed next to
  the planner in the project's layout. The Tauri import maps `orchestrator` panes (skipped until now)
  and copies `orchestrator-jobs.json` into the profile when it has none. All gated by the feature.
  Files: `AletheModel/PaneContent.swift`, `AletheModel/TauriImport.swift`, `ContentPaneRegistry.swift`,
  new `Workspace/ContentPanes/OrchestratorPaneView.swift`, `AddContentSheet.swift`,
  `NewTerminalSheet.swift`, `SidebarView.swift`. *Tests:* U (pane decoding, import mapping), UI
  (Orchestration mode opens a planner and a board; entry points hidden with the feature off). *Parity:*
  ORC-1, AG-3.
  *Done:* (`afd0e3e`) pane kind `orchestrator` (`{"kind":"orchestrator"}`; old workspace files
  unaffected) shown by `OrchestratorPaneView` (empty board until P6-14, or a Turn On notice while the
  feature is off). Add Content › Orchestration and project menu › Add Orchestration only while the
  feature is on (the menu always adds a new board, as upstream). New Terminal › Open as Orchestration
  offers Claude Code and Codex planners, sends the goal as the first prompt, turns the feature on before
  the tab exists and adds the board right after the planner, which keeps focus (no pane groups). Tauri
  import maps `orchestrator` panes (id and grid kept) and copies `orchestrator-jobs.json` into a profile
  that has none. Tests (U + UI `OrchestratorEntryTests`) written and compiled, NOT run.
- [x] **P6-14 (L) Board canvas.** `OrchestratorPaneView` filled in (upstream
  `OrchestratorPane/index.tsx`): planner tabs (label, agent glyph, run count; a planner whose tab is
  gone says so), the rail (runs → workers by lane, attention first, unsettled runs open), the canvas
  (P6-12 layout drawn with SwiftUI `Canvas` plus node views: planner, run with done and blocked counts,
  worker cards with status, elapsed, context share, tokens, cost, isolated and diff chips, media cards),
  pan, pinch and button zoom, fit, focus on the selected worker; worker detail (plan, report or the live
  reply's tail, routing note); the planner node reveals its terminal tab. Live from the P6-9 service
  plus P6-11's subagents; Reduce Motion respected; theme tokens only. Files:
  `OrchestratorPaneView.swift`, new files in `Alethe/Orchestrator/`. Needs P6-9, P6-11, P6-12, P6-13.
  *Tests:* UI (a seeded jobs file: tabs, rail, select a worker, fit), HT (three zoom levels), P (layout
  and redraw with 100 workers). *Parity:* ORC-1.
  *Done:* (`aaa3df2`) `OrchestratorPaneView` shows the board: planner tabs (agent, name, run count,
  attention, a closed planner struck through; "+" opens New Terminal), summary rail (finished %, lane
  counts, slots, runs needing you first, workers by lane, finished runs folded, other planners needing
  you), and the canvas (P6-12 layout in one SwiftUI `Canvas`: dot grid, `ConnectorStep` connectors,
  routing notes; cards placed at zoomed size, never `scaleEffect`, culled off-screen). Pan, pinch and
  button zoom (no scroll-wheel zoom), fit, focus; worker detail (plan, report or live reply, routing,
  media opening image/web panes); planner node reveals its tab. Derived off main from P6-9 snapshots +
  P6-11 subagents, filtered to the pane's project (closed planners kept when they ran in the project
  folder). Reduce Motion respected. Stub files for P6-15/16/17. Tests (UI `OrchestratorBoardTests` with
  seeded jobs, HT at 3 zooms, P with 100 workers) written and compiled, NOT run.
- [x] **P6-15 (M) Worker actions.** On the worker detail (upstream `ApprovalAsk`, the composer, the diff
  viewer): a pending ask shows what, where and why with Accept, Accept for Session, Decline and Abort —
  nothing is answered without a click, and an ask outside the worker's folder is called out (upstream
  `askIn`); a message field that steers a running worker and sends to an idle one (upstream
  `orchestrator_message`); the worker's diff with the Diff pane's line styling, loaded off main; Cancel
  (asks once while running) and Release; Show in Finder for a worktree. Failures are recorded in
  Diagnostics (P5-11). Files: new files in `Alethe/Orchestrator/`. Needs P6-7, P6-14. *Tests:* UI (a
  stub worker blocked on an approval is answered from the board; steer vs. send), HT. *Parity:* ORC-1.
  *Done:* (`e8eeca6`) `OrchestratorWorkerActions` on the worker detail: pending ask (what, command, why;
  an ask outside the worker's folder called out) with Accept / Accept for Session / Decline / Abort,
  only on a click; a message field that steers a running worker, sends the next turn to an idle one and
  resumes an interrupted or released one (so Release is reversible, as `alethe_send` allows); diff from
  the service parsed off main in the Diff pane's styling; Cancel (asks once while running or blocked; a
  queued one just leaves), Release, Show in Finder for a worktree; failures inline and in Diagnostics.
  Cancel/release go through a small extension in the actions file (service untouched). Tests (UI
  `OrchestratorWorkerActionsTests` over a stub Codex worker, HT at 3 zooms) written and compiled, NOT
  run.
- [x] **P6-16 (M) Apply a worker's worktree.** Upstream `applyWorktree`: commit the worktree's pending
  changes (`GitWorktrees.commitPending`), fetch the branch for local copies, analyze it against the
  project's current branch with the Merge Center analyzer (P4-10) and, when clean, prepare and finalize
  into it (P4-11, P4-13); a conflict or failed validation opens the Merge Center on that branch instead
  (`EditorRequest.mergeCenter`, existing case). Asks once (it changes the target branch), runs off main
  with progress, cancelable before the merge step, marks the job applied for the session. Files: new
  `Alethe/Orchestrator/ApplyWorktree.swift` and its button on the worker detail. Needs P6-7, P6-14.
  *Tests:* U (step order and stop points with stubs), UI (a clean apply on a seeded repository).
  *Parity:* ORC-1.
  *Done:* (`4057c3c`) Apply to Branch on a done worker with a worktree: the first click shows source and
  target (the branch checked out in the main repository) and pending + committed files, and asks once;
  then off main: commit pending (`Alethe orchestrator: <job>`), fetch, analyze, prepare, finalize (no
  validation commands, as upstream), cancelable until the merge step. Conflicts or a stopped finalize
  open the Merge Center on the prepared environment (`resume:`); nothing to integrate discards it. The
  worktree is kept (P6-15's diff/Finder use it). `WorktreeApply` (AletheMerge, stub-testable) + app
  `ApplyWorktreeCenter` (session state, Diagnostics, P6-19 merge events). Tests (U with stubs, G temp
  repos, UI `OrchestratorApplyTests`) written and compiled, NOT run.
- [x] **P6-17 (S) Spend and quota warnings.** The board header (upstream `aggregateAgentSpend`,
  `useOrchestratorQuotaWarnings`): spend per agent for the selected planner (cost, or tokens when
  unpriced) and a warning chip per agent at 80 % or rate-limited, with its reset; while a board is open,
  Claude and Codex usage (P3-13 readers) is read every 60 s and pushed into the core as fitness (P6-8),
  so the planner and the person read the same numbers (`FitnessFeed`). Files: new files in
  `Alethe/Orchestrator/`. Needs P6-8, P6-14. *Tests:* U (threshold, the feed stops when the last board
  closes), UI (seeded usage shows the chip). *Parity:* ORC-1.
  *Done:* (`d64f52b`) pure `QuotaWarning` (≥80 % or rate-limited, same threshold as `headroomHint`;
  upstream `formatReset` countdown) and a `FitnessFeed` actor: reads every 60 s while a board is open
  (immediately on open), keeps the last good reading, pushes `setAgentFitness`, stops when the last
  board closes. App `OrchestratorQuotaFeed.shared` reads through P3-13's `UsageMonitor` (Codex every
  tick; Claude only while its pill is on — no new Keychain prompts). `OrchestratorSpendHeader` shows
  `AgentSpend.aggregate` chips (cost or "no price") and warning chips with their reset, theme tokens
  only. Debug `-AletheUITestUsage` fakes readings. Tests (7 U, 1 UI `OrchestratorQuotaTests`) written
  and compiled, NOT run.
- [x] **P6-18 (M) Event bus and telemetry.** `AletheFoundation/Events` (upstream `event_bus.rs`,
  `telemetry.rs`): an `EventBus` actor (type, time, correlation id, task, agent, JSON data; each
  subscriber gets an `AsyncStream` that drops its oldest events rather than blocking the publisher),
  `Telemetry` (a count per event type; count, last and sum of `duration_ms`, `cost_usd`, `memory_mb`;
  the last 500 traces, filterable by correlation id; appended to `<logs>/telemetry.jsonl`, rotated like
  `alethe.log`, through `SecretRedactor`). The app's `MultiagentController` (new, in
  `Alethe/Orchestrator/`) owns bus and telemetry, is started from `AppEnvironment`, and publishes
  `PlanningUpdated` from the P5-20 `.planning/` FSEvents watchers it keeps for the projects the
  scheduler or autocommit follow. No dependencies. *Tests:* G (upstream
  `test_event_bus_publish_subscribe`, `test_telemetry_metrics_and_traces`), U (ring limit, correlation
  filter, redaction). *Parity:* ORC-3.
  *Done:* (`ebaba11`) `AletheFoundation/Events`: `EventBus` actor with a per-subscriber `AsyncStream`
  (newest 1024 kept, oldest dropped, publishing never waits) and events in upstream's snake_case JSON;
  `Telemetry` actor (count per event type; count/last/sum of `duration_ms`/`cost_usd`/`memory_mb`; last
  500 traces filterable by correlation id; redacted rotating `<logs>/telemetry.jsonl`, 256 KB × 3). App
  `MultiagentController` (started from `AppEnvironment`, stopped on quit) owns both and publishes
  `PlanningUpdated` from `.planning/` watchers for projects that the scheduler or autocommit `follow`
  (folders outside a git checkout rejected, as upstream). Tests (upstream bus/telemetry cases + ring,
  filter, redaction, JSON keys) written and compiled, NOT run.
- [x] **P6-19 (S) Event publishers.** The events upstream publishes outside the scheduler, from their
  native equivalents, with upstream's names and data keys: Merge Center analysis and conflict resolution
  (`merge_analyzer.rs`, `conflict_resolution.rs`), Graphify generation (`graphify.rs`), plugin load
  failures (`plugins.rs`), resource policy actions (`resource_manager.rs`; `supervisor.rs` timeouts and
  restarts only where P2-24 has an equivalent). Files: the owning app controllers only
  (`GraphifyController`, the Merge Center model, the plugin host wiring, `ResourceMonitor`). Needs
  P6-18. *Tests:* U (each publisher emits one event in upstream's shape). *Parity:* ORC-3.
  *Done:* (`eafc49d`) `BusEvent` builders (`PublishedEvents`) and a non-blocking `EventOutbox` (holds
  the newest 64 until a bus attaches). Publishers: Merge Center model
  (Clean/Conflict/Requested/Validated/ValidationFailed/Merged/Aborted), `GraphifyController`
  (`GraphUpdated` on generate/bootstrap/rollback), `ResourceMonitor` (`ResourceMetricsUpdated` each
  pass; pressure mapped to Ok/Medium/Critical, `webview_mb` 0), plugin host and extension manager
  (`PluginEnabled`/`PluginDisabled` + new `PluginFailed`). The plugin bus is attached from Settings ›
  Plugins until P6-9 wires `plugins?.events.attach(multiagent.bus)` in `AppEnvironment`. Not ported:
  supervisor events (no P2-24 equivalent), snapshot/prune events, PluginInstalled/Removed. Tests written
  and compiled, NOT run.
- [x] **P6-20 (M) Scheduler.** `AletheOrchestrator/Scheduler` (upstream `scheduler.rs`): tasks from the
  roadmap checkboxes of `.planning/task.md` (P5-20 `PlanningGate` parser) with ids derived from project
  and text, each depending on the one before; a reload keeps running, done and failed tasks and drops
  stale pending ones; a tick moves pending → ready when the dependencies are done, ready → running with
  a `worktree:<task>` lease and a worktree provisioned in the project's worktree mode (P4-9), running →
  done when that worktree's planning reports complete; cancel fails a running task and frees its lease;
  ticks run on request and on `PlanningUpdated`; every transition is published (P6-18). In memory, like
  upstream; subscribes to the bus itself, and the app's instance lives in `MultiagentController` from
  P6-22. Needs P6-1, P6-18. *Tests:* G (upstream's four scheduler tests on temporary repositories).
  *Parity:* ORC-3.
  *Done:* (`f83313e`) `AletheOrchestrator/Scheduler`: `Scheduler` actor,
  `SchedulerTask`/`SchedulerTaskStatus` in upstream camelCase JSON; loads `.planning/task.md` as a chain
  with project-namespaced ids (FNV-1a, so ids differ from Tauri's — in-memory only); reload keeps
  running/completed/failed and drops stale pending; tick pending → ready → running on a
  `worktree:<task>` lease, provisioning a worktree in the project's mode (injectable), completing when
  that worktree's planning reports complete; cancel fails a running task and frees the lease (cancel
  during setup does not publish `AgentSpawnRequested`); transitions published with upstream names;
  injected clock; auto-tick on `PlanningUpdated` only after `startAutoTick(on:)`. Upstream `supervisor`
  start/stop not ported. P6-22 wires it into `MultiagentController`. Tests (upstream's 4 scheduler cases
  on temp repos + units) written and compiled, NOT run.
- [x] **P6-21 (M) Planning audit and autocommit.** `AletheIntegrations/GSDSync/PlanningAudit` (upstream
  `planning.rs`): a record commits only `.planning/` (`git commit -- .planning`, so other staged work
  never joins it) as `gsd(alethe): <reason>` with an `Alethe-Agent:` trailer, does nothing when
  unchanged and publishes `PlanningCommitted`; history from `git log -- .planning` with unit/record
  separators and the trailer (50, at most 500; empty on a new repository). Autocommit
  (`PlanningAutocommit`, started by `MultiagentController`) is opt-in and off at each launch like
  upstream: on `PlanningUpdated`, 2 s after the last change per planning folder. Needs P6-18. *Tests:* G
  (upstream `records_scoped_audit_commit_with_agent_trailer`), U (debounce generations, history parsing,
  unrelated staged files untouched). *Parity:* ORC-3.
  *Done:* (`ef8ad4f`) `AletheIntegrations/GSDSync/PlanningAudit`: `git commit -- .planning` as
  `gsd(alethe): <reason>` with an `Alethe-Agent:` trailer (`unknown` default); nothing when `.planning/`
  is unchanged; other staged files stay staged; publishes `PlanningCommitted` {hash, subject}; history
  from `git log -- .planning` (50 default, 500 max, empty on a new repository). `PlanningAutocommit`
  subscribes to the bus and commits 2 s after the last `PlanningUpdated` per planning folder (per-folder
  generations); `MultiagentController` starts it, off at every launch, no preference key
  (`setAutocommit`, `isAutocommitEnabled`); P6-22 must `follow(… by: .autocommit)` the chosen project.
  Tests (upstream `records_scoped_audit_commit_with_agent_trailer` on temp repos + U) written and
  compiled, NOT run.
- [x] **P6-22 (M) Settings › Multiagent.** A Settings tab (upstream `MultiagentPage`, `schedulerStore`):
  scheduler — project picker, Run Tick, the task queue with status, dependencies, assigned worker and
  Cancel (asks once); execution metrics; recent events filterable by correlation id; planning audit —
  the autocommit toggle and the project's history. Refreshed from the bus, not polled. Files:
  `SettingsView.swift` (`SettingsTab.multiagent`), new `Alethe/Settings/MultiagentSettings.swift`,
  `MultiagentController` (holds the scheduler). Needs P6-18, P6-20, P6-21. *Tests:* UI (a seeded
  `.planning/` project: tick, cancel, autocommit), HT. *Parity:* ORC-3.
  *Done:* (`3be39a0`) Settings › Multiagent (only while the orchestrator feature is on; falls back to
  General when turned off): project picker, Run Tick in the project's worktree mode, task queue in
  roadmap order with status, dependencies, assigned worker and Cancel (asks once); event-bus metrics;
  newest 15 events filterable by correlation id; planning audit history (15) with the autocommit toggle
  (off at every launch). Refreshes from the bus (150 ms coalescing; history reloads on
  `PlanningCommitted`). `MultiagentController` holds `Scheduler(bus:)` with auto-tick and `focus(_:)`
  follows the chosen project by `.scheduler` and by `.autocommit` while on. The app now links
  `AletheOrchestrator`. Not ported: upstream opening an agent terminal on `AgentSpawnRequested` (running
  tasks show their worker id only). Tests (UI/HT `MultiagentSettingsTests`) written and compiled, NOT
  run.
- [x] **P6-23 (S) Changelog + phase review.** Parity matrix statuses; run upstream-watch; full test run.
  *Done (review, 2026-09-25):* all Phase 6 tasks implemented by parallel agents and integrated. Owner
  rule: compile only — package `swift build --build-tests`, app `build.sh Debug` (the helper is embedded
  signed in `Contents/Helpers`) and UI `build-for-testing` succeed, strings gate ok; every Phase 6 test is
  written and compiled but NOT run; no real Claude/Codex orchestration run yet. upstream-watch: 0 upstream
  commits. Integration fixes: duplicated `AletheOrchestrator` pbxproj link (P6-11 vs P6-22) and a
  duplicated seed case (`89cd574`). Parity ORC-1/2/3 Done.

Parallel waves (a task starts when everything it needs is committed; tasks in a wave share no files
beyond string catalogs — P6-7 and P6-8 add separate files to the core; rebase on conflicts). Shared
files and the tasks that edit them, never two in one wave: `AppEnvironment` P6-18, P6-9; `AgentHookHub`
P6-11, P6-9; `Package.swift` P6-1, P6-10; `OrchestratorWiring` P6-9, P6-10; `OrchestratorPaneView`
P6-13, P6-14; `MultiagentController` P6-18, P6-21, P6-22; `SettingsView` P6-22 only. No task touches
`EditorRequest`, `MainWindow`, the right sidebar's tab list or `PreferencesDocument`:
1. P6-1, P6-13, P6-18 — no dependencies.
2. P6-2, P6-3, P6-4, P6-5, P6-12, P6-19, P6-20, P6-21.
3. P6-6, P6-11, P6-22.
4. P6-7, P6-8, P6-9.
5. P6-10, P6-14.
6. P6-15, P6-16, P6-17.
7. P6-23.

**Phase 6 exit criteria:** a Claude Code or Codex terminal opened in Orchestration mode delegates
through the `alethe_*` tools to Codex and Claude Code workers that run in parallel within the
concurrency limit, each in its own worktree when asked, and can be checked, steered, sent more work,
answered, cancelled and released; the board shows every planner, run, worker and subagent live, with
approvals answered only by an explicit choice, diffs, apply into the branch after one confirmation,
spend and quota warnings; `alethe-orchestrator-mcp` serves the same tools over stdio with or without the
app; job history survives a relaunch or a crash with in-flight work shown as interrupted, and no worker
process outlives its job, the app or a crash; the scheduler, telemetry and planning audit and autocommit
work from Settings › Multiagent; no token or secret appears in logs, exports or process arguments.

### Phase 7 — Peripherals
Order: groundwork first — the Keychain store with the Phase 7 preference and workspace fields and their
Tauri import, the `AletheRemote` target with its pairing hub, remote question extraction, and the
Discord and 9router services (none needs another); then the app slots every later task fills (Settings
tabs, sheets, toolbar items, sidebar and Home slots, controllers placed in the `AppEnvironment` start
sequence, seed hooks) alongside the services that need the Keychain or the hub (remote transport, API
and client bundle, Spotify, gist sync); then each peripheral's app service and UI; last the remote
end-to-end and security checks. Remote control is the largest and riskiest piece (§10): upstream
`src-tauri/src/remote/` is ported as a pure hub (pairing, sessions, limits), a transport and an API, so
each is testable without a network and the transport never decides policy; the phone client is the
upstream PWA, bundled (§11). Principles: nothing listens, polls, connects or starts on its own — remote
control is off at every launch (upstream resets `remoteEnabled`), Discord, Spotify, 9router and gist
sync do nothing until the user turns them on or connects them, and each surface is gated by its own
upstream setting (upstream has no `enabledFeatures` key for them, so none is added); the remote
listeners bind one address — the Mac's LAN address or, when chosen, its Tailscale address, failing
closed when Tailscale is missing — never a wildcard, and turn themselves off after 4 h with no paired
device; a device pairs only through a 120 s QR window and gets a session token bound to it that
expires, within a device limit (1–4), rate limits and a lockout after failed attempts; read-only when
asked; it sees only terminals shared one by one (`remoteShared`, off by default) and can be revoked;
9router and the Spotify OAuth callback bind loopback (`127.0.0.1`) only; OAuth uses upstream's
registered loopback redirect (`http://127.0.0.1:8888/callback`) opened in the default browser, with a
`state` check and a timeout; secrets (Spotify client secret and tokens, the GitHub token, the 9router
API key) live in the Keychain — never in `preferences.json`, profile files, backups or logs — and the
plaintext copies in Tauri data move into it on import; remote pairing and session tokens live in memory
only; every socket, request, process and file read runs off the main thread, is cancelable and has a
timeout; logs record device ids, addresses and sizes, never tokens or message text (OSLog `.private`,
`SecretRedactor` on exports). *Tests* list what each task must ship; they run per the test cadence
above.

- [x] **P7-1 (M) Keychain store, Phase 7 model and Tauri import.** `AletheFoundation/Keychain` (ADR-1:
  keyring → Security.framework): `KeychainStore` get/set/delete of generic passwords per profile (service
  `com.kc1t.alethe.mac`, account `<profile>/<item>`, this device only, never synchronized; values never
  logged) with the item names every later task uses (`spotifyClientSecret`, `spotifyTokens` — access,
  refresh, expiry —, `githubToken`, `router9APIKey`), and an in-memory store for tests and UI-test
  launches. Model (upstream `types.ts` `Preferences`, `Router9Preferences`, `Terminal.remoteShared`,
  `SubTab.useRouter9`): `PreferencesDocument` gains `spotifyClientID`, `discordPresence`, `router9`
  (enabled, autoStart, source managed or external, port 20128, defaultForNewAgents) and `remote`
  (maxDevices 1…4, default 1; sessionExpirySecs 5 min…24 h, default 1 h; readOnly; allowShellInput;
  useTailscale) — `remoteEnabled` is not stored (session-scoped upstream); `Pane.remoteShared` (old files
  decode as not shared), `PaneTab.useRouter9`; `ToolbarItemKind` `remote`, `router9`, `sync` (the items
  P5-13 deferred); `GistSyncState` (`<profile>/github_sync.json`: login, gist id, last push and pull —
  never the token). Tauri import maps them (upstream migration `remoteExcluded` → `remoteShared`;
  `topbarShowSync`, `topbarShowRouter9`) and reports `spotifyClientSecret`, `router9.apiKey`,
  `spotify_tokens.json` and `github_sync.json`'s token as secrets that the app's import apply path writes
  to the Keychain; `github_sync.json`'s other fields become the profile's `GistSyncState`. Files:
  `PreferencesDocument.swift`, `WorkspaceDocument.swift`, `ToolbarLayout.swift`, `TauriImport.swift`,
  `TauriImportSheet.swift` (the apply path shared with onboarding). No dependencies. *Tests:* U (Keychain
  round trip in a throwaway service, decoding without the new keys, clamps, an upstream v9 fixture with
  these fields: secrets reported and absent from every written file). *Parity:* groundwork for PER-3,
  PER-4, PER-5, PER-7, SET-5, UI-7.
  *Done:* (`8f531fc`) `AletheFoundation/Keychain/KeychainStore` (service `com.kc1t.alethe.mac`, account
  `<profile>/<item>`, this device only, never synchronized; the four named items; in-memory store for
  tests and debug launches with `-AletheDataRoot`/`-AletheNoKeychain`). `PeripheralPreferences` + pane
  sharing / tab routing / toolbar kinds (`remote`, `router9`, `sync`, hidden via
  `ToolbarItemKind.offered` until P7-6) with range limits; `GistSyncState` (profile `github_sync.json`;
  the Tauri gist id kept apart in `tauriGistID` so P7-11 never pushes to it). Tauri import maps the
  Phase 7 settings, pane sharing (upstream rule: `remoteShared` true, or unset and not `remoteExcluded`)
  and tab routing, and moves plaintext secrets to the Keychain off main — never to a profile file. Tests
  (Keychain round trip in a throwaway service, decoding, limits, v9 fixture with secrets absent from
  written files) written and compiled, NOT run.
- [x] **P7-2 (L) `AletheRemote` target and pairing hub.** New package target (ADR-7; depends on
  AletheFoundation) and test target, porting upstream `remote/mod.rs` (limits), `state.rs` and
  `util.rs`: a `RemoteHub` actor — pairing window (120 s; a 32-character token regenerated on open and
  close), `pair` → device session (40-character token, name ≤ 48 characters, address, connected and
  expiry times; the device limit; closes the window), `info` (upstream `RemoteInfo`), revoke one or all,
  expiry pruning, auth-failure lockout per address (10 in 60 s → 5 min), per-session message rate (20 per
  60 s), connection cap (24), idle check (4 h with nobody paired; 0 disables), a generation counter for
  restarts, one subscription per session and `publish` that builds a payload only when someone is
  subscribed; constant-time token comparison, message sanitizing, query parsing with percent decoding;
  host resolution — the LAN address (upstream `local_ip`), the Tailscale address from the `tailscale` CLI
  (PATH or `Tailscale.app`'s bundled CLI; 3 s; off main) accepted only in 100.64.0.0/10, and an
  unbindable empty host when Tailscale is chosen but missing; `RemotePairingQR` (`CIQRCodeGenerator`,
  cached per pairing URL). Owns the types the other remote tasks share: `RemoteRequest`,
  `RemoteResponse`, `RemoteRouter`, `RemoteTerminalSource` (scrollback tail, size, write, output),
  `RemoteWorkspaceSource` (shared tabs, snapshot, appearance, transcript, questions),
  `RemoteAssetSource` and `RemoteEvent` (message, start failed, auto-disabled). No sockets, no UI.
  Files: `Package.swift`. No dependencies. *Tests:* G (upstream `state.rs` 15 cases,
  `percent_encoded_query_values_are_decoded`, `tailscale_range_accepts_only_cgnat_addresses`), U (a QR
  image decodes back to its URL, lockout expiry, a revoked device's subscription is dropped).
  *Parity:* groundwork for PER-7.
  *Done:* (`c43cff7`) target `AletheRemote` (depends only on AletheFoundation): `RemoteLimits` (upstream
  `mod.rs` limits, `remote` log category — device ids and private addresses, never tokens), `RemoteText`
  (constant-time token compare, sanitizing, percent-decoded queries, 32/40-char tokens), `RemoteHost`
  (LAN address; Tailscale via the CLI on PATH, Homebrew or Tailscale.app, 3 s, only 100.64.0.0/10),
  `RemoteHub` actor (pairing and sessions with injectable clock/host resolver; start/stop;
  revoke/expire/detach end that device's stream), `RemotePairingQR` (`CIQRCodeGenerator`, ≥220 px,
  cached per URL), `RemoteProtocol` shared types (request/response with upstream headers and 64 KB/4 MB
  limits, router, terminal/workspace/asset sources, events, WS frames; question/transcript types live
  here, so P7-12 converts P7-3's). Tests (15 upstream `state.rs` cases + plan extras) written and
  compiled, NOT run.
- [x] **P7-3 (S) Remote questions and transcript snapshots.** In `AletheAgents/Handoff` (upstream
  `handoff.rs` `remote_questions`, `transcript_snapshot`, `active_remote_questions`; left out of P3-12):
  interactive questions read from Claude Code `AskUserQuestion` and Codex `request_user_input` tool calls
  (header, question, options with descriptions, multi-select; the call id as the question set id);
  `transcriptSnapshot(agent:folder:session:since:limit:)` (the session's transcript, else the folder's
  newest; revision = modification time in ms, an unchanged revision skips the parse; the newest 160
  events); `activeQuestions` from the last event. Files: `Handoff.swift` only. No dependencies.
  *Tests:* G (upstream `parses_codex_and_claude_questions`,
  `preserves_agent_call_ids_for_remote_questions`), U (unchanged revision, the limit keeps the newest).
  *Parity:* groundwork for PER-7.
  *Done:* (`78bdf1d`) `Handoff.swift` ports upstream remote questions: Claude Code `AskUserQuestion` and
  Codex `request_user_input` tool calls become questions keyed by the agent's call id;
  `transcriptSnapshot(agent:folder:session:since:limit:)` (session transcript, else the folder's newest;
  revision = mtime in ms, an unchanged revision skips parsing; newest 160 events; text passed through
  secret redaction — upstream does not); `activeQuestions` only when the last event asked them. The
  tool-result role is written `tool-result` like upstream; unsupported agents give an empty snapshot
  (upstream errors). Tests (upstream goldens + units) written and compiled, NOT run.
- [x] **P7-4 (S) Discord IPC client.** `AletheIntegrations/Discord` (upstream `discord_presence.rs`, over
  the `discord-rich-presence` crate): an actor that finds Discord's socket (`$TMPDIR/discord-ipc-0…9`),
  frames messages (opcode and length, little-endian, then JSON), handshakes (`v: 1`, application id
  `1517303547761528942`), sets the activity (`SET_ACTIVITY` with pid and nonce: details, state, start
  timestamp, large image `alethe`, large text "Alethe") and clears it (then closes), reconnecting once
  when a send fails and staying silent while Discord is not running. No dependencies. *Tests:* G
  (upstream `application_id_is_numeric`; handshake and activity payloads as the crate writes them), U
  (framing, a fake socket server: handshake, set, clear, Discord restarted, no Discord). *Parity:*
  groundwork for PER-4.
  *Done:* (`3a1c9c3`) `AletheIntegrations/Discord/DiscordIPC.swift`: `DiscordIPCClient` actor on its own
  serial queue; finds `discord-ipc-0…9` in `$TMPDIR` and the other folders the upstream crate checks,
  skipping stale sockets; opcode + little-endian length framing; handshake with app id
  `1517303547761528942`; set activity (pid, nonce, details, state, start, image `alethe`); clear sends
  an empty activity then closes; one reconnect on a failed send, quiet `false` with backoff (2 s
  doubling to 60 s) while Discord is absent; 2 s socket timeouts, SIGPIPE-safe; a refused handshake
  counts as failed. `DiscordPresenceClient` protocol + `DiscordActivity` for P7-13's fakes. Tests
  (upstream payloads + fake local socket scenarios) written and compiled, NOT run.
- [x] **P7-5 (M) 9router service.** `AletheIntegrations/Router9` (upstream `router9.rs`,
  `lib/router9.ts`): routing rules (Claude Code → `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`; Codex and
  OpenCode → `OPENAI_BASE_URL` with `/v1` + `OPENAI_API_KEY`; nothing when off, keyless or unsupported;
  port normalized, base URL always loopback), source resolution (the preferred install, else the other);
  status (managed install in `<profile>/tools/9router`, version from its `package.json`; external
  `9router` through `LauncherResolver` with its version; running; port in use by a 400 ms probe; data,
  log and dashboard paths; pinned `0.5.59`); install and uninstall command lines (`npm install --prefix
  <dir> 9router@0.5.59`, built only here); start (managed: `node cli.js` in the install folder with
  `DATA_DIR=<profile>/tools/9router-data`; external: the user's binary with its own data) with `PORT`,
  `NEXT_PUBLIC_BASE_URL` and `HOSTNAME=127.0.0.1` (Next.js binds the LAN otherwise), output appended to
  `<profile>/9router.log`, in its own process group; a busy port is refused; stop terminates the group
  and reaps. No dependencies. *Tests:* G (upstream `router9.test.ts`: supported agents, env per
  dialect, custom port, nothing routed, `normalizePort`, loopback base URL, `router9ResolveSource`,
  `router9HasInstall`), U (status from a fake install folder, command quoting, a stub server started
  and stopped with no process left). *Parity:* groundwork for PER-5.
  *Done:* (`65f8a71`) `AletheIntegrations/Router9`: `Router9Routing` (Claude Code gets `ANTHROPIC_*`,
  Codex/OpenCode `OPENAI_*` with `/v1`; nothing when off, keyless or unsupported; port normalizing; base
  and dashboard always on 127.0.0.1; managed vs external install; pinned 0.5.59; `Router9RoutingConfig`
  input until P7-16/17 wire the P7-1 preferences), `Router9Service` (status, profile paths,
  install/uninstall command lines with POSIX quoting, start via `node cli.js` + `DATA_DIR` or the user's
  binary, `PORT`/`NEXT_PUBLIC_BASE_URL`/`HOSTNAME=127.0.0.1`, busy port refused, async or blocking
  stop), `Router9Process` (own process group, `9router.log`, SIGTERM then SIGKILL tree, 400 ms port
  check). API key only as a parameter, never logged. Tests (upstream `router9.test.ts` goldens + stubbed
  units) written and compiled, NOT run.
- [x] **P7-6 (S) App slots for the peripherals.** The shared app files every later Phase 7 task would
  otherwise touch, wired once to stub files that exactly one later task fills (the P6-14 pattern):
  Settings › Integrations (Spotify, Discord and 9router sections, upstream `IntegrationsPage`) and
  Settings › Remote tabs; `EditorRequest.remotePairing` and `.gistSync` presented by `MainWindow`;
  toolbar items for P7-1's `remote`, `router9` and `sync` kinds; a Now Playing footer in the sidebar and
  a Now Playing card on Home; controllers `RemoteControlController`, `DiscordPresenceController`,
  `NowPlayingController`, `Router9Controller`, `GistSyncController` created and started in the
  `AppEnvironment` start sequence after the terminal registry, with `flush` stopping remote control
  (revoking every device) and a managed 9router; `TestSeeds` cases routed to per-feature
  `TestSeeds+<Feature>.swift` files. Stubs render nothing and do nothing. Files: `SettingsView.swift`
  (`SettingsTab.integrations`, `.remote`), `EditorRequest.swift`, `MainWindow.swift`, `MainToolbar.swift`,
  `SidebarView.swift`, `HomeSections.swift`, `AppEnvironment.swift`, `TestSeeds.swift`; new stub files
  in `Alethe/Remote/`, `Alethe/Integrations/{Spotify,Discord,Router9,GistSync}/`,
  `Alethe/Settings/{IntegrationsSettings,RemoteSettings}.swift` and `Alethe/Spike/TestSeeds+*.swift`.
  Needs P7-1. *Tests:* UI (both new Settings tabs open; the three items are offered in Customize
  Toolbar). *Parity:* groundwork for PER-3, PER-4, PER-5, PER-7, SET-5, UI-7.
  *Done:* (`95c4eb8`) Settings › Integrations (Spotify, Discord, 9router sections) and › Remote tabs
  (window 720 wide so 11 tabs fit); `EditorRequest.remotePairing`/`.gistSync` in `MainWindow`;
  remote/router9/sync toolbar items offered (`allCases`); Now Playing slots in the sidebar footer and
  the Home hero row (`HomeView`, not `HomeSections`); five controllers started after the terminal
  registry, `flush` stopping remote, 9router and Discord first; `TestSeeds` routed to
  `TestSeeds+<Feature>.swift` (document, preferences and environment hooks). Every placeholder renders
  and does nothing. Tests (UI `PeripheralSlotsTests`) written and compiled, NOT run.
- [x] **P7-7 (L) Remote transport.** Network.framework (ADR-1: tiny_http/tungstenite → `NWListener`;
  upstream `remote/http.rs` `run_http`/`read_request`/`respond*`, `remote/websocket.rs`): an HTTP
  listener bound to the hub's host on the first free port of 9340…9360 (`requiredLocalEndpoint`, never a
  wildcard address) and a WebSocket listener (`NWProtocolWebSocket`) on 9341…9361; requests read with
  upstream limits (headers ≤ 96 KB found across chunks, body ≤ 64 KB, 20 s socket timeouts), the lockout
  checked before parsing, the connection cap, responses (JSON; static with `no-store` or immutable
  caching; ≤ 4 MB) with routing delegated to a `RemoteRouter`; WebSocket: `Origin` must be the HTTP URL
  (or absent), the first frame must authenticate within 10 s (session token; the device name renames the
  device), `subscribe` sends the scrollback tail (512 KB) and size, then live output through the hub; an
  expired session gets `{"type":"error","reason":"expired"}` and is closed; frames over 4 KB close the
  socket. Start and stop by generation (stop revokes every device and closes pairing); a bind failure
  emits start-failed; the idle check turns everything off and emits auto-disabled. Needs P7-2. *Tests:* G
  (upstream `request_headers_end_is_detected_across_chunks`, `header_lookup_is_case_insensitive`), U
  (limits, lockout → 429, origin refused, an unauthenticated socket closed at 10 s, stop with open
  connections), P (loopback round trip: pair, subscribe, 1 MB of output streamed). *Parity:* PER-7.
  *Done:* (`746a062`) `RemoteTransport` on Network.framework: HTTP and WebSocket listeners bound only to
  the hub's literal host, first free port of 9340…9360 / 9341…9361; `RemoteHTTPReader` limits (headers
  ≤96 KB across chunks, body ≤64 KB, 20 s timeouts), lockout before parsing (429), over-limit responses
  400, routing via `RemoteRouter`. WebSocket: Origin checked at the handshake, first frame authenticates
  within 10 s, one session per socket, `subscribe` sends scrollback tail and size only for shared tabs
  (upstream does not check), output streamed through the hub, expired/revoked → "expired" frame and
  close, frames >4 KB close. Start/stop follow the hub generation; stop closes every connection; bind
  failure → start-failed; idle check → auto-disabled. Tests (2 upstream + loopback end-to-end incl. 1 MB
  stream) written and compiled, NOT run.
- [x] **P7-8 (M) Remote API.** `RemoteAPI: RemoteRouter` (upstream `http.rs` `handle_http`/`handle_api`,
  `workspace.rs`, `appearance.rs`): `POST /api/pair` (401 and a recorded failure on a bad token),
  `GET /appearance.json`, and bearer-authorized `/api/info`, `/api/state` (groups; projects with their
  shared chats only), `/api/scrollback` (403 unless shared; subscribes the session), `/api/transcript`
  (Claude Code and Codex through P7-3, `since`), `/api/question-answer` (the choice typed as arrow-key
  navigation — upstream `question_answer_input`; a changed question → 409), `/api/agent-control`
  (`interrupt` → Ctrl-C; Claude Code and Codex only) and `/api/message` (sanitized, ≤ 4 KB, Return
  appended; shell tabs only when shell input is allowed); read-only → 403, rate limit → 429; each
  accepted input emits `RemoteEvent.message` (device, preview ≤ 120 characters); static paths go to the
  `RemoteAssetSource`. Appearance from native preferences with upstream's rules (a known theme else
  `elite-indigo`, light themes, app icon, `en`/`pt-BR`, reduced motion). Needs P7-2, P7-3. *Tests:* G
  (upstream `interactive_answers_become_terminal_navigation`, `appearance_defaults_are_safe_and_branded`,
  `appearance_accepts_persisted_light_preferences`, `appearance_rejects_unknown_persisted_values`), U
  (every route over stub sources: unshared 403, read-only, shell input off, rate limit, stale question,
  bad token 401). *Parity:* PER-7.
  *Done:* (`f91df3c`) `RemoteAPI: RemoteRouter` ports upstream `http.rs`: pairing (401 + recorded
  failure on a bad token), `/appearance.json`, and session-checked `/api/*` — info, state (up to 4 MB),
  scrollback (403 unless shared; subscribes the device), transcript (fixed message on failure, no local
  paths), question answer (409 when the question changed; answers mapped to arrow keys like upstream),
  interrupt, message. Read-only, shell-input, rate-limit, lockout and 64 KB checks before parsing; tab
  not running 409, unknown 404; ids ≤128 chars without control characters; each valid call resets the
  idle clock; each accepted input emits `RemoteEvent.message`; logs only device ids and byte counts.
  `RemoteAppearance.resolved` ports upstream's appearance rules. P7-12 wires it. Tests (4 upstream
  goldens + 16 route tests over fakes) written and compiled, NOT run.
- [x] **P7-9 (M) Remote client bundle.** The upstream PWA (§11) as a resource of `AletheRemote`:
  `src-tauri/remote/{index.html,app.js,app.css,locales.js,manifest.webmanifest}`, `src/styles/theme.css`,
  `@xterm/xterm` 5.5 (`xterm.js`, `xterm.css`) and `@xterm/addon-unicode11` 0.9 with their MIT licenses,
  the three agent icons and the four brand icons (`src/assets/theme-icons/`); the Caskaydia fonts are
  served from `AletheDesign`'s resources, not copied. `RemoteClientBundle: RemoteAssetSource` answers
  upstream's paths with their content types and caching, and the brand icon of the app icon theme. The
  copy stays byte-identical to upstream except patches the native server needs, recorded with the
  upstream SHA and each file's checksum in a bundle manifest, so upstream's `src/remoteChat.test.ts`
  remains the client's test; `Scripts/sync-remote-client.sh` recopies from a Tauri checkout and
  `Scripts/upstream-watch.py` reports changes under `src-tauri/remote/`. Files: `Package.swift`
  (resources, `AletheDesign` dependency), the two scripts. Needs P7-2. *Tests:* G (upstream
  `selected_brand_icon_uses_embedded_png_assets`), U (every path `index.html` and `app.js` request
  resolves; checksums match the manifest). *Parity:* PER-7.
  *Done:* (`91ffb50`) `RemoteClientBundle: RemoteAssetSource` serves the upstream phone client from
  `AletheRemote/Resources/RemoteClient` on upstream's paths, content types and caching (no-store for
  page, scripts, styles, manifest and brand icon; immutable for vendor files, fonts and agent icons);
  the brand icon follows the app icon theme, fonts come from `AletheDesign`
  (`AletheFonts.bundledFontURL(named:)`). The copy is byte-identical to upstream `2f3e5ed` (xterm 5.5.0,
  unicode11 0.9.0, no patches); `bundle-manifest.json` records sources and checksums; `Scripts/sync-
  remote-client.sh` recopies it (patches from `Scripts/remote-client-patches/`); `upstream-watch.py`
  reports changes to the bundled files. Tests written and compiled, NOT run.
- [x] **P7-10 (M) Spotify service.** `AletheIntegrations/Spotify` (upstream `spotify.rs`): credentials
  (client ID from preferences, secret from the Keychain, `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` as
  fallback; both required); login — a random `state`, the authorize URL (scopes
  `user-read-currently-playing user-read-playback-state user-read-recently-played`, redirect
  `http://127.0.0.1:8888/callback`) opened in the default browser while a one-shot `NWListener` on
  `127.0.0.1:8888` waits for `/callback` (other paths 404; `state` checked; `error` reported; a short
  page tells the user to return; 5 min timeout; cancelable; a busy port is a clear error); code exchange
  and refresh with Basic auth (refreshed 30 s before expiry; a rejected refresh token disconnects);
  tokens as P7-1's `spotifyTokens` item (not `spotify_tokens.json`); logout deletes them; the current
  track (`204` → the most recently played as paused; track, artists, album art — the smallest image —,
  progress, duration, Spotify URL). Needs P7-1. *Tests:* G (upstream
  `parses_recent_track_as_paused_now_playing`), U (authorize URL, callback parsing and state mismatch,
  refresh timing, the 204 fallback, over a `URLProtocol` stub; no token in logs). *Parity:* groundwork
  for PER-3.
  *Done:* (`07ba1b9`) `AletheIntegrations/Spotify`: `SpotifyService` actor (credentials from
  preferences, then Keychain, then `SPOTIFY_*` env; login through a one-shot `NWListener` on
  127.0.0.1:8888 bound before the browser opens, `state` checked first, 5 min timeout, cancelable, busy-
  port error; Basic-auth exchange, refresh 30 s early, a rejected refresh deletes the tokens; tokens
  only in `spotifyTokens`; current track with the 204 → recently-played paused fallback; logs never
  carry secrets). No PKCE (the plan asks only for `state` + Basic auth). Tests (upstream golden + units
  over `URLProtocol`) written and compiled, NOT run.
- [x] **P7-11 (M) GitHub gist sync service.** `AletheIntegrations/GistSync` (upstream
  `github_sync.rs`): a personal access token checked with `GET /user` (401 → invalid; the login kept) and
  stored as P7-1's `githubToken`; status from P7-1's `GistSyncState` (connected, login, gist URL, last
  push and pull); push — the profile's `workspace.json`, `preferences.json` and `activity-stats.json` to
  a private gist with its own description (a native gist, so the Tauri app's gist is never overwritten),
  `PATCH` when a gist id is known and create on 404/422; pull — the gist's files (a truncated file read
  from its `raw_url`, upstream `gist_file_content`), `workspace.json` required, validated by decoding
  before anything is replaced, then applied as a pending operation at the next launch with a safety
  backup (the P5-10 path; the app relaunches); a gist holding only upstream's `projects.json` is offered
  as a Tauri import (P1-12 mapping) instead; logout deletes the token. GitHub API headers as upstream
  (`X-GitHub-Api-Version: 2022-11-28`). Needs P7-1. *Tests:* U (over a `URLProtocol` stub: invalid
  token, create vs. patch, 404 → a new gist, truncated file, missing workspace refused before anything
  changes, Tauri gist detected; the token absent from `github_sync.json` and logs). *Parity:* groundwork
  for SET-5.
  *Done:* (`507d114`) `AletheIntegrations/GistSync`: `GistSyncService` checks the token with `GET /user`
  (Keychain only); push PATCHes this app's private gist or creates one (also on 404/422), never
  `tauriGistID`; pull reads truncated files from `raw_url` (GitHub hosts only), decodes every file
  before staging, and returns a staged `.importProfile` operation flagged as replacing data or a Tauri
  `projects.json` to import; 401 is an invalid token everywhere; logout deletes the token. `AletheModel`
  added as an `AletheIntegrations` dependency. Tests over a stubbed `URLSession` written and compiled,
  NOT run.
- [x] **P7-12 (M) Remote control app service.** `RemoteControlController` (upstream
  `useRemoteControlService.ts`, `remote/commands.rs`, `pty_bridge.rs`): the app sources for the hub and
  API — shared tabs from `Pane.remoteShared` (a pane's tabs, id = tab id), the workspace snapshot, the
  scrollback tail from the tab's scrollback file and live output from its `TerminalIOTap`, the terminal
  size, input written to the tab's PTY as typed input (a tab that is not running → 409), transcripts and
  questions through P7-3 with the tab's session; turning on (starts both listeners; off at every launch),
  turning off, preferences pushed to the hub (max devices, expiry, read-only, shell input;
  a reach-mode change rebinds only when it changed, upstream `remote_control_set_reach_mode`), open and
  close pairing (refreshing the host), revoke; `RemoteEvent`s become notifications through
  `AgentNotifier` (a device sent a message, start failed, auto-disabled — the last two also turn the
  toggle off); stop and revoke at quit (P7-6's `flush` call). Links `AletheRemote` into the app. Files:
  `Alethe/Remote/RemoteControlController.swift`, `TerminalRegistry.swift` (a read and input API by tab),
  `TerminalPaneView.swift` (grid size), `AgentNotifier.swift`, `project.pbxproj`, `Alethe-Info.plist`
  and `InfoPlist.xcstrings` (`NSLocalNetworkUsageDescription`, if macOS asks for it), the P7-6 stub
  `TestSeeds+Remote.swift` (a shared terminal; remote control on; used by P7-18 to P7-20). Needs P7-6,
  P7-7, P7-8, P7-9. *Tests:* U (sources over a seeded workspace: only shared tabs listed, input reaches the
  PTY, preference changes do not restart unless the reach mode changed), UI (seeded remote on: a stub
  device message shows in the notification list). *Parity:* PER-7.
  *Done:* (`4a2c52e`) `RemoteControlController` wires `RemoteControlService` (AletheRemote) to the app:
  workspace source lists only tabs of shared panes (`AletheModel/RemoteSharing`), builds the snapshot,
  derives appearance from preferences, reads transcripts and questions through `Handoff` off main;
  `RemoteTerminalBridge` (typed PTY input, 409 when not running; scrollback tail cut on a character
  boundary; grid size; tap output decoded across chunk splits, only for tabs shared right now). Off at
  every launch; settings pushed as they change (only a reach-mode change rebinds); pairing refreshes the
  host; revoke one or all; quit stops and revokes everything. Events become `AgentNotifier`
  notifications; start-failed/auto-disabled turn the toggle off. `AletheRemote` linked into the app,
  `NSLocalNetworkUsageDescription` added; debug UI-test launches bind loopback only. Tests (sharing,
  bridge, service; UI notification) written and compiled, NOT run.
- [x] **P7-13 (S) Discord Rich Presence in the app.** `DiscordPresenceController` (upstream
  `useDiscordPresence.ts`): while `discordPresence` is on, "Working with Alethe" with the current view
  (Home → "Viewing the dashboard", workspace → "Managing terminals", an orchestration board in front →
  "Orchestrating AI agents") and the app's launch time, refreshed every 30 s and on view changes;
  cleared when turned off and at quit; Settings › Integrations › Discord section (upstream
  `IntegrationsPage` `discord`). Files: the P7-6 stubs `DiscordPresenceController.swift`,
  `DiscordSettingsSection.swift`, `TestSeeds+Discord.swift`. Needs P7-4, P7-6. *Tests:* U (activity per
  view, cleared when off, with a fake client), UI (the toggle). *Parity:* PER-4.
  *Done:* (`aa575e4`) `DiscordPresenceSession` (AletheIntegrations) drives the P7-4 client: while
  `discordPresence` is on it sends "Working with Alethe" with the view (dashboard, terminals, or
  orchestration board in front) and the launch time, on view changes and every 30 s; clears when turned
  off and at quit (flush); no project names (upstream has no setting for them); ordered client calls.
  `DiscordPresenceController` follows the preference and view by observation; Settings › Integrations ›
  Discord toggle; test launches use a silent client (seed `discordPresence`). Tests (U with a fake
  client, UI toggle) written and compiled, NOT run.
- [x] **P7-14 (L) Now Playing.** `NowPlayingController` (upstream `useNowPlaying.ts`): connected status,
  the current track every 8 s only while a Now Playing view is visible and the app is active (one request
  in flight), the last track kept per profile and shown paused after a relaunch, connect (P7-10 login)
  and disconnect; the Home card (upstream `HomeView/NowPlayingWidget.tsx`: art, track, artists,
  progress, open in Spotify, connect prompt) — closing P3-15's deviation — and the sidebar footer
  (upstream `SidebarNowPlaying`); Settings › Integrations › Spotify (client ID, secret in a secure field,
  the redirect URI to register with a copy button, Connect/Disconnect, errors). Art loaded off main and
  cached; Reduce Motion respected; theme tokens only. Files: the P7-6 stubs `NowPlayingController.swift`,
  `NowPlayingViews.swift`, `SpotifySettingsSection.swift`, `TestSeeds+Spotify.swift`. Needs P7-6, P7-10.
  *Tests:* U (polling stops when hidden, last track restored), UI (seeded track on Home and in the
  sidebar; Settings section), HT. *Parity:* PER-3, HOME-1.
  *Done:* (`d29b839`) `AletheIntegrations/Spotify/NowPlayingModel` (upstream `useNowPlaying`):
  connection checked when a view first appears; track fetched every 8 s only while a view is visible,
  the app active and Spotify connected, one request at a time; last track kept per profile (`spotify-
  last-track.json`, saved on song change) and restored paused; a rejected refresh disconnects;
  Disconnect also deletes the saved track. `NowPlayingController` connects it to the profile, Keychain
  and app activation with localized callback pages. Home card, sidebar footer, Settings › Integrations ›
  Spotify (client ID, Keychain secret, redirect URI with Copy, Connect/Disconnect); cover art off main
  and cached; Reduce Motion stops the equalizer; theme tokens only. Seeds `spotify`/`spotifyOff` never
  reach Spotify. Tests (U 12, UI 4 incl. HT at 3 zooms) written and compiled, NOT run.
- [x] **P7-15 (M) GitHub Sync sheet and toolbar item.** The sheet (upstream `SyncModal` GitHub card;
  the cloud card is SET-6, Won't port): connect with a token (secure field; a link to create one with
  the `gist` scope), connected as, gist link, Push, Pull (asks once: it replaces this profile's
  workspace and relaunches), last push and pull, Disconnect, upstream's error cases; the toolbar Sync
  item (upstream `topbarShowSync`) and Settings › General › Data › GitHub Sync… open it. Files: the P7-6
  stubs `GistSyncController.swift`, `GistSyncSheet.swift`, `SyncToolbarItem.swift`,
  `TestSeeds+GistSync.swift`; `DataSettings.swift`. Needs P7-6, P7-11. *Tests:* UI (connect, push and
  pull over a stub endpoint; no pull without confirmation), HT. *Parity:* SET-5, UI-7.
  *Done:* (`2bbb865`) GitHub Sync sheet: connect with a token in a secure field (cleared at once, never
  shown again; link to create a `gist`-scoped token); connected: account, Open Gist, Upload (open
  documents saved first), Download, last upload/download, Disconnect, upstream error messages. Download
  validates the gist first and asks once before replacing the profile (showing its project and terminal
  counts), then safety backup, schedule (`DataActions.importGistPull`) and relaunch; a Tauri gist opens
  the Tauri import sheet (new optional `projectsFile`). Toolbar Sync item and Settings › General › Data
  › GitHub Sync… open it. Tests (UI `GistSyncTests` against an in-app GitHub stub, HT at 120 %) written
  and compiled, NOT run.
- [x] **P7-16 (M) 9router settings, install and toolbar pill.** `Router9Controller` (upstream
  `useRouter9Runtime.ts`, `useRouter9AutoStart.ts`): status refreshed while visible, start and stop,
  auto-start at launch when enabled, auto-start is on, an install exists and the port is free; Settings ›
  Integrations › 9router (upstream `Router9Settings.tsx`: enable, source, port, API key in the Keychain,
  auto-start, default for new agents, status, Start/Stop, Open Dashboard, log, advisories and docs
  links); the install and uninstall sheet (upstream `Router9InstallModal.tsx`, `useRouter9Install.ts`:
  the exact command shown, run through the P3-3 installer with its log); the toolbar pill (upstream
  `Router9PillButton`: status, start/stop). Files: the P7-6 stubs `Router9Controller.swift`,
  `Router9SettingsSection.swift`, `Router9ToolbarItem.swift`, `TestSeeds+Router9.swift`; new
  `Router9InstallSheet.swift`. Needs P7-5, P7-6. *Tests:* U (auto-start conditions), UI (settings and
  pill against a stub install), HT. *Parity:* PER-5, UI-7.
  *Done:* (`5ef0319`) `Router9Controller`: status while visible, start/stop, auto-start once per launch
  only when enabled with auto-start, installed and the port free (`Router9AutoStart` rule in the
  package); stops what it started at quit and when turned off; API key only in the Keychain, never shown
  again; `routingConfig()` for P7-17. Settings › Integrations › 9router (enable, source, port, key,
  auto-start, default for new agents, status, Start/Stop, dashboard, log, advisories/docs).
  Install/uninstall sheet shows the exact command and runs it through the P3-3 installer (extended to
  plain command lines) with its log; success only if the install is on disk. Toolbar pill shows status
  and starts/stops. Tests (U auto-start rules; UI settings/pill/sheet against a stub install) written
  and compiled, NOT run.
- [x] **P7-17 (M) 9router routing for new terminals.** `AgentLaunchRequest.environment` (added
  variables, merged after the scrubbed ones; values never logged — `spawn.log` keeps names only, P5-11);
  a tab with `useRouter9` launches with P7-5's variables while 9router is enabled and keyed (upstream
  `useXtermSession.ts` `router9EnvFor`); the New Terminal sheet's "Route through 9router" toggle
  (upstream `NewTerminalModal`: shown only for supported agents when routing is available, default from
  `defaultForNewAgents`, a Start button while 9router is stopped) stored on the tab and kept by repeat
  last (P3-4). Files: `AgentLauncher.swift`, `TerminalRegistry.swift`, `NewTerminalSheet.swift`. Needs
  P7-1, P7-5, P7-16. *Tests:* U (environment per agent, placement, nothing when off or keyless), UI (the
  toggle appears only when available and the tab keeps it). *Parity:* PER-5, AG-3.
  *Done:* (`5cd24f6`) `AgentLaunchRequest.environment` applied after the scrubbed variables (the
  launcher's own still win), never logged (`spawn.log` keeps names). `Router9Launch` rules
  (`routingAvailable`, `launchEnvironment`, `wantsRouting`). A tab with `useRouter9` reads
  `router9.routingConfig()` (settings + Keychain key) off main on every start/restart through the
  existing wait-before-launch path. New Terminal › "Route through 9router" only for supported agents
  when enabled, keyed and installed (default from `defaultForNewAgents`, Start button while stopped,
  "Always route new agents"); stored on the tab; `TerminalCreation.useRouter9` keeps it for ⌥⌘T. Tests
  (U + UI `Router9RoutingTests` with stub agents) written and compiled, NOT run.
- [x] **P7-18 (M) Remote settings and terminal sharing.** Settings › Remote (upstream
  `RemoteControlPage.tsx`, `RemoteControlSettingsFields.tsx`): on/off (with the startup note: off at
  every launch), reach (LAN or Tailscale; Tailscale disabled with its hint and download link when not
  detected), read-only, shell input, max devices, session expiry, pairing status with Pair a Device…,
  devices (name, address hidden until revealed, online, expiry) with Revoke and Revoke All; the
  terminal menus' Share with Remote Devices toggle (upstream `sidebarMenus.tsx` `remoteShared`) with a
  shared glyph. Files: the P7-6 stub `RemoteSettings.swift`; `SidebarView.swift` and the pane header
  menu. Needs P7-12. *Tests:* UI (seeded: toggles reach the
  controller; sharing a terminal lists it in the controller's snapshot), HT. *Parity:* PER-7.
  *Done:* (`62d89fd`) Settings › Remote: on/off (off at every launch; turning on asks once with the LAN
  or Tailscale warning), reach (Tailscale disabled with hint, download link and Copy when not detected;
  fail-closed explained), read-only, shell input (disabled while read-only), device limit, session
  lifetime, pairing status with countdown, Close Window and Pair a Device…, devices (address hidden
  until revealed, online/idle, expiry) with Revoke / Revoke All (ask once); tokens never shown. "Share
  with Remote Devices" in the sidebar tab menu and the pane header menu, with a shared glyph in both.
  Debug-only `settings.remote.probe` line for UI tests. Upstream's 5-step how-to not ported. Tests (UI
  `RemoteSettingsTests`) written and compiled, NOT run.
- [x] **P7-19 (M) Pairing sheet and remote toolbar pill.** The pairing sheet (upstream
  `RemoteControlModal.tsx`): status, the QR (P7-2) and URL with Copy, the 120 s countdown, reopen when
  closed, devices with Revoke, Open Settings; the toolbar pill while remote control is on (upstream
  TitleBar remote pill: devices connected or idle) opens it. Files: the P7-6 stubs
  `RemotePairingSheet.swift`, `RemoteToolbarItem.swift`. Needs P7-12. *Tests:* UI (open pairing shows a
  QR and countdown; the pill appears only while on), HT. *Parity:* PER-7, UI-7.
  *Done:* (`b3317e2`) `RemotePairingSheet` (upstream `RemoteControlModal`): status badge and on/off,
  pairing QR (`RemotePairingQR`, ≥220 px) with the 120 s countdown and the URL with Copy, shown only
  while the sheet is open (the pairing window opens with the sheet, closes on dismiss, reopens by button
  once expired), connected devices (online/idle, expiry) with Revoke and Revoke All, LAN/Tailscale note,
  Open Settings (› Remote). `RemoteToolbarItem`: pill only while remote control is on ("N devices
  connected" or "Remote control on"), refreshed every 2 s, opens the sheet. Open: the controller
  notifies observers even when unchanged (the pill redraws every 2 s). Tests (UI `RemotePairingTests`,
  HT at 3 zooms) written and compiled, NOT run.
- [x] **P7-20 (S) Remote end-to-end and security checks.** On the running app with remote control bound
  to loopback through a test-only host: a `WKWebView` loads the bundled client from the pairing URL,
  pairs, lists only the shared seeded terminal, receives its output, sends a message and interrupts;
  read-only refuses input, revoke disconnects the page, the pairing token works once, a second device is
  refused at the limit; plus a checklist test over the sources (no wildcard bind, Tailscale fails
  closed, no token in logs, exports or `workspace.json`, 9router and the OAuth callback on `127.0.0.1`).
  Files: new tests and `TestSeeds+Remote.swift`. Needs P7-18, P7-19. *Tests:* UI, U. *Parity:* PER-7
  (the §10 security review before release).
  *Done:* (`3b0cf7d`) `RemoteEndToEndTests` loads the bundled phone client in runner-side `WKWebView`s
  from the loopback pairing URL (`remoteE2E` seed: shared stub Claude Code tab + private shell, one
  device max): pairs, lists only the shared terminal, receives output, sends a message and interrupts;
  read-only refuses input; a second device refused at the limit; a used pairing token refused; revoke
  ends the page and its token gets 401; no token anywhere under the data root.
  `RemoteSecurityChecklistTests`: no wildcard binds, Tailscale fails closed (no LAN fallback), remote
  logs never carry tokens or message text, exports redact remote credentials, saved documents hold no
  token keys, 9router and the Spotify callback stay on 127.0.0.1. Fix: `SecretRedactor` now redacts
  `pair=` tokens. Written and compiled, NOT run.
- [x] **P7-21 (S) Changelog + phase review.** Parity matrix statuses; run upstream-watch; full test run.
  *Done (review, 2026-09-26):* all Phase 7 tasks implemented by parallel agents and integrated. Owner
  rule: compile only — package `swift build --build-tests`, app `build.sh Debug` and UI
  `build-for-testing` succeed, strings gate ok; every Phase 7 test (incl. the remote end-to-end and
  security checklist) is written and compiled but NOT run; no real Spotify, Discord, 9router, GitHub or
  phone pairing run yet. upstream-watch: 0 upstream commits, 0 remote client changes. Parity SET-5,
  PER-3/4/5/7 Done.

Parallel waves (a task starts when everything it needs is committed; tasks in a wave share no files
beyond string catalogs — rebase on conflicts). Shared files and the tasks that edit them, never two in
one wave: `PreferencesDocument`, `WorkspaceDocument`, `ToolbarLayout`, `TauriImport` P7-1 only;
`Package.swift` P7-2, P7-9; `Handoff.swift` P7-3; `AppEnvironment`, `SettingsView` (tabs),
`EditorRequest`, `MainWindow`, `MainToolbar`, `HomeSections`, `TestSeeds.swift` P7-6 only;
`SidebarView` P7-6, P7-18; `TerminalRegistry` P7-12, P7-17; `AgentNotifier`, `TerminalPaneView`,
`project.pbxproj`, `Alethe-Info.plist` P7-12 only; `AgentLauncher`, `NewTerminalSheet` P7-17 only;
`DataSettings` P7-15 only; each P7-6 stub file by the one task named with it
(`TestSeeds+Remote.swift`: P7-12, then P7-20). No task touches the right sidebar's tab list:
1. P7-1, P7-2, P7-3, P7-4, P7-5 — no dependencies.
2. P7-6, P7-7, P7-8, P7-9, P7-10, P7-11.
3. P7-12, P7-13, P7-14, P7-15, P7-16.
4. P7-17, P7-18, P7-19.
5. P7-20.
6. P7-21.

**Phase 7 exit criteria:** with remote control turned on, a phone on the same network (or tailnet)
pairs by scanning a QR within its window, sees only the terminals shared with it, follows their output
live, reads Claude Code and Codex conversations, answers their questions, sends prompts and interrupts
— within the device limit, rate limits and session expiry, read-only when asked, shell input only when
allowed — and loses access when revoked, when remote control is turned off, after 4 h idle or at quit;
the listeners never bind a wildcard address and are off at every launch; Spotify connects through the
loopback OAuth redirect and Now Playing shows on Home and in the sidebar; Discord shows the current
activity while enabled; 9router installs into the profile, starts on loopback and routes Claude Code,
Codex and OpenCode tabs that ask for it; the profile's workspace pushes to and pulls from a private
gist; the Tauri app's settings for all of them import; no token or secret appears in preferences,
profile files, backups, logs, exports or process arguments.

### Phase 8 — Release
Developer ID signing, `notarytool` + staple, Sparkle 2 + appcast, DMG (L); SET-8 updater UI + What's New
(M); performance audit (launch < 400 ms to first frame; idle CPU < 1% with 10 terminals; memory per
hibernated terminal) (M); accessibility audit (VoiceOver, keyboard-only, Reduce Motion/Transparency,
Increase Contrast) (M); extraction to the new repository with `git filter-repo --subdirectory-filter
AletheNative` (S).

Groundwork done ahead of Phase 8 (2026-09-28): `Scripts/make-dmg.sh` builds a branded DMG (dmgbuild,
`Scripts/dmg/`), the bundle icon sits on Apple's icon grid (`Scripts/make-app-icon.py`), and a
non-notarized preview is published on the fork as `mac-native-v2-preview.1` (docs/FORK_WORKFLOW.md).

## 8. Parity matrix

Status values: **Not started**, **In progress**, **Done**, **Replaced** (different native mechanism, same
user outcome), **Won't port** (with reason). All rows start at the baseline `75083e2`.

| ID | Feature | Phase | Status | Notes |
|---|---|---|---|---|
| HOME-1 | Home dashboard | P3 | Done | P3-15; no ASCII background (see P3-15 deviation), no avatar |
| HOME-2 | Mini-terminal quick launch | P3 | Done | P3-15; quick launch picks a project instead of a folder |
| HOME-3 | Activity graph / time analytics / usage strip | P3 | Done | P3-15 |
| HOME-4 | Setup walkthrough | P3 | Done | P3-16; four steps (agents, project, terminal, appearance) |
| HOME-5 | Notifications list | P3 | Done | P3-11 list, shown on Home in P3-15 |
| WS-1 | Project containers | P1, P2 | Done | Open, resize, close (P1-6); collapse, fullscreen, reorder, isolate (P2-16) |
| WS-2 | Flat mode | P2 | Done | P2-21; View › Flat Workspace, saved per workspace tab |
| WS-3 | Layouts Auto/Spotlight/Sidebar/Custom | P1 (Auto), P2 | Partial | Auto (P1-6), Spotlight and Sidebar (P2-18), project Custom grid + designer (P2-19); workspace/group scopes open |
| WS-4 | Named project grids | P2 | Done | P2-20; switched from the container header and the project menu (no grid rows in the sidebar) |
| WS-5 | Tabs, closed tabs, history | P2 | Done | P2-17; History menu (⌘[ ⌘] ⌃Tab ⇧⌘T), ⌥-click adds to the current tab |
| WS-6 | Markdown pane | P2 | Done | P2-9; Mermaid as code (ADR-11) |
| WS-7 | Image pane | P2 | Done | P2-10 |
| WS-8 | Video pane | P2 | Done | P2-10; AVKit |
| WS-9 | Diff pane | P2 | Done | P2-11; side by side added |
| WS-10 | Focus mode | P2 | Done | P2-21; double-click header, ⇧⌘F, Esc/backdrop to leave |
| WS-11 | Add content | P2 | Done | Markdown (P2-9), image/video (P2-10), Git changes (P2-11), website (P2-12); orchestration with ORC-1 |
| WS-12 | Link viewer overlay | P2 | Done | P2-14; sheet + link actions menu (⇧⌘-click) |
| WS-13 | Empty workspace launcher | P2 | Done | P2-22; Find/Jump row (P2-25) |
| WS-14 | Disable terminal/project, suspend group | P2 | Done | P2-23; processes end with output kept (upstream behavior, not SIGSTOP) |
| TERM-1 | Real PTYs + process tree | P1 | Partial | Spawn/resize/restart/kill done (P1-7); shell integration marks (P2-3); process-tree kill (P2-2); process-tree info later |
| TERM-2 | Sub-tabs lane | P2 | Done | P2-1; close is undoable instead of confirmed |
| TERM-3 | Terminal search | P0 spike, P2 | Done | P2-4; Ghostty search is case-insensitive only |
| TERM-4 | Smart copy/paste | P2 | Done | P2-5; paths backslash-escaped (macOS convention) |
| TERM-5 | Prompt history | P2 | Done | P2-6; ⌥⌘↑/⌥⌘↓ |
| TERM-6 | Clickable links | P2 | Done | P2-13; actions menu P2-14 |
| TERM-7 | Terminal themes/font | P1 | Done | App theme + zoom-scaled font (P1-7) |
| TERM-8 | Restart / command-not-found overlays | P1 | Done | Install button comes with AG-5 |
| TERM-9 | Double ^C force-kill | P2 | Done | P2-2; kills the whole process tree |
| TERM-10 | Scrollback persistence + reattach | P2 | Done | P2-7; replay limited to the last 1 MiB by GhosttyKit |
| TERM-11 | `alethe` CLI shim | P5 | Done | P5-8; `~/.local/bin/alethe` shell shim, folder open requests |
| SB-1 | Project tree (Normal/Clean) | P1 | Done | Tree, reorder, drag and drop, context menus (P1-4); Clean compact mode (P2-27) |
| SB-2 | New/edit project (clone, marker, git init, stack) | P1 (basic), P5 | Done | P1-5 basics; P5-5 clone, `.alethe/project.json` marker, git init, stack detection |
| SB-3 | Groups (nested, suspend) | P1, P2 | Done | Nested groups (P1-4/P1-5); suspend and resume (P2-23) |
| SB-4 | Export/import project config | P5 | Done | P5-6; upstream key names, both directions |
| SB-5 | Live chat title + busy/done glyph | P3 | Done | P3-10; titles from transcripts, working / needs-input / unread-done glyphs |
| SB-6 | Open in VS Code / Finder / browser | P5 | Done | P5-7; VS Code/Insiders/VSCodium, Finder, repository page |
| SB-7 | Right sidebar | P4 | Done | P4-3; ⌥⌘0, plugin tabs + Files, Docs, Pull Requests; extension tabs (P4-19) |
| SB-8 | View placement | P4 | Partial | P4-2 model + persistence; left-placement tabs now render in the left sidebar shell; no drag UI between sidebars yet |
| SB-9 | Left sidebar shell | Native polish | Done | Home/Projects/Files + left plugin tabs, Find/Jump, selected-project organization, Now Playing and shared profile menu; Files removal from the right sidebar is owned by the separate right-sidebar task |
| AG-1 | 11 agent types | P1 (5), P3 | Done | P3-1; ten agents; `wsl`: Won't port (Windows-only) |
| AG-2 | Unrestricted flags | P1 | Done | Launch support (P1-8); per-terminal toggle in the New Terminal sheet (P1-9) |
| AG-3 | New-terminal modal | P1, P3 | Done | Basic sheet + first prompt (P1-9); repeat last ⌥⌘T and grid picker (P3-4); planner → Phase 6, 9router → Phase 5 |
| AG-4 | Launcher resolution + override | P1, P3 | Done | Resolver + `cliPaths` (P1-8); Choose CLI… on a missing CLI (P1-7); Settings › Agents with version, Choose…, Reset (P3-2) |
| AG-5 | Install/update/uninstall CLIs | P3 | Done | P3-3; macOS commands from each vendor's docs (script, Homebrew, npm) |
| AG-6 | Enable/disable agents | P3 | Done | P3-2; Settings › Agents |
| AG-7 | Claude ↔ Codex handoff | P3 | Done | P3-12; review-and-edit capsule, redaction, new terminal with upstream's bootstrap prompt |
| AG-8 | Agent hook bridge | P3 | Done | P3-9; loopback endpoint (Network.framework), Claude --settings, Codex notify forwarder, traffic fallback |
| AG-9 | Model discovery | P3 | Done | P3-5; real listings + Claude aliases, no stale fallback lists; any id can be typed |
| SE-1 | Session auto-resume (5 providers) | P1 (2), P3 | Done | Claude + Codex (P1-10); OpenCode, Antigravity, Cursor (P3-6) |
| SE-2 | Resume last session | P2 | Done | P2-26; Terminal › Resume Previous Conversations (Claude Code, Codex) |
| SE-3 | Claude history + recent chats | P3 | Done | P3-7; History › Conversations… ⌘Y, Claude Code + Codex, one or all projects |
| SE-4 | Session/transcript cost | P3 | Done | P3-8; Claude Code priced, Codex tokens, OpenCode from opencode.db (read-only) |
| GIT-1 | Git Control | P4 | Done | P4-5; built-in plugin, sheet from project/History menus; not in Find/Jump yet |
| GIT-2 | Commit graph | P4 | Done | P4-6; Git Control › History; no diff of a past commit's file |
| GIT-3 | Incoming/outgoing | P4 | Done | P4-7 |
| GIT-4 | Worktree isolation | P4 | Done | P4-9; New Terminal toggle, project defaults, Worktrees… sheet |
| GIT-5 | Merge Center | P4 | Done | P4-10…P4-13; sidebar panel, resume, branch testing, contract check; `terminalVerified` and BranchTesting checklist not ported |
| PR-1 | Open PRs + send to Todo | P4 | Done | P4-14; right sidebar tab via `gh` |
| PR-2 | PR review + squash merge | P4 | Done | P4-15; review reads the PR with `gh`, not a local branch diff |
| FS-1 | File explorer + git badges | P4 | Done | P4-8; Quick Look on Space; no drag to a pane yet |
| FS-2 | Folder browser | P1 | Replaced | `NSOpenPanel` + Finder drops (P1-4, P1-5) |
| BR-1 | Web pane | P2 | Done | P2-12, WKWebView (private); CDP engine: Won't port |
| BR-2 | Agent page offer | P2 | Done | P2-15; from terminal output (no shared CDP browser) |
| BR-3 | Playwright MCP browser session | P5 | Done | P5-19; shared browser in its own window (no CDP pane) or headless |
| EXT-1 | MCP manager | P5 | Done | P5-1/2/14/21/22/25; five agents, registry, health, sync, backups; no paste-JSON add |
| EXT-2 | Skills browser | P5 | Done | P5-15; History › Skills… and embedded in the MCP manager |
| EXT-3 | Plugin system | P4 | Done | `AlethePluginKit` + built-ins (P4-1/2); ExtensionKit third parties (P4-19, unverified end to end); JS plugins: Won't port |
| EXT-4 | Agent library + economy agents | P5 | Done | P5-16; Project menu › Agent Library… (upstream only had it in the Agent Canvas POC) |
| EXT-5 | Graphify | P5 | Done | P5-17/23; per-launch MCP wiring (no writes to project agent configs), graph pane, snapshots |
| EXT-6 | ai-memory wiring | P5 | Done | P5-18; per-launch MCP wiring |
| EXT-7 | GSD Sync | P5 | Done | P5-20/24; no per-project `gsdWatcherEnabled` |
| ORC-1 | Orchestrator board | P6 | Done | P6-13/14/15/16/17; board opens beside the planner (no pane groups) |
| ORC-2 | Orchestrator MCP tools + core | P6 | Done | P6-1…P6-10; app serves `POST /mcp`; `alethe-orchestrator-mcp` helper (bridge + standalone) |
| ORC-3 | Scheduler, telemetry, planning audit | P6 | Done | P6-18…P6-22; no supervisor events; scheduler does not open agent terminals |
| USE-1 | Usage pills + AI Usage + reset credit | P3 | Done | P3-13; pills opt-in per provider, in-memory cache |
| USE-2 | Activity tracking | P3 | Done | P3-14; same file format as upstream |
| USE-3 | RAM control, hibernation, supervisor | P2 | Done | P2-24; memory indicator + policy; hibernated terminals resume when shown; no history chart |
| USE-4 | Crash report | P5 | Done | P5-11; clean-exit marker, `.ips` + MetricKit offered, never sent |
| UI-1 | Themes (16 + 4) | P0, P1, P4 | Done | 16 built-ins + picker (P1-11); Theme Pack plugin (P4-18) |
| UI-2 | Visual style normal/clean | P2 | Done | P2-27; Clean theme transform + compact sidebar |
| UI-3 | Motion preference | P2 | Done | P2-27; preference or macOS Reduce Motion |
| UI-4 | App icon themes | P5 | Done | P5-12; runtime Dock icon only (bundle icon unchanged) |
| UI-5 | UI zoom | P1 | Done | Font + metric scale only; View menu + Settings (P1-11) |
| UI-6 | Window opacity | — | Won't port | Win32-only upstream; Mac uses materials |
| UI-7 | Toolbar configuration | P5 | Done | P5-13; `.toolbar(id:)` + Settings › Toolbar |
| UI-8 | i18n EN + pt-BR | P0, P1 | Done | String Catalogs (P0-4); language setting + relaunch (P1-11) |
| SET-1 | Preferences | P1, ongoing | Partial | Settings scene with Appearance (P1-1, P1-11); other panes land with their features |
| SET-2 | Feature toggles | P5 | Done | P5-3 |
| SET-3 | Profiles | P1 (base), P5 | Done | P1-3 base; P5-9 Settings › Profiles + toolbar menu |
| SET-4 | Backup/import/reset/logs | P5 | Done | P5-10 backup/import/reset/erase; P5-11 logs and diagnostics |
| SET-5 | GitHub gist sync | P7 | Done | P7-11/15; own private gist (never overwrites the Tauri gist); pull applies at next launch after a safety backup |
| SET-6 | Cloud sync | — | Won't port | Upstream server not shipped (localhost default); revisit if it ships |
| SET-7 | Onboarding + welcome | P5 | Done | P5-26; onboarding + welcome back (after an update or 7 days away) |
| SET-8 | Updater + What's New | P8 | Not started | Sparkle |
| SET-9 | Notifications | P3 | Done | P3-11; agent done / needs-input, UserNotifications in the background, toolbar list |
| SET-10 | Find/Jump | P2 | Done | P2-25; ⌘K, fuzzy ranking (upstream substring), terminals + projects + commands |
| SET-11 | Audit center | P5 | Replaced | OSLog + diagnostic export |
| SET-12 | Close confirmation | P2 | Done | P2-26; quit confirmation with Don't ask again; Settings toggle |
| SET-13 | Keyboard shortcuts | P1, ongoing | Partial | ⌘N, ⇧⌘N, ⌘O, ⌘T, ⌘,, zoom, undo (P1-1…P1-9); §6.3 |
| PER-1 | Todos | P4 | Done | P4-16; built-in plugin, right sidebar, JSONC template |
| PER-2 | Pomodoro | P4 | Done | P4-17; toolbar pill, phase notifications |
| PER-3 | Spotify | P7 | Done | P7-10/14; loopback OAuth on 127.0.0.1:8888, secrets in the Keychain |
| PER-4 | Discord Rich Presence | P7 | Done | P7-4/13; no project names |
| PER-5 | 9router | P7 | Done | P7-5/16/17; key in the Keychain, loopback only |
| PER-6 | Dictation | P3 | Done | P3-17; Apple SpeechAnalyzer, ⌥⌘E toggle/hold, no Fn-Fn |
| PER-7 | Remote control | P7 | Done | P7-2/3/7/8/9/12/18/19/20; upstream phone client bundled byte-identical; off at every launch |
| EXP-1 | Agent Canvas POC + TokenHud | — | Won't port | Experimental upstream; revisit after v1 |
| EXP-2 | Agent Sandbox | — | Won't port | Disabled upstream |
| EXP-3 | Ghostty backend in Tauri | — | Replaced | Native terminal is the default |
| — | Windows-only code (ConPTY, registry, Job Objects, WebView2, `wsl`) | — | Won't port | Platform-specific |

## 9. Staying current with upstream

The native app shares no code with upstream, so "staying current" means **detecting and triaging**
upstream changes, not merging them.

1. `AletheNative/UPSTREAM_BASELINE` stores the last reviewed `origin/main` SHA.
2. `Scripts/upstream-watch.py` runs `git fetch` and diffs `baseline..origin/main` for: new or removed
   `#[tauri::command]` names in `src-tauri/src/lib.rs`; new keys in `src/lib/i18n/messages/en.ts`; new
   `docs/CHANGELOG.md` sections; new directories under `src/components/`; new fields in
   `src/lib/types.ts` (`ProjectsFile`, `Project`, `Terminal`, `Preferences`); schema version bumps in
   `projectsStore.migrations.ts`. It writes `AletheNative/upstream-reports/<date>-<sha>.md`; triage
   moves each item into §8 by hand (the script never edits this plan).
3. Cadence: at the start of every phase and weekly. Triage assigns each row a phase or "Won't port" and
   advances the baseline in its own commit.
4. Importer compatibility: when upstream bumps the `projects.json` version, add a fixture and extend
   `TauriImporter` in the next phase.
5. Strings only land with code; the orphan test prevents translated-but-unimplemented debt.

### 9.4 Extraction to the new repository
When the owner decides (Phase 8 or earlier): `git filter-repo --subdirectory-filter AletheNative` on a
fresh clone of `mac-native-v2`, producing a repository whose root is the native app with history. The
self-contained layout (ADR-7) makes this lossless.

## 10. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `HOST_MANAGED` exists only as a libghostty-spm patch | Terminal architecture | Built from pinned sources (P0-5); P0-6 gate; SwiftTerm fallback behind `TerminalEngine`; pin moves only with a re-run of the P0-6 checks |
| Volume of the port (~290 commands) | Schedule | Vertical phases; matrix as control; upstream tests ported as golden files |
| No Developer ID yet | No external distribution; Keychain prompts | Stable local identity; Keychain reads behind a dev flag; Phase 8 waits for the account (§11) |
| Comment-preserving TOML editing without a mature Swift library | Corrupting `~/.codex/config.toml` | Minimal table-level editor; golden tests from `toml_edit` cases; backup before write |
| ExtensionKit distribution/UX for third parties | Plugin API scope | Spike in P4; built-ins do not depend on it |
| Liquid Glass × custom themes | Legibility | Chrome tinted, content on tokens; per-theme contrast test; Reduce Transparency path |
| SwiftUI/AppKit key-routing regressions | Terminal usability | ADR-10; key-routing UI tests in CI from P0 |
| Scope creep (the first attempt's failure mode) | Depth vs breadth | Phase order fixed; showcase features only after their phase's depth items |
| Upstream keeps moving fast | Parity gap | §9 watch + weekly triage |
| Remote control exposes terminals on the network | Security | Pairing, read-only default, device limits, token expiry, LAN/Tailscale only, security review before release |

## 11. Owner decisions and open questions

Resolved (2026-09-22):
1. **Name:** the product stays **Alethe**. Bundle id **`com.kc1t.alethe.mac`** (distinct from the Tauri
   app's `com.kc1t.alethe`, so the two never share a data directory).
2. **Changelog:** `AletheNative/CHANGELOG.md` (the repository's `docs/CHANGELOG.md` stays the Tauri
   product's).
3. **Dictation:** Apple on-device speech (`SpeechAnalyzer`/`SpeechTranscriber`); Parakeet is not ported.
5. **License:** same as `main` — AGPL-3.0.
6. **Developer ID:** not available yet. Phase 0–7 use the stable local signing identity; Phase 8
   (notarization, Sparkle, public DMG) waits for the account.
7. **Remote control client:** reuse the upstream PWA, bundled as a resource.

4. **Third-party plugins channel:** **ExtensionKit** (for now). Each third-party plugin ships as an app
   extension inside its own signed app, runs out of process and sandboxed, and renders UI remotely.
   Built-ins (Git, Todos, Theme-pack) stay in-process on the same `AlethePluginKit` API. The P4 spike
   validates the ExtensionKit flow; in-process bundles are rejected unless the spike fails.

### Left sidebar shell parity — 2026-10-16

- `LeftSidebar` wraps the unchanged project list and reuses `FilesView` and the plugin view registry.
  Selected tabs use scene restoration; Home and profile actions are shared with the toolbar controls.
- Organization uses the same `WorkspaceDocument.setLayoutMode` mutation as the container header and
  appears only for a selected project with at least two panes. Now Playing lives in the shared footer.
- Files shows an Explorer heading and the upstream empty-state copy with a Create project action when
  no project is selected. Native Files continues to browse the project folder, independently of PTY state.
- The project rows, menus and existing accessibility identifiers remain unchanged. The only project-list
  embedding change removes its Now Playing inset; `RightSidebar.swift` is untouched. Follow-up: the
  separate right-sidebar task must remove Files from its tab list.
- Validation: the string gate and Swift syntax parsing pass. Debug build and hit-target UI validation
  cannot resolve packages in this sandbox because Xcode cannot write its user module/manifest caches;
  full compilation and interaction validation remain required outside the sandbox.
- AI memory could not be recorded: this session exposes neither an ai-memory tool/CLI nor its skill.
  This note preserves the outcome and follow-up for the reviewer.

### Sidebar compilation follow-up — 2026-10-16

- Removed `listRowSpacing(0)` from `SidebarWebAppearance.swift`: the modifier is unavailable on macOS.
  Existing row insets, heights and padding continue to control sidebar layout.
- Validation: `check-strings.py` and `git diff --check` pass; no sidebar references to
  `listRowSpacing` remain. No build was attempted, as requested; the reviewer must compile externally.
- AI memory remains unavailable in this session (no tool or skill); this note records the outcome.
- A checkpoint commit cannot be written under the current read-only Git metadata permissions.
- Reviewer follow-up (2026-10-17): removed the reintroduced `listRowSpacing(0)` call from the
  pending sidebar polish. The string gate and whitespace checks pass; no sidebar calls remain.
  No build was attempted. AI memory is still unavailable; external compilation remains required.


### Modal/dropdown and focus audit — 2026-10-18

See `AletheNative/upstream-reports/MODALS_DROPDOWNS_AUDIT.md` for the complete presentation inventory,
corrected window-overlay routing, Debug onboarding retry, menu actions, dropdown bounds and terminal
window-wide focus. The audit explicitly distinguishes existing themed content from unresolved web UI
and service parity. Do not mark all modal/dropdown parity complete from this pass. Validation uses an
isolated copy because the working index initially contained an unresolved ScrollbackFile merge.
Concurrent workspace work resolved it and checkpointed the shared implementation (`efbf229`).
The isolated Debug build and both targeted focus/onboarding UI tests pass. No external ai-memory
capability is available; the report preserves decisions, state and next steps.


### Browser setup parity follow-up — 2026-10-18

The main menu and Add Content now open a themed browser setup overlay. URL validation, optional
persistent name, zoom, JavaScript and resource policy reuse the existing WKWebView model. Optional
WebPaneOptions.name decodes older files unchanged. Model tests (6), string gate and the browser
UI flow at 150% zoom (including modal transition, Escape and relaunch) pass. Shared Escape capture
now respects dropdowns, nested overlays and focused AppKit text editors. The audit report records
state and decisions because external ai-memory is unavailable.


### Remaining top-level dialogs — 2026-10-18

The web path now presents conversations, handoff, cost, diagnostics, remote pairing, preview,
import, layout design, GSD activity, welcome and crash artifacts through the themed window overlay.
Native presentations remain available. UI validation covers both visual styles, light/dark themes,
150% zoom, dropdown/field Escape priority, native conversations, preview, import+undo, grid+undo
and nested onboarding import. The audit report records detailed state because ai-memory is unavailable.
