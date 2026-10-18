# Modal, dropdown and terminal focus audit — 2026-10-18

## Scope and reference

Static inventory of every `EditorRequest`, every sheet/popover presentation site under
`AletheNative/Alethe`, the shared dropdown controls, and their React reference in `src/`.
This inventory is not a claim of rendered 1:1 parity for every screen.

## Corrections in this pass

- The web main menu exposes profile backup/import/reset/erase, data/log folders, log export,
  flat workspace, and Debug-only **Redo onboarding**. Data actions reuse the existing safety
  backups and confirmation dialogs. Destructive and disabled rows use semantic theme styling.
- Git Control, Merge Center, Worktrees and Branch Testing use their existing themed window
  overlays. The window installs the nested Git presentation layer for review/merge/commit dialogs.
- MCP manager/intro, Skills, Agent Library, GitHub Sync and onboarding use window overlays with
  their existing close handlers, theme, metrics, motion and width. Onboarding can be repeated
  without relaunching and its height is bounded at larger interface zoom.
- Title-bar and profile menus fit above/below the trigger, scroll within the available window
  height and dismiss with Escape/outside clicks. Profile menus use the window dropdown layer.
- RowSelect menus avoid horizontal overflow, preserve trigger toggling and support Escape.
  Their corners respect Clean style. Shared dialog bodies use themed overlay scrollbars.
- Project/group modals honor explicit resize height, allow header dragging, and host dropdowns.
- Terminal focus reparents the existing pane over the whole window, including the title bar and
  both sidebars. It preserves the terminal surface and selects/focuses the target pane. Existing
  frame animations survive repeated layout passes with the same destination. Escape restores
  the original grid; clicking the exposed backdrop also exits.

## Complete presentation inventory

| Family | Native implementation / React reference | Result / remaining work |
| --- | --- | --- |
| Project/group create/edit | ProjectEditor, GroupEditor / NewProject, EditProject, NewGroup, EditGroup, GroupFields | Existing themed overlays; shared resize/header/dropdown corrections applied |
| Terminal/sub-tab | NewTerminalSheet / NewTerminalModal, NewSubTabModal | Existing themed overlay; RowSelect bounds, Escape and Clean corners corrected; some system pickers remain |
| Find/jump | WebTitleBarSearch / FindJumpModal | Existing window overlay |
| Usage/reset credit | WebTitleBarUsage / AiUsageModal, ResetCreditModal | Existing window overlay; exact nested credit presentation still needs rendered review |
| Merge/worktrees/branch validation | Git sheets / MergeCenterModal, BranchTestingModal, ConfirmWorktreeCommitModal | Overlay routing integrated; functional differences documented in MODALS_M1_PARITY.md remain |
| PR review/merge and Git prompts | PullRequestWebModals, GitGraphWebModals | Window presentation layer integrated; existing native alerts remain where the reference uses prompt/confirm |
| MCP manager/add/edit/intro | McpManagerSheet, McpServerEditor, McpIntroSheet / McpManagerModal, AddServerFlow, McpIntroModal | Top-level overlay integrated; backup-list sheet still uses system presentation |
| Skills/Agent Library | SkillsSheet, AgentLibrarySheet / SkillsBrowser, AgentLibrary | Top-level overlay integrated |
| GitHub sync | GistSyncSheet / SyncModal | Overlay integrated; Tauri-import fallback remains native |
| Onboarding/welcome | OnboardingSheet, WelcomeBackSheet / OnboardingModal, WelcomeModal | Debug retry added; onboarding overlay integrated; welcome remains native |
| Add content/browser | AddContentSheet / AddContentModal, AddBrowserModal | Still native form and native URL alert; dedicated browser setup UI and main-menu browser shortcut remain a gap |
| Conversations | ConversationsSheet / RecentChatsModal, ClaudeHistoryModal | Native presentation; agent/scope filtering exists, exact web list/actions differ |
| Handoff/session cost | HandoffSheet, SessionCostSheet / HandoffModal, terminal session cost | Native presentation; themed web chrome still needs implementation |
| Layout/grid editing | LayoutDesignerSheet, ProjectGridPrompts / LayoutDesignerModal, ProjectGridModal | Native presentation; designer scope differences remain |
| Remote pairing | RemotePairingSheet / RemoteControlModal | Native presentation and functional service; web chrome still differs |
| Diagnostics/crash/memory | DiagnosticsSheet, CrashNoticeSheet, MemoryIndicator / AuditModal, MemoryAnalyticsModal | Native presentation and different data model; exact web audit/memory screens absent |
| Link preview/import/GSD activity | LinkPreviewSheet, TauriImportSheet, GSDSyncActivitySheet / LinkViewerOverlay and native migration tools | Native presentation; not routed to generic overlays without adapting dismissal and sizing |
| Preferences/profile management | WebSettingsView, ProfileSettings / PreferencesModal, ProfilesModal | Separate Settings window and nested native profile sheet; SETTINGS_PARITY.md lists field/service gaps |
| Appearance/toolbar/theme | AppearanceSettings / ThemePickerModal, TopbarSettingsModal | Native nested toolbar sheet; dedicated theme-picker menu shortcut remains a gap |
| Agent and Router9 installation | AgentInstallSheet, Router9InstallSheet | Web content exists; Settings entry points still use system sheets |
| Todos settings | TodosSettingsSheet / TodoSettingsModal | Native sheet presentation remains |
| Extensions/consent | ExtensionSettingsSection, ExtensionConsentSheet | macOS ExtensionKit/system presentation; JS plugin marketplace is not ported |
| Update/What's New | WebTitleBarNews / WhatsNewModal, UpdateModal | Existing themed news overlay; native updater installation is still a separate backlog item |
| Main/profile/title-bar dropdowns | WebWindowMenu, SidebarWebProfile, ProfileToolbarMenu / MainMenu, UserProfile, TitleBar | Shared bounds/scroll/Escape fixes; debug retry and data shortcuts added |
| Terminal/project/group context menus | PaneChrome, SidebarView, PaneChrome grid menus / TerminalPane, sidebarMenus, ProjectGrid menus | Native AppKit menus remain; full custom themed context-menu parity still outstanding |
| Shared selectors | NewTerminalRowSelect, AletheSelect, SwiftUI Picker / RowSelect, Dropdown, ModelSearchablePicker | RowSelect fixes cover terminal mode/agent/folder and Git agent pickers; remaining system selectors require individual migration |
| Notifications/memory popovers | NotificationsButton, MemoryIndicator / TitleBar popovers | Native popovers remain outside the web title-bar replacements |

## Embedded browser

`WebPageModel` already creates a private `WKWebView`, and `WebPaneView` supplies navigation,
address validation, zoom, JavaScript and hidden-page resource policy. The Playwright MCP shared
browser is separate and opens its own Chromium window; it is not the WKWebView session.
The missing browser menu/setup flow is UI parity work, not a lack of embedded-browser support.

## Validation and repository state

- String-catalog gate and syntax parsing run on the changed sources.
- The working checkout initially contained a pre-existing unresolved `ScrollbackFile.swift` merge.
  It was preserved during the audit and was resolved by concurrent workspace work before completion.
  Concurrent checkpoint `efbf229` also incorporated the shared presentation implementation.
- A copy at `/tmp/alethe-modal-validation-20261018` uses the HEAD side of that conflict only for
  validation. The first Debug build passed. This does not validate the unresolved merge result.
- Focus-mode and Debug onboarding UI regression tests cover the window-wide pane, restoration,
  Escape/backdrop dismissal, and reopening onboarding at 150% zoom. Both targeted UI tests passed
  in the isolated copy (8.458 s and 12.136 s). The title-bar accessibility container now preserves
  individual button identifiers. Initial failed runs exposed stale gesture assumptions and
  identifier inheritance; these were corrected and rerun.
- No external ai-memory skill/tool is available. This report and the migration plan record the
  current state, decisions and remaining work. The resolved checkout receives a final checkpoint
  for the regression tests, presentation follow-up and audit documentation.

### Integrated verification

- `Scripts/build.sh Debug`: passed in the working checkout after the concurrent merge resolution.
- Final focus-mode UI run also covers opening a project dialog while focused; passed (11.062 s).
- `Scripts/test.sh`: did not pass. Failures are in `PaneWorkingDirectoryTests` (observed cwd),
  `OrchestratorHelperTests` (standalone helper tool count), and `TauriImportTests` (usage/toolbar
  preference expectations). This pass does not change those services or their expectations.
- The design lint additionally reported `Motion.sidebarColor(reduceMotion:)` as a literal color
  constructor because it searched for the substring `Color(red`. Constructor matching now requires
  an identifier boundary and uses a cached regular expression, preserving genuine Color/NSColor/CGColor
  detection. The filtered design lint passes all three checks; no theme colors are suppressed or hardcoded.
- Full visual parity remains open for the native presentations explicitly listed in the inventory.
