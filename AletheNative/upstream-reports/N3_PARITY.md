# Web parity audit follow-up (n3)

Scope: audit3 section 3 fixes 8, 9, 10, 11, 12, 16, 17 and 18. The final n3 assignment supersedes
the project/group cover assignment earlier in the prompt. Sources were read with
`git show origin/main:<path>`; no checkout, build, staging, commit or push was performed.

## Source comparison and outcome

| Fix | Web source at origin/main | Outcome |
| --- | --- | --- |
| 8 | `src/components/VoiceCommand/index.tsx` (`isOpenChord`, overlay key listener) | Ctrl/Cmd+Shift+Space, F9, Escape and Enter already existed. Ignore repeated Escape/Enter events, as the web listener does. Enter still requires a runnable pending command. |
| 9 | `src/components/VoiceCommand/VoiceCommand.module.css` | Added 1.8s breathing, 2.4s listening scan / 1.2s processing scan, 6s traveling border (14/86 dash pattern, 1.25pt stroke), 280ms entrance and 8pt rise. Edge is inset 18pt, 14pt from bottom, 2pt high; glow and scan occupy 34% and 20%. Reduced motion freezes the effects. |
| 10 | `src/components/modals/preferences/PluginsPage.tsx` | Folder import already uses NSOpenPanel and the registry; ZIP support already streams its manifest without extraction. Added identifiers to import, manifest input, install, rescan and folder actions. Existing `PluginWebRegistryTests` cover folder and ZIP sources. |
| 11 | `src/components/modals/LayoutDesignerModal.tsx` / `.module.css`, `src/lib/types.ts`, `src/stores/projectsStore.ts` | Added project/group/workspace contexts, project children for group/workspace, scoped history, saving and workspace reset. Group rows expose Design layout; the web footer context menu exposes Workspace layout. Custom grids now position open containers. Web toolbar uses 12pt gaps, 10/18pt padding, 22pt buttons, 11pt labels and 12pt monospaced values; library is 196pt wide with 14/10pt padding; canvas inset is 18pt. |
| 12 | `src/plugins/git-control/GitTabs.tsx`, `GitControl.tsx`, `GitGraphCommitDetail.tsx` | Git is now a persistent selected sidebar tab. Project changes reload its model; Add to grid keeps the sidebar open. Existing group/folder/file discard paths, count confirmation, Sync (pull then push) and commit-detail Back already match these sources. The web source has no Ctrl/Shift arbitrary file selection: multiple-path discard is by folder/group. |
| 16 | `src/plugins/todos/TodoSidebar.module.css`, `src/styles/visual-clean.css`, `src/components/HomeView/HomeView.module.css` | Retained matching normal Todos literals (10pt header/composer inset, 36pt rows, 26pt sections, 17pt checkboxes). Clean now uses 8pt header/composer inset, 13pt title, plain counts, no list gap, 30pt rows and zero row radius. Home retains 940pt cap, 24pt section spacing, 18pt hero spacing, 28/18/42pt hero padding, 430–610pt hero and 560–780pt backdrop; fixed 620/900pt checks to use content width after outer padding. |
| 17 | `Alethe/Localizable.xcstrings` | All 419 `*.web.*` keys have nonempty en and pt-BR translations, including seven new layout keys. No missing translations were found in the existing keys. |
| 18 | All 54 `Alethe/**/*Web*.swift` source files | Added stable identifiers to previously unidentified interactive surfaces (plugin install/catalog, style selection, settings folds, popover, dropdown, row selection, PR dialogs, profile menu) and Git branch/reset dialogs. Existing identifiers are retained. |

All fixed sizes use metrics and colors use theme tokens. Native visual branches are retained.
No edits to `Components.swift`, web source, web changelog or the macOS migration plan.

## Persistence and tests

- Optional web-named fields: group `layoutMode`, `gridLayout`, `gridLayoutHistory`; preferences
  `workspaceGridLayout`, `workspaceGridLayoutHistory`. No required fields or version bump.
- History writes web epoch milliseconds and reads both those values and legacy native Date values
  (including ISO 8601 through the document store's decoder).
- Tauri import remaps grid cell keys from web IDs to imported project IDs for both scopes.
- Added `ScopeGridParityTests`: group/preference encode/decode, epoch timestamps, old optional-field
  absence, legacy numeric/ISO dates and project-ID remapping.
- Passed `python3 AletheNative/Scripts/check-strings.py`, syntax-only `swiftc -frontend -parse` for
  all 31 changed/new Swift files, JSON translation completeness checks, and `git diff --check`.
- Unit/UI tests and SDK typechecking were not run: the task explicitly prohibits builds in this
  nested sandbox. Syntax parsing is not a compiler or runtime verification.

## Deviations and handoff memory

- Voice gradients are replaced by solid accent strokes/fills because repository rules forbid
  gradients. No fabricated spectrum/audio levels: the existing speech controller does not expose
  an audio-level stream. Cloud Jev planning remains the previously documented native subset.
- Local web plugins remain manifest registrations, explicitly labeled unavailable on macOS; no
  JavaScript execution host or executable plugin assets were added. ZIP is a native extension of
  the web page's folder/pasted-manifest flow.
- Workspace layout entry uses the existing web sidebar footer context menu. The existing modal
  host and grid canvas remain; this task does not claim full pixel verification of that host.
- Collapsed containers retain the existing collapsed-strip layout; custom grids apply when all
  containers are expanded, with fullscreen and flat-workspace behavior preserved. Grid dividers
  are hidden in this mode; track sizes can be changed through the designer's saved layouts.
- Identifier-free files after the sweep are non-surface helpers/models/styles:
  `WebShortcutEvents`, `PluginCatalogWebModel`, `WebScrollStyle`, `WebShellAnimation`,
  `SidebarWebAppearance`, `SidebarWebMotion`, `WebProjectTransfer`, `WebPageModel`.
- No ai-memory skill/provider is available in this session. This section preserves decisions,
  current state, limitations and next steps; an external ai-memory write remains unavailable.
- Reviewer: build/typecheck outside the sandbox, run `ScopeGridParityTests`, existing plugin/grid
  tests and the UI hit-target harness. Exercise group/workspace save/reset/history and reopening;
  switch selected projects while Git is visible; verify folder/group discard confirmation and Sync
  only in a disposable repository; test Jev Escape/Enter/F9 and reduced motion. No remote Git
  mutations, app restarts or process-wide keystrokes were used during this task.

## Changed files

- `AletheNative/Alethe/Dictation/DictationController.swift`
- `AletheNative/Alethe/Dictation/DictationHUD.swift`
- `AletheNative/Alethe/Dictation/JevVoiceBar.swift`
- `AletheNative/Alethe/Dictation/JevVoiceEffects.swift`
- `AletheNative/Alethe/Editors/EditorRequest.swift`
- `AletheNative/Alethe/Editors/FindJumpSheet.swift`
- `AletheNative/Alethe/Editors/LayoutDesignerSheet.swift`
- `AletheNative/Alethe/Editors/NewTerminalWebPresentation.swift`
- `AletheNative/Alethe/Editors/WebDropdown.swift`
- `AletheNative/Alethe/Git/GitControlSheet.swift`
- `AletheNative/Alethe/Git/GitControlWebContent.swift`
- `AletheNative/Alethe/Git/GitGraphWebModals.swift`
- `AletheNative/Alethe/Git/PullRequestWebModals.swift`
- `AletheNative/Alethe/Home/HomeView.swift`
- `AletheNative/Alethe/Localizable.xcstrings`
- `AletheNative/Alethe/RightSidebar/TodosWebPanel.swift`
- `AletheNative/Alethe/Settings/PluginCatalogWebSection.swift`
- `AletheNative/Alethe/Settings/PluginInstallWebView.swift`
- `AletheNative/Alethe/Settings/WebSettingsSections.swift`
- `AletheNative/Alethe/Settings/WebVisualStyleGrid.swift`
- `AletheNative/Alethe/Shell/MainWindow.swift`
- `AletheNative/Alethe/Shell/WebTitleBarPopover.swift`
- `AletheNative/Alethe/Sidebar/LeftSidebar.swift`
- `AletheNative/Alethe/Sidebar/ProfileMenuWebStyle.swift`
- `AletheNative/Alethe/Sidebar/SidebarView.swift`
- `AletheNative/Alethe/Workspace/PaneHost/PaneHostContext.swift`
- `AletheNative/Alethe/Workspace/PaneHost/PaneHostView.swift`
- `AletheNative/CHANGELOG.md`
- `AletheNative/Packages/AletheKit/Sources/AletheModel/CustomGrid.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheModel/PreferencesDocument.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheModel/TauriImport.swift`
- `AletheNative/Packages/AletheKit/Sources/AletheModel/WorkspaceDocument.swift`
- `AletheNative/Packages/AletheKit/Tests/AletheModelTests/ScopeGridParityTests.swift`
- `AletheNative/VOICE_PARITY.md`
- `AletheNative/upstream-reports/N3_PARITY.md`
