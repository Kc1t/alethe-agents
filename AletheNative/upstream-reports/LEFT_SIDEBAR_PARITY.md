# Left sidebar remainder handoff

Source: `origin/main`, read using `git show` without checkout. Scope: `InterfaceStyle.web` only.

## Outcome and source values

- `NormalProjectSidebar.tsx` and `NormalProjectSidebar.module.css`: retain 4-point tab gaps,
  28×26 tab controls, 34-point section headers, 28-point project rows with 6-point top margins,
  28-point terminal rows, 10-point group indentation increments and section border tokens.
  Home, grid, folder and Git branch controls are present. Git opens the existing native Git
  control sheet, since there is no corresponding native sidebar panel.
- `NormalProjectNode.tsx` / `NormalProjectSidebar.module.css`: folder symbols use 20 points per
  the task's explicit override of the web's 16-point icon and 15-point lead slot. Terminal icon
  slots remain 15 points. Search is 52 points per the task's override of the CSS quick-nav sizing.
- `sidebarMenus.tsx`: archive and hide/unhide use archivebox, eye and eye.slash equivalents;
  background controls reveal hidden projects. A footer menu also exposes visibility and archive
  recovery, because native settings have no archive browser. Restoring an archive retains its
  previous group and hidden state. Archive closes its workspace presentation without deleting it.
- `UserProfile/index.tsx` / `UserProfile.module.css`: custom avatar or bundled DefaultProfile,
  circular 34-point image, 14×12 row padding, 13/11-point identity fonts; clean mode retains
  24-point images and 11/10-point fonts. Popover identity uses 36-point images (28 in clean mode).
- `SidebarUpdate.tsx` / `SidebarUpdate.module.css`: actual available native releases produce the
  13-point update icon, 7-point gap, 6×9 padding, 8-point radius and 11.5-point label. Unlike the
  web modal, clicking opens the verified GitHub release page. No automatic installation exists.
- `EmptyState/index.tsx` / `EmptyState.module.css`: retain compact inner spacing and controls;
  omit the surrounding card border/background as explicitly requested, including Explorer.
- New UI dimensions use metrics; colors use theme tokens. Existing accessibility identifiers and
  native interface branches remain. No shared Components.swift or workspace schema changes.

## Validation

- `python3 AletheNative/Scripts/check-strings.py`: passed after implementation.
- `git diff --check`: passed after implementation; rerun after documentation update.
- Reviewed native-path guards, profile scoping, archive recovery, and drag insertion/reordering
  with filtered rows. Catalog additions contain English and pt-BR translations without orphans.
- No build, app restart, UI harness, commit, staging or push. Reviewer must compile and validate
  actual rendering and interactions at multiple zoom levels outside the nested sandbox.

## Memory handoff and constraints

- No ai-memory skill or memory connector was available in this session. This versioned handoff
  records the implementation state, decisions and next checks for the reviewer.
- Local flags use `sidebar.web.hiddenProjects` and `sidebar.web.archivedProjects`, encoded as JSON
  sets of profile/project compound identifiers. Reveal state uses `sidebar.web.revealHiddenProjects`.
  Data is local UserDefaults state and is not included in project exports or profile backups.
- Custom images are stored as per-profile PNG data in `sidebar.web.avatarImages`; choose/reset
  controls live in the profile popover. The current model has no existing avatar preference.
- Release checks query the fork's releases once per sidebar lifetime. Only non-draft, stable
  releases with a DMG asset and a strictly newer three-component version qualify. Windows-only
  releases and incomparable `mac-native-v2-preview.1` tags cannot produce false update chips.
  Network failures leave the chip absent. A native preview update service remains outside scope.
- The task overrides the repo's commit/changelog workflow: changes remain unstaged and only the
  native changelog is updated. The main migration plan and web changelog are untouched.

## Profile menu and image sizing follow-up

- `origin/main:src/components/UserProfile/index.tsx` and `UserProfile.module.css` supply the
  popover's 4-point padding, 2-point gap, 7×10-point row padding, 8-point icon/text gap,
  13-point labels and 36-point header avatar. Clean header values remain 28/12/10 points.
  The task specifies 14-point icons and a trailing active-profile checkmark. Existing local
  avatar actions and profile switching remain available; no account/schema changes were made.
- The web CSS has no fixed popover width: `left: 8px; right: 8px` resolves against the sidebar
  (6 points in clean mode). The native popover receives that measured, fixed width rather than
  deriving width from individual row labels. Dividers retain the CSS 4×2-point margins.
- `Components+ProfileImages.swift` contains the flat row/label styles and explicit web image
  bounds. `Components.swift` is untouched. Shared image bounds return the original image in
  `.mac`; the original profile popover remains in a separate native branch.
- Image audit covers Sidebar, Home, Settings and Terminals, including symbols embedded in
  Labels and AppKit Menu labels. Agent/VS Code artwork is redrawn into a display-size NSImage,
  rather than changing metadata on copies retaining large bitmap representations. Avatar fill
  intentionally follows CSS `object-fit: cover`; document previews fit their available viewport.
- Native AppKit popover/menu hosting, SF Symbol glyph shapes and font rendering remain platform
  differences. Reviewer should inspect hover, profile confirmation, long names, menus, clean mode
  and zoom after building outside the sandbox. Strings gate and diff whitespace checks pass;
  no build, restart, staging, commit or push was performed.
- No ai-memory skill or connector is exposed in this session. This existing handoff records
  the follow-up state and remaining validation instead of claiming an external memory update.

## Sidebar motion follow-up

All references below were read from `origin/main` using `git show`; the reference was never
checked out. Changes are confined to the sidebar, a new design-component extension, this handoff
and the native changelog. The `.mac` disclosure, navigation and row-menu paths remain intact.

Implemented motion:

| Web source | Native behavior |
| --- | --- |
| `NormalProjectSidebar.module.css` `.sidebarTab` | Color 140 ms CSS ease; fill/border 160 ms CSS ease; hover lift −1 point over 180 ms `(0.16, 1, 0.3, 1)`. |
| Same file, `.layoutBtn` / `.quickNavItem` | Layout color/fill 100 ms; search hover 150 ms CSS ease. |
| Same file, `.disclosureChevron` | −90° closed rotation, 160 ms fluid ease. |
| `ui/Collapse.tsx` and `Collapse.module.css` | Disclosure list changes request 170 ms fluid layout animation and independent 130 ms CSS-ease opacity transitions. Initial expanded state does not animate. |
| Same sidebar CSS, `sidebarPanelIn` | Tab changes use 260 ms fluid opacity/5-point vertical entry; outgoing panel cross-fades. Initial window render does not animate. |
| Same file, `.rowEndSlot` / `.rowStatusIndicator` | Stable status/menu cell; width 0/16/20 points over 120 ms CSS ease; status hover fade 100 ms. The spinner stays mounted while hidden. |
| Same file, `.dropBefore` | Project drops show an immediate 2-point accent line, inset 5 points and offset −2 points. Group drops keep their inside highlight. |
| `UserProfile.module.css` | Profile hover 100 ms CSS ease; popover content enters with 4-point offset/opacity over 120 ms CSS ease-out. |
| `SidebarUpdate.module.css` | Update-chip hover 150 ms CSS ease. |
| `styles/visual-clean.css` | Button transition overrides use 120 ms; profile popover uses 180 ms fluid ease. |

`Components+LeftSidebarMotion.swift` centralizes these timings under `Motion.SidebarEffect`.
Every helper returns nil for Reduce Motion. Sizes use metrics and colors use theme tokens.
`Components.swift` is untouched. Web terminal row identity is explicitly tied to its pane ID,
so switching the active sub-tab does not replace the owning row. Existing model-ID ForEach
collections remain in place. No visible strings were added, and the string catalog is unchanged.

Audited behavior intentionally retained:

- Normal sidebar row hover/press fills, selected/focused fills, count pills and drop indicators
  have no CSS transitions of their own. No fabricated pulse, shimmer, insertion spring, selected
  indicator slide or empty-state animation was added. Empty panels participate in tab entry.
- Running agents retain the shared dot-matrix spinner (`DotmCircular2` uses speed 1.2, hence a
  1.5-second cycle); the existing shared spinner pauses under Reduce Motion. There is no separate
  running-dot pulse or loading shimmer in the normal web sidebar.
- Web tooltips use HTML `title`; there is no specified delay to copy. Native `.help` remains
  controlled by macOS. Context-menu appearance and drag previews remain hosted by AppKit.

Remaining deviations / reviewer integration:

- Outer sidebar width is controlled by `Shell/MainWindow.swift`, outside this task's assigned
  sidebar ownership. That host still conditionally removes the sidebar. To match `App.module.css`,
  its owner must retain the column while closing, animate width over 220 ms fluid ease, content
  opacity over 220 ms CSS ease and horizontal offset −16 points over 280 ms fluid ease, and disable
  transitions while resizing. This task does not claim the outer width slide is implemented.
- SwiftUI List owns actual row insertion/removal and height interpolation. The requested disclosure
  animation uses the web timings, but exact CSS grid clipping/retention through the 170 ms close
  interval needs runtime review. Root row insertion/removal uses stable IDs and platform behavior;
  upstream does not define separate insert/remove keyframes.
- Native drag previews do not reproduce dnd-kit's 0.45 source opacity/120 ms fade or its custom
  overlay. Group guide hover tint, merge-tree/panel-specific transitions and clean context-menu
  entry remain platform behavior. The web merge panel's resizable 220 ms container has no matching
  sidebar container in the current native implementation.
- Profile popover content matches translation/fade timing. AppKit additionally animates its host;
  the web clean popover's 0.985 scale is omitted to honor the task's no-scaleEffect constraint.

Validation: strings gate, Swift frontend syntax parse for all changed Swift files, and whitespace
checks pass. No compilation, app execution/restart, UI test, staging, commit or push was performed.
The reviewer must build outside the nested sandbox and inspect rapid disclosure toggles, hover
slots, tab changes, group/project drops, clean style, Reduce Motion and zoom. No ai-memory skill
or connector is available; this existing versioned handoff records the state and remaining work.

## Group click behavior audit (Windows 1.7.0)

Reference: `origin/main:package.json` reports `1.7.0`. The implementation was compared with
`ProjectSidebar/{NormalProjectSidebar,NormalGroupNode,NormalProjectNode,NormalTerminalNode,
GroupNode,ProjectGrids,ContextMenu,MergeTree,sidebarMenus}.tsx`, their CSS, the workspace
navigation store, workspace surface rendering, and the navigation/selector/drag tests.
All source reads used `git show origin/main:<path>`; no checkout, server restart, staging,
commit or push was performed. This section supersedes earlier click-behavior claims above.

| Interaction | Web source and contract | Native before | Native after |
| --- | --- | --- | --- |
| Group single click, including modified click | `NormalGroupNode:onTagClick`, `GroupNode:onTagClick`: toggle disclosure only | Disclosure toggled, but List selection still participated | Workspace selection binding is inert in web mode; disclosure does not open a view or leave Home |
| Group double click | `NormalGroupNode:onDoubleClick`: open group only; clean `GroupNode` has no double-click opener | Opened first project tab, then mutated it into a group composition | Normal opens/reuses a group-sourced composition; clean keeps disclosure-only behavior |
| Group chevron | `NormalGroupNode:groupChevronBtn`: toggle collapse, stop propagation | Toggle persisted group collapse | Retained; no workspace navigation |
| Group context open only | `sidebarMenus:groupMenu`, `openGroupWorkspace`: own saved group tab, including empty group | Disabled for empty group; reused a project tab | Separate reusable group source; empty group gets an empty tab and leaves Home |
| Group context append | `openGroupWorkspace`: append once, preserve active tab, select first openable member; empty scope is a no-op | Opened every project and selected the last one | Filters projects without panes, recursively includes descendants in document order, selects first, clears flat/fullscreen, converts active tab to composition |
| Reopen group | `openGroupWorkspace`: restore existing group snapshot | Rebuilt group by opening projects | Restores saved open projects, widths, focus and collapse state; active project grids are still global (see limitations) |
| Project name/folder, including modified or repeated click | `NormalProjectSidebar:activateProject`, `openProjectGrid`: own project tab regardless of current visibility | Visible project stayed in composition; Option appended | Explicit web gesture opens/reuses project tab and leaves Home; modifier flags do not append |
| Project chevron | `NormalProjectNode:onToggleCollapsed`: persist project disclosure independently of activation | View-local expansion | Profile/project scoped `sidebar.web.collapsedProjects` preference, separate from container collapse |
| Empty project | `openProjectGrid`, `WorkspaceView:surfaces`: empty workspace, no terminal creation | Empty container | Empty workspace rendering; no terminal auto-creation |
| Terminal single/repeated click | `NormalProjectSidebar:onTerminalClick`, `focusWorkspaceTerminal`: preserve visible composition; otherwise open its grid; request focus, read completion | Selected project through `openInTab`, then activated sub-tab; repeated List selection could do nothing | Web visibility check, grid reveal, active project/focused pane update, explicit repeated keyboard-focus request, completion marked read, leave Home |
| Terminal double click | `NormalProjectSidebar:onTerminalDoubleClick`, `openTerminalWorkspace`: reusable pane-only tab | No distinct double-click path | Reusable pane-sourced composition rendered with one pane independently of active grid |
| Context-menu reveal/open | `sidebarMenus:terminalMenu`: explicit reveal and open individually | No reveal or pane-only opening action | Added localized reveal and individual-pane opening; native menu path unchanged |
| Terminal drag onto project | `NormalProjectSidebar:onDragEnd`, `moveTerminal`: move sessions to destination active grid | No pane drag payload | Dedicated own-process payload, preserved pane/tab IDs, destination active grid, inside-drop highlight |
| Terminal drag onto group | `sidebarCollisionDetection`: terminal candidates are projects only | No terminal drag support | Group accepts plain-text project/group payloads only; terminal payload cannot target it |
| Cmd+1…9 | `useKeybindings`: projects in document order, independent of workspace-tab positions; does not explicitly leave Home | Workspace-tab position | Project-index event monitors on workspace root; tab events retain middle-click close only |
| Sidebar Projects/Files buttons | `NormalProjectSidebar`: preserve Home; clean `ProjectSidebar`: leave Home | Preserved Home in both styles | Normal preserves Home; clean leaves Home |
| Middle click sidebar row | Row components have no auxiliary-click navigation | No explicit handler | Retained; workspace tab middle-click close remains separate |
| Arrows, Enter, Space, Left/Right, F2, Delete | Sidebar row components have no tree navigation, rename or delete key handlers; pointer-only drag sensor | List selection could navigate via binding | Web List selection cannot navigate; existing control/accessibility keyboard handling remains platform-native. No invented F2/Delete actions |
| Hidden/archived projects | Sidebar filters rows; `openGroupWorkspace` does not filter hidden/archived membership | Local visibility controls; group opened every project | Local row visibility retained; group action uses all members that contain panes, as web store does |

### Storage and native-path boundaries

- `WebSidebarNavigation.swift` adds pure selection/open operations. Existing `openInTab`,
  `open`, `activateTab` and native group opener remain unchanged. UI callers opt into web methods
  only with `metrics.isWebInterface`; clean versus normal differences are handled separately.
- Existing composition tabs have an unused optional `projectID` source slot. Web group/pane tabs
  use reserved `web-group:<id>` / `web-pane:<id>` values in that slot to retain source identity
  without adding persisted fields, Codable cases or migrations. Project tabs still store real
  project IDs. Appending clears the source marker. Label/color helpers resolve markers before
  ordinary composition fallback; the serialization regression test covers repair after decoding.
- Terminal-only views use existing isolated-pane/fullscreen snapshot fields and a presentation
  copy in PaneHost. Stored project panes and active grid are not rewritten for double-click views.
- `ProjectEditorModel.swift` has no workspace selection/open methods; its folder inspection,
  cloning and Git initialization paths were left untouched.
- Existing row accessibility identifiers, theme tokens, metrics and Components.swift are retained.
  Reveal terminal uses one new dotted key with English and pt-BR translations.

### Validation and remaining deviations

- `python3 AletheNative/Scripts/check-strings.py`: passed after implementation.
- `git diff --check`: passed before this documentation update; rerun for final handoff.
- Added 14 model tests for navigation contracts, recursive/empty groups, append/reuse, focus,
  source encoding, rename, pane moves and the unchanged native project selection path. Tests
  were reviewed but not executed: sandbox builds and the UI harness are prohibited for this task.
- Explicit project/group reopening moves the saved tab to the end of the tab bar, following
  `applyTabNavigation`; activation through the tab bar preserves its position. Terminal context
  focus mode now calls the web focus path while the native action remains unchanged.
- Reviewer must compile with Swift 6 and exercise actual single/double-click recognition,
  chevron/menu event isolation, repeated terminal focus, drop feedback and scroll behavior.
- Exact per-container grid/pane membership snapshots, arbitrary pane-subset append, and custom
  group grid layouts remain unsupported by the existing native schema. Group tabs restore
  snapshot fields the native model can represent, but grid changes are global per project.
  Terminal context-menu Add to current is still absent; it must not silently add an entire grid.
- Group archive controls and archived-parent promotion remain absent in the native model/UI;
  existing project hide/archive flags remain local preferences. Named-grid disclosure grouping,
  non-file content rows and the full web menu inventory are not completed by this change.
- Native project/group reordering retains its prior insertion behavior; the project drop delegate
  adds inside feedback for terminal payloads but does not implement web before/after half-row
  reordering. Terminal moves into an already open destination still follow native visible-grid
  membership rather than retaining the web container's exact previous pane subset.
- Tree keyboard and automatic sidebar scrolling still use SwiftUI/AppKit infrastructure; parity
  is not claimed for browser scrolling or keyboard focus traversal. Workspace tab overflow
  scrolling remains unchanged. Visual focus styling uses existing pane/row renderers.
- No ai-memory or graphify-query skill/connector was available. This existing versioned report
  records decisions, limitations and reviewer next steps as the memory handoff.

## Audit 2 k3 — project persistence, configuration transfer and inspector

Web references: `origin/main:src/components/ProjectSidebar/sidebarMenus.tsx`,
`src/stores/projectsStore.projectSlices.ts`, `src/lib/types.ts`, and
`src/components/TerminalInspector/{index.tsx,TerminalInspector.module.css}`.

- Web sidebar visibility and Organization restore now read/write optional `Project.hidden` and
  `Project.archived` fields. Existing profile-qualified AppStorage entries migrate when each flag is
  absent; explicit false flags win. The session reveal preference remains local. Archive matches the
  web action by setting the flag without closing an already-open workspace.
- Web project menu transfer exports a bare full Project to `.alethe-project.json`. Import adds a new
  project beside the source row, with a new project identity and creation date, retained sessions,
  no live PTY handles, unarchived state and collision-safe pane/tab/layout references. Unknown web
  fields and unsupported plugin panes remain in optional native persistence metadata for re-export.
  Native settings-only transfer is preserved in `.mac`.
- Terminal inspector uses the web CSS measurements and theme tokens, with pane focus/reveal, folder
  and VS Code actions, restart/disable/lane/history/kill, media/browser close actions and the sub-tab
  switcher. It is bounded above the sidebar content and can be dismissed; the existing Conversations
  sheet provides history rather than duplicating the web's per-tab history modal.
- New Swift tests cover persistence, transfer validation and legacy visibility migration. The string
  gate passes. Compilation, Swift tests and visual/runtime checks are pending outside the sandbox.
  See `../ORCHESTRATION_PARITY.md` for the complete k3 handoff and implementation memory.


## Sidebar drag and drop — dd

Source of truth: `origin/main:src/components/ProjectSidebar/{NormalProjectSidebar,index}.tsx`,
`NormalProjectNode.tsx`, `NormalGroupNode.tsx`, `GroupNode.tsx`, both sidebar CSS modules,
`src/lib/sidebarDrag.ts` and its tests, and `src/stores/projectsStore.{projectSlices,terminalSlices}.ts`.

| Web behavior | Native implementation |
| --- | --- |
| Project row midpoint selects before/after | `SidebarWebDrop` uses the label height and pointer Y; `dropProject` translates against persisted IDs, including hidden rows. |
| Project header drops append into a group | Typed project targets append only when changing membership, matching `moveProjectToGroup`. |
| Group headers reorder among the target's siblings | `dropGroup` applies source-removal compensation once and delegates to `moveGroup`. |
| Expanded group contents accept nesting | Group empty rows and project subtrees accept group payloads; nested group headers retain their own reorder targets. |
| Ungrouped target moves projects/groups to root | Explicit root drop area supports both kinds, including an empty ungrouped list. |
| Self/descendant drops are rejected | Provider identity filters invalid hover targets; pure model operations retain cycle guards. |
| Terminal drops only target project rows | Own-process UTTypes separate projects, groups and panes; terminal and file rows carry a pane identity. |
| DragOverlay | Folder symbol 14, gap 8, padding 7×10, width 150–260, minimum height 34, font 12, elevated background, strong border and small radius through metrics/theme. |
| Insertion and inside indicators | Accent line 2 points high, inset 5 and offset 2 outside the selected edge; inside uses panel-hover and a 1-point strong border. |
| Escape cancels | AppKit owns cancellation; document mutation happens only on successful drop. |
| Edge scrolling | Drop updates scroll the enclosing sidebar clip view near its top/bottom edges, clamped to document bounds. |
| Collapsed groups | No hover expansion is added: the inspected web does not implement it. Expand before nesting a group into its body. |
| Finder folders | Row drops create projects in the target group (project rows use their containing group); existing empty-area import is preserved. |
| Undo/order persistence | All completed moves use `workspace.update(undoManager:actionName:)` and existing bilingual `undo.move`; no schema changes. Existing groups/projectIDs/ungroupedProjectIDs retain order. |

Validation: string gate and `git diff --check` pass. Added `SidebarDropOperationsTests` covers
both project edges in both directions, cross-group moves, ungrouping, group reorder/nesting,
cycle and stale-target rejection, JSON order round trip, and pane/session preservation.
Swift tests, build and UI harness were deliberately not run under the owner's sandbox restriction.
The `.mac` branch retains its original row providers, drop delegates and native disclosure.

Memory handoff: no ai-memory skill/connector is available in this session; this existing report
records the implementation decisions and outstanding reviewer validation. No staging, commit or push.
Reviewer should check overlapping nested List drop targets, dragging at multiple zoom levels,
Escape and continuous edge scrolling on macOS 26.6. Current deviations: the explicit root drop
area remains visible outside a drag to keep a stable List target; preview uses the nearest native
semibold weight to CSS 650 and AppKit's drag shadow/source treatment rather than web CSS shadow
and explicit 0.45 source opacity. Group-body highlights follow the flattened List row targets
rather than a single DOM wrapper surrounding all descendants. These require UI review for exact
visual parity; model behavior is covered by the added tests, pending execution outside the sandbox.
