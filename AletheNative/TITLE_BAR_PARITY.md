# Title bar parity review

Task T8, 2026-10-17. Changes are intentionally unstaged; do not commit or push this worktree.

## Source and implementation

Read source from `origin/main` with `git show`, without checking out that branch:

- `src/components/TitleBar/index.tsx` and `TitleBar.module.css`: 32-point bar, 28-point
  icon buttons, 14-point sidebar/menu icons, 13-point news icon, 4/7-point group gaps,
  24-point status divider, 22-point pills and 50/80 percent usage color thresholds.
- `MainMenu/index.tsx` and `MainMenu.module.css`: elevated 220-point dropdown, 4-point
  outer padding, 14-point icons, 13-point text, 7×10-point row padding and hover fill.
- `modals/FindJumpModal.tsx`: 520-point modal, 32-point search field, 12-point result gap,
  320-point results viewport and 8×10-point result padding. Uses existing native commands
  and terminal models, command shortcuts, keyboard navigation and AgentLogo artwork.
- `modals/AiUsageModal.tsx`, its CSS and `HomeView/UsageStrip.tsx` / `HomeView.module.css`:
  920-point overlay; adaptive provider cards with 244-point minimum height, 26-point badges,
  16-point agent logos, 6-point meters and live reset readings. Reset credits and the existing
  toolbar visibility preference remain functional.
- `modals/TopbarSettingsModal.tsx` and CSS: 440-point overlay with seven 42-point widget
  rows, 18-point icons, 6-point row gaps and 20-point trailing checked squares.
- `modals/MemoryAnalyticsModal.tsx` and CSS: 760-point overlay, 8-point summary gap,
  10-point summary padding, 18-point icons and compact live terminal memory rows.
- `modals/WhatsNewModal.tsx` and CSS plus `modals/Modal.module.css`: 480-point overlay,
  32-point icon slot, 18-point newspaper and 12-point hero padding.
- Inspected `UserProfile`, `ProfilesModal`, `UpdateModal`, `TokenHud` and `InAppNotifications`.
  TitleBar itself has no bell, cost HUD or grid-layout button, so this task adds none.

The web path lifts title-bar dropdowns into a shell overlay, avoiding AppKit popover arrows.
Click outside or Escape dismisses menus. Provider details survive the pointer crossing the gap.
Centered modals reuse the existing terminal/project overlay helpers and Motion entrance/exit.
All added artwork is bounded, dimensions use Metrics, colors use theme tokens, and added strings
have English and Brazilian Portuguese localizations. Existing accessibility identifiers remain.
The `.mac` branch retains its toolbar, sheets and profile menu implementation.

## Known differences and follow-up

- macOS traffic lights remain on the left; their visible right edge is measured in AppKit points,
  followed by the web CSS's scaled 6-point padding. Hidden or absent buttons and fullscreen reserve
  no traffic-light space. Windows window controls are not duplicated. SF Symbols substitute for
  Lucide icons.
- The hamburger exposes supported native actions. Web backup/log-reset commands have no matching
  native action here; no fake or destructive replacement was added.
- Profile switching retains the native relaunch confirmation and Manage Profiles settings entry.
  The web's full account-management modal is not reproduced in this task.
- Sync still opens the existing Gist Sync sheet. Native update delivery remains the existing
  sidebar release checker; What's New uses the existing native release copy, without claiming
  Windows updater support or inventing release notes/update badges.
- Memory displays real app/system/terminal measurements. WebView buckets, historical charts,
  process diagnostics and crash-report panels are absent because the native monitor does not
  supply those web datasets. No synthetic samples or model changes were introduced.
- Usage cards retain native labels and reset-credit semantics; web-only provider visibility
  settings have no matching native model field. A pill toggle edits the existing preference.
- Dropdowns have themed surfaces, but visual and interaction parity still needs reviewer checks
  at each zoom level; no runtime screenshot comparison was possible inside the nested sandbox.

## Validation and handoff memory

`python3 AletheNative/Scripts/check-strings.py` passed. `git diff --check` passed.
No build, unit/UI test harness, app restart, commit, staging or push was performed.
The reviewer must build outside the sandbox and check Swift 6 diagnostics, overlay sizing,
hover transfer, Escape/outside-click dismissal, profile confirmations, keyboard navigation,
Reduce Motion, all zoom levels and `.mac` mode. New Swift sources are included by the existing
Xcode synchronized source group and Swift package source discovery.

No ai-memory skill, MCP tool or CLI is available in this session. This handoff records the
implementation decisions, validation limits and remaining differences for subsequent work;
it has not been submitted to an external ai-memory service.

## Leading-gap correction (F2, 2026-10-17)

The previous `WebTitleBar` reserved 72 scaled points plus its HStack's 4-point spacing whenever
`fullScreen` was false. That boolean could not describe absent or independently hidden buttons.
`WindowChromeBridge` also forcibly revealed every standard button outside fullscreen.

The bridge now publishes the rightmost visible button edge after positioning the real buttons.
`MainWindow` passes that measured point coordinate to `WebTitleBar`, which adds exactly
`metrics.size(6)` from `origin/main:src/components/TitleBar/TitleBar.module.css` (`.bar`).
`TitleBar/index.tsx` confirms that the hamburger and sidebar toggle are the first two controls;
their 4-point gap remains, while the artificial spacer and its extra stack gap are removed.
Fullscreen hides the lights and restores their previous hidden states on exit. Outside fullscreen,
independently hidden buttons stay hidden. Resize, window updates and zoom-driven layout recompute
the extent. The native shell and window setup are unchanged.

Layout reasoning: the title bar is a full-width sibling above the sidebar/workspace split, so
collapsing either sidebar cannot add a leading inset. The bridge and web shell already ignore the
top safe area, and the bridge already removes NSToolbar in web mode. No extra safe-area or toolbar
reserve is added. At zoom 0.8–1.5 the CSS gap is 4.8–9 points; AppKit button widths are already
points and are not scaled twice. Window width does not enter the leading-edge calculation, so
the same rule applies from 800 to 1920 points.

Validation: the strings gate and `git diff --check` pass. Added
`TitleBarLeadingLayoutTests.testFullscreenUsesWebPaddingAtEveryZoomEndpointAndSidebarState`
for reviewer execution outside the sandbox. It checks fullscreen padding at 80%, 100% and 150%,
sidebar toggling, and restoration of the reserve on fullscreen exit. No build or UI run was
performed here; the reviewer still needs to inspect hidden/absent-button windows and widths
800–1920 visually. No ai-memory service or skill is available; this existing handoff document
records the decision and remaining checks. Changes remain unstaged and uncommitted.
