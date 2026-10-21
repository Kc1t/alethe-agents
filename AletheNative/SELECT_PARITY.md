# Select and dropdown parity (sel)

Baseline inspected directly from `origin/main` (`e684e72`); no checkout or baseline changes.
This task changes presentation only in `InterfaceStyle.web`. Existing native controls, saved shapes,
option ordering, labels and bindings are retained. Extra native controls already present in the port
are explicitly called out below rather than presented as baseline features.

## Shared controls

`WebDropdown` and `NewTerminalRowSelect` now attach their lists to the owning window's content view.
They do not require a modal preference-layer ancestor. The portal clips neither the list nor its
shadow, recalculates placement on scroll/resize, flips above when needed, and removes its view and
local event monitor on dismissal. It restores menu focus on Escape/selection and lets outside clicks
and Tab reach their target. New Terminal retains its 44pt row layout and full trigger-width list.

The standard list follows Dropdown.module.css: sunken 32pt trigger (30pt in Clean), 14pt chevron,
220...320pt width, elevated list, 4pt padding, 1pt gaps, 30pt/11pt options, selected/hover fills,
search and custom-value rows. Todo/Home retain their distinct compact trigger and option metrics.
All dimensions use Metrics; colors use theme tokens. Raw select triggers keep their module CSS.
In particular, reset.css's `min-height: 32px` constrains the filter/sort `height: 28px` in Normal;
Clean sets both to 30px. The raw trigger background shorthands reset the global SVG arrow, while
`select.input` explicitly restores its 10×6px arrow for shortcut rules.

Raw option menus intentionally share the themed listbox instead of browser-engine menus, as
requested by the owner; this is registered as **MD-022**. No persisted fields were added.

## Site audit

Paths below are relative to `AletheNative/Alethe/`; web paths are relative to `origin/main`.
Some entries refer to unchanged callers that now inherit the shared dropdown fix.

| Native site | Web source | Result / reason |
|---|---|---|
| `Editors/WebDropdown.swift:6` | `src/components/ui/Dropdown.tsx; Dropdown.module.css` | Converted: window portal, standard/Clean trigger and list, search, custom values, disabled choices and keyboard navigation. |
| `Editors/NewTerminalWebPresentation.swift:6` | `src/components/modals/RowSelect.tsx; RowSelect.module.css` | Retained 44pt row variant; shares the window portal, disabled handling, Space/Home/End and Clean list styling. |
| `Settings/AppearanceSettings.swift:27` | `src/components/modals/preferences/AppearancePage.tsx` | Converted terminal theme, topbar and sidebar placement selects; native interface selector keeps its existing choices. |
| `Settings/WebSettingsPages.swift:61` | `src/components/modals/preferences/AccountPage.tsx` | Left as choice cards: the web language selector is not a dropdown. |
| `Settings/RemoteSettings.swift:119` | `src/components/modals/RemoteControlSettingsFields.tsx` | Existing web selects now use the shared window portal; no bindings/options changed. |
| `Settings/MultiagentSettings.swift:67` | `src/components/modals/preferences/MultiagentPage.tsx` | Existing project dropdown now uses the shared window portal. |
| `Settings/PlaywrightSettings.swift:47` | `src/components/modals/onboarding/FeaturesStep.tsx; FeaturesStep.module.css` | Corrected the previously ported dropdown to the web segmented choice, preserving the native segmented Picker. |
| `Integrations/Router9/Router9SettingsSection.swift:40` | `src/components/Router9/Router9Settings.tsx; Router9Settings.module.css` | Corrected the previously ported dropdown to the web segmented source buttons. |
| `Settings/OrchestrationSettings.swift:121` | `src/components/modals/preferences/OrchestrationPage.tsx` | Converted skill/role selects and searchable custom model entry; duplicate orchestrator choices disabled. Existing model data retained. |
| `Settings/OrchestrationRoutingSettings.swift:39` | `src/components/modals/preferences/RoutingSection.tsx` | Converted policy, role and quota-gate selects; routing preset cards retained. |
| `Dictation/DictationSettings.swift:89` | `src/components/modals/preferences/VoiceDictationSection.tsx` | Converted microphone/language lists; existing voice mode segments retained. Native-only language data unchanged. |
| `Settings/CustomAgents.swift:139` | `src/components/modals/preferences/CustomAgentsSection.tsx; CustomAgentsSection.module.css; src/styles/reset.css` | Converted accent/icon raw selects with their own trigger styling; MD-022 for themed opened lists. |
| `Settings/MultiagentWorkerSettings.swift:63` | `src/components/modals/preferences/MultiagentPage.tsx; src/components/modals/controls.module.css` | Converted shortcut-rule raw select; preserves labels/order and localized prefix typing; MD-022. |
| `Home/HomeView.swift:453` | `src/components/HomeView/index.tsx; HomeView.module.css` | Converted agent/mode popups; keeps the 30pt compact summaries and separate Home option sizes. |
| `Home/HomeSections.swift:420` | `src/components/HomeView/TimeAnalytics.tsx` | Left as tabs: the time range is not a dropdown. |
| `RightSidebar/PluginsWebPanel.swift:81` | `src/components/PluginsSidebar/PluginMarketFilters.tsx; PluginsSidebar.module.css; src/styles/reset.css` | Converted status/source/sort; retains raw-trigger typography, padding and colors; MD-022. |
| `Settings/PluginMarketplaceWebView.swift:81` | `src/components/modals/PluginMarketplaceModal.tsx; PluginMarketplaceModal.module.css; src/styles/reset.css` | Converted sort; retains existing options and bindings; MD-022. |
| `RightSidebar/TodosWebPanel.swift:361` | `src/plugins/todos/TodoSidebar.tsx; TodoSidebar.module.css` | Converted compact/composer project popups with Todo trigger surfaces and 220...300pt lists. |
| `Workspace/PaneHost/PaneChrome.swift:116` | `src/components/ProjectSidebar/LayoutFooter.tsx; ProjectGrids.tsx; ContextMenu.tsx` | Existing themed action menus retained. Web sidebar already exposes layout icon buttons; container action commands remain available. |
| `Terminals/MemoryIndicator.swift:122` | `src/components/modals/preferences/TerminalPage.tsx; existing MD-009` | Existing web select now opens at window level. Baseline currently has a manual-policy hint rather than this native policy picker; no policy choices changed. |
| `Workspace/ContentPanes/WebPaneView.swift:104` | `src/components/WebPane/index.tsx; src/components/modals/AddBrowserModal.tsx` | Converted system options menu and resource-mode picker to a themed action menu with checked resource choices; existing pane actions retained. |
| `Git/PullRequestWebModals.swift:65` | `src/components/PullRequestReview/PullRequestReviewModal.tsx` | Restyled the existing native review-agent choice. The current baseline review modal does not expose a separate agent select; no new agent options introduced. |
| `Editors/ConversationsSheet.swift:82` | `src/components/modals/RecentChatsModal.tsx` | Retained agent tabs; restyled the existing native project-scope select. Current baseline modal has no project-scope popup. |
| `Editors/TauriImportSheet.swift:62` | `No web equivalent: native import of Tauri profiles` | Converted existing profile choice to the standard web dropdown; native path unchanged. |
| `Settings/AgentInstallSheet.swift:52` | `src/components/AgentInstall/AgentInstallModal.tsx; agentActions.module.css` | Left as install-method cards: the web uses a radio-like method list, not a dropdown. |
| `Integrations/SkillsBrowser.swift:54` | `src/components/modals/mcp/SkillsBrowser.tsx` | Existing native agent-filter dropdown gains reliable window placement; baseline browser has no corresponding agent-filter popup. |
| `Integrations/McpPanel.swift:155` | `src/components/McpPanel/index.tsx; ScopeSwitch.tsx; src/components/modals/McpManagerModal.tsx` | Left segmented/tab controls unchanged; no menu-style choice Picker in this surface. |
| `Integrations/McpServerEditor.swift:97` | `src/components/modals/mcp/AddServerFlow.tsx` | Left segmented source/filter/transport controls unchanged. |
| `Git/MergeCenterWebContent.swift:62` | `src/components/modals/EditProjectModal.tsx; controls.module.css` | Standard themed source/target selects with controls.input overrides; existing agent choice restyled. |
| `Git/BranchTestingWebContent.swift:28` | `src/components/modals/BranchTestingModal.tsx; src/components/modals/controls.module.css` | Existing native branch selector restyled with shared input metrics; the baseline testing modal receives its branch from the caller. |
| `Git/GitControlWebContent.swift:89` | `src/plugins/git-control/GitControl.tsx; src/components/ProjectSidebar/ContextMenu.tsx` | Converted mixed branch/action menu to the existing themed menu. Root action layer moved above web modal overlays. |
| `Editors/ProjectEditor.swift:169` | `src/components/modals/NewProjectModal.tsx; EditProjectModal.tsx; controls.module.css` | Existing source/group/worktree selects use the improved shared list; group trigger uses controls.input values. |
| `Editors/ProjectEditorAdvanced.swift:74` | `src/components/modals/EditProjectAgentSettings.tsx; ModelSearchablePicker.tsx; controls.module.css` | Provider now uses agent cards; models use searchable Dropdown with loading/placeholder/empty/custom labels. |
| `Editors/GroupEditor.swift:83` | `src/components/modals/NewGroupModal.tsx; existing native parent choice` | Existing parent select inherits the shared portal; no parent options changed. |
| `Editors/NewTerminalSheet.swift:422` | `src/components/modals/NewTerminalModal.tsx; RowSelect.tsx` | Converted leftover project/worktree selects and model menu; grid uses the web 44pt RowSelect. Existing native-only advanced options retained. |
| `Shell/ProfileToolbarMenu.swift:73` | `src/components/UserProfile/index.tsx` | Sidebar web profile popup now uses the existing themed action menu; title-bar custom profile list and native path retained. |
| `Settings/AgentSettings.swift:197` | `src/components/AgentInstall/AgentUpdateButton.tsx; AgentUninstallButton.tsx` | Converted the web management menu to the source's inline update/uninstall actions using AletheInstallActionStyle; kept native menu, existing actions, labels, disabled rules and manage identifier. |

## Review handoff

- `check-strings.py`: passes, including English/pt-BR translations and orphan-key checks.
- `check-divergences.py`: passes with MD-022 registered.
- Swift syntax-only parsing of changed Swift files: passes. This does not type-check or build.
- `git diff --check` and a changed-source color/gradient/scale scan: pass.
- No app/dev-server restart, build, UI-test run, commit, staging, push or schema change.
- The reviewer still needs the external build and visual/keyboard checks on macOS 26.6: open a
  dropdown in Settings, each right sidebar, the title-bar resource panel and modal advanced fields;
  test zoom extremes/window edges, searchable model selection and outside/Escape/Tab dismissal.
- Existing model discovery is unchanged. Orchestration's current model/default/custom choices are
  restyled without adding a model catalog or changing model validation.
- No ai-memory skill or connector is exposed in this session. This versioned audit records the
  outcome, constraints and next review steps for handoff.

## Changed files

- `AletheNative/Alethe/Dictation/DictationSettings.swift`
- `AletheNative/Alethe/Editors/AddContentSheet.swift`
- `AletheNative/Alethe/Editors/ConversationsSheet.swift`
- `AletheNative/Alethe/Editors/NewTerminalSheet.swift`
- `AletheNative/Alethe/Editors/NewTerminalWebPresentation.swift`
- `AletheNative/Alethe/Editors/ProjectEditor.swift`
- `AletheNative/Alethe/Editors/ProjectEditorAdvanced.swift`
- `AletheNative/Alethe/Editors/TauriImportSheet.swift`
- `AletheNative/Alethe/Editors/WebDropdown+Models.swift`
- `AletheNative/Alethe/Editors/WebDropdown+Select.swift`
- `AletheNative/Alethe/Editors/WebDropdown+Window.swift`
- `AletheNative/Alethe/Editors/WebDropdown.swift`
- `AletheNative/Alethe/Git/BranchTestingWebContent.swift`
- `AletheNative/Alethe/Git/GitControlWebContent.swift`
- `AletheNative/Alethe/Git/MergeCenterWebContent.swift`
- `AletheNative/Alethe/Git/PullRequestWebModals.swift`
- `AletheNative/Alethe/Home/HomeView.swift`
- `AletheNative/Alethe/Home/WebDropdown+Home.swift`
- `AletheNative/Alethe/Integrations/Router9/Router9SettingsSection.swift`
- `AletheNative/Alethe/Localizable.xcstrings`
- `AletheNative/Alethe/RightSidebar/PluginsWebPanel.swift`
- `AletheNative/Alethe/RightSidebar/TodosWebPanel.swift`
- `AletheNative/Alethe/RightSidebar/WebDropdown+Todos.swift`
- `AletheNative/Alethe/Settings/AgentSettings.swift`
- `AletheNative/Alethe/Settings/AppearanceSettings.swift`
- `AletheNative/Alethe/Settings/CustomAgents.swift`
- `AletheNative/Alethe/Settings/MultiagentWorkerSettings.swift`
- `AletheNative/Alethe/Settings/OrchestrationRoutingSettings.swift`
- `AletheNative/Alethe/Settings/OrchestrationSettings.swift`
- `AletheNative/Alethe/Settings/PlaywrightSettings.swift`
- `AletheNative/Alethe/Settings/PluginMarketplaceWebView.swift`
- `AletheNative/Alethe/Settings/WebSettingsSections.swift`
- `AletheNative/Alethe/Shell/MainWindow.swift`
- `AletheNative/Alethe/Shell/ProfileToolbarMenu.swift`
- `AletheNative/Alethe/Workspace/ContentPanes/WebPaneView.swift`
- `AletheNative/CHANGELOG.md`
- `AletheNative/DIVERGENCES.md`
- `AletheNative/Packages/AletheKit/Sources/AletheDesign/Components+SelectDropdown.swift`
- `AletheNative/SELECT_PARITY.md`
