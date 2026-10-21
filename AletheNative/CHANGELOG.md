# Changelog

All notable user-facing changes to Alethe for macOS (native) are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Divergences from the Windows/Linux app are tracked in [`DIVERGENCES.md`](DIVERGENCES.md). A bullet about something the
baseline lacks is tagged `[Mac-only]`, one about a baseline feature that works differently on purpose
`[Mac-different]`; both cite their `MD-nnn` id (checked by `Scripts/check-divergences.py`).

## [Unreleased]

### Title bar
- Web interface: the title bar's buttons, menus and pills now respond in a normal (non-full-screen) window. They
  were dead there because SwiftUI drops pointer events inside the title-bar safe-area band; the window now cancels
  that inset while a title bar exists.
- The three window buttons are vertically centered in the 32pt bar and stay visible in native full screen.

### Debug builds
- A Debug build now runs as `com.kc1t.alethe.mac.debug` ("Alethe Debug"): its own data folder, preferences, Keychain
  service and permissions, so it never touches the installed app's profile, and both can run side by side. It has a
  red "DEBUG" app icon and a DEBUG badge in the title bar. `Scripts/dev/seed-debug-profile.sh` copies the production
  data over once, when you want the Debug app to start with your real projects.

### Sidebar drag and drop
- Web interface: dragging projects, groups and terminals in the left sidebar no longer uses the macOS drag
  session. It follows the web's pointer drag instead: 8px to start, a floating drag preview that is never
  clipped, a 2px accent line for before/after and a bordered fill for "inside", auto-scroll near the list
  edges and Escape to cancel. Projects land on rows and group headers, groups reorder on headers and nest in
  group bodies, terminals land on other projects, exactly as in the web collision rules.
- Fix drops that were ignored or sent to another group, and indicators drawn away from the row under the pointer.
  Finder folders dropped on the list keep using the system drag.
- [Mac-different] Reorder from anywhere inside a group's area: a project goes before or after any project row, a
  group dragged over a project row becomes a child of that row's group at that position, group headers have
  before / into / after zones, and the margin between two groups means "before the next one". (MD-003)
- [Mac-different] The terminals under a project count as that project when dropping, so the insertion line sits
  under the last one. (MD-005)
- [Mac-only] A group may sit between or after the projects of its parent. The order is saved with the group as an
  optional field; existing workspaces and the baseline's import and export are unaffected. (MD-004)

### Sidebar dimensions (sz)
- Web interface: align Clean and Normal project icon slots, row actions, group indentation and empty rows, working indicators, and Organization footer dimensions with the web sidebar.

### Terminal link actions (tl)
- Web interface: detect printed URLs and file paths, underline hovered links with the active theme,
  and open a themed actions menu on click. Open files in the grid, preview media and Markdown,
  send Markdown to the right sidebar, open externally, reveal files, or copy the resolved target.
- Resolve relative links from the terminal folder and other project worktrees, including named
  worktree paths and the newest matching file. The macOS interface retains its existing behavior.

### Sidebar drop targets (dd2)
- Web interface: show one correctly aligned insertion line or group highlight, including nested
  groups, row spacing, collapsed headers, and the ungrouped area below the last project.
- Clear drop highlights and restore dragged rows after dropping or cancelling; dropping at the root
  end also moves already-ungrouped projects and root groups to the end.

### Sidebar drag and drop (dd)
- Web interface: reorder projects and groups before or after a row, move projects between groups,
  nest groups through their expanded contents, and move projects or groups back to the root.
- Move terminal and file panes onto another project without replacing their tabs or sessions;
  import Finder folders into the group under the pointer. Drops show insertion lines or target
  highlights, a compact themed drag preview, edge scrolling, and support undo.
### Terminal pane dividers (dv)
- Web interface: Clean split panes now touch with invisible resize handles; Normal retains its
  separator spacing and center line. Custom grids have no gaps in either style, with handles inside
  cell edges, hover grips, and double-click to fill free space. The macOS interface is unchanged.
### Terminal input parity (x1)
- Add web-profile terminal input routing for copy-or-interrupt, smart clipboard paste, right-click
  copy/paste, Ctrl+arrow prompt recall, and explicit Shift+right-click actions with icons.
- Match web clipboard newline normalization, bare deployment/localhost link targets and escaped
  file paths; clear stale find counts when the web query changes.
- Add web-profile 14-point terminal text and 4/6/2/8 host padding, scaled with UI zoom. The macOS
  profile retains its existing font, padding and input routing.
- The input/appearance integration requires live metrics at the existing monitor installation;
  see `upstream-reports/TERMINAL_INPUT_PARITY.md` for the pending bridge and remaining gaps.

### Web-styled settings controls
- Web interface: Integrations (9router, Playwright, usage), Plugins, Custom agents, Multiagent, CLI tool,
  Profiles and Terminal settings use the themed dropdown, confirm/prompt dialogs, stepper, spinner and
  progress bar instead of system pickers, alerts, steppers and progress views.
- The sidebar merge panel is a web-style card with a status tag and a custom conflict tree.

### Toasts, modal motion and title bar polish (n2)
- Web interface: in-app toast stack at the top of the window (newest four, action chips, 6.5 s or
  20 s with actions, hover pauses the timer, close button) for agent and system notifications.
- Web interface: every overlay uses the web modal enter/exit motion (backdrop fade, spring pop,
  clean-style slide) from one shared modifier; Reduce Motion disables it.
- Web interface: the usage pill no longer draws an accent outline; the memory pill pulses under
  high and critical memory pressure; the onboarding avatar fades in like the web.
- Removed the unused disabled-field placeholder from the web settings pages.
### Web parity audit (n3)
- Web interface: Git Control now stays in a selected sidebar tab instead of opening a modal.
- Design and save group and workspace grids, restore recent layouts, and remove a custom workspace
  layout. Imported grids remap project IDs; layout history uses web-compatible timestamps.
- Jev ignores repeated Escape/Return events and shows the web's edge breathing, scanning and
  traveling confirmation border, with reduced-motion support and solid theme colors.
- Match Clean Todos spacing and row heights, correct Home's content-width breakpoints, and add
  accessibility identifiers to web controls, plugin import sources, and dialogs.

### Plugin marketplace and local registration
- Web interface: browse the plugin catalog from Settings or the Plugins sidebar, search and filter
  by capabilities, source and state, sort, inspect details, refresh, and use cached results offline.
- Import plugin manifests from folders, ZIPs or pasted JSON; rescan, open the plugins folder,
  update/reinstall pinned catalog manifests, and uninstall local registrations. Web plugins are
  labeled unavailable on macOS and remain metadata only; native plugin enablement and extension
  consent continue through the existing hosts. The macOS interface is unchanged.
### Dictation and Jev (k2)
- Web interface: dictation settings now offer On/Off, Toggle/Hold for Cmd/Ctrl+E, a microphone
  picker, and Apple on-device language model selection/download with progress and readiness.
- Cmd/Ctrl+Shift+Space opens Jev; hold F9 or use the microphone button to speak a registered
  Find/Jump command title, then confirm with Run or Return. History keeps the latest 50 commands,
  their status and invoked actions, with Clear. Escape and app deactivation cancel recording.
- The macOS interface retains its existing settings and Option+Cmd+E dictation behavior.
- Apple manages speech model removal. Jev currently matches registered command titles locally;
  cloud planning, arbitrary agent prompts and continuous hands-free listening are not included.
### Live spend, project transfer and detached boards
- Web interface: a collapsible Live spend HUD lists running agent sessions, their tokens and costs,
  and the aggregate total, refreshed every four seconds.
- Project hide/archive flags now persist with the project and migrate existing sidebar preferences.
  Web-interface project export/import transfers the whole project, including terminal sessions,
  layouts and cover images, using web-compatible JSON without reusing live terminal processes.
- Orchestration boards can open in a separate restorable window that mirrors the live workspace and
  reports when its pane is gone. The web sidebar inspector adds pane actions and a sub-tab switcher.

### Fixed
- Clicking the orchestration row in the sidebar shows only the board, in its own tab.
- Orchestration boards (and Graphify, diff and web panes) now get a row in the sidebar project tree, like the web.
- Terminal content now always resizes with its pane (window resize, splitter drag, sidebars, grid
  change, focus mode, tab switch): the surface is pinned to the pane by frame and refit, with the PTY
  size updated, on every size change, reparent and unhide.
- A terminal shrunk and enlarged again (Claude Code TUI) no longer stays cut off: 120 ms after the
  last size change the surface is refitted and the final grid is re-sent to the PTY, with a SIGWINCH
  to the foreground program when it was not last told that size.
### Settings, right sidebar and chrome parity (c2)
- The Agents and Queue right-sidebar tabs no longer depend on the orchestrator feature flag (web `agentsPanel` is always on).
- Settings: 52pt bottom padding under the content; Features gains the "Review my MCP servers" link (reopens the MCP intro); Appearance lists every contributed sidebar tab with a Left/Right placement dropdown.
- Web interface: the disabled-pane overlay uses the web icon box, name and Reactivate button; the usage pill outline is the 15% agent soft tone; What's New shows the unread dot while a newer native release is available.
- Todos: Cmd+N focuses and expands the composer. Orchestrator board: Cmd/Ctrl + scroll wheel zooms around the pointer.
- Recent chats (web interface): "Open here" restarts the focused terminal pane on the chat, "New pane" resumes it in a new one.
- Find/Jump lists plugin commands placed in Find/Jump.
### Workspace and Git parity
- In the web interface an empty workspace with no project shows the web quick-start card (agent grid,
  project folder picker, Graphify toggle, "Open folder as project" and the project form shortcut), and an
  empty group workspace offers Open group workspace, New project and Find and jump.
- Git Control history uses the web commit graph (34-point rows, 18-point lanes, thicker main lane, ref
  badges, filter field), and selecting a commit swaps the list for a detail screen with a Back button.
- Git Control changes use the web layout: staged, merge, changes and untracked groups with a nested
  folder tree, folder and group stage or discard, a confirmation when committing with nothing staged
  (stages everything), and a Sync button (pull when behind, then push) in the branch row and next to Commit.
  Fetch, pull and push stay in the branch menu. The macOS interface is unchanged.

### Context menu parity
- In the web interface, project, group, terminal, workspace-tab, pane-header and grid/layout menus
  use a themed panel like the web `ContextMenu`: elevated surface, 1pt border, 8pt radius, shadow,
  15pt icon column, hover and danger rows, 1pt separators, hover/arrow-key submenu flyouts, Arrow/Return
  keyboard navigation, Escape and outside-click dismissal, opened at the cursor and kept 8pt inside the
  window. The macOS interface keeps the native menus.
### Modal confirmations and selectors
- In the web interface, questions the web app asks with the browser `confirm` and `prompt` now open
  in themed window dialogs instead of AppKit alerts: rename, delete terminal, delete or suspend group,
  worktree commit, remove and lock, named grids (a themed create, rename and delete dialog), git
  discard, merge abort and cleanup, skills, agent library and Gist pull confirmations, and the
  Settings reset, import, erase and remote-access confirmations. The native alerts are unchanged.
- Dropdowns in project, group, merge, branch-test and settings dialogs use the web dropdown menu
  (32-point trigger, 220 to 320-point listbox) instead of the system pop-up menu.
- The AI usage dialog opens a nested "Usage limit resets" dialog listing each Codex reset credit with
  its own "Use reset credit" action. Memory analytics now shows health, now/peak/average/trend, a
  history chart with hover tooltip, bottleneck diagnostics, composition bars, live terminals and the
  latest samples, with a Clear history action; the toolbar notification list uses the themed popover.

### Onboarding parity
- In the web interface the onboarding dialog matches the web app: a fixed 640-point dialog over a
  dimmed backdrop that ignores outside clicks, a header with brand mark, step dots and an EN/PT
  switch, an avatar with photo upload or GitHub avatar shortcut, a three-column agent card grid with
  versions and install, and a searchable, grouped feature list with switches. The native layout is
  unchanged.

### Settings parity
- Terminal settings gain spawn concurrency (1 to 8), a shell executable override and a terminal font
  family; the shell and font apply to new and open terminals. Appearance gains window opacity,
  classic or three-area title bar (32-point height), and an independent terminal theme. Account
  stores the display name and photo, archived groups live under Organization with restore and delete,
  About shows the update check, download and install states, settings search lists section hits, and
  the audit sheet gains search, an All or Errors filter and Copy report.

### Modal parity (web interface)
- Todo settings use the web's Cancel and Save form with a draft storage folder and the reference-list
  reset; the agent and 9router install dialogs match the web (480-point width, install-method rows,
  Node.js section, retry and auto-close on success); the toolbar customization in Settings opens the
  same themed dialog as the title bar. Accounts open as the web's standalone dialog with per-account
  backup and a typed-name deletion confirmation, and Manage accounts opens it directly. A theme picker
  dialog (themes, visual style, terminal theme) opens from the Home setup step. What's New lists
  published release notes and the update dialog opens from the sidebar chip, and the extension consent
  prompt uses the themed overlay. The native interface is unchanged.

### Dialog parity
- Conversations, handoff, session cost, diagnostics, remote pairing, link preview, import, layout
  design, GSD activity, welcome and crash dialogs now use themed window overlays in the web interface.
  Dialog bodies scroll at high zoom; conversation filters and imported-profile selection use themed
  controls. Nested onboarding import returns to onboarding without closing its parent.

### Browser setup parity
- Add Content and browser setup use themed window overlays. Open a browser from the main menu,
  validate its address, name it and set page zoom, JavaScript and hidden-page resource policy.
  Browser names persist across relaunch. Escape closes dropdowns before their containing modal,
  including while a text field is focused.

### Added
- Settings › Appearance can hide the border around the focused pane or lower its opacity.
- Web-style keyboard shortcuts (⌘B, ⌘P, ⇧⌘G, ⇧⌘P, ⌘W, ⌘1–9, terminal cycling, R), the full hamburger menu, group archive/quick-rename/move menu items and a web-style file preview overlay.
- Web-style pane groups persist and import from web workspaces. Shift-click panes to combine them
  in one layout slot, keep each pane interactive, and ungroup from the group header.
- Markdown, image, video, diff and Graphify panes use web-style headers and actions; media panes
  support focus mode and close confirmation. Diff lines retain the web colors and spacing.
- Web-style orchestration settings now expose worker limits, roles, routing presets and ordered
  quota rules. Edit worker rule sets and lead-agent prompt shortcuts, with defaults and validation.
- Custom agents can be added, edited, enabled and removed with CLI arguments, accent colors and
  preset, local ICO or HTTPS image icons. The Agents panel has its own default-on feature toggle.
- Project agent settings include validation commands, health probes, conflict-resolution provider
  and model, planning-file watching and explicit migration of existing agents into worktrees.
- Debug main-menu action to redo onboarding, plus profile backup/import/reset, data and log shortcuts.
- Debug builds include Debug → Load sample data and the `ALETHE_SAMPLE_DATA=1` launch option:
  25 varied global/project todos and an editable four-file Markdown sample project with its README
  open beside Todos. Repeated loads preserve existing tasks, sample edits and project/pane identity.
- Project and group editors accept icon URLs, local images, file drops and clipboard images, with
  previews and removal. Images persist across relaunch and web imports, and appear in web-style
  sidebar rows, recent-project cards and workspace tabs. Local uploads retain the web 2 MB limit.
- Web-style sidebar project menus can hide, reveal, archive and restore projects, with local state
  retained per profile. Profile images can be selected locally or reset to the bundled default.
- A sidebar update chip links to newer stable native DMG releases on the fork when available.
- Persistent prompt queue in the right sidebar for Codex and Claude, with priority ordering,
  drag reordering, Run now and Cancel actions. Prompts release when an agent has capacity, at a
  scheduled time or after a job settles; usage-limit failures wait for the reset before retrying.
- Queue MCP tools and `/queue` skill; `alethe_delegate` accepts `queue: true` to defer work when
  the requested agent is strained or rate-limited, preserving its worktree and approval options.

### Removed
- The live spend (token HUD) overlay: its panel sat behind open dropdowns and took their hover.
- Removed the native Pomodoro timer, focus actions, notifications, toolbar item and duration settings.
  Existing Todos lists and template settings continue to load, ignoring legacy timer fields.

### Fixed
- Opening a dialog exits terminal focus mode, and title-bar controls retain separate accessibility identifiers.
- Git and integration dialog routing now uses themed window overlays. Dropdowns fit the available
  window at interface zoom, and RowSelect corners respect Clean style.
- Terminal focus expands the existing surface across the whole window, restores keyboard focus and
  preserves its animation through repeated layout passes.
- Terminal scrollback compaction preserves UTF-8 and ANSI sequence boundaries, bounds pending output,
  and retains pending bytes after disk-write failures. Prompt history sanitizes restored entries and
  applies the web's Unicode length limit.
- Running shell panes persist their reported working directory, with process-directory fallback.
  Unambiguous agent session-file changes continue to update the saved conversation after initial
  discovery; pane-specific Claude hooks remain authoritative when multiple panes share a directory.
- Project and group covers decode off the main thread and share cached thumbnails; local image
  imports retain the web byte format and size limit without blocking the editor.
- Reduced startup JSON work, repeated logo rendering, inactive Home animation and idle terminal
  timer work. Resource sampling runs in the background; scrollback reads and disk batches are
  bounded, and failed workspace saves retain their latest snapshot for retry.
- In full screen the window buttons are handed back to the system title bar, so the menu-bar reveal shows exit full screen and minimize again.
- The Projects tab icon in the sidebar is no longer highlighted while Home is showing.
- Web-style Settings follows the web category order from Account through About, with separate
  appearance sections, archived-project restoration, profile controls and persistent section folds.
  Settings scrollbars use thin overlay thumbs and theme colors; unavailable native settings are
  identified without creating new document fields. Native macOS Settings keeps its existing layout.
- Image inputs report failed file drops and accept a supported image provider when unrelated drop
  items precede it. Profile photo fields use their own labels and hints.
- Image drops and clipboard imports select the first supported attachment and report unreadable
  image data instead of silently leaving the project or group image unchanged.
- Web-style image previews retain the selected project or group color behind transparent images,
  matching the web image field after the preview finishes loading.
- Web-style profile dropdown follows the Windows Preferences, Manage accounts and Sign out order,
  with compact icons, destructive hover styling and an upward-opening menu. Sign out resets the
  local avatar and reopens native onboarding; the native macOS profile menu is unchanged.
- Image-input previews use the web thumbnail shadow; web imports explicitly support null icons.
- Settings opens at the web size (1180×780) and stays resizable instead of reopening tiny.
- Web-style title-bar controls reserve only visible macOS traffic lights, followed by the web
  left padding. Hidden or absent buttons and fullscreen no longer leave an empty leading gap.
- Fixed sidebar menu compilation by composing its conditional actions with a view builder.
- Web-style terminal headers replace the extra add button and overflow menu with direct pin,
  recent chats, handoff, VS Code, focus, restart and delete actions. Unpinned headers float on
  hover; terminal-row menus follow the Windows action order and exited panes use the web restart
  overlay. Native macOS controls remain unchanged.
- Web-style terminal and agent panes keep their 32-point headers pinned, including shell titles,
  bounded agent logos and compact action buttons. Solo panes no longer show a
  project container title, border or extra padding; grouped projects retain their title and count.
  Workspace gutters, collapsed strips, resize indicators, sub-tab add states and empty-project
  actions follow the web metrics. Native macOS styling and terminal lifecycle callbacks are retained.
- Web-style group, project and terminal navigation follows Windows 1.7.0: group tabs are reused,
  empty groups can open, project clicks leave compositions, terminal clicks preserve visible
  layouts and double clicks open individual panes. Project disclosure persists per profile,
  terminal drops move sessions between projects, and numbered shortcuts open projects.
- The Home ASCII art is no longer drawn upside down.
- Fixed workspace-tab event monitoring compilation under Swift's strict concurrency checks.
- Web-style workspace tabs show pinned borders, pane counts and clean-style selection, support
  numbered shortcuts and middle-click closing, and reveal the selected tab when overflowing.
  Terminal headers support inline title editing, compact action hover states, lane drag handles
  and unread completion badges. Native macOS styling is preserved.
- Web-style Git dialogs use themed modal headers, compact repository and worktree rows, bounded
  agent artwork, pending-file commit review and pull-request cards. Native macOS sheets and Git
  operation guards are retained; full-window overlay routing remains pending host integration.
- Web-style left sidebar matches the web search height, row spacing, folder and pause icons,
  group hover corners and nested-group margins. Search hover colors, unread completion marks,
  group double-click opening and the now-playing/update order follow the web interface;
  terminal names truncate before their count pills and row actions. Native styling is preserved.
- Web-style right sidebar uses the web tab-strip height, compact icons, panel spacing and tooltips.
  Todos now has completion progress, filters, a dashed composer, project pickers and compact rows;
  Files has web-style rows, keyboard navigation, hover actions and Markdown-sidebar shortcuts.
- Sidebar Markdown follows the web document typography, tables and code-block spacing, remembers
  scroll positions and shows loading, copy and file-drop feedback. MCP filters, input focus,
  disabled controls, agent logos and error states follow the web styling. Installed native plugins
  appear as searchable cards; the native macOS interface keeps its existing controls.
- Web-style Home aligns the streak badge with the profile avatar, follows the selected profile
  image, and matches the web quick-launch fonts, compact toolbar, path labels and button states.
  The greeting scales with the window width while the native interface keeps its existing layout.
- Fixed the web-style Home usage enable action to save its toolbar preference through the supported setter.
- Web-style Home matches the web overview's responsive project and action cards, usage headlines,
  meters, reset statistics and provider logos. View All opens the workspace, activity appears once,
  refresh controls expose busy states, and the two-step setup checklist and music dock follow the
  web layout with keyboard focus expansion and reduced-motion support. The native interface is unchanged.
- Web-style sidebars retain their state while opening and closing with smooth panel resizing,
  content fades and directional motion matching the web interface. Separators fade on collapse;
  dragging stays immediate, Reduce Motion disables transitions, and the title bar stays fixed.
- Claude usage polling no longer repeatedly asks for Keychain access. Credential reads use Apple's
  stable system tool and are cached until expiry, authorization failure or explicit reconnect;
  denied reads are not retried by polling. Sign-in checks remain prompt-free, and Antigravity
  credential reads use the same protection.
- Authenticated Claude, Codex and Antigravity agents appear in both title bar styles by default.
  Local sign-ins are detected automatically; toolbar opt-outs stop background usage reads.
  Loading or unavailable usage keeps a neutral logo pill, and stale figures remain dimmed.
- The web interface keeps a full-width, 40-point title bar above both sidebars and the workspace.
  Traffic lights stay centered in their reserved area; fullscreen hides them and releases that space.
  Sidebar toggles leave the title bar in place, with the native interface layout preserved.
- Web-style New Terminal dialogs open centered and recenter with the window. Edge and corner
  handles resize the dialog; dragging the header moves it within the window, and double-clicking
  the header restores its default size. The body and agent menus scroll within their bounds while
  the header and footer stay visible. The native interface keeps its existing sheet presentation.
- Web-style right sidebar tabs and MCP/GSD rows fade hover and selection colors with the web
  timings. MCP and pull-request refresh icons rotate at their original speeds without shifting
  the header; GSD busy sessions use the stepped dot-matrix indicator. Reduce Motion pauses these
  indicators and disables the new transitions.
- Web-style Todo sections have rotating collapse chevrons and count pills. Todo and Queue drag
  targets show an insertion marker without changing row layout; the native interface retains
  its existing controls and lists.
- Web-style profile menus use flat, full-width hover rows, bounded sidebar-relative width and a
  trailing checkmark for the active profile instead of native checkbox controls.
- Images and menu icons in Home, sidebar, Settings and terminal surfaces retain explicit bounds
  at every interface zoom level. Menu brand artwork is rasterized at its display size to prevent
  AppKit from using oversized asset representations; the native interface retains its image path.
- Web interface title-bar controls use fixed icon frames and a 32-point sidebar toggle inside a
  40-point bar, with macOS traffic lights reserved separately. The right tab strip is 40 points
  tall and Markdown empty states use a centered 24-point icon.
- Web workspace empty actions retain the original watermark, spacing and shortcut sizes without
  overflowing narrow windows. Sidebars yield width at 800×500 and higher interface zoom levels.
- Fixed opaque return type inference in the native Settings tabbed layout.
- Home quick-launch agent images keep a 16-point intrinsic and layout size, preventing oversized
  menu artwork; Agent, Path and Mode controls retain their web widths and compact wrapping.
- The Alethe Home sidebar opens Projects and includes a Git Control shortcut. Title-bar controls
  reserve space for macOS traffic lights at every interface zoom level.
- Removed the unsupported sidebar list-spacing modifier to restore macOS API compatibility.

### Changed
- The project "…" menu folds related actions (open in, layout and grids, Git and worktrees, content and history, project settings) into flyouts that open to the right, so it no longer runs off the screen.
- Web-style title bars use the web's 32-point height, 28-point sidebar controls, compact status
  spacing, themed hamburger/profile dropdowns and live provider hover details with agent logos.
  Memory analytics, AI usage, terminal search, widget customization and What's New open centered
  overlays; native interface menus, sheets and toolbar remain available unchanged.
- Web-style New/Edit Project and Group use centered overlays with the shared Motion entrance,
  440-point creation/group and 760-point project-edit widths, compact labeled fields, folder
  browsing, wrapping color swatches, footer actions and Return/Escape handling. Native-style
  sheets retain their existing forms and creation behavior.
- Project/group editor parity remains limited to existing model settings:
  conflict-provider cards, validation/health-check settings and the web edit-project navigation
  are not ported. Existing theme-backed colors and clone controls remain available.
- Web-style New Terminal and Add Sub-tab use a centered overlay, branded agent dropdowns,
  compact folder and mode selectors, collapsible advanced options and keyboard shortcuts.
  The native interface retains its system sheet and existing form.
- Web-style sidebar tabs, disclosures, trailing status slots and profile popovers use the web
  motion timings and respect Reduce Motion. Project drops show an insertion line; terminal
  status indicators stay mounted on hover to avoid abrupt row layout changes.
- Alethe interface Settings use a searchable sidebar, compact section headings, bordered option
  rows and scrolling content. Appearance includes web-style theme swatches, visual-style previews
  and zoom controls; agent rows show brand logos and wrap their actions in narrow windows.
  Shortcuts and application version are available in the sidebar. Native macOS Settings retain
  their tabbed layout.
- Web-style sidebar navigation includes the Git control shortcut; search uses a 52-point row,
  project folders use 20-point symbols, and empty lists omit the surrounding bordered card.
  Profile menus show the active avatar and identity; new project actions retain context-menu icons.
- Alethe Home uses the original web background as theme-aware flowing ASCII art, including pointer
  response, reduced motion and the fading lower edge. Launch surfaces use the web transparencies.
- Remaining fixed dividers and sub-tab details in Home, workspace panes and terminal controls scale
  with interface zoom. Clean Alethe styling suppresses launch, search, tab and drag shadows and
  decorative hover movement while preserving native macOS interface paths.
- The Alethe sidebar uses bundled agent logos (including mixed-agent terminal stacks), the default
  profile image, icon-only row menus and labeled context-menu icons. Long names yield to fixed
  controls; count chips, album art and playback indicators retain their dimensions when zoomed.
- Empty project lists show the web's centered No projects yet card and accent Create project action;
  Explorer uses the same compact card. Group empty rows and drag targets follow web tree spacing.
- Clean sidebar profiles use the web's 40-point row, 24-point avatar and compact identity fonts.
  Layout switches use the elevated background and hide their label when space is insufficient.
  Native macOS interface styling remains unchanged.
- Alethe interface right sidebar includes Jev and Plugins tabs with disabled controls and clear
  macOS availability messages; Markdown empty states, PR headers and states, agent cards, GSD rows
  and MCP filters follow the web dimensions. MCP filters and server rows use agent brand logos,
  and narrow panels keep scope controls separate from scrollable agent filters. Native macOS
  interface layouts remain unchanged.
- Alethe interface agents use the original web logos in pane headers, sub-tabs, disabled terminals,
  Home selectors and usage cards, notifications and title-bar usage pills. Mimo, Cursor, Copilot,
  Kimi, Grok, Codewhale and WSL keep their vector marks and theme tint; OpenCode retains its
  separate light and dark assets. Native macOS agent glyphs remain unchanged.
- Home and the profile menu use the bundled profile image in the Alethe interface. Quick-launch
  agent names keep their minimum field width, and notification summaries stay within their rows.
- Alethe pane identities follow the web's half-width/320pt limit; pane actions and title-bar
  accessories scroll horizontally when space is limited. Workspace composition tabs and context
  menu actions include their corresponding icons.
- Alethe interface title bar follows the web control order: menu and pressed sidebar toggle after
  the traffic lights, then news, sync, profile, live memory in MB and the right-sidebar toggle.
  Idle Pomodoro, notification and usage-launcher buttons no longer occupy the web title bar.
- The right sidebar opens on first use of the Alethe interface and remembers subsequent toggles.
- Empty Alethe workspaces use the original web knight mark and compact Open all panes, New terminal
  and Add content actions with keyboard hints. Native macOS interface layouts remain unchanged.
- Alethe interface sidebar projects use colored folder icons and persistent trailing chevrons;
  group tags omit monograms and align their names, rules, add actions and chevrons with the web tree.
- The Projects header shows only New group and New project; Add project folder remains in the
  New project menu, sidebar context menu and folder drop. Native macOS styling is preserved.
- Sidebar terminal rows use unboxed shell and distinct agent glyphs; file panes appear alongside
  terminals in project order with document icons, focus selection and hover actions.
- Alethe Home follows the web dashboard's lowercase date, separated streak bubble, labeled quick-launch
  menus, single-letter project badges and three outlined start actions. Usage cards, repeated activity
  heatmaps, time summaries and notification empty states use web dimensions and theme colors;
  Native macOS mode retains its existing presentation.
- Alethe interface title bar spans the window with its left controls aligned to the sidebar width;
  standard macOS traffic lights remain visible and centered after resizing and appearance changes.
- Alethe interface links and controls inherit the active theme accent throughout the main window.
- Alethe sidebar surfaces use the base background and the web Explorer header dimensions and borders.
- The sidebar profile footer keeps its full-width avatar, identity and account actions visible;
  Home preserves the selected sidebar panel, and sidebar navigation keeps Home open like the web app.
- Alethe Home centers the avatar, activity streak, greeting and date with web-matched hero spacing;
  the compact music dock appears only for a known track and no longer covers the greeting.
- Alethe Home setup uses the web's two-step walkthrough, divided rows, compact progress bar and
  footer; quick-launch controls wrap at narrow widths and Native macOS mode keeps its existing layout.
- Alethe interface workspace containers use square borders, project-colored top rules and 32pt
  headers; panes use square focus rings, 10pt split gutters with hover handles, and web terminal padding.
- Pane actions use compact identity and action chips; sub-tabs keep their add control next to the tabs.
- Alethe Home uses the web composition's compact avatar, stacked project and action sections,
  quick-launch fields, project card borders, section labels and ruled footer. Native macOS styling is preserved.

### Added
- The web app's agent and brand logos (Claude Code, Codex, Freebuff, Antigravity, Kiro, OpenCode, shell,
  VS Code, the Alethe mark and the default profile picture) in the asset catalog, with an `AgentLogo` view.
- Alethe interface window chrome with a compact 32-point title bar, system traffic lights,
  workspace tabs and history, menu and sidebar controls, profile, sync and live status widgets.
- Resizable Alethe sidebars with web-matched default widths and limits, one-point separators and
  hover grips; the Native macOS interface keeps its system toolbar, sidebar and inspector.
- Interface changes update window chrome in place, and the left-sidebar menu shortcut works in
  both interfaces.
- Settings › Appearance › Interface: "Alethe" (the same interface as on Windows and Linux, the default)
  or "Native macOS" (system toolbar, sidebar and inspector).
- Left sidebar with Home, Projects, Files and left-placement plugin tabs, Search, a project
  organization switch, Now Playing and a local profile menu with Preferences and profile switching.
- Sidebar group creation and empty-state guidance; hover actions for adding projects and terminals,
  row action menus, project activity and pause indicators, and multi-tab pane counts.
- Group actions to open only a group, add it to the current tab, or confirm deletion of the group,
  its subgroups and their projects (undoable; files stay on disk).
- Sidebar project layout design and quick rename, plus terminal rename, focus mode, process stop
  and movement between project grids.
- Right sidebar Agents tab with focused/all scope, sorted worker and native subagent cards,
  running counts, elapsed time, cost, approval answers, Stop, and an action to open the board.
- Markdown viewing inside the right sidebar, with closable document tabs, file drops, refresh,
  source copying, file paths, back-to-list navigation, and Open in pane.
- Home content parity: profile-name greeting with an initial avatar and activity streak, responsive
  Now Playing dock, a free folder picker for quick launch, and New Terminal / New Project actions.
- Recent project cards show terminal counts and recorded last-use times, with View All opening
  Find/Jump; New Group shows its Mac shortcut, and the footer adds Search and Help shortcuts.
- Home usage cards show reset times and support manual refresh; activity adds weekday labels and
  a percentage change against the previous week, and time analytics can be refreshed manually.
- Home shows the five latest notifications with agent-colored icons, a count, Clear, and a positive
  empty state. Help on Home opens the existing onboarding guide with ⌘?.
- Full-window startup console with a themed wordmark card, blinking cursor and staggered progress cells;
  decorative motion stops when Reduce Motion is enabled.
- Home content styled after the web dashboard: centered greeting and date chip, terminal-style quick
  launch, compact two-column recent projects, and uppercase section headings with count pills. Native
  window chrome and SF Symbols remain, and all dashboard values still come from real data.
- Shared themed controls in `AletheDesign` (button, icon button, select, card, row highlight, section label,
  count pill, status dot, project monogram) mirroring the web app's primitives.
- Kimi, Grok and Codewhale agent color tokens in all built-in and theme-pack themes, matching the web palette.
- Native macOS app skeleton (Swift, macOS 26+), bundle id `com.kc1t.alethe.mac`.
- Main window with a sidebar and toolbar, a Settings window (⌘,) and UI zoom in the View menu
  (⌘+ / ⌘− / ⌘0); the zoom level and sidebar visibility are restored on relaunch.
- Sidebar with nested groups, projects and their terminals: add project folders (⌘O, the + button
  or by dropping folders from Finder), create groups (⇧⌘N), drag projects between groups or onto a
  group, move them with the context menu, show them in Finder, and undo any change with ⌘Z.
- New Project (⌘N) and New Group (⇧⌘N) sheets, plus Edit Project… / Edit Group… in the sidebar
  context menu: name, color, folder and group (or parent group); missing or already-added folders
  are reported before saving, and every edit can be undone with ⌘Z.
- Agent launching for Claude Code, Codex, OpenCode, Cursor and the shell: each CLI is found even
  when Alethe is opened from Finder (PATH, Homebrew, npm, pnpm, bun, Volta, fnm, nvm, asdf, mise),
  can be pointed at a custom path, and starts in unrestricted mode when requested.
- Terminals: open Claude Code, Codex, OpenCode, Cursor or a shell in a project (New Terminal in
  the project's menu), rendered with the app theme and following the UI zoom. Terminals keep running
  while you switch projects; an ended process can be restarted, a missing CLI can be pointed at with
  Choose CLI…, and terminals are closed from the sidebar (undoable).
- Workspace panes: open projects sit side by side, each with its terminals in the Auto layout (one
  fills the area, two side by side, more in rows of two). Drag the gaps to resize projects and splits
  live, drag a pane's header onto another to swap them, and close panes or projects from their
  headers (undoable). Sizes are remembered.
- New Terminal sheet (⌘T, or New Terminal… on a project): pick the agent, project and folder, start
  unrestricted, and give it a first prompt that is typed in once the agent is ready. The last agent
  used is preselected.
- Claude Code and Codex terminals resume their own conversation when Alethe is reopened. A new
  Codex conversation is linked to its terminal as soon as Codex saves it, two terminals never take
  the same conversation, and one that can no longer be resumed opens a fresh session instead.
- Settings › Appearance: choose among the 16 built-in themes (applied at once, terminals included),
  set the interface size, and switch the language between English and Português (Brasil) or follow
  the system; a language change offers to restart Alethe.
- File › Import from Alethe (Tauri)…: bring groups, projects and their terminals (and, optionally,
  theme, interface size, enabled agents, CLI paths and language) over from the Windows/Tauri app's data.
  A summary shows what will be added and what is left out before importing, the import can be undone
  with ⌘Z, and the Tauri app's files are only read.
- Sub-tabs: a terminal can hold several agents or shells. A lane on the pane's left edge switches
  between them, adds one with + (or New Sub-tab… in the pane's or the sidebar's menu) and closes them,
  undoable with ⌘Z. The lane appears by itself when a terminal has more than one sub-tab and can be
  shown or hidden from the same menus.
- Press ⌃C twice in quick succession to force-quit a stuck terminal: the program and everything it
  started are killed, and the terminal offers to restart. A single ⌃C still reaches the program.
- Shell terminals (zsh, and bash from Homebrew) mark each prompt, so Terminal › Previous Prompt (⌘↑)
  and Next Prompt (⌘↓) jump between commands and the prompt redraws cleanly after a resize. Your
  shell's startup files are used as before and are never modified.
- Find in the terminal (⌘F): matches are highlighted as you type, the bar shows which match you
  are on out of how many, ↩ / ⇧↩ or ⌘G / ⇧⌘G move between them, ⌘E searches the selected text and
  Esc closes the bar.
- Paste a screenshot or a copied image into a terminal with ⌘V: it is saved as a PNG and its path is
  typed in, ready for an agent to open. Files and images dragged onto a terminal paste as their paths.
- Prompt history per terminal: ⌥⌘↑ / ⌥⌘↓ (Terminal › Older / Newer Prompt from History) bring back
  what you sent before, and each terminal remembers its last 50 prompts across relaunches.
- Terminal output survives quitting: when Alethe reopens, each shell terminal shows what it had on
  screen above the new session (agent terminals start clean; the agent redraws its own conversation). Terminal › Clear Scrollback (⌥⌘K) erases it; restarting a terminal starts it
  clean, and closing it deletes what was saved.
- Markdown panes: File › Add Content… (⇧⌘A) › README or Markdown shows a Markdown file beside your
  terminals, with tables, task lists and code blocks, and reloads it whenever an agent or editor
  changes it. Edit it in place and save with ⌘S, copy its source or show it in Finder.
- Image and video panes: Add Content › Image or Video shows a picture (fitted or at actual size,
  refreshed when the file changes) or plays a video with the system player, beside your terminals.
- Diff panes: Add Content › Git Changes shows a project's uncommitted changes with line numbers,
  unified or side by side, for the working tree or what is staged.
- Web panes: Add Content › Website shows a live page beside your terminals — the app an agent is
  building on localhost, docs, anything over http(s) — with back, forward, reload and an address bar.
  Pages are private (nothing is kept after closing) and, while hidden, are released to save memory
  unless you choose to keep them loaded.
- ⌘-click a link in a terminal: Markdown, images and videos open as panes beside it, other files in
  their app, folders in Finder, web addresses in your browser — or in a web pane with ⌥⌘-click.
  Relative paths follow the shell's current folder, and `file.swift:42` style locations work.
- ⇧⌘-click a terminal link for all its actions — open in a pane or the browser, show in Finder, copy
  — or Preview it: Markdown, images, videos, pages and text files open in a quick sheet that Esc
  closes, without adding a pane.
- When a terminal prints a local server address (a dev server saying `Local: http://localhost:5173`),
  a bar above it offers to open the page in a pane beside it or in your browser, once per address.
- Project containers can be collapsed to a narrow strip, shown alone (⌥⌘↩ or the header button) and
  reordered by dragging their header; a single pane can be shown alone from its menu or with ⇧⌘↩.
- Workspace tabs: clicking a project in the sidebar opens it in its own tab (⌥-click adds it to the
  current one instead). Tabs sit above your panes; switch with a click or ⌃Tab / ⌃⇧Tab, drag to
  reorder, pin the ones you keep, and close them — History › Reopen Closed Tab (⇧⌘T) brings the last
  one back. Back (⌘[) and Forward (⌘]) retrace the views you visited, and everything is restored on
  relaunch.
- Project layouts: the layout button in a project's header (or View › Project Layout) switches
  between Auto, Spotlight (the first terminal large, the others stacked beside it) and Sidebar (the
  others in a narrow list, the first terminal large). Each project keeps its own layout, and the
  splits stay resizable.
- Custom grids: choose Custom Grid in a project's layout menu, or Design Grid… to draw one — set the
  columns and rows, start from a preset (balanced, columns, rows, focus left or top) or a recent
  grid, and grow, shrink or drag each terminal's box into place. In the workspace, drag a terminal
  onto an empty slot or another terminal to move it, resize any row or column, and use Fill Free
  Space from a terminal's menu to let it take the room next to it.
- Named grids: a project can keep several sets of terminals, each with its own layout — for
  example “Review” beside the main one. Create one with New Grid… (layout menu or the project's
  menu), switch from the grid menu in the project's header, move a terminal with Move to Grid, and
  rename or delete a grid (keeping or closing its terminals). New terminals join the grid on screen.
- Flat workspace (View › Flat Workspace): the terminals of every open project share one area,
  without project headers. Each workspace tab remembers whether it is flat.
- Focus mode: double-click a terminal's title bar (or View › Focus on Pane, ⇧⌘F) to float it over a
  blurred workspace; Esc or a click outside brings everything back.
- When nothing is open, the workspace offers quick actions with their shortcuts — open the
  selected project, new terminal, new project, add content, reopen a closed tab. Before your first
  project, pick an agent and open a folder: Alethe makes it a project and starts the agent there.
- Disable a terminal (its menu, or the sidebar) to stop it without losing it: nothing runs until you
  enable it, and its output comes back. Disable a whole project the same way, or suspend a group
  to stop every project in it and free their memory; Resume Group brings them back. All of it can
  be undone with ⌘Z.
- Memory: a toolbar indicator shows what your terminals use, turning amber or red as the Mac runs
  short; click it for each terminal's share. Terminals that are not on screen run at background
  priority. In Settings › Resources you can let Alethe hibernate idle hidden terminals — always
  after an idle limit, or only when memory is critical. A hibernated terminal keeps its output and
  picks up its session again as soon as you show it.
- Find or Jump (⌘K): type a few letters of a terminal, project or command and press Return — results
  are ranked by how well they match, so “cli” finds client-site. Commands like New Terminal, Flat
  Workspace or a project layout run from the same field.
- Alethe asks before quitting while terminals are running (with a “Don't ask again” option, also in
  Settings › General). Settings › General › Open with an empty workspace starts with nothing open,
  your workspace tabs ready to pick.
- Terminal › Resume Previous Conversations restarts your running agents on the conversation they
  had before the current one.
- Settings › Appearance › Style and motion: choose the Clean style — flat, compact surfaces with
  quiet borders and a denser sidebar — or keep Normal; turn on Reduce motion to stop panes and
  overlays from animating (it also follows the macOS setting).
- New agents: GitHub Copilot, Antigravity, Mimo, Freebuff and Kiro CLI join Claude Code, Codex,
  Cursor, OpenCode and the shell in New Terminal, each with its unrestricted mode where the CLI has one.
- Settings › Agents: turn agents you don't use off (they leave New Terminal), see which CLI each
  agent runs and its version, and point one at another CLI or back to automatic lookup.
- Install, update and uninstall agent CLIs from Settings › Agents: Alethe offers the ways that work
  on your Mac (the vendor's install script, Homebrew or npm), shows the exact command and its output,
  and checks the result. A newer release is flagged next to the installed version.
- File › New Terminal Like Last (⌥⌘T) opens another terminal just like the last one you created,
  without the sheet. New Terminal also lets you pick which of the project's grids it joins.
- New Terminal has a Model field: pick one of the models the agent reports (Cursor, OpenCode,
  Antigravity) or Claude Code's aliases, or type any model id; leave it empty for the agent's default.
- OpenCode, Antigravity and Cursor terminals now pick up their conversation again after Alethe
  restarts, like Claude Code and Codex. Resume Previous Conversations also covers Antigravity.
- History › Conversations… (⌘Y) lists your past Claude Code and Codex conversations for the project
  or for all projects, with titles, dates and sizes. Open one to pick it up in a new terminal — or to
  jump to the tab where it is already open.
- Terminal › Session Cost… shows what an agent session used — tokens per model and the cost where it
  is known (Claude Code, and OpenCode's own figure; Codex shows tokens). Conversations shows the same
  for the conversation you select.
- Alethe now knows what each agent is doing — working, waiting for you, or done — from Claude Code's
  and Codex's own events (without touching your settings) and, for other agents, from their output.
  A Claude conversation that you `/clear` or `/resume` stays bound to its terminal.
- Agent terminals are named after their conversation in the sidebar, the lane and the title bar, and
  show what they are doing: a pulsing dot while working, a question bubble when they wait for you, and
  a dot when they finished while you were looking elsewhere.
- Notifications: when an agent finishes or needs your answer in a terminal you are not looking at,
  it shows up under the bell in the toolbar — and as a macOS notification when Alethe is in the
  background. Click one to jump to that terminal. Turn it off in Settings › General.
- Continue in the Other Agent… (Terminal menu or a terminal's menu) hands a Claude Code conversation
  to Codex, or the other way round: review and edit the context capsule — secrets are redacted — and a
  new terminal of the other agent picks the work up from it.
- AI Usage (toolbar gauge) shows Claude Code, Codex and Antigravity limits — each window, how full it
  is and when it resets — with the Codex plan and reset credits. Turn on a provider's toolbar pill to
  keep an eye on it, and get notified when a limit resets.
- Alethe keeps activity statistics — time with it open and in use, and time agents spent working, in
  parallel or in the background, per agent and project — on this Mac for Home. Settings › General clears
  them.
- Home (⇧⌘H or the house button in the toolbar): a greeting, a quick launch that starts an agent with a
  prompt in any project, recent projects, AI usage, a 13-week activity graph with your streak, where your
  time went (active, agents working, in the background) and notifications. Settings › General can open
  Alethe on Home.
- Home shows setup steps until they are done — install an agent, create a project, open a terminal, pick
  a look — each one a click away. Hide them, and bring them back from Help › Show Setup Steps.
- Dictation: press ⌥⌘E and speak — the words go into the focused terminal or field; press again to stop,
  or hold the keys and release. Transcription runs on this Mac (Apple's speech model, downloaded the first
  time) in the interface language; Esc cancels.
- Fixed: the agent choices on the empty workspace no longer squeeze into one row.
- Fixed: a terminal restored after relaunch could start with a stray `^[[O` (and odd arrow keys) because
  the previous program's focus-reporting and key modes carried over to the new one.
- Fixed: a restored agent terminal could open with lines of garbage such as `^[[?62;22;52c` and
  `ghostty 1.3.2`: replaying the saved output re-ran the previous program's terminal queries, and the new
  process echoed the answers.
- Fixed: a restored terminal no longer draws the new session over the old screen (Claude Code's header
  and prompt came out garbled); the old output moves into the history and the new session starts clean.
- Plugin foundation: built-in plugins can add sidebar tabs, commands, themes, pane kinds, sheets,
  settings pages and agent providers, use only the host features they declare, and are turned on or off
  with the choice kept after relaunch; a plugin that fails to start does not affect the others.
- Git layer: runs your own `git` for status, diffs, branches, commits, history and sync (pull, push and
  fetch with progress), and refreshes when the repository changes.
- Theme Pack plugin: the Dark Lemon, Orca, Ember and Golden Premium themes.
- Groundwork for Git review (not in the interface yet): commit graph lane layout, a merge analyzer that
  trial-merges two branches in a throwaway worktree and classifies each conflict, your open pull requests
  through `gh`, and a squash merge guarded by the reviewed head commit.
- Groundwork for the Todos plugin (not in the interface yet): global and per-project lists with tags, PR
  links, reordering, the editable JSONC template file, and a Pomodoro session that survives relaunch.
- Settings › Plugins lists the built-in plugins with version and capabilities, turns each on or off and
  shows a load error; the Theme Pack themes appear in the theme picker.
- Groundwork for the file explorer and agent worktrees (not in the interface yet): a lazy file tree with
  icons, git badges, rename/new/Trash and live refresh; each agent in its own git worktree or local copy
  with lock/unlock, auto-commit of pending work and cleanup; the Merge Center's prepare step (a separate
  merge copy, conflicts listed with a strategy each, and a ready prompt for an agent to resolve them).
- Groundwork for the Merge Center's last steps (not in the interface yet): per-project build/test checks
  and a health probe in the merge copy, then finalize, abort or force-clean it, committing pending worktree
  work first.
- Right sidebar (⌥⌘0): a Todo list (global and per project, `#tags`, drag to reorder, Pomodoro timer) and
  a Docs tab listing the project's Markdown files. View › New Todo opens it.
- Git Control (project context menu or History menu): stage, discard, commit with amend, switch branches,
  fetch/pull/push with progress, open a file's diff, and see incoming/outgoing commits.
- Git Control › History: a commit graph with branch and tag badges, commit detail, and copy SHA,
  cherry-pick, revert, branch from commit, and reset soft/mixed/hard (hard asks first).
- Pull Requests tab in the right sidebar: your open GitHub pull requests with check and review status;
  open in the browser, copy the URL, or send one to your Todos.
- Files tab in the right sidebar: browse the project folder with git badges and live refresh; open,
  rename, create, move to Trash, reveal in Finder, and Quick Look (Space).
- Pull requests: review one with an agent and model of your choice, then squash merge it only while its
  head is still the commit that was reviewed.
- Agent terminals can run in their own git worktree or local copy (New Terminal sheet); the sidebar marks
  them, and the tab menu commits their changes or removes the worktree.
- Merge Center (project menu or History menu): analyze a branch merge, prepare a merge copy, resolve
  conflicts with an agent, run your checks, then finish or abort.
- Git Control is a built-in plugin you can turn off in Settings › Plugins; its branch switcher creates a
  branch from the current commit.
- Projects can start new agents in their own worktree by default (git worktree or local copy); the
  Worktrees… sheet lists them with lock/unlock, fetch branch, commit, remove and stale cleanup.
- Todos: edit tags, move a todo between the global and project lists, and Todo Settings (template file
  open/import/export, Pomodoro lengths, reset to the default list).
- Pomodoro: pick a focus todo, get a notification when each phase ends, and follow the running phase in a
  toolbar pill; the session carries on after relaunch.
- Fixed: Files badges refresh on commits and stages when the project folder is inside a larger repository.
- Pull requests: reviewed commits and the review agent/model are remembered across relaunches.
- Sidebar: in-progress merges appear under their project with stage and conflicts (by folder or class);
  clicking one reopens the Merge Center where you left off.
- Merge Center: Resolve with Agent lets you pick any installed agent; Validate shows each command, the
  health probe and an API contract check.
- Test Branch…: run a branch's checks, health probe and contract check in a temporary checkout, with results
  kept per branch.
- Fixed: the health probe stops every process its start command launched, not just the shell.
- Third-party ExtensionKit extensions: listed in Settings › Plugins, ask for permission on first enable,
  add their own right-sidebar tab, and are isolated if they crash (a sample extension is included).
- `alethe` command line tool (Settings › General › Command Line Tool): `alethe .` opens that folder in
  Alethe, showing its project or offering to add it.
- Settings › Features: turn optional modules on or off (Browser, MCP & Skills, Playwright Browser, Agent
  Orchestration, Open Pull Requests; Graphify, GSD Sync and AI Memory under Show More), imported from
  the previous Alethe.
- Settings › Appearance › App Icon: four Dock icons (Elite Original, Pure Black, Indigo, Blush),
  imported from the previous Alethe.
- Help › Diagnostics… (recent warnings and errors, JSON export), Export Logs… and Open Logs Folder, with
  secrets removed; after an unexpected quit Alethe offers the crash report to view or save, never
  sending it.
- Settings › Profiles: see each profile's projects, terminals and size; create, rename, duplicate,
  delete (to the Trash) and switch profiles; a profile menu in the toolbar.
- Settings › General › Data: export the profile as a `.zip` and import it back (contents shown first),
  reset the profile or erase all data; a safety backup is saved first and the app relaunches to apply
  it.
- New Project can clone a repository (owner/name, a GitHub or git URL, or a local path) with progress; a
  folder's saved Alethe settings (`.alethe/project.json`) are offered back, Initialize Git is offered
  for non-repositories, and the detected stack is shown.
- Project menu › Export Settings… / Import Settings…: move a project's settings as JSON; import lists
  the changes and can be undone.
- Open in VS Code in the project and terminal menus, Show in Finder for a terminal's folder, and Open in
  Browser for the project's repository page.
- AI Memory: with the feature on, Claude Code, Codex and OpenCode start with the ai-memory MCP server
  without editing your config files; Settings › Features › AI Memory shows the CLI, its version and the
  server state.
- The toolbar is customizable: View › Customize Toolbar… arranges it and Settings › Toolbar shows or
  hides each item (Home, Pomodoro, usage pills, AI Usage, notifications, memory, profile); the previous
  Alethe's top bar choices are imported.
- Skills browser (History › Skills…): the skills of Claude Code, Codex, OpenCode, Antigravity and the
  shared store with filter, details, files and the rendered SKILL.md; removal asks first and never
  touches bundled skills.
- Agent Library (project menu): install Alethe's Claude Code subagents in a project or for all projects,
  with cost badges, and turn economy mode's Haiku agents on or off; your own files are never touched
  without asking.
- Graphify: turn it on per project and Claude Code, Codex and OpenCode get the project's code graph as
  an MCP server (generated on first launch if missing); Settings › Features › Graphify sets and checks
  the command.
- Playwright browser (Settings › Features): agents get the Playwright MCP server, attaching to a browser
  Alethe starts (Shared) or opening their own (Dedicated).
- GSD Sync: a right-sidebar tab lists the project's OpenCode child sessions with state and roadmap
  progress, planning status appears under the project, a read-only activity view follows the child
  session, and Settings › Features › GSD Sync edits the model fallback chain.
- Code graph pane (Add Content or the project menu): pan, zoom, search and inspect a project's Graphify
  graph, open a node's source, compare snapshots with the changes highlighted, roll back, or generate
  the graph when there is none.
- First-run onboarding: your name, style and theme, agents, features and MCP servers, plus import from
  the Tauri app when its data is found; skippable, reopened from Help › Show Onboarding…; a welcome-back
  screen after an update or a long absence.
- MCP manager: an MCP tab in the right sidebar and History › MCP Servers… list every agent's servers
  side by side with health; add from the MCP registry or by hand, enable/disable with undo, edit, copy
  to agents that lack a server, reveal a masked value on request and restore config backups; skills are
  in the same window.
- Orchestration board pane: open it from Add Content › Orchestration or the project menu, or choose Open
  as Orchestration in New Terminal to start a Claude Code or Codex planner with a goal and the board
  beside it; orchestrator panes and job history come over from the Tauri app.
- Settings › Multiagent (with the orchestrator feature on): run a project's `.planning/task.md` roadmap
  as a task queue, see event metrics and recent events by correlation id, and turn on planning
  autocommit with the audit history.
- Orchestrator: steer a running worker, send follow-ups (reviving a released worker on its thread),
  answer a worker's approval requests, read its diff, and run each delegated task in its own git
  worktree.
- Claude Code terminals in Orchestration mode delegate work through Alethe's `alethe_*` tools over a
  private, token-protected local endpoint; every worker stops when the app quits, and workers left
  behind by a crash are ended at the next launch.
- Codex terminals in Orchestration mode delegate through the `alethe_*` tools via the bundled `alethe-
  orchestrator-mcp` helper, which also runs on its own as a stdio MCP server.
- Orchestration board: planner tabs, a summary rail and a zoomable canvas show every run, worker and
  subagent live, with fit, focus, worker details (plan, report, routing, media) and a jump to the
  planner's terminal.
- Orchestrator board header: each agent's spend for the selected planner and a warning chip when Claude
  or Codex reaches 80 % of a usage window or is rate-limited, with its reset; usage is re-read every
  minute while a board is open.
- Orchestration board: act on a selected worker — answer its approval request, steer it or give it its
  next turn, view its diff, cancel (asks while it runs), release (a message starts it again), and show
  its worktree in Finder.
- Orchestration board: Apply to Branch merges a finished worker's worktree into the project's current
  branch after one confirmation that shows its files; conflicts continue in the Merge Center.
- Discord Rich Presence (Settings › Integrations › Discord): Discord shows that you are working in
  Alethe and which view you are on, without project names; it updates every 30 s and clears when turned
  off or when you quit.
- GitHub Sync: back up this profile's workspace, settings and time stats to a private Gist and restore
  them (safety backup first, then relaunch); from the toolbar's Sync item or Settings › General › Data.
- 9router: Settings › Integrations › 9router (enable, source, port, Keychain key, start with Alethe,
  route new agents, status, dashboard, log, advisories), an install/uninstall sheet with the exact
  command and live log, and a toolbar pill to start or stop it.
- Now Playing: a Home card and the sidebar footer show the current Spotify track (the last one stays,
  paused, after a relaunch); Settings › Integrations › Spotify sets the client ID and secret (in the
  Keychain) and connects or disconnects.
- Remote control can be turned on for the session: paired devices see only the terminals you share,
  follow their output and send input when allowed; device messages and automatic shutdowns show in the
  notification list, and it is always off when Alethe starts.
- Remote control: a toolbar pill while it is on opens a pairing sheet with the QR code, the address with
  Copy, a 2-minute countdown with reopen, paired devices with Revoke, and a shortcut to Remote settings.
- New terminals can route Claude Code, Codex and OpenCode through 9router (New Terminal › Route through
  9router when it is enabled, keyed and installed); New Terminal Like Last keeps the choice.
- Settings › Remote: turn remote control on (with a network warning; always off at launch), choose Local
  Network or Tailscale, set read-only, shell input, device limit and session lifetime, and review or
  revoke devices; terminals get a Share with Remote Devices toggle and a shared icon.
- Fixed: exported logs and diagnostics also redact remote-control pairing links.
- Fixed: after a relaunch, an agent terminal (Claude Code, Codex…) no longer shows the previous run's
  screen stacked above the new one; only shell terminals bring their saved output back.
- Fixed: a terminal now starts at its pane's real size, so an agent's first screen no longer leaves
  fragments behind when it redraws, and a starting program no longer echoes `^[[I` / `^[[O` when the
  window gains or loses focus.
- Data is stored per profile in `~/Library/Application Support/com.kc1t.alethe.mac`.
- The DMG opens a branded install window: drag Alethe onto the Applications shortcut to install.

### Changed
- The Alethe interface uses web-sized left-sidebar icon tabs, Search and Projects headers, custom
  group and project disclosures with guide lines, 28 pt terminal rows and multi-tab counts, a
  segmented layout switch, and compact Now Playing and profile footers. Native macOS retains its
  source-list presentation.
- Alethe interface right sidebar now uses the web icon tab strip, compact panel headers, agent and
  pull request cards, underlined Markdown tabs, GSD session rows, and MCP filters and server rows.
  Native macOS interface keeps its existing sidebar controls and layout.
- Right sidebar follows the web tab order, with Mac-only Todos and extensions last; Files is no
  longer shown there. The strip includes Close and an MCP-only action to open its manager.
- Pull request rows show Send to Todo directly and Already added for linked Todos, including in
  the context menu.


- Sidebar rows follow the web app: project monograms, 12.5 pt rows, agent icons tinted by agent,
  faint group tags with a hairline rule, and a `PROJECTS` header with add-folder and new-project
  buttons (the footer button moved there). Working terminals show the dot-matrix spinner and unseen
  finished ones a check mark.
- Workspace tabs match the web title-bar tabs (26 pt, muted until hovered, the active tab pressed into an
  elevated bar, count pill, round close button) and the sub-tabs lane gets the web hover, selected card,
  glowing accent bar and dashed add button.
- Container and pane headers follow the web: 11 pt container tags over a hairline rule, an elevated
  identity chip (agent icon, name, working-folder pill) in pane headers, themed icon buttons, sunken pane
  surfaces and the focus-ring color on the focused pane in Normal style.

### Fixed
- The sidebar profile row highlights flat and edge to edge, so its pressed state no longer shows an inner
  rounded corner that disagrees with the window's corner.
- The app launches on macOS 26 again: orchestrator worker teardown no longer links Swift 6.4's
  task-cancellation shield, whose runtime symbols exist only on macOS 27.
- The app now has its icon in Finder, Launchpad and the DMG, not only in the Dock while running.
- The app icon now follows the macOS icon grid, so it is the same size as other apps in the Dock, Finder and the app switcher.
- Clicking Home in the toolbar no longer crashes the app on macOS 27 right after launch, and its icon no longer disappears while Home is shown; the icon now turns the accent color on Home.
- Expanding a project in the sidebar (or any other animated view) no longer crashes the app on macOS 27 when the system asks to draw an icon at zero size.
