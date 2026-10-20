# Orchestration parity handoff

Baseline: `origin/main` web v1.7.0, read with `git show` on 2026-10-18. Scoped follow-up to
the local `audit.md` Codex report. “Done” below means implemented and statically
reviewed, pending the reviewer's build and visual/runtime validation outside the sandbox.

| Audit area | Implementation status | Web sources and native behavior |
| --- | --- | --- |
| Orchestration configuration page | Done for native MCP workers; skill transport is not portable as-is | `OrchestrationPage.tsx`, its module CSS, `orchestrationSettings.ts`: backend/strategy/provider preferences round-trip; limits, timeout, plugin exclusions and role overrides reach the native core. See transport limitation below. |
| Routing presets and advanced rules | Done | `RoutingSection.tsx`, its module CSS, `routingPresets.ts`: economy/balanced/performance presets, retained custom roles, ordered enabled rules, kind/effort selectors, provider/window gates, critical threshold, Opus switch and both-critical policy. Explicit role/model selections take precedence. |
| Worker rules and prompt shortcuts | Done | `MultiagentPage.tsx`, its module CSS, `workerRules.ts`, `orchestratorShortcuts.ts`, `src-tauri/assets/rules/*.md`: editable lists, protected General, accent/case-insensitive name checks, character counts, unique new names, restore/delete and explicit-empty semantics. Rules prefix worker instructions rather than their displayed task. Shortcuts insert a bracketed draft into the lead terminal without submitting. |
| Agents panel independent feature gate | Done | `RightSidebar/index.tsx`, `lib/features.ts`: `enabledFeatures.agentsPanel` defaults on independently of orchestrator; Queue retains its orchestrator gate. |
| Custom agent CRUD and icons | Done | `CustomAgentsSection.tsx`, its module CSS, `customAgents.ts`, `custom_agent_icons.rs`: web-compatible definitions, validated CLI tokenization, enable/edit/remove, presets, HTTPS PNG/JPEG URLs, 512 KiB ICO magic/square checks and atomic local asset writes. New-terminal selection, launch commands and agent logos use the custom registry in the web interface. |
| Project advanced agent configuration | Done | `EditProjectAgentSettings.tsx`, `EditProjectModal.module.css`: optional web-named fields persist/import, branch testing and merge validation consume commands/health settings, merge launches use provider/model, existing-agent migration explicitly confirms restart without session continuity, planning-file watcher preference persists. |
| Project/group images | Existing implementation retained and reviewed | `ImageInput.tsx`, `controls.module.css`, project/group modal fields and sidebar TSX/CSS: original image bytes in `iconUrl`, 2 MiB limit, preview, URL, file picker/drop/paste, removal, bounded cover rendering and fallback. Existing `ProjectImageTests` cover persistence, imports, formats and limits. No source image changes were necessary. |

## Transport and presentation limits

The web skill backend and its provider/strategy switching depend on the web/Tauri skill installation
and launch integration. Native delegation currently hosts its own MCP helper for Claude/Codex. The
skill preference keys are preserved for interoperability but do not install a skill backend, select
Agy/Kimi workers, or change native transport. This part of the web configuration is not portable
through the current native transport and remains an explicit runtime limitation, rather than a
claim that those selections change native launches.

Role model entry allows a CLI model name; the project conflict-model field also offers discovered
models. The web's model-specific effort dropdown restrictions are not replicated. SwiftUI supplies
text editing, menu, open-panel and confirmation presentation. Pixel identity, focus transfer,
animated/SVG cover decoding and live CLI version behavior require reviewer execution.

The existing group cover display is retained as requested by the owner; the current web
`NormalGroupNode.tsx` and `GroupNode.tsx` do not actually render `iconUrl`. No “Change image” context
item was added because the web `sidebarMenus.tsx` does not contain one. The web image input does
not resize or recompress uploads; native keeps the original bytes too.

The `.mac` forms and sidebar rendering branches remain. Added configuration fields are optional;
no document version or migration was changed. Task-specific button metrics live in `Components+Orchestration.swift`. Shared `Components.swift`, web changelog and native
migration plan are untouched. Pre-existing unstaged orchestration files were extended, not reverted.

## Validation and working memory

- Reviewer compile follow-up (2026-10-18): qualified `self.set` in
  `WorkerRuleCard.duplicate` so Swift does not parse the leading `set` as a setter declaration.
  Duplicate-name behavior is unchanged. Strings and whitespace checks passed after the fix;
  no build was attempted. Reviewer compilation outside the sandbox remains the next step.
- `python3 AletheNative/Scripts/check-strings.py`: passed, including en/pt-BR and orphan checks.
- `git diff --check`: passed.
- Added `OrchestrationPreferencesTests`, `CustomAgentTests`, and `OrchestrationSettingsTests`.
  Swift tests, build and UI harness were not run: the task explicitly forbids sandbox builds.
- Reviewer next steps: compile the app and AletheKit tests, run the UI harness, check zoom and both
  interface modes, and exercise custom CLI launch, ICO replacement, quota routing and migration in
  a disposable repository. No app/server was started, stopped or restarted.
- No ai-memory skill/server is available in this session. This handoff records the implementation
  decisions, current state, limitations and next steps; no external memory update is claimed.
- All changes remain unstaged; no commit or push was run. The external audit was used as a checklist
  and is unchanged; this scoped handoff provides the implementation status without modifying the
  protected migration plan.

## Worktree file inventory

This includes the pre-existing orchestration edits present when this task began.

- `AletheNative/Alethe/App/AppEnvironment.swift`
- `AletheNative/Alethe/Editors/NewTerminalSheet.swift`
- `AletheNative/Alethe/Editors/ProjectEditor.swift`
- `AletheNative/Alethe/Git/BranchTestingSheet.swift`
- `AletheNative/Alethe/Git/MergeCenterSheet.swift`
- `AletheNative/Alethe/Localizable.xcstrings`
- `AletheNative/Alethe/Orchestrator/BoardNodes.swift`
- `AletheNative/Alethe/Orchestrator/MultiagentController.swift`
- `AletheNative/Alethe/Orchestrator/OrchestratorService.swift`
- `AletheNative/Alethe/RightSidebar/RightSidebar.swift`
- `AletheNative/Alethe/Settings/FeatureSettings.swift`
- `AletheNative/Alethe/Settings/MultiagentSettings.swift`
- `AletheNative/Alethe/Settings/WebSettingsPages.swift`
- `AletheNative/Alethe/Settings/WebSettingsView.swift`
- `AletheNative/Alethe/Terminals/AgentLogo.swift`
- `AletheNative/CHANGELOG.md`
- `AletheNative/Packages/AletheKit/Package.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheAgents/AgentLauncher.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheAgents/AgentRegistry.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheModel/PreferencesDocument.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheModel/TauriImport.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheModel/WorkspaceDocument.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheOrchestrator/AgentFitness.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheOrchestrator/CodexWorkerProtocol.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheOrchestrator/Core/OrchestratorCore+Tools.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheOrchestrator/Core/OrchestratorCore.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheOrchestrator/Job.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheOrchestrator/Resources/orchestrator-tools.json`
- `AletheNative/Alethe/Editors/ProjectEditorAdvanced.swift`
- `AletheNative/Alethe/Settings/CustomAgents.swift`
- `AletheNative/Alethe/Settings/MultiagentWorkerSettings.swift`
- `AletheNative/Alethe/Settings/OrchestrationRoutingSettings.swift`
- `AletheNative/Alethe/Settings/OrchestrationSettings.swift`
- `AletheNative/Alethe/Settings/OrchestrationShortcuts.swift`
- `AletheNative/ORCHESTRATION_PARITY.md`
- `AletheNative/Packages/AletheKit/Sources/AletheDesign/Components+Orchestration.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheModel/CustomAgentDefinition.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheModel/OrchestrationPreferences.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheModel/OrchestrationPresets.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheModel/OrchestrationWorkerPreferences.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheOrchestrator/OrchestrationSettings.swift`
- `AletheNative/Packages/AletheKit/Tests/AletheModelTests/CustomAgentTests.swift`
- `AletheNative/Packages/AletheKit/Tests/AletheModelTests/OrchestrationPreferencesTests.swift`
- `AletheNative/Packages/AletheKit/Tests/AletheOrchestratorTests/OrchestrationSettingsTests.swift`

## Audit 2 — k3 handoff (2026-10-18)

Scope: backlog #16, #17, #20 and TerminalInspector from `audit2.md`. Image covers were already
implemented in this baseline; this follow-up uses the final k3 assignment.

| Surface | Web source read from `origin/main` | Native implementation |
| --- | --- | --- |
| Token HUD | `src/components/TokenHud/index.tsx`, `TokenHud.module.css`, `src/stores/agentCostStore.ts`, `src/lib/costFormat.ts` | `Editors/TokenHud.swift`, web-shell bottom-right overlay: 16-point inset, 280-point expanded panel, 260-point list limit, 4-second polling, expandable pill, per-agent session totals, four cost decimals below $1, two otherwise, thresholds at $1/$5. No mock data. |
| Detached board | `src/OrchestrationWindow.tsx`, `OrchestrationWindow.module.css`, `src/components/OrchestratorPane/index.tsx` and its CSS | `Orchestrator/DetachedOrchestrationWindow.swift`, second value-based WindowGroup, header action, restorable profile/pane identity, pane-gone message. Both scenes share one startup task. |
| Project configuration | `src/lib/types.ts`, `src/stores/projectsStore.projectSlices.ts`, `src/components/ProjectSidebar/sidebarMenus.tsx` | `WebProjectFile`, `ProjectVisibility`, `WebProjectTransfer`, sidebar/Organization settings. See the left-sidebar report for migration and interoperability notes. |
| Terminal inspector | `src/components/TerminalInspector/index.tsx`, `TerminalInspector.module.css` | `Sidebar/TerminalInspector.swift`: 10-point inset, 24-point icon, two-column 28-point actions with 5-point gap, 26-point tab rows and 52-point type column. Open inspector/Reveal in terminal menus; file rows offer Open inspector. |

### Decisions and implementation memory

- Only the web shell draws the HUD/inspector and offers detachment. Native project settings transfer
  and the existing `.mac` main-window layout remain in place. Shared optional model fields do not
  change the document version or invalidate older native workspaces.
- A native second scene shares the same observable workspace, orchestrator service and subagent
  tracker. It therefore observes edits immediately and uses the normal saved workspace after launch;
  it does not independently reload a stale disk copy or run a second document writer. This replaces
  the web's cross-webview mirror and throttled `projects://saved` reload transport.
- The inspector is hosted above the left-sidebar content, with a close affordance and a bounded
  scroll area so long tab lists cannot hide all navigation. History opens the existing Conversations
  sheet; the web-specific per-tab history modal is not duplicated here. File panes use the existing
  native renderer. Web-only plugin panes are retained for export but are not rendered as native panes.
- Legacy hide/archive entries remain as recovery data. Migration applies only when the corresponding
  optional model flag is absent. A restored explicit `false` is never overwritten on the next launch.
- Full-project import creates a new project in the source row's group, retains session IDs and unknown
  web configuration fields, clears PTY IDs, resets archive state, and remaps colliding pane/tab IDs
  plus grid/stack references. Epoch-millisecond grid-history dates are converted explicitly.
- No ai-memory skill or memory service was available in this session; these notes are the durable
  versioned handoff. No external memory update was claimed.

### Validation and next checks

- `python3 AletheNative/Scripts/check-strings.py`: passed; new keys have en and pt-BR translations.
- `git diff --check`: passed. No build, Swift test execution, UI harness, app restart, staging,
  commit or push was performed under the task's nested-sandbox constraint.
- Added `WebProjectFileTests` for web/native persistence round trips, unknown fields, PTY reset,
  collision remapping, malformed input, backward-compatible flags, profile-scoped legacy migration
  and epoch-millisecond history timestamps. Reviewer must run these tests outside the sandbox.
- Reviewer: compile first; then inspect normal/clean HUD hover and collapse, costs with an unpriced
  Codex session, pane/tab inspector actions at 80–150% zoom, repeated full-project imports, archive
  restore across relaunch, two-window live board updates, restored detached-only startup, pane deletion
  and profile switching. Pixel parity and runtime behavior remain unverified until that pass.
