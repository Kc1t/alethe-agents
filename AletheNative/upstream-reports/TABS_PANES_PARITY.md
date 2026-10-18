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


## Pane header and terminal menu follow-up (2026-10-17)

This section supersedes the earlier header action and pinning notes above. Changes are unstaged;
no commit, push, build, app restart or dev-server restart was performed. The session has no
ai-memory skill or memory write tool, so this versioned record preserves the outcome and next steps.

Source reads used `git show origin/main:` for `TerminalPane/index.tsx`, `TerminalPane.module.css`,
`SubTabsLane/index.tsx`, `ProjectSidebar/NormalTerminalNode.tsx`, `ProjectSidebar/ContextMenu.tsx`,
`ProjectSidebar/sidebarMenus.tsx` and the English/Portuguese message modules. The requested
`src/i18n/en.json` does not exist at this ref; `src/lib/i18n/messages/en.ts` is the actual catalog.

- Removed the web header's add-subtab action, overflow menu and header context menu. Native-only
  header isolation, grid, session-cost, remote sharing and disable controls remain in the mac path.
- Added direct pin/unpin, non-shell recent chats, Claude/Codex handoff, VS Code and process-backed
  restart actions. Kept lane toggle, focus and delete in upstream order. Delete asks for confirmation.
  Pinning is retained in per-pane UserDefaults without modifying the document schema.
- Matched 32-point pinned / 26-point floating headers, 22/20-point targets, 12-point symbols,
  2-point action gaps, active pin fill, disabled opacity and destructive hover tokens. Shell titles
  disappear when unpinned. Reordering is limited to multi-pane, non-focus presentations.
- Terminal sidebar menus now order grid move, reveal, restart, file manager, VS Code, focus and lane;
  workspace actions; rename, sharing, disable and kill; destructive delete. Web subtab context menus
  are removed because upstream has none. Existing lifecycle actions are reused.
- Exited web terminals use the full-area 86% sunken overlay, 24-point restart icon, 10-point gap,
  13-point label and 7-by-18-point restart padding. The native overlay retains CLI troubleshooting.
- Retained accessibility IDs for kept controls. Header remote-sharing/glyph UI tests now explicitly
  launch mac interface mode because web headers no longer expose those controls.

Validation: `python3 AletheNative/Scripts/check-strings.py` and `git diff --check` pass.
The sandbox prohibits builds; reviewer compilation and UI checks remain required.

### Remaining parity gaps

Exact Windows parity is not achieved for the following existing model/flow constraints:

- No parked-PTY or resume-pending state is exposed by TerminalRegistry. Restart remains Restart;
  the overlay cannot distinguish a parked process or render Resuming/disabled pending state.
- No per-pane orchestration membership, read-only GSD viewer or handoff-packet metadata exists in
  Pane/PaneTab. Open orchestration is omitted rather than guessing its eligibility or changing launches.
- Recent chats opens the existing project conversations sheet, which lacks the web action's
  terminal/agent-scoped route. Handoff usage-limit suggestion styling is not wired here.
- Per-terminal split visibility is absent from the native model. The sidebar omits Show in split /
  Close split and stop PTY. Add to current view uses the existing project composition operation,
  which adds the project's panes rather than only this terminal. Move to grid remains a submenu
  rather than the web modal. Exact equivalents need model/navigation work outside this task's scope.
- Sidebar menus and confirmation dialogs use AppKit presentation. They retain platform menu sizing
  rather than reproducing the DOM context menu CSS. SF Symbols replace Lucide/VS Code glyphs.
- Pin state uses local UserDefaults keyed by pane ID; it is not imported/exported with web preferences.
  Floating reveal is immediate and does not yet retain focus-within visibility during pointer exit.

Reviewer next steps: compile outside the sandbox; check hover hit targets and inline rename at
narrow pane widths and all zoom settings; run pane/subtab and remote-sharing UI suites. Resolve
remaining model/flow gaps before declaring the terminal control set 1:1 with Windows.


## Pane grouping and content panes (2026-10-18)

Task state / handoff memory: changes remain unstaged. No commit, push, build, app restart or
UI automation was performed. No ai-memory skill or memory write tool is available; this
versioned report records implementation decisions and reviewer follow-up.

Source of truth was read using `git show origin/main:<path>`:

- `src/lib/types.ts` and `src/stores/projectsStore.terminalSlices.ts`: `paneGroups` contains
  `id`, ordered `paneIds`, optional `kind` and `plannerId`. Grouping absorbs intersecting groups,
  preserves their member order and metadata, and moves members to the first selected pane's grid.
  The grouping implementation is in terminalSlices, despite the audit citing workspaceSlices.
- `src/components/WorkspaceView/PaneArea.tsx` and `WorkspaceView.module.css`: one outer slot
  per group; 28-point header, 11-point semibold uppercase label, 22-point ungroup target,
  8-point radius (zero in Clean), 6-point body padding/gaps and two columns. Orchestration groups
  use a vertical layout. The actual web implementation does not replace members with a tab strip.
- `src/components/{ImagePane,VideoPane}/index.tsx` and their module CSS: 32-point header,
  11-point identity, 10-point monospace path, 23-point action targets and 12-point symbols,
  drag handle, Explorer/Finder, focus mode and confirmed delete. Existing playback/image
  lifetimes remain in the content registry; grouping does not recreate them.
- `src/components/MarkdownPane/{index.tsx,MarkdownPane.module.css}`: 32-point tabs-lane header,
  16-point document icon, bounded monospace path pill, 22-point actions, 20/24-point body padding,
  14-point paragraphs, heading multipliers and 18/22-point editor padding.
- `src/components/DiffPane/{index.tsx,DiffPane.module.css}`: 36-point header, 13/11-point
  identity/path, 24-point close target with 14-point symbol, 16-point content padding and
  13-point monospace lines at 19.5-point line height, including hunk/add/remove colors.
- `src/components/GraphifyView/{index.tsx,GraphifyView.module.css}`: title/stats and labeled
  refresh/snapshot/prune toolbar, 8/12-point padding, 12-point buttons with 13-point symbols.

The native `.mac` view branches remain; the web layout uses metrics and theme tokens. Existing
accessibility identifiers remain. The new optional model field does not require migrating old
native documents. Tauri imports retain stacks and image/video/Markdown/diff/Graphify pane IDs.
Close reconciles dangling and singleton groups. Nested pane hit testing and drag targets include
all visible members, and layout leaves the currently dragged member alone.

Tests added in `PaneGroupTests.swift`: JSON round trip and optional old-schema field, orchestration
metadata, selection deduplication, absorption/order/grid assignment, invalid selection, ungroup,
close promotion/singleton cleanup, invalid membership reconciliation and media-stack import.
`python3 AletheNative/Scripts/check-strings.py` and `git diff --check` pass. Swift tests have not
run because compilation is prohibited in this sandbox; reviewer must build/test on macOS 26.

### Audit disposition and remaining parity

- Pane stacking / Shift-click grouping / ungroup: implemented in inspected source. Runtime
  validation remains: Shift-click terminal and content panes, merge groups, close leader/member,
  ungroup, drag members, change grids, focus/escape, relaunch and import a web stack.
- Image/video panes and focus chrome: implemented with native rendering adaptations. AVKit
  controls and supported codecs differ from browser HTML video; NSImage does not reproduce every
  browser SVG/GIF animation behavior. These renderer differences are not portable pixel for pixel
  using the retained native renderers. Verify fitted bounds and zoom externally.
- Content pane chrome and renderer parity: headers and the listed dimensions/colors are ported;
  full renderer parity remains partial. Graphify retains the native graph Canvas/timeline rather
  than Cytoscape. Markdown retains the native block parser (including literal HTML handling),
  rather than the web renderer's complete syntax/highlighting. Browser blur/shadow/animation and
  toolbar wrapping are not certified. These must not be represented as full 1:1 parity.

The requested external audit file is outside writable roots. Its existing rows were not rewritten;
this report supplies the scoped disposition for the reviewer to incorporate. Do not mark the
content-renderer row done until its remaining differences are resolved or explicitly accepted.

### Cover-image verification

Cover-image implementation and tests already existed when this task began; no cover files were
changed. Read `ImageInput.tsx`, sidebar TSX/CSS, web types and native fields. Web uploads store
original bytes as data URLs, accept image MIME types and cap files at 2 MiB; there is no resize or
compression. Native `ProjectImageInput`, editor fields, `SidebarCoverImage`, `iconUrl` model/import
fields, recent cards and tab icons already implement this path, including macOS drop/clipboard
extensions and loading/error fallbacks. No Change image context action appears in the inspected
web sidebar menu. Existing `ProjectImageTests` cover serialization, validation and imports; they
also await reviewer execution. Cover rendering for SVG/animated GIF remains a renderer check.
