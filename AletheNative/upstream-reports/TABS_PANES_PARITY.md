# Workspace tabs and terminal pane state review

2026-10-17. Changes remain unstaged; no commit or push. This record also captures task state
for the next agent because no ai-memory skill or memory write tool is available in this session.

## Source and implementation

Read the complete TSX and CSS from `origin/main` with `git show`:

- `src/components/TitleBar/index.tsx` and `TitleBar.module.css`: 26-point workspace tabs,
  96–190-point bounds, 8/4-point padding, 11-point labels, 14-point composition icon,
  11-point pin and close icons, 18-point close targets, numeric pane count pills, pinned
  borders, clean selection and 140/120ms state transitions. Existing title-bar placement
  and the absence of a separate web-mode row were already correct and remain unchanged.
- `src/components/SubTabsLane/index.tsx` and `SubTabsLane.module.css`: 36-point lane,
  26-point items, 5-point gaps, 6-point padding, 26-point leading drag control, 14-point
  agent logos, 2×16-point active marker, unread 10-point completion badge, clean-style
  opacity and marker suppression. Added arrow-key navigation, hover close fade and insertion fade.
- `src/components/TerminalPane/index.tsx` and `TerminalPane.module.css`: floating header
  at 4-point offsets, 26-point chips, 120ms reveal on pane hover, 20-point action targets,
  12-point icons, 2-point action gaps and 100ms hover fills. Removed the reserved web header
  row, hid floating shell identity, added agent-title double-click editing, corrected clean
  focus border and suppressed the focus ring in focus mode. Disabled panes use 0.85 opacity.

The existing Ctrl+Tab / Ctrl+Shift+Tab menu commands are retained. Cmd+1…9 and middle-click
closing are scoped to the key window. Existing dragging, back/forward and accessibility IDs
remain. Context menus now expose open individually and add to current view through existing
model operations. Numbered navigation scrolls the selected tab into view. Native view bodies
remain separate; new controls and styling are confined to the web interface.

## Remaining differences and reviewer checks

- Reviewer compilation follow-up: `WorkspaceTabEvents` now returns a `Bool` from
  `MainActor.assumeIsolated` and returns the original `NSEvent` only in the outer monitor
  callback. This avoids the unavailable `NSEvent: Sendable` conformance while preserving
  activation, middle-click closing and event passthrough. Strings and whitespace checks pass;
  no build was attempted under the nested sandbox restriction. External compilation remains
  pending. No ai-memory skill or write tool is available; this report records the outcome.
- No build or UI harness ran, as requested. `check-strings.py` and `git diff --check` pass.
  Reviewer should build on macOS 26, verify event-monitor Swift 6 isolation, hover hit testing,
  title editing, lane keyboard focus, zoom and transitions between interface styles.
- The native snapshot stores project IDs rather than pane ID lists. The count and add-to-current
  operation therefore use each saved project's current visible panes, not historical pane lists.
- The current web TSX has numeric count pills, no workspace-tab double-click rename and only
  unread-completion badges in its lane. It does not dim ordinary unfocused panes. These facts
  take precedence over the broader examples in the task description.
- Persistent pane-topbar pinning has no native model field; the floating mode is implemented.
  No model or schema changes were made. The native header still exposes native-supported
  isolation, session-cost and disable actions rather than the complete Windows action set.
- Existing header activity and remote-share indicators remain. Broadcast/linked state and WSL
  badges have no wired native pane-header state here; they were not synthesized. Running,
  needs-input and error-specific lane indicators beyond the upstream completion badge remain
  follow-up work if desired independently of this web revision.
- Hover enlargement and scale entrance animations are omitted to honor the no-scaleEffect rule;
  insertion uses the web duration with an opacity transition. Focus-border layer changes remain
  immediate; AppKit header reveal uses the matching 120ms timing and honors Reduce Motion.
- SF Symbols substitute for Lucide. No new assets, theme colors or shared Components.swift edits.
