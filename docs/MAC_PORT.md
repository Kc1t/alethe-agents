# macOS port ledger

The macOS app is a separate Swift codebase. This file lists every behavior change made here since
the last point the Mac app matched, so each one can be ported, or skipped on purpose.

Mac synced through: `v1.7.0` (`80e44a3`)

## How it works

- **Baseline.** The line above, mirrored by a local `mac-synced` tag, marks the last commit the Mac
  app is at parity with. `git log mac-synced..main` is everything that came after it.
- **Report.** `npm run mac-port` lists the portable commits since the baseline, grouped by kind.
  `npm run mac-port -- --all` also shows what was skipped automatically (docs, ci, tests, style,
  chore). `npm run mac-port -- --check` fails when a portable commit has no entry below.
- **Commit trailer.** Every `feat`/`fix` commit carries `Mac-Port: required`, `Mac-Port: skip
  (<reason>)` or `Mac-Port: n/a`. `skip` and `n/a` drop the commit from the report.
- **Moving the baseline.** When the Mac app reaches a new point, set the line above and move the
  tag (`git tag -f mac-synced <sha>`), then delete the entries that are now `ported`.

## Entry format

```
- `<status>` · `<kind>` · `<sha>` <commit subject>
  - Files: <two or three reference files>
  - Contract: <persisted format, sync payload, MCP tool shape: anything both apps must read alike>
```

- **status:** `pending`, `ported`, or `skip` (with the reason).
- **kind:** `contract` (data both apps exchange: Cloud sync, `projects.json` migrations, profiles,
  keyring, backups; port these first), `backend` (Rust only), `ui`, or `platform` (Windows or
  Linux only).
- Before the commit exists, write the entry with the subject and fill in the sha afterwards; the
  check accepts either.
- Behavior is described in [`CHANGELOG.md`](CHANGELOG.md). Link the matching entry when the subject
  alone is not enough.

## Unreleased

- `pending` · `ui` · Codex's first prompt (handoff, prompts sent at launch) waits for its composer and never presses Enter while a trust, hooks-review or update dialog is open
  - Files: `src/lib/agentPromptDelivery.ts`, `src/components/XTermView/useXtermSession.ts`
- `pending` · `backend` · A handoff packet stays until its pane closes; packets no pane lists are pruned at startup (`prune_agent_handoffs`)
  - Files: `src-tauri/src/handoff.rs`, `src/stores/projectsStore.ts`, `src/components/TerminalPane/index.tsx`
- `pending` · `backend` · Writing Codex hooks removes the unmarked subagent hook blocks older releases appended to `.codex/config.toml`
  - Files: `src-tauri/src/agent_events.rs`
- `pending` · `ui` · Tutorials page in Preferences plays the Alethe videos inline (YouTube privacy-enhanced embed) with links to YouTube
  - Files: `src/lib/tutorials.ts`, `src/components/modals/preferences/TutorialsPage.tsx`, `src/components/modals/PreferencesModal.tsx`
- `pending` · `ui` · New install defaults: Elite Pure Black, clean style, reduced motion, 90% zoom, Dark Lemon terminal, sidebars 380/420; the default avatar is the app icon
  - Files: `src/lib/types.ts`, `src/stores/projectsStore.migrations.ts`, `src/lib/profile.ts`, `src/lib/themeIcons.ts`, `index.html`
- `pending` · `ui` · Agents tab groups workers by project and planner, with agent icons, a status summary and folded finished work
  - Files: `src/components/RightSidebar/AgentsPanel.tsx`, `src/components/RightSidebar/AgentsPanel.module.css`, `src/lib/agentsPanelGroups.ts`
- `skip (web only: styling, labels and Esc handling of the web settings selects)` · `ui` · Settings selects share one dropdown with steady widths, a check on the current choice and readable custom agent pickers; Esc on an open select no longer closes Settings
  - Files: `src/components/ui/Dropdown.tsx`, `src/components/modals/preferences/CustomAgentsSection.tsx`, `src/components/modals/PreferencesModal.module.css`, `src/components/modals/PreferencesModal.tsx`
- `pending` · `contract` · Official skills: the bundled skill becomes `alethe` v21 and installs into projects
  - Files: `src-tauri/src/skills.rs`, `src/components/OfficialSkills/index.tsx`, `src/components/modals/mcp/SkillsBrowser.tsx`, `scripts/sync-skill.mjs`
  - Contract: catalog entries gain `repository`; agent results gain `error`; new `skills_remove_bundled`; `skills_catalog`, `skills_install_bundled` and `skills_remove_bundled` take an optional `projectPath` that targets `<project>/.claude/skills/<name>` for Claude and `<project>/.agents/skills/<name>` for Codex; installing `alethe` removes an Alethe-managed `alethe-orchestrate` folder (one with `.alethe-skill.json`); an empty skill folder counts as not installed; managed files are written to a temporary file and renamed; tooling manifests that name `alethe-orchestrate` map to `alethe`
- `pending` · `contract` · Orchestration policy path on macOS and Linux
  - Files: `src-tauri/src/orchestrator.rs`
  - Contract: `~/.config/alethe/orchestrate.json` (honoring `XDG_CONFIG_HOME`), or `ALETHE_ORCHESTRATE_POLICY` when set, matching the skill's `default_policy_path`; Windows keeps `%APPDATA%\Alethe\alethe-orchestrate.json`
- `pending` · `contract` · Playbooks page: the skill's playbooks as a canvas of blocks in Preferences, with price and spend conditions
  - Files: `src/lib/playbooks/flowDoc.ts`, `src/lib/playbooks/state.ts`, `src/components/modals/preferences/playbooks/NodeCanvas.tsx`, `src-tauri/src/orchestrator.rs`
  - Contract: `orchestrator_playbooks` / `orchestrator_save_playbooks` read and write `alethe-playbooks.yaml` next to the skill policy (or `ALETHE_ORCHESTRATE_PLAYBOOKS`), falling back to the bundled `playbooks.yaml` until a copy is saved; the YAML subset, key order and `routing` block match the skill's `assets/editor.html` export; the canvas compiles to the same phases (`with`, `after`, `if`, `then`, `gate`), a decision whose no skips ahead becomes a phase that runs only if, and `price-above:<usd>` / `spent-above:<usd>` follow the skill's version 21 conditions; node positions stay in local storage, never in the file

- `pending` · `contract` · Jev moves to the external `alethe.jev` plugin; the plugin API goes to version 2 (accepts manifests 1..=2) and gains overlays, settings sections, workspace control, terminal input, toasts and events
  - Files: `src/lib/plugins/workspace.ts`, `src/lib/plugins/legacyMigration.ts`, `src/components/ContributedOverlays/index.tsx`, `docs/PLUGINS.md`
  - Contract: `Preferences` drops `voiceCommandApiKey`, `voiceKeepListening` and every `dictation*` key; on load they are handed once to `plugin-data/alethe.jev.json` as `legacyPreferences` (only when that record has neither `settings` nor `legacyPreferences`), then removed from `projects.json`; `dictationEnabled` leaves the synced `settings` keys; new plugin capabilities `ui.overlay`, `ui.settings`, `workspace.read`, `workspace.control`, `terminal.write` and `listen:<event>`. The Mac app has no plugin host, so it drops its built-in voice bar or keeps it outside sync
- `pending` · `contract` · fix(backup): export the whole profile and skip files in use
  - Files: `src-tauri/src/backup.rs`, `src/lib/backup.ts`, `src/lib/storageNamespace.ts`
  - Contract: archives gain `alethe-backup.json` at the root (`format: 1`, `appVersion`, `createdAtMs`, `profileName`, `localStorage` keyed without the `alethe:<profile>:` prefix, `skipped`), never extracted on import; archives leave out `browser-session/`, `mcp/backups/`, `speech-models/`, `tools/`, `cloud_sync.json` and `sync-state.json`; the archived `projects.json` embeds `iconUrl` and `profileImageUrl` links as `data:` URLs of up to 4 MB each; import renames the profile to `profileName` unless another profile already uses it
- `pending` · `ui` · feat(about): creator, contribution links, and installing an older release
  - Files: `src/components/modals/preferences/AboutPage.tsx`, `src/lib/releases.ts`, `src-tauri/src/release_install.rs`
- `pending` · `ui` · feat(memory): list leftover processes and end orphaned terminal children
  - Files: `src/components/modals/MemoryAnalyticsModal.tsx`, `src-tauri/src/leftover_processes.rs`
- `skip (Windows Job Objects; macOS terminals already end their process group)` · `platform` · Terminals run in a per-PTY Job Object so killing one ends orphaned descendants
  - Files: `src-tauri/src/process_tree.rs`
- `pending` · `contract` · Alethe Cloud sync v3: scoped documents, three-way merge, devices, Supporter plan
  - Files: `src/lib/sync/`, `src-tauri/src/cloud_sync.rs`, `src/hooks/useCloudSync.ts`
  - Contract: [`SYNC_PROTOCOL.md`](SYNC_PROTOCOL.md) — `/v1` API with device registration and `If-Match`, payload format 3 (`settings`, `projects`, `tooling`), `sync-state.json` per profile, session token in the keyring as `profile:<id>:cloud-sync-token` (plaintext `cloud_sync.json` tokens migrate on load)
- `pending` · `contract` · MCP servers and skills saved per account and per project, carried by sync
  - Files: `src/lib/toolingManifest.ts`, `src/lib/toolingNotice.ts`, `src/components/ToolingManifestPanel/`
  - Contract: `tooling` scope keyed by `<agent>::<name>`; secret env and header values are never stored
- `pending` · `contract` · Cloud sync carries project settings, matched by id, Git remote or folder
  - Files: `src/lib/projectSync.ts`, `src/lib/sync/scopes/projects.ts`, `src-tauri/src/git_control.rs`
  - Contract: `projects` scope; remote ids linked to local ones through aliases in the sync state
- `pending` · `contract` · Projects by computer: per-machine folders, opt-in add, per-computer settings
  - Files: `src/lib/projectSync.ts`, `src/lib/sync/machines.ts`, `src/components/modals/sync/MachinesSection.tsx`, `src/components/modals/LocalOverrideToggle.tsx`, `src-tauri/src/cloud_sync.rs`
  - Contract: each synced project carries `machines: { <machineId>: { name, path, custom? } }` instead of `pathHint`; the machine id is a random id in the app-data root `machine-id` file, suffixed `:<profileId>` for non-default profiles; projects from other machines are never created automatically; a project leaves the account when its last machine drops it; `Project.localOverrides` (`agents`, `tooling`) keeps those settings off sync; `sync-state.json` gains `forgetMachines`
- `pending` · `contract` · Settings file export and import (`.alethe`)
  - Files: `src/lib/sync/bundle.ts`, `src/components/modals/sync/FileCard.tsx`
  - Contract: `{ kind: "alethe-bundle", format: 3, scopes }`, merged with no base on import
- `pending` · `contract` · Backups skip device-bound data and reset the sync state on import
  - Files: `src-tauri/src/backup.rs`
  - Contract: archives leave out `browser-session/`, `mcp/backups/`, `speech-models/`, `tools/`, `cloud_sync.json` and `sync-state.json`
- `pending` · `contract` · Orchestration preferences merge into the skill policy instead of rewriting it
  - Files: `src-tauri/src/orchestrator.rs`
  - Contract: `alethe-orchestrate.json` keeps every key the app does not set (`budget`, `modelTiers`, `maxWorkers`, `onboarded`); the app sets `backend`, `defaultStrategy`, `providerSwitch`, `conserveProviders` and `maxConcurrent`, and moves the preferred provider to the front of the saved `providerOrder`
- `pending` · `ui` · Sync window: Sync now, Supporter checkout, devices, history, account export and deletion; Gist sync download-only
  - Files: `src/components/modals/sync/CloudCard.tsx`, `src/components/modals/sync/LegacyGistCard.tsx`, `src/components/modals/SyncModal.tsx`
- `pending` · `ui` · Preferences shows a diagram of the default orchestration strategy with official provider marks
  - Files: `src/components/modals/preferences/StrategyArchitecture.tsx`, `src/components/modals/preferences/OrchestrationPage.tsx`
- `pending` · `backend` · alethe-orchestrate skill v12, vendored from `Kc1t/alethe-orchestrate`: setup onboarding that builds base, savings and aggressive profiles, `report`, `budget`, `mark`, `status`, `dry-run --write` with warnings, an SVG architecture preview, strategy playbooks with conditions and spare-quota rules, `references/briefs.md`
  - Files: `src-tauri/assets/skills/alethe-orchestrate/`, `src-tauri/assets/skills/sources.json`, `scripts/sync-skill.mjs`, `src-tauri/src/skills.rs`
  - Contract: the skill folder is platform-neutral; the Mac app ships the commit recorded in `sources.json` at version 12, the `metadata.version` in `SKILL.md`, and the user copy lives next to the policy as `alethe-playbooks.yaml` with `providers`, `adapters`, `routes`, `profiles` and `profile`. An orchestration folder may hold a `budget.json` (`version` 1, `limits` with `maxCalls`, `maxReportedCostUsd`, `maxReportedTokens`) and each worker folder a `mark.json` (`mark` of `used`, `partial` or `discarded`); the Windows-only `.cmd` shim handling has no Mac counterpart

## Since 1.7.0

### Contract (cross-platform data, port first)

- `pending` · `contract` · `bdd037c` fix(security): store GitHub sync token in keyring
  - Files: `src-tauri/src/github_sync.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/profiles.rs` +1
- `pending` · `contract` · `7d2dbd8` fix(security): store Spotify credentials in keyring
  - Files: `src-tauri/src/backup.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/profiles.rs` +7
- `pending` · `contract` · `d1b591d` feat(terminal): let the user choose the shell plain tabs spawn
  - Files: `src-tauri/src/cli_resolver.rs`, `src/components/ProjectSidebar/sidebarMenus.tsx`, `src/components/TerminalInspector/index.tsx` +6
- `pending` · `contract` · `2d90096` feat(orchestrator): shells on the board, worker rule sets and a detail panel
  - Files: `src-tauri/src/cli_resolver.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/orchestrator.rs` +45
- `pending` · `contract` · `c84e157` feat(agents): custom agent persistence with migration
  - Files: `src/stores/projectsStore.migrations.ts`, `src/stores/projectsStore.slices.ts`, `src/stores/projectsStore.ts`
- `pending` · `contract` · `52564e9` feat(i18n): add zh-CN locale and Chinese README
  - Files: `src-tauri/remote/locales.js`, `src-tauri/src/remote/appearance.rs`, `src/App.tsx` +7
- `pending` · `contract` · `b3f0228` feat(orchestration): named worker roles and limits in Preferences
  - Files: `src-tauri/src/lib.rs`, `src-tauri/src/orchestrator.rs`, `src-tauri/src/orchestrator_core.rs` +14
- `pending` · `contract` · `366ae1f` feat(privacy): make provider usage reading opt-in per provider
  - Files: `src/components/AgentCanvasPOC/hooks/useUsagePolling.ts`, `src/components/HomeView/HomeView.module.css`, `src/components/HomeView/UsageStrip.tsx` +21
- `pending` · `contract` · `bcef2f6` feat(handoff): let the user choose what the other agent receives
  - Files: `src-tauri/src/handoff.rs`, `src/components/modals/HandoffModal.module.css`, `src/components/modals/HandoffModal.tsx` +6
- `pending` · `contract` · `1e8a33c` fix(security): add a permission mode for experimental agent workers
  - Files: `src/components/AgentCanvasPOC/AgentCanvasPOC.module.css`, `src/components/AgentCanvasPOC/CanvasTopBar.tsx`, `src/components/AgentCanvasPOC/CodexWorkerCard.tsx` +15
- `pending` · `contract` · `bd8ec3b` feat(usage): show Kimi Code quotas in AI usage and the topbar
  - Files: `src-tauri/Cargo.toml`, `src-tauri/src/kimi_usage.rs`, `src-tauri/src/lib.rs` +13
- `pending` · `contract` · `ad8a63c` feat(voice): compact voice pill, OpenRouter transcriber and hands-free sending
  - Files: `src-tauri/src/jev.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/speech.rs` +17

### Backend

- `pending` · `backend` · `3819c9a` fix(security): contain agent handoff context
  - Files: `src-tauri/src/handoff.rs`
- `pending` · `backend` · `b1a2470` fix(privacy): minimize local telemetry logs
  - Files: `src-tauri/src/telemetry.rs`
- `pending` · `backend` · `441149e` refactor: translate the error strings this PR touches to English
  - Files: `src-tauri/src/claude_sessions.rs`, `src-tauri/src/codex_sessions.rs`, `src-tauri/src/opencode_sessions.rs`
- `pending` · `backend` · `4dc45aa` feat(orchestrator): brief planners and keep deliveries until acknowledged
  - Files: `src-tauri/src/orchestrator_core.rs`, `src-tauri/tests/orchestrator.rs`
- `pending` · `backend` · `e186ff3` fix(cli): log the second-instance handoff on the receiving process
  - Files: `src-tauri/src/cli_launch.rs`
- `pending` · `backend` · `4e7e843` feat(tauri): custom agent icon commands
  - Files: `src-tauri/src/custom_agent_icons.rs`, `src-tauri/src/lib.rs`
- `pending` · `backend` · `09e442a` fix(codex): pass -UseBasicParsing in the generated MCP bridge
  - Files: `src-tauri/src/agent_events.rs`
- `pending` · `backend` · `739eac8` fix(codex): report MCP bridge request failures on stderr
  - Files: `src-tauri/src/agent_events.rs`
- `pending` · `backend` · `8e7d065` fix(graphify): start the MCP server with graphify-mcp and the graph file
  - Files: `src-tauri/src/cli_launch.rs`, `src-tauri/src/graphify.rs`
- `pending` · `backend` · `aa5d6bd` fix(codex): read reset credit details from their own endpoint over HTTP
  - Files: `src-tauri/src/codex_usage.rs`
- `pending` · `backend` · `f4cb986` fix(graphify): build a missing graph with `graphify update`
  - Files: `src-tauri/src/graphify.rs`
- `pending` · `backend` · `6b59188` fix(build): stage the remote page's xterm assets in build.rs
  - Files: `src-tauri/build.rs`, `src-tauri/src/remote/http.rs`
- `pending` · `backend` · `c822ca1` feat(ai-memory): pick the release asset for this platform
  - Files: `src-tauri/src/ai_memory.rs`
- `pending` · `backend` · `e988862` fix(pty): signal the process group through kill(2) on Unix
  - Files: `src-tauri/Cargo.lock`, `src-tauri/Cargo.toml`, `src-tauri/src/pty.rs`
- `pending` · `backend` · `d280ac0` feat(ai-memory): resolve the managed copy by path, so agents can run it
  - Files: `src-tauri/src/ai_memory.rs`
- `pending` · `backend` · `9f81501` fix(ai-memory): add extraction bounds and parameterize plugin limits
  - Files: `src-tauri/src/ai_memory.rs`, `src-tauri/src/plugin_package.rs`
- `pending` · `backend` · `96d52ae` feat(ai-memory): install a verified copy, and run it
  - Files: `src-tauri/src/ai_memory.rs`, `src-tauri/src/lib.rs`
- `pending` · `backend` · `d4414a4` fix(ai-memory): stop the managed server on app exit, clean up failed installs
  - Files: `src-tauri/src/ai_memory.rs`, `src-tauri/src/lib.rs`
- `pending` · `backend` · `b60045b` fix(ai-memory): invalidate the cached hooks when the binary changes
  - Files: `src-tauri/src/ai_memory.rs`
- `pending` · `backend` · `ad5aaa8` fix(orchestration): refuse a readOnly that is not a boolean
  - Files: `src-tauri/src/orchestrator_core.rs`, `src-tauri/tests/orchestrator.rs`
- `pending` · `backend` · `ca155e2` fix(orchestration): pass a delegated effort to Claude workers
  - Files: `src-tauri/src/orchestrator_core.rs`, `src-tauri/tests/orchestrator.rs`
- `pending` · `backend` · `97f51aa` fix(orchestration): trim a worker's live reply at a character boundary
  - Files: `src-tauri/src/orchestrator_core.rs`
- `pending` · `backend` · `4354913` fix(orchestration): make alethe_status small enough for a planner to read
  - Files: `src-tauri/src/orchestrator_core.rs`, `src-tauri/tests/orchestrator.rs`
- `pending` · `backend` · `89fd9b0` fix(app): hide the window before waiting on the terminal teardown
  - Files: `src-tauri/src/lib.rs`, `src-tauri/src/pty.rs`
- `pending` · `backend` · `e62cfb6` fix(orchestration): fail a worker whose Codex thread does not start
  - Files: `src-tauri/src/orchestrator_core.rs`, `src-tauri/tests/orchestrator.rs`
- `pending` · `backend` · `eb83752` fix(orchestration): restart a worker on its model, effort, read-only or role
  - Files: `src-tauri/src/orchestrator_core.rs`
- `pending` · `backend` · `fb2334e` perf(orchestration): reuse Codex's model list instead of starting Codex each time
  - Files: `src-tauri/src/orchestrator_core.rs`, `src-tauri/tests/orchestrator.rs`
- `pending` · `backend` · `994f017` fix(single-instance): write the handoff report in English
  - Files: `src-tauri/src/lib.rs`
- `pending` · `backend` · `e2b18f3` refactor(telemetry): use is_none_or for the size cap check
  - Files: `src-tauri/src/telemetry.rs`
- `pending` · `backend` · `8aad8dd` fix(security): keep the Claude hook settings out of the shared temp folder
  - Files: `src-tauri/src/agent_events.rs`

### UI

- `pending` · `ui` · `db00513` fix: use accent-on token in HomeView project badges
  - Files: `src/components/HomeView/HomeView.module.css`
- `pending` · `ui` · `4d7229e` fix(deps): update vulnerable frontend packages
  - Files: `package-lock.json`, `package.json`
- `pending` · `ui` · `71d650c` fix(security): guard MCP registry activation
  - Files: `src-tauri/src/mcp_catalog.rs`, `src/components/modals/mcp/AddServerFlow.module.css`, `src/components/modals/mcp/AddServerFlow.tsx` +3
- `pending` · `ui` · `f8db579` fix(workspace): sync topbar tab label when renaming a terminal, project, or group
  - Files: `src/stores/projectsStore.projectSlices.ts`, `src/stores/projectsStore.slices.ts`, `src/stores/projectsStore.terminalSlices.ts`
- `pending` · `ui` · `42e192c` fix(sidebar): let an explicit terminal rename win over the live auto-title
  - Files: `src/components/ProjectSidebar/NormalTerminalNode.tsx`, `src/components/ProjectSidebar/TerminalNode.tsx`, `src/lib/terminalFactory.ts` +2
- `pending` · `ui` · `32366f2` feat(terminal): make the terminal font configurable
  - Files: `src/components/XTermView/index.tsx`, `src/components/modals/PreferencesModal.module.css`, `src/components/modals/preferences/TerminalPage.tsx` +2
- `pending` · `ui` · `d31164a` feat(preferences): fold settings sections
  - Files: `src/components/modals/PreferencesModal.module.css`, `src/components/modals/PreferencesModal.tsx`, `src/components/modals/preferences/MultiagentPage.tsx` +2
- `pending` · `ui` · `a2c06d2` feat(plugins): let a plugin open its own view and modal
  - Files: `src/lib/plugins/host.ts`, `src/lib/plugins/navigation.ts`, `src/lib/plugins/placement.ts` +3
- `pending` · `ui` · `c1df00e` feat(agents): custom agent types and provider registration
  - Files: `src/lib/agentProviders.ts`, `src/lib/types.ts`
- `pending` · `ui` · `0d5270d` feat(agents): validation, safe command splitting and normalization
  - Files: `src/lib/customAgents.ts`
- `pending` · `ui` · `9fc5e0b` feat(agents): custom icon loading and rendering
  - Files: `src/components/icons/customAgentIcons.tsx`, `src/lib/customAgentIconAssets.ts`
- `pending` · `ui` · `ca5fbd9` feat(prefs): custom agents section with live preview
  - Files: `src/components/modals/preferences/CustomAgentsSection.module.css`, `src/components/modals/preferences/CustomAgentsSection.tsx`
- `pending` · `ui` · `6e07ac1` feat(i18n): custom agent section strings
  - Files: `src/lib/i18n/messages/en.ts`, `src/lib/i18n/messages/pt-BR.ts`
- `pending` · `ui` · `78253e9` feat(agents): customs in pickers and PTY spawn
  - Files: `src/components/XTermView/useXtermSession.ts`, `src/components/modals/preferences/TerminalPage.tsx`
- `pending` · `ui` · `e8e5b52` refactor(agents): use record lookup for preset icons
  - Files: `src/components/icons/customAgentIcons.tsx`
- `pending` · `ui` · `63a5223` fix(codex): read usage over HTTP instead of spawning codex.exe per poll
  - Files: `src-tauri/src/codex_usage.rs`, `src/hooks/useOrchestratorQuotaWarnings.ts`
- `pending` · `ui` · `f70abc1` fix(codex): show a weekly-only quota as weekly, not as the 5h window
  - Files: `src-tauri/src/codex_usage.rs`, `src/components/AgentCanvasPOC/CanvasTopBar.tsx`, `src/components/AgentCanvasPOC/UsageDropdown.tsx` +5
- `pending` · `ui` · `70b600f` feat(usage): show per-model weekly limits on the Claude usage card
  - Files: `src-tauri/src/claude_usage.rs`, `src/components/AgentCanvasPOC/UsageDropdown.tsx`, `src/components/HomeView/UsageStrip.tsx` +4
- `pending` · `ui` · `4b7f2cd` fix(usage): count model-scoped Claude limits in orchestrator fitness
  - Files: `src/lib/agentFitness.ts`
- `pending` · `ui` · `9920a49` fix(whats-new): list 1.6.0 and 1.7.0 in the in-app panel
  - Files: `src/lib/changelogData.ts`, `src/lib/i18n/messages/en.ts`, `src/lib/i18n/messages/pt-BR.ts`
- `pending` · `ui` · `b15fc97` fix(lint): clear the ESLint errors that keep CI red
  - Files: `eslint.config.js`, `src/components/GhosttySurface/index.tsx`, `src/components/TerminalPane/index.tsx` +3
- `pending` · `ui` · `fcee01d` fix(ui): align startup loading screen with the design system
  - Files: `src/App.module.css`, `src/App.tsx`, `src/bootstrap.ts` +1
- `pending` · `ui` · `2060fdf` fix(whats-new): show release dates in UTC
  - Files: `src/components/modals/WhatsNewModal.tsx`, `src/lib/changelogData.ts`
- `pending` · `ui` · `5957682` feat: voice command routing, Kimi Code agent and plugin catalogue
  - Files: `src-tauri/Cargo.lock`, `src-tauri/src/agent_events.rs`, `src-tauri/src/github_pr.rs` +68
- `pending` · `ui` · `86033a6` feat: add Grok Build and Codewhale as native agent providers
  - Files: `src-tauri/src/cli_resolver.rs`, `src/components/HomeView/HomeView.module.css`, `src/components/HomeView/index.tsx` +13
- `pending` · `ui` · `5e6aaad` fix(i18n): show locale short code on onboarding language chips
  - Files: `src/components/modals/OnboardingModal.tsx`
- `pending` · `ui` · `c19d859` fix: get the branch green again after merging main
  - Files: `src-tauri/src/mcp_health.rs`, `src-tauri/src/speech.rs`, `src/components/ProjectSidebar/NormalProjectSidebar.tsx` +7
- `pending` · `ui` · `df86dbf` fix(i18n): add zh-CN keys for grok/codewhale agent desc
  - Files: `src/lib/i18n/messages/zh-CN.ts`
- `pending` · `ui` · `3f60b78` fix(install): let installer dialogs be cancelled and run unattended
  - Files: `src/components/AgentInstall/AgentInstallModal.tsx`, `src/components/AgentInstall/AgentUninstallButton.tsx`, `src/components/Router9/Router9InstallModal.tsx` +3
- `pending` · `ui` · `6e6a1f6` fix(terminal): open links to paths under the home folder
  - Files: `src-tauri/src/filesystem.rs`, `src-tauri/src/lib.rs`, `src/components/XTermView/index.tsx` +2
- `pending` · `ui` · `7a167f8` fix(orchestration): end background shells when Claude reports them done
  - Files: `src/stores/agentCanvasStore.ts`
- `pending` · `ui` · `b4d428c` fix(orchestration): end board workers that finish without an end event
  - Files: `src-tauri/src/agent_events.rs`, `src/stores/agentCanvasStore.ts`
- `pending` · `ui` · `90edce9` fix(workspace): close panes that are shown through a pane group
  - Files: `src/stores/projectsStore.terminalSlices.ts`
- `pending` · `ui` · `c1016e9` feat(orchestration): right-click a worker to open, stop or restart it
  - Files: `src-tauri/src/lib.rs`, `src-tauri/src/orchestrator.rs`, `src-tauri/src/orchestrator_core.rs` +5
- `pending` · `ui` · `8438c1e` fix(usage): stop calling a rate-limited Claude usage read a missing token
  - Files: `src/components/HomeView/UsageStrip.tsx`, `src/components/TerminalPane/index.tsx`, `src/components/TitleBar/TitleBar.module.css` +7
- `pending` · `ui` · `b32fdba` feat(orchestration): open the orchestration board in its own window
  - Files: `src-tauri/capabilities/orchestration-window.json`, `src-tauri/src/agent_events.rs`, `src-tauri/src/lib.rs` +15
- `pending` · `ui` · `ada10c0` feat(orchestration): start orchestration on an open Claude terminal
  - Files: `src/components/OrchestratorPane/index.tsx`, `src/components/ProjectSidebar/sidebarMenus.tsx`, `src/components/TerminalInspector/index.tsx` +12
- `pending` · `ui` · `b5c77f3` feat(plugins): a marketplace built to hold a lot of plugins
  - Files: `src-tauri/src/plugin_catalog.rs`, `src/App.tsx`, `src/components/modals/PluginMarketplaceModal.module.css` +8
- `pending` · `ui` · `c6c6ae8` feat(ai-memory): the decisions the panel needs
  - Files: `src/lib/aiMemory.ts`, `src/lib/tauri/aiMemory.ts`
- `pending` · `ui` · `e7a7951` feat(ai-memory): capture hooks in Alethe's own per-terminal settings
  - Files: `src-tauri/src/agent_events.rs`, `src-tauri/src/ai_memory.rs`, `src-tauri/src/ai_memory_hooks.rs` +5
- `pending` · `ui` · `3a40cc1` fix(ai-memory): make the capture default un-forgettable, and bound the hooks lookup
  - Files: `src-tauri/src/ai_memory.rs`, `src/components/AgentCanvasPOC/index.tsx`, `src/components/TerminalPane/index.tsx` +3
- `pending` · `ui` · `514cbaa` feat(ai-memory): guide the install from under its own switch
  - Files: `src/components/modals/preferences/AiMemoryPanel.module.css`, `src/components/modals/preferences/AiMemoryPanel.tsx`, `src/components/modals/preferences/FeaturesPage.tsx` +2
- `pending` · `ui` · `7fa429c` fix(ai-memory): move server ownership into the tracked child, add a checking state
  - Files: `src-tauri/src/ai_memory.rs`, `src/components/modals/preferences/AiMemoryPanel.tsx`, `src/lib/aiMemory.ts` +3
- `pending` · `ui` · `0325cc1` feat(orchestration): let delegated workers choose model, effort and read-only
  - Files: `src-tauri/src/orchestrator_core.rs`, `src-tauri/tests/orchestrator.rs`, `src/components/OrchestratorPane/index.tsx` +4
- `pending` · `ui` · `44d42ac` fix(ai-memory): register the MCP server as its real HTTP endpoint
  - Files: `src-tauri/src/ai_memory.rs`, `src/lib/tauri/aiMemory.ts`
- `pending` · `ui` · `2ead337` feat(ai-memory): start the server automatically when the feature is on
  - Files: `src/App.tsx`, `src/hooks/useAiMemoryAutoStart.ts`
- `pending` · `ui` · `99d4027` fix(ai-memory): busy feedback on Start/Stop, and real error sentences
  - Files: `src/components/modals/preferences/AiMemoryPanel.tsx`, `src/lib/aiMemory.ts`, `src/lib/i18n/messages/en.ts` +1
- `pending` · `ui` · `0b6a8fb` fix(orchestration): let a Claude role set its effort
  - Files: `src-tauri/tests/orchestrator.rs`, `src/components/modals/preferences/OrchestrationPage.tsx`, `src/lib/orchestrationSettings.ts`
- `pending` · `ui` · `d44f553` fix(orchestration): hide a worker once the same task has been sent again
  - Files: `src-tauri/src/orchestrator_core.rs`, `src-tauri/tests/orchestrator.rs`, `src/components/OrchestratorPane/index.tsx` +2
- `pending` · `ui` · `c462902` feat(orchestration): warn a worker before its budget ends and keep its work
  - Files: `src-tauri/src/orchestrator_core.rs`, `src-tauri/tests/orchestrator.rs`, `src/lib/tauri/orchestrator.ts`
- `pending` · `ui` · `3da1b8e` fix(orchestration): name a new terminal's planner after the terminal
  - Files: `src/components/XTermView/useXtermSession.ts`
- `pending` · `ui` · `22f3d1c` fix(orchestration): state a worker's budget up front instead of warning mid-turn
  - Files: `src-tauri/src/orchestrator_core.rs`, `src-tauri/tests/orchestrator.rs`, `src/lib/tauri/orchestrator.ts`
- `pending` · `ui` · `c9b1095` fix(orchestration): list the Codex models, and offer efforts when Codex cannot
  - Files: `src-tauri/src/orchestrator_core.rs`, `src-tauri/tests/orchestrator.rs`, `src/components/modals/preferences/OrchestrationPage.tsx` +1
- `pending` · `ui` · `dcd9fa5` feat(orchestration): let Codex workers start without chosen plugins
  - Files: `src-tauri/src/orchestrator_core.rs`, `src/components/modals/preferences/OrchestrationPage.module.css`, `src/components/modals/preferences/OrchestrationPage.tsx` +4
- `pending` · `ui` · `ad3e7a7` feat(orchestration): let a role fall back to another when its provider runs out
  - Files: `src-tauri/src/orchestrator_core.rs`, `src-tauri/tests/orchestrator.rs`, `src/components/OrchestratorPane/index.tsx` +8
- `pending` · `ui` · `c8754a2` fix(terminal): find relative link paths in the project's other worktrees
  - Files: `src-tauri/src/filesystem.rs`, `src-tauri/src/lib.rs`, `src/components/XTermView/index.tsx` +2
- `pending` · `ui` · `14d4fbb` fix(orchestration): show finished workers in the finished colour
  - Files: `src/components/OrchestratorPane/OrchestratorPane.module.css`
- `pending` · `ui` · `98c7620` fix(orchestration): measure a worker's context share on the last turn
  - Files: `src/components/OrchestratorPane/contextShare.ts`, `src/components/OrchestratorPane/index.tsx`
- `pending` · `ui` · `5fb5b02` feat(orchestration): let a role row apply to one orchestrator
  - Files: `src-tauri/src/orchestrator_core.rs`, `src-tauri/tests/orchestrator.rs`, `src/components/modals/preferences/OrchestrationPage.module.css` +5
- `pending` · `ui` · `6551c1c` fix(prs): fall back to the account-wide list when the project is not a git checkout
  - Files: `src/components/PullRequestsSidebar/index.tsx`, `src/lib/tauri/githubPr.ts`
- `pending` · `ui` · `5fdb100` fix(orchestration): preselect the terminal a board was started on
  - Files: `src/lib/orchestrationOnTerminal.ts`, `src/lib/orchestratorRuns.ts`, `src/lib/types.ts` +2
- `pending` · `ui` · `f06ed64` fix(orchestration): say that starting orchestration turns it on, and skip read-only panes
  - Files: `src/components/TerminalPane/index.tsx`, `src/lib/i18n/messages/en.ts`, `src/lib/i18n/messages/pt-BR.ts`
- `pending` · `ui` · `00a93ee` refactor(notifications): give the toast stack its own CSS module
  - Files: `src/App.module.css`, `src/components/InAppNotifications.module.css`, `src/components/InAppNotifications.tsx`
- `pending` · `ui` · `1a6cf35` fix(orchestration): keep a detached board's canvas live after the main window reloads
  - Files: `src/App.tsx`, `src/lib/agentCanvasMirror.ts`
- `pending` · `ui` · `4815241` perf(orchestration): reload a detached board once per burst of saves
  - Files: `src/OrchestrationWindow.tsx`
- `pending` · `ui` · `2aa4d5e` fix(orchestration): say what happens to a role name that cannot be saved
  - Files: `src/lib/types.ts`, `src/lib/i18n/messages/en.ts`, `src/lib/i18n/messages/pt-BR.ts`
- `pending` · `ui` · `b4094c4` fix(orchestration): scroll the roles table in a narrow Preferences window
  - Files: `src/components/modals/preferences/OrchestrationPage.module.css`
- `pending` · `ui` · `87e4316` fix(i18n): translate the strings added since zh-CN was written
  - Files: `src/lib/i18n/messages/zh-CN.ts`
- `pending` · `ui` · `e7c6ec8` fix(grids): reserve the default grid's name in every language
  - Files: `src/stores/projectsStore.workspaceSlices.ts`
- `pending` · `ui` · `6856baf` fix(mcp): open a registry server's repository only as an http(s) address
  - Files: `src/components/modals/mcp/AddServerFlow.module.css`, `src/components/modals/mcp/AddServerFlow.tsx`, `src/components/modals/mcp/registryReview.ts`
- `pending` · `ui` · `da45448` fix(i18n): add the zh-CN registry review strings
  - Files: `src/lib/i18n/messages/zh-CN.ts`
- `pending` · `ui` · `240f287` fix(security): fail closed remote control
  - Files: `src-tauri/src/remote/commands.rs`, `src-tauri/src/remote/http.rs`, `src-tauri/src/remote/mod.rs` +10
- `pending` · `ui` · `7157003` fix(orchestrator): forget an agent's quota once its usage is no longer read
  - Files: `src-tauri/src/orchestrator_core.rs`, `src-tauri/tests/orchestrator.rs`, `src/hooks/useOrchestratorQuotaWarnings.ts` +1
- `pending` · `ui` · `3af03cb` fix(onboarding): stop opening the MCP introduction after the first-run setup
  - Files: `src/App.tsx`, `src/hooks/useMcpIntroPrompt.ts`
- `pending` · `ui` · `f58de23` fix: lint and formatting after merging upstream/main
  - Files: `plugins.json`, `src/App.tsx`, `src/components/OrchestratorPane/OrchestratorInspector.module.css` +12
- `pending` · `ui` · `13f8e8c` feat(orchestration): add configurable worker routing
  - Files: `src-tauri/src/orchestrator_core.rs`, `src/components/modals/controls.module.css`, `src/components/modals/preferences/OrchestrationPage.tsx` +9
- `pending` · `ui` · `2b9593b` fix(release): refuse to stamp a version that has no release notes
  - Files: `scripts/release.mjs`, `src/lib/changelogData.ts`
- `pending` · `ui` · `e100873` fix(sidebar): keep explorer rows sharp and its context menu in view
  - Files: `src/App.module.css`, `src/components/ProjectSidebar/FileExplorer.module.css`, `src/components/ProjectSidebar/FileExplorer.tsx` +2
- `pending` · `ui` · `ef74955` fix(usage): fit any number of providers in the AI usage modal
  - Files: `src/components/HomeView/HomeView.module.css`, `src/components/modals/AiUsageModal.tsx`, `src/components/modals/Modal.module.css`
- `pending` · `ui` · `359e75d` feat(ui): use one themed dropdown for every selector
  - Files: `src/components/VoiceCommand/VoiceCommand.module.css`, `src/components/VoiceCommand/index.tsx`, `src/components/modals/PreferencesModal.module.css` +6
- `pending` · `ui` · `f516f16` feat(sidebar): add an agents panel to the right sidebar
  - Files: `src/App.tsx`, `src/components/RightSidebar/AgentsPanel.module.css`, `src/components/RightSidebar/AgentsPanel.tsx` +10
- `pending` · `ui` · `57cc7ee` feat(preferences): find the routing settings from the preferences search
  - Files: `src/components/modals/PreferencesModal.tsx`, `src/lib/i18n/messages/en.ts`, `src/lib/i18n/messages/pt-BR.ts` +1
- `pending` · `ui` · `f955427` feat(skills): ship the alethe-orchestrate skill with the app
  - Files: `src-tauri/assets/skills/alethe-orchestrate/schemas/plan.schema.json`, `src-tauri/assets/skills/alethe-orchestrate/scripts/orchestrate.py`, `src-tauri/src/lib.rs` +14
- `pending` · `ui` · `0fc8148` fix(sessions): keep Claude and Codex panes on their current conversation
  - Files: `src-tauri/src/agent_events.rs`, `src-tauri/src/claude_sessions.rs`, `src-tauri/src/codex_sessions.rs` +15
- `pending` · `ui` · `6789b9e` fix(terminal): keep agent output aligned and intact across hide, resize and paste
  - Files: `src-tauri/src/lib.rs`, `src-tauri/src/pty.rs`, `src-tauri/src/resources.rs` +7
- `pending` · `ui` · `987d424` fix(updater): save the workspace before installing an update
  - Files: `src/lib/updater.ts`
- `pending` · `ui` · `5424dbc` feat(plugins): open Plugin Market profiles in a modal with shared filters
  - Files: `src/components/PluginDetailPane/PluginDetailPane.module.css`, `src/components/PluginDetailPane/index.tsx`, `src/components/PluginsSidebar/PluginDetailsModal.module.css` +9
- `pending` · `ui` · `1483488` feat(sidebar): compact the Markdown viewer tab strip
  - Files: `src/components/RightSidebar/RightSidebar.module.css`, `src/components/RightSidebar/index.tsx`

### Platform-specific

- `skip` · `platform` · `eab3d92` fix(clipboard): add Klipper D-Bus fallback and clearer errors on Linux (Windows/Linux only)
  - Files: `src-tauri/src/diagnostics.rs`
- `skip` · `platform` · `1e5cc27` feat(wsl): run shells and agent CLIs inside a WSL distro (Windows/Linux only)
  - Files: `src-tauri/src/filesystem.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/pty.rs` +1
- `skip` · `platform` · `9157e2c` feat(wsl): read agent sessions from inside the distro (Windows/Linux only)
  - Files: `src-tauri/src/antigravity_sessions.rs`, `src-tauri/src/claude_sessions.rs`, `src-tauri/src/codex_sessions.rs` +3
- `skip` · `platform` · `05c1499` feat(wsl): git actions on repositories inside a distro (Windows/Linux only)
  - Files: `src-tauri/src/git_control.rs`, `src-tauri/src/projects.rs`, `src-tauri/src/worktrees.rs`
- `skip` · `platform` · `3d60b2d` feat(wsl): add a toggle for the WSL integration (Windows/Linux only)
  - Files: `src/App.tsx`, `src/components/modals/OnboardingModal.tsx`, `src/components/modals/preferences/FeaturesPage.tsx` +5
- `skip` · `platform` · `4ada995` feat(wsl): pick a distro folder and see which distro a pane runs in (Windows/Linux only)
  - Files: `src/components/TerminalPane/WslBadge.module.css`, `src/components/TerminalPane/WslBadge.tsx`, `src/components/TerminalPane/index.tsx` +7
- `skip` · `platform` · `7d584fc` feat(wsl): install a missing agent inside the distro (Windows/Linux only)
  - Files: `src/components/AgentInstall/AgentInstallButton.tsx`, `src/components/AgentInstall/AgentInstallModal.tsx`, `src/components/XTermView/index.tsx` +3
- `skip` · `platform` · `19808cd` fix(single-instance): report the D-Bus handoff instead of exiting silently (Windows/Linux only)
  - Files: `src-tauri/Cargo.lock`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs` +1
- `pending` · `platform` · `340a1de` feat(ai-memory): unpack the tar.gz releases Linux and macOS ship
  - Files: `src-tauri/Cargo.lock`, `src-tauri/Cargo.toml`, `src-tauri/src/ai_memory.rs`
- `skip` · `platform` · `7125958` fix(clipboard): keep Klipper as the last resort and the copied text off the disk (Windows/Linux only)
  - Files: `src-tauri/src/diagnostics.rs`
- `skip` · `platform` · `8ad4716` fix(single-instance): build the D-Bus probe on Linux only (Windows/Linux only)
  - Files: `src-tauri/src/lib.rs`
- `skip` · `platform` · `b8de17c` fix(cli-resolver): find agent CLIs installed under fnm or a custom Volta home on Linux (Windows/Linux only)
  - Files: `src-tauri/src/cli_resolver.rs`
- `skip` · `platform` · `f719a09` feat(terminal): start Windows shell tabs as administrator (Windows/Linux only)
  - Files: `src-tauri/src/cli_resolver.rs`, `src-tauri/src/pty.rs`, `src/components/ProjectSidebar/sidebarMenus.tsx` +11
