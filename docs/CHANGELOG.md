# Changelog

Notable user-facing changes to **Alethe** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/). Dates use UTC.

> **Rule:** every feature addition, change, or removal must be recorded under
> `[Unreleased]` in the same task. During a release, `[Unreleased]` becomes the new
> dated version and a new empty `[Unreleased]` section is added at the top.

## [Unreleased]

### Added

- Agent CLIs installed via nvm, bun, `npm --prefix`, pnpm or volta are now detected on Linux
  even when Alethe is launched from the desktop menu — which inherits a minimal PATH — matching
  the existing `~/.local/bin` and `~/.cargo/bin` fallbacks. Onboarding and agent tabs now see
  these installs instead of reporting them as missing.
- When an agent opens a page in the shared browser, Alethe asks where it should go. The browser
  itself has no window, which is right most of the time — an agent reading a page needs no
  interface at all — so the question only comes up when a page actually appears. All three
  answers are spelled out: show it in a pane, open it in your own browser, or leave it running
  out of sight. Nothing takes over the layout on its own. A pane attaches to the agent's own
  tab rather than opening a copy, so its work can be watched and taken over by hand; your own
  browser gets a copy instead, since no page in it can be driven from here.

- Tabs in a browser pane can be closed from the tab strip. An agent that navigates a lot leaves
  tabs behind and nothing reaped them, so they piled up for as long as the browser lived.
- Browser panes can now render inside the pane itself instead of in a native child webview.
  Toggle it from the pane toolbar. The page is painted from CDP screencast frames onto a canvas,
  which is ordinary DOM, so clipping, z-order and dragging behave like any other pane, and it
  streams only while the pane is actually visible. Mouse, wheel and keyboard are forwarded back
  to the page. The browser runs without a window of its own, so the pane is the only view, and a
  tab strip appears when more than one page is open — including tabs an agent opened, so its
  work can be watched live and taken over by hand.

- A commit graph, cherry-pick, revert, reset-to-commit, and branch-from-commit now live in the
  Git panel, alongside an incoming/outgoing changes view against the remote.
- Agent worktrees can now be integrated through a full merge cycle: analyze for conflicts,
  auto-commit pending work before integrating, spawn an ephemeral conflict-resolution agent when
  needed, validate with the project's configured commands, and finalize with an optional health
  check that boots the app in an isolated environment. The Merge Center in the sidebar tracks
  every worktree pending review, with reject/validate/test/review actions per agent.
- An end-to-end test harness (WebdriverIO) covering onboarding, the git pipeline, the commit
  graph, and conflict/merge UI flows.
- Projects can now be given an animated rainbow color, both as the sidebar swatch and as the
  project container's border.
- The embedded terminal font now bundles "Caskaydia Cove Nerd Font Mono" so Powerline/Nerd Font
  glyphs (icons and separators used by TUIs like OpenCode's `opentui`) render correctly on every
  OS instead of falling back to a mismatched system font.
- A new "GSD Sync" tab in the right sidebar shows a read-only activity feed for each project's GSD
  Sync child sessions — no PTY terminal involved, reads straight from `opencode export`.

### Removed

- Removed the previous app-icon themes; the icon picker now offers only the four Elite
  marks. Preferences still pointing at a removed icon are migrated to Elite Original on
  load. The UI themes they shared a name with are untouched.

### Changed

- Alethe Remote now mirrors the selected desktop theme, app icon, motion preference, and language
  while it is open. Its splash, workspace, terminal view, connection feedback, empty states, and
  recovery screens now use the same Alethe design tokens and official branding.
- Notifications that ask something now read as one line rather than a block. The choices sit
  inline as chips after the message, separated by a hairline, with a single filled chip for the
  answer most people want and a plain one for declining. Stacking buttons underneath had broken
  the single shape the notification has.
- Standardized modal dropdowns on the Todo List picker pattern, including consistent portal-based
  menus, searchable model selection, keyboard handling, long-list scrolling, and reliable clicks
  inside modal focus traps.
- Elite Indigo is now the default UI theme and the default app icon for new installations. The
  application icon, the installer icon and the installer artwork all use the same Indigo mark.
- Replaced the home and loading backdrop artwork with the same monochrome portrait, so the
  backdrop and the installer icon come from one mark.
- Updated the Windows NSIS installer sidebar artwork from the Elite Dev source design, so the
  Indigo portrait is framed as a face at 164x314 instead of being cropped to the edge of the
  panel.
- Added an Animated/Reduced motion preference and lowered the home ASCII background's CPU cost by
  caching image processing and pausing it while hidden, while preserving the creator's original 8px
  ASCII design and 30 FPS animated cadence.
- Hardened the production renderer with a defense-in-depth Content Security Policy and replaced its
  broad core/plugin defaults with the audited permissions used by the main webview. Privileged custom
  commands still depend on their own authorization and input-validation boundaries.

### Fixed

- The Source Control panel in the right sidebar no longer stays empty for a selected project that
  has no open terminal — it now falls back to the project's default working directory.
- Closing the app now actually stops the agents it started. Shutdown handed the work to a
  detached thread that killed sessions one after another, each waiting on `taskkill`, and the
  process exited before it got through them — so terminals were left running with nothing to
  attach them to. Reopening then failed to resume those sessions, because the abandoned process
  was still holding them. The kills now run in parallel and shutdown waits for them, up to four
  seconds.
- Terminals stop refusing keystrokes while a session is being killed. Killing one runs `taskkill`
  and waits for it — under load that takes seconds — and it did so holding a lock that the
  process snapshot needs, which in turn holds the lock every keystroke goes through. One slow
  kill therefore stopped every terminal in the app from accepting input, while output, which
  never takes that lock, kept arriving: panes that could be read but not typed into. The pid is
  now read and the lock released before the kill, and the snapshot never waits on a session it
  only wants to report on.
- On Linux a browser left behind by a previous run was never cleared, so it kept the profile
  locked and the next session could not start. The check recognised only the Windows spellings;
  google-chrome, chromium-browser and microsoft-edge all went unmatched.
- The offer to show an agent's page now appears in the case that actually happens. It was raised
  only when a tab was created, but an agent attaching over the debugging protocol navigates the
  blank tab already open rather than making a new one, so the page arrived as a change to an
  existing tab and went unannounced. Each tab is still offered only once, however far it
  navigates afterwards.
- A terminal printing fast no longer stalls the whole window. A PTY hands over up to 64 KB every
  16 ms while a frame draws 16 KB, so a noisy command outran the terminal four to one and the
  queue grew without limit: the pane kept drawing output from minutes earlier and asked for a
  frame every 16 ms indefinitely, which starved every other pane, since they all draw on the
  same thread. The backlog is now capped and the oldest output is dropped, so a terminal under
  a flood shows what is happening now instead of replaying what already scrolled past.
- Reloading a browser pane now actually refetches the page. It discarded the tab and opened a new
  one, which landed on the same cached copy, so an edited page kept showing its old version. The
  tab is kept and reloaded without its cache instead.
- Reloading a browser pane now bypasses the cache and keeps the tab it is showing. It used to
  discard the tab and open a new one, which landed on the same cached copy, so a page being
  edited kept coming back unchanged no matter how many times it was reloaded.
- The topbar customization pencil no longer reserves empty space while hidden and expands only
  when the status area is hovered or the control receives keyboard focus.
- Parking a terminal to free memory now says so. It kills the process tree, so the pane simply
  fell silent and was indistinguishable from a frozen one, and the restart that brings the
  session back was not something a reader had any reason to try.
- Confirmation dialogs work again. The permission for them was missing, so every confirm — including
  the one guarding app close — was rejected before it could be shown, and the action behind it was
  silently abandoned.
- Two Alethe instances no longer redirect each other's agent events. The hook endpoint was written
  to a single shared file, so whichever started last captured the events of both.
- Terminals are no longer killed behind your back under memory pressure. At critical pressure
  the app terminated one hidden, idle session every five seconds and never brought any of them
  back, so a burst of memory use from anything on the machine left a row of dead terminals that
  each had to be started again by hand. It did this even on the default policy, which promises
  that a session is only ever terminated after you opt in. Manual mode is now honoured at every
  pressure level and warns instead.
- A browser pane showing a tab that was not in the foreground stayed blank forever. Chromium
  reports a background tab as hidden and stops rendering it, so its screencast produced no
  frames at all; the tab is now brought to the front before streaming starts. This is what made
  a pane opened next to other tabs, or one watching a tab an agent had opened, never paint.
- The embedded browser pane no longer hangs on "Connecting to the browser". It depended on the
  translation function, which is rebuilt on every render, so each repaint tore the session down
  and opened a new one and no first frame ever survived.
- Starting an agent no longer opens a browser. Every Claude terminal used to launch one just to
  fill in the Playwright endpoint, and because the check and the launch were not serialised,
  terminals starting together each launched their own; restoring a workspace could therefore
  open several browsers at once and exhaust memory. The shared browser is now started only when
  something actually needs it, agents attach to it when it is already running, and Playwright
  falls back to its own default otherwise.
- The automation browser is now shut down with the app and any copy left by a previous run is
  cleared on startup. Chromium deliberately detaches from the job object that ties every other
  child process to Alethe, so it used to survive a crash and keep holding its profile.
- Memory relief actually runs now. The resource manager raised one event per pressure level and
  nothing on the frontend listened to any of them, so every level was a no-op — and the most
  severe one was emitted as `resource::drop-caches`, a name no listener could match. Cached
  polling results are dropped from medium pressure upward, and at critical pressure the app now
  says how little memory is left and how much the terminals are holding, instead of freezing
  without warning.
- The embedded browser no longer escapes its pane. Its native surface is composited above the
  page, so an ancestor's `overflow: hidden` never clipped it and the raw bounding box let it
  overhang the layout; the surface is now measured against every clipping ancestor and the
  viewport. A browser living in an inactive workspace tab stayed on screen over the active one,
  because a hidden tab keeps its layout box. Re-showing a hidden surface could reveal it at its
  previous position, and a move that failed was remembered as applied and never retried.
- Dropdowns, confirmations, an in-flight pane drag and a display scale change now hide or
  resync the native surfaces, which previously only reacted to dialogs and menus.
- Switching the app icon had no effect in packaged builds. The icon bytes were loaded with
  fetch, which answers to the Content Security Policy's connect-src, and the bundler inlines
  the smaller icons as data URLs — a scheme connect-src does not allow. The picker still
  rendered every option because images are governed by img-src instead, so the selection
  moved while the window icon never changed. Inlined icons are now decoded directly.
- The embedded browser pane no longer escapes its cell on scaled displays. Its webview was
  positioned with CSS-pixel coordinates while the window places child webviews in physical
  pixels, so the two only lined up at a device pixel ratio of 1 — on a HiDPI screen the
  browser was drawn oversized and offset, covering the rest of the layout.
- Changing the terminal palette now repaints the rows already on screen. Only the option was
  being swapped, so existing output kept the previous colours until the next redraw.
- Terminal text no longer disappears on light themes. xterm's built-in ANSI palette assumes a
  dark background, so anything an agent painted as white or bright white rendered white on a
  light surface. Light themes now carry an ANSI palette that keeps every hue — so agent
  branding survives — and re-points only the neutrals that would otherwise vanish.
- Light-theme detection is now derived from each theme's own background luminance instead of
  a hardcoded pair of theme names. The OpenCode icon and the Markdown pane were picking their
  dark-theme variants on any light theme outside that pair, rendering a pale icon and dark
  syntax highlighting on a light surface.
- The terminal no longer falls back to the dark palette when the selected theme has no
  terminal colours of its own. Orca had been silently rendering a dark terminal since it was
  added, and every light theme showed the same mismatch. The resolver is now an exhaustive
  map, so a theme without terminal colours fails the build instead of shipping wrong.
- Windows updates no longer close the app without coming back. The update manifest pointed Windows
  at the MSI, but the installer nearly everyone actually has is the NSIS `setup.exe` the download
  page serves. An MSI applied over an NSIS install neither upgrades it nor restarts the app, so the
  updater downloaded, closed Alethe, and left the old version behind. The generic Windows entry now
  points at the NSIS installer; the `-msi` and `-nsis` entries are still published for anyone
  pinning one deliberately. Existing installs that ended up with both an MSI and an NSIS entry
  registered will settle onto NSIS after this update.
- The **Continue in Claude Code** button in the agent handoff dialog was unreadable. It painted its
  label with a colour token that does not exist anywhere in the app, so the text fell back to the
  inherited foreground and sat light-on-accent.
- On Linux, orphaned agent and shell processes could outlive the app because the kill-on-close
  guard was a no-op. The Windows implementation uses a Job Object that kills descendants when the
  app exits; on Linux the guard now reports as active and relies on the shutdown handler (which
  sends `SIGTERM` to every process group) combined with orphan sweep at next startup.

## [1.6.0] — 2026-08-17

### Added

- Added Normal and Clean application-wide visual styles. Normal preserves the production UI with
  colored borders and rounded surfaces, while Clean uses the new compact project tree, flat right
  sidebar, square terminal containers, restrained hover states, and single-row profile footer.
- Added shared Clean visual tokens for row and control heights, spacing, radii, borders, hover
  surfaces, and transition behavior so the minimal language can be extended consistently.
- The onboarding now asks which interface style to use (Normal or Clean) with a live preview of each
  one, right after the theme step.
- Claude Code and Codex conversations can now be continued in the other agent from the terminal
  toolbar or Recent chats — so hitting a usage limit on one agent no longer ends the conversation,
  you carry it into the other and keep working. Alethe builds an editable context packet, redacts
  anything that looks like a secret, token, password, API key or credential before it leaves the
  machine, opens the target agent in a new pane, keeps the source conversation available, and
  removes the temporary packet after the first target turn or when its pane is closed.
- The right sidebar now keeps a cumulative, per-profile history of up to 12 recently opened
  Markdown files as switchable tabs, persisted across app launches. Markdown files can be sent
  there from the Explorer or dropped from the desktop, history tabs can be closed individually,
  and they remain available while visiting the Todos, Git, or MCP sidebar modes.
- GitHub Copilot CLI is now available as an agent throughout onboarding, installation, quick launch,
  terminal creation, sub-tabs, CLI path overrides and unrestricted mode.
- New **Golden Premium** theme, with its own terminal palette.
- New **MCP** tab in the right sidebar: a single place to see every MCP server configured on the
  machine, grouped by server name and showing which agents have it. It reads Claude Code
  (`~/.claude.json`, `.mcp.json`), Codex (`~/.codex/config.toml`), OpenCode (`opencode.json`) and
  Antigravity (`~/.gemini/config/mcp_config.json`), with a Global/Project switch — so a server
  present in Claude but missing in Codex is visible at a glance. At project scope it also reads the
  servers `claude mcp add` writes by default, which Claude keeps inside `~/.claude.json` under the
  project's entry rather than in the repo, and labels each row with the file it came from. Environment values are masked and
  only leave the backend one key at a time, on an explicit click. A config that cannot be parsed is
  reported as read-only and is never written to. Servers can be added, removed and enabled/disabled;
  every write is preceded by a backup, validated by re-parsing the result and checking that no other
  server changed, and committed atomically. A server can be **copied from one agent to another** in
  one click, and adding a new one takes a form, a pasted JSON block in any of the shapes the agents'
  own docs use, or a search of the official MCP registry — which turns a published package into a
  ready-to-run command and pre-fills the variables it expects, marking the secret ones empty. The
  last successful search of each term is kept on disk so the list still opens when the registry is
  unreachable, labelled with the date it was captured. Alethe translates a server to each target's
  format and refuses, rather than silently dropping, a field the target cannot express. A per-agent
  **Check** button asks the agent itself whether it can actually reach each server — the one thing no
  config file can answer. The first time the app opens with the feature on, a card shows what was
  found and offers to align the agents in one click; it can be reopened at any time from
  Preferences → Features, where the whole feature can also be turned off.
- The MCP tab splits into **Servers** and **Skills**, each with its own search and an **Add more**
  button that opens the manager straight on the registry search. Every row shows the icon of each
  agent that has the entry, greyed out for the ones missing it, and a row of agent buttons filters
  the list down to a single agent. A server or a skill can be removed from every agent at once
  instead of one row at a time, and the add flow asks which agents get it before writing anything.
  The registry search filters by whether a server runs locally or remotely.
- A **Skills** tab in the same manager lists every skill installed for each agent, reading
  `~/.claude/skills`, `~/.codex/skills` and the shared `~/.agents/skills` store. It resolves links
  (including Windows junctions) so a skill shared between agents is shown once with its real
  location, renders the SKILL.md frontmatter, folder structure and body, and surfaces where the
  skill was installed from. Skills that ship with the agent are locked and cannot be deleted;
  removing a linked skill unlinks it from that agent only and keeps the shared copy the other
  agents point at.
- Grid layouts are now edited directly on the grid. Every pane and every project container carries
  resize edges: dragging against a neighbour resizes the tracks as before, but dragging towards an
  empty cell stretches the pane over it, cell by cell. Double-clicking an edge — or the expand button
  that appears on a pane with empty space next to it — makes that pane swallow all the free space
  around it, so a lone pane on the bottom row can finally take the whole row without opening a
  dialog. Empty cells also became drop targets: dragging a pane or a container onto one moves it
  there instead of swapping with a neighbour.
- The project container header has a **+** button that creates a new terminal in that project.
- Agents that are not installed can now be installed from inside Alethe. The onboarding agent step
  and the "not found" overlay of a terminal both offer an **Install** button that runs the official
  installer in a real shell and streams its output, then confirms the CLI is reachable before
  reporting success. Alethe probes the machine for Node, npm, WinGet, Scoop and Chocolatey and only
  offers the methods that work there, preferring each vendor's official installer — which needs no
  Node — and listing the alternatives under **Other ways**.
- A **Recent chats** button on the terminal toolbar, next to Open in VS Code, lists the Claude and
  Codex conversations of that pane's working directory and resumes any of them, either in a new pane
  on the current grid or in the pane it was opened from. The panel opens on the tab matching the
  pane's agent, and unrestricted mode is a checkbox applied to the resumed session.
- **Ctrl+B** toggles the left sidebar open and closed. The topbar button now shows the shortcut in
  its tooltip.
- When an agent can only be installed through npm and Node.js is missing, its install dialog now says
  so instead of dead-ending on "no automatic installer". It offers a one-click Node.js install
  through WinGet, Scoop or Chocolatey when one of them is available, and a **Download Node.js**
  button otherwise. Once Node lands, the agent's own installer appears without reopening the card.
- Freebuff and Mimo can now be installed from inside Alethe like the other agents, with their
  documentation links — until now they were the only agents with no installer at all.
- Installed agents can be **uninstalled** from the onboarding agent step. Confirmation happens in a
  dialog that shows the exact command about to run, and the agent is only reported as removed once
  its CLI can no longer be found. Only one agent can be installed, updated or uninstalled at a time —
  package managers share a single global directory and corrupt each other when run in parallel.
  Agents whose only installer is a vendor script offer no uninstall, since none of them documents
  one and guessing what to delete
  would be worse than doing nothing.
- Agents with a newer release published on npm can be updated in place from that table.
- Right-clicking a terminal pane pastes the clipboard (text, images and files) when nothing is
  selected; with a selection, the right click copies it and clears the highlight.
- A URL printed in a terminal can now be opened as a browser pane in the grid, next to the existing
  "open in app" and "open in browser" actions — the same one-click **Open in grid** that Markdown and
  video links already had.
- The Files sidebar now supports quick previews, adding or dragging files into the workspace grid,
  revealing entries in File Explorer, renaming, and confirmed deletion. Git file rows can also open
  the working file in the grid or reveal it alongside the existing stage, discard, commit, and sync actions.
- Browser panes now offer app-first, balanced, and keep-alive resource modes. App-first is the default,
  and every mode releases hidden native webviews when Alethe detects memory pressure.
- The layout organizer now includes adaptive presets and keeps the eight most recently saved layouts
  separately for each project, group, and workspace.
- New **Ember** interface theme: cool charcoal surfaces, hairline dividers and a single ember-orange
  accent for live state, with a matching terminal palette. Selectable in Preferences → Appearance and
  as the terminal theme; it does not ship a native app icon variant.
- Remote control now pairs through a **short-lived pairing window**. The QR code is valid for two
  minutes and stops working as soon as one device pairs; a paired device receives its own session
  token and can be revoked individually. Preferences → Remote control can reopen or close the window
  at any time.
- A message sent from a paired phone now raises a desktop notification naming the device and showing
  what it sent, so remote input is never silently typed into a terminal.
- Individual terminals can now be hidden from remote devices from the sidebar context menu. A hidden
  terminal disappears from the phone's list and its output and input are refused server-side.
- Remote control gained a **read-only mode** (on by default) and a separate switch that decides
  whether plain shell terminals accept remote input. With both at their defaults a paired phone can
  watch terminals but cannot type into them.
- Session scans that take longer than 250 ms are now recorded in `logs/app-events.log`.
- Restored browser panes in the workspace grid. **Add browser** is available from the app menu
  and each project's three-dot menu, opens a dedicated URL and settings dialog, and runs every
  page in a native incognito webview whose cookies, cache, autofill, and site storage are discarded
  when the pane closes.
- Added a live Remote Control device counter to the top bar with direct access to the connection
  panel.
- The project editor now warns when its folder is not a Git repository and offers initialization
  without leaving the dialog.

### Changed

- The sidebar's **Organization** block is back to the 1.5.0 layout: the label with the four layout
  modes, plus the workspace grid button — the reworked panel with stacked icon rows and a scope
  switch in its header was reverted.
- The right sidebar no longer depends on the Todos feature being enabled — it now appears whenever
  Todos, MCP, or Git-on-the-right is active.
- Installing an agent now happens in a dialog. It lists every method that works on this machine —
  the vendor's own installer, npm, WinGet, Scoop, Chocolatey — with the exact command each one runs,
  and you pick which to use instead of being given one button and a hidden "other ways" list.
- The onboarding agent step was rebuilt as a table. Every agent is one row with its icon, the
  resolved path of its CLI, the installed version, a status tag, and its actions — install, update
  or uninstall — so all rows line up regardless of what each agent offers. Above it there is a
  counter strip (enabled, up to date, with updates, installable), a search field that matches on name
  or path, and All / Detected / Installable filters. A **Scan again** link re-runs detection without
  leaving the step, for when an agent was installed outside Alethe.
- GitHub Copilot is drawn with its official mark instead of the generic robot placeholder, so every
  agent in the app now carries its own logo.
- Setting MCP up is no longer a step of first-run onboarding. It is offered once as its own card
  after the app opens, and stays available in Preferences → Features — onboarding goes back to five
  steps.
- The layout designer dialog now uses the same drag-and-drop engine as the rest of the app. Cards
  follow the cursor without lag, only the cell under the pointer lights up, a plain click still just
  selects, and cards are resized with the same edge handles as the real grid.
- Switching workspace tabs no longer reloads them. Every tab in the tab bar — the same ones Ctrl+Tab
  cycles through — stays mounted in the background instead of being torn down, so its terminals keep
  their scrollback, their PTY attachment and their scroll position. Coming back to a tab no longer
  shows a boot spinner and never restarts anything, however many projects you move between. The two
  most recently used background tabs also keep receiving output, so returning to them costs nothing
  at all; the rest pause their stream while hidden and redraw on return. None of them are suspended
  for being idle while they stay mounted. A tab that produced no output while it was away skips the
  redraw entirely and comes back untouched.
- The terminal boot overlay uses the same dot-matrix loader as the sidebar instead of its own
  spinner.
- Terminals start faster. Resolving an agent's launcher scanned every directory in PATH on every
  boot; successful lookups are now remembered and revalidated against the file itself, so installing
  or removing a CLI is still picked up immediately.
- Critical Windows memory pressure now suspends one eligible hidden idle runtime at a time, preserving
  session scrollback while preventing system-wide stalls that can make even Alt+Tab stop responding.
- High-volume terminal output now coalesces runtime activity timestamps, avoiding repeated global
  state updates and skips remote-control serialization when no remote device is connected, without
  delaying terminal rendering or process I/O.
- Spotify playback widgets now share connection and track requests instead of polling the backend
  independently.
- The title bar now uses a lightweight connected-device count and pauses remote-control polling while
  the app is inactive, avoiding repeated QR-code generation for a badge update.
- Native browser panes now share one overlay observer instead of each watching the entire application
  DOM independently.
- Remote-control polling now reuses the pairing QR code until its URL or token changes.
- GSD session watching now reads child state in one background command instead of launching three Git
  root-resolution processes per watched item every five seconds.
- Layout editing now provides a smoother drag preview, a clearer preset/history library, and reduced-
  motion support. Sidebar activity indicators now share the trailing action slot with the three-dot
  menu, while Todo edit and delete actions no longer reserve empty space before hover or keyboard focus.
- Repository instructions now explicitly require English for source comments, JSDoc, internal logs,
  documentation, changelog entries, and default user-facing strings.
- Windows installers now include the official WebView2 bootstrapper and automatically install the
  Evergreen Runtime when it is missing, instead of downloading the bootstrapper separately.
- App icon choices now update the running native window and taskbar icon immediately.
- Memory monitoring no longer parks runtimes, closes tabs, or blocks new sessions automatically.
  Memory Analytics now bases its health alert on available Windows memory and keeps session closure
  under explicit user control.
- Resource health is recorded periodically in `logs/resource.log`, and failed `projects.json` saves
  are logged and retried instead of being silently discarded.
- Everything inside a group now sits indented under a barely-there rail that picks up the group's
  color on hover, so a grouped project is distinguishable from a loose one without adding noise.
- Groups and projects now expand and collapse with a short height-and-fade animation, and the
  disclosure chevron rotates instead of swapping icons. Both respect reduced-motion.
- Group headers now read as section labels — quiet 11px text and a rule line, with no folder mark —
  so they are no longer mistaken for project rows, and project and session rows were tightened to a
  28px scale so the group no longer competes with them.
- Reworked both sidebar styles into a flat three-level list. Groups are now section dividers (label,
  rule, add and collapse actions) instead of a tree level, every project renders as a single folder
  row with its sessions underneath, and the boxed active-project card, its primary badge and its
  separate new-terminal button are gone — the row's + creates a session and clicking a group header
  only expands or collapses it.
- Row actions (+ and the three-dot menu) now appear on hover, and the selected session is marked
  only by a solid background.
- Hidden and paused agents are now signalled only by a desaturated agent logo and a softer name —
  the strikethrough and the italic "disabled" styling are gone.
- The agent logo is now the leading element of every terminal row; the running indicator and the
  response-ready badge moved to the right end of the row.
- Standardized the entire changelog in English and made English the explicit default language for
  versioned repository content and commit messages.
- Simplified Clean sidebar selection with subtle background feedback and no side markers, preserved
  animated running-state indicators, removed the Ungrouped heading and Primary badge, increased tree
  spacing, and added a direct new-terminal action to every project.
- The Clean sidebar footer now keeps the latest known Spotify track visible when playback is
  inactive and stays hidden when no real track is available, without an empty connection prompt.
- Clean mode now presents a dedicated New Agent action, folder-based project rows, one focused row at
  a time, dimmed inactive agent icons, and matching flat selection feedback in the top bar.
- Extended Clean styling across dialogs, dropdowns, context menus, workspace panes, browser/video/
  Markdown surfaces, sub-tabs, Home cards, empty states, and floating inspectors with neutral focus,
  flat hover feedback, reduced motion, and no heavy elevation shadows.
- Tightened the Clean sidebar tree: New Agent moved below the toolbar and reads as a quiet row,
  project rows dropped the branch label, agent counter and standalone AI icon, every project now
  expands by default with its own chevron, and group, project and terminal rows were reduced in
  height with clearer indentation between the three levels.
- Removed finished-agent badges from Clean sidebar items while preserving the aligned state gutter
  and animated working indicator for agents that are actively running.
- Removed the workspace's animated gradient focus frame in both visual styles, increased the Clean
  sidebar's separation between groups and projects, and added group logo selection to both group
  creation and editing with a folder fallback.
- Removed the space-consuming terminal header bar in both visual styles and kept its controls
  available in a compact hover overlay that does not reduce terminal content height. The overlay
  now also shows the active conversation's agent logo and name on the left.
- Spotify now refreshes existing connections automatically and falls back to the most recently
  played track when nothing is currently active, while connection prompts no longer appear in the
  sidebar or Home dock.
- Increased inactive Clean top-bar tab and logo contrast, aligned Spotify and profile footer rows to
  the same proportions, and restyled the profile menu with the shared compact Clean popover metrics.
- Matched the Clean right sidebar to the left sidebar's flat toolbar, controls, spacing, and list
  treatment, and standardized every Clean menu and dropdown on the profile menu's smooth entrance
  motion, including model, project, agent-usage, context, Home, and terminal-link selectors.
- Project and group rows now prefer their configured logo over the folder fallback in Clean mode,
  and the right sidebar mirrors the left toolbar's button sizing, spacing, utilities, and active states.
- Claude rows in both sidebar styles now show the live conversation title, falling back to the first
  user prompt and then the agent name, with long titles truncated without disturbing row actions.
- Groups are always ordered above loose projects at every sidebar level, orphaned subgroups remain
  visible at the root, and configurable group logos replace the folder fallback in both styles.
- The Clean Organization layout strip now matches the 40 px footer rhythm with compact, flat controls.
- Extended Clean mode to the remaining top-bar controls: flat icon buttons without scale-on-hover,
  borderless usage, RAM, profile and sync pills, and a lighter usage popover.
- Visible-pane calculations now run once per state update and are shared instead of running once per
  open pane.
- Off-screen terminal history loading is deferred until the pane becomes visible, and heavy TUI
  writes are processed in 16 KB chunks instead of 64 KB chunks.

### Removed

- The Merge Center is **out of this version and will return in a later one**. Out for now: its
  sidebar panel, the **Merge** tab of the project editor, the branch testing dialog, the merge store,
  and the `merge_analyze` / `merge_prepare` / `merge_finalize` / `merge_abort` /
  `merge_preflight_abort` / `merge_rebase_onto_target` / `merge_force_cleanup` backend commands,
  along with the `merge_analyzer` and `conflict_resolution` modules behind them. Projects do not
  carry a post-merge action setting in this version. Worktrees, the conflict-resolution agent
  settings and GSD Sync are untouched — they only shared the `merge.` prefix.
- Removed the optional GitHub repository clone field from the new-project dialog.
- Removed the Infinite Rainbow project-color option, its animated styles, and its workspace focus
  treatment. Existing invalid or retired accent values now fall back to a stable solid color.
- Removed the unused WebGL terminal rendering path and dependency. Terminals continue to use the
  Canvas 2D renderer without a behavior change.

### Fixed

- Panes running in a worktree now resume their conversation. A pane created with worktree isolation
  came back as a fresh agent every time the app reopened, with its history gone and its sidebar title
  never filled in, while panes in the repository root were unaffected. Claude folds a dot into a
  hyphen when it names a project's session directory, and worktrees live under
  `<repo>/.alethe/worktrees/<id>` — so the computed directory never existed, the pane never learned
  its real session id, and each reopen saved an empty session over the pointer to the real one.
- The left and right sidebars no longer come back collapsed. A collapsible panel closes itself
  whenever the layout squeezes it under its minimum width — which is what minimizing the window, or
  restoring it narrow, does to both sidebars at once — and nothing ever reopened them, so they stayed
  shut even though the saved preference still said they were open. They are now reopened whenever the
  window has room for them again.
- The left and right sidebars no longer close on their own. Closing the app tears the window down and
  the panel group reports one last zero-width layout on the way out, which was saved as if both
  sidebars had been collapsed by hand — so the next launch opened with both closed. Layout changes
  that arrive while the window is hidden are now ignored. Separately, dragging a separator until the
  sidebar collapsed left its "the user is resizing" flag stuck on, because a collapsed separator
  stops receiving pointer events and never saw its own release.
- Picking a server in the MCP manager's list now switches the detail panel. Opening the manager from
  a server row in the sidebar pinned the selection to that server: every click re-ran the effect that
  applies the requested server and snapped the list straight back.
- Continuing a Claude conversation in Codex no longer launches Codex with `--add-dir`, a Claude Code
  flag that Codex rejects on startup.
- A Codex pane that was not visible when it started now recovers from a busy session on its own. The
  bootstrap error is written and the process exits before the stream listeners exist, and a hidden
  pane never read the buffered output, so the retry that opens a fresh session never ran.
- Home now adapts to the width of the pane it is in, not the width of the window. Its layout was
  driven by window breakpoints, so opening Home in a narrow pane of a wide window kept the wide
  layout: the shortcut pills spilled outside the "new terminal / new project / new group" cards and
  the message count in the activity card ran over the word next to it. The sections now collapse on
  the space they actually have, long labels truncate instead of overflowing, and the big activity
  number scales with its card.
- Two paths inside the same parentheses are no longer underlined as one link. A path opened right
  after a bracket ran straight to the closing bracket, ignoring every space in between, so
  `(/pt-br/vitrine-dupla/projetos e /en/double-showcase/projects)` came back as a single link. The
  bracket now only caps the link instead of defining it, and each path is detected on its own.
- An extensionless path in terminal output no longer swallows the rest of the sentence as a link:
  `/pt-br/vitrine-dupla/trajetoria — 5 variações` used to underline the whole line. A space now ends
  the link unless a file extension is waiting on the other side, which is what a path with spaces
  actually looks like.
- Invalid CLI overrides are rejected instead of being saved and launched. Existing invalid overrides
  are cleared automatically, preventing the Antigravity desktop application from opening when Alethe
  expects the `agy` command-line executable.
- The agent update button in onboarding no longer fails silently. It decided success purely by
  checking whether the CLI binary was still on PATH, which is true even when the update itself
  failed (network error, permission denied, ...), since the previous binary is still there. The
  installer's real exit code is now checked first, and a failed update shows a toast instead of
  quietly leaving the CLI on its old version. It also now catches the case where the installer
  genuinely succeeds but a second, unmanaged install of the same CLI earlier on PATH shadows the
  one that was just updated: if the resolved binary's version hasn't moved, the update is reported
  as failed and the toast names the shadowing binary's path instead of reporting a false success.
- Antigravity no longer shows "Version unknown" forever in onboarding. Latest-version lookup only
  ever checked the npm registry, and Antigravity ships through a native installer instead of npm,
  so it never had a package to look up. It now falls back to the latest tag on its public GitHub
  releases when an agent has no npm package.
- A terminal that accepted keystrokes but rendered nothing — recoverable only by restarting it — now
  recovers on its own. Output is gated per PTY by a visibility flag, and the call that switches it
  back on was silently ignored whenever it landed while the session was spawning or restarting,
  leaving the stream off with nothing to turn it back on. The resource sampler now re-asserts
  visibility for every PTY on each pass, so a stuck stream clears within one sample instead of
  lasting until the terminal is restarted.
- An agent pane no longer loses the conversation it was resuming when you leave and come back to it
  quickly. The saved session was being read destructively at launch, so a pane torn down mid-launch —
  switching workspace tabs with Ctrl+Tab, for example — erased the only record of its conversation and
  came back on a different chat. The record now survives until a new session actually replaces it.
- The terminal "command not found" overlay was written in English regardless of the selected
  language; its text now goes through the translation system like the rest of the app.
- A pane no longer starts an empty chat when you come back to it after a long time away. The session
  claim that prevents two panes from writing to the same conversation was tied to the PTY id, so a
  PTY that ended on its own — parked by memory control, suspended, or killed — left the conversation
  permanently marked as taken and the pane silently dropped its own session id.
- Reopening a pane no longer replays its history line by line. The stored scrollback was fed to the
  terminal in 16 KB slices, one rendered frame each, so a large buffer visibly scrolled from the top
  down to the prompt and took seconds; it is now written in a single pass straight to the bottom.
- Switching conversation from inside the CLI with `/new` or `/resume` now sticks. Alethe pinned the
  session id given at launch and sent the old one back on the next restart, dragging the pane to the
  previous chat.
- Ctrl+Tab did nothing after coming back to the app from another window. Returning left the webview
  with no focused element, and WebView2 then kept the key for its own focus traversal instead of
  handing it to the app. Focus is now parked on the app shell whenever nothing else holds it, so
  every shortcut keeps working. Ctrl+Tab also focuses the first terminal of the tab it switches to,
  instead of switching with the keyboard pointed at nothing.
- Agent CLIs installed through Homebrew were invisible on macOS. An `.app` launched from Finder does
  not run as a login shell, so it inherits the minimal Launch Services PATH without `.zshrc` /
  `.zprofile`. Launcher discovery and the PATH rebuilt for terminals now include the default Homebrew
  prefixes (`/opt/homebrew/bin` and `sbin` on Apple Silicon, `/usr/local/bin` and `sbin` on Intel) as
  a fixed fallback.
- The Antigravity usage widget showed "—" on Linux. The OAuth token lookup used an explicit keyring
  target required by the Windows Credential Manager, which prevented the Linux Secret Service (GNOME
  Keyring / KWallet) from finding the entry written by the `agy` CLI. Credential discovery now
  supports both layouts and also looks for the `agy` binary in `~/.local/bin` and `~/.cargo/bin` on
  Linux and macOS.
- Pasting an image or files into a terminal did nothing on Linux, silently. `read_clipboard_payload`
  was implemented on Windows only and errored out everywhere else without falling back. A Linux/BSD
  backend using `wl-paste` / `wl-copy` (Wayland) or `xclip` (X11) now handles screenshots, images
  copied from the web (`image/png`) and files copied in a file manager (`text/uri-list`). macOS is
  still unimplemented.
- **Remote control is now off by default and stays off until you turn it on.** Alethe used to open a
  LAN listener on every launch, and the on/off switch was lost when the app restarted. The setting is
  now saved with your preferences and the listener only starts while it is enabled.
- The remote pairing address and QR code are only shown while a pairing window is open, and the
  address the phone uses is no longer carried in the page URL after pairing.
- Remote control session lifetime, the device limit, and per-device revocation now apply to the whole
  remote surface. They previously only guarded the live WebSocket, so an expired or revoked device
  could still read terminal output and send messages over HTTP.
- A paired phone now only receives output from the terminal it is watching. Every terminal's output
  was previously broadcast to every connected device.
- The remote workspace listing now sends only the fields the phone renders, instead of copying raw
  workspace records.
- Remote requests split across network packets are no longer truncated, oversized requests are
  rejected, and a failed request always gets a response instead of leaving the phone waiting.
- Remote connections now time out, are capped in number, must authenticate within ten seconds, and
  repeated bad tokens temporarily block the offending address — a device on the same network can no
  longer exhaust the app's connections.
- Remote control now re-reads the machine's network address every time it is enabled, so the pairing
  QR code stays valid after switching Wi-Fi networks.
- The **App icon** setting in Preferences → Appearance now actually changes the taskbar and window
  icon. It previously sent the bundled asset URL to the native window, which silently failed, so the
  icon never left the default variant. Each icon now ships at 32, 48, and 64 pixels and the variant
  matching the display scaling is used, so the taskbar no longer shows a blurry downscale.
- Submitting `/new` in an agent terminal now clears both the visible conversation and its persisted
  terminal scrollback, so the fresh session no longer inherits the previous conversation on screen.
- Terminals now recover automatically when a native PTY write stalls instead of blocking every
  later keystroke until a manual refresh, and use the stable xterm DOM renderer to avoid a renderer
  transition race that could leave the terminal unable to accept input.
- Large terminal pastes now use bounded high-throughput IPC chunks, preserve Unicode boundaries, share
  the normal input queue, skip synchronous per-character prompt-history work, and always close
  bracketed-paste mode after partial failures. This prevents Claude Code and Codex pastes from freezing
  the app, interleaving with typing, or stopping halfway.
- Native browser panes now remain hidden for the full lifetime of modal and menu overlays, including
  closing animations, preventing them from flashing above or interfering with dialogs.
- Opening a terminal's tabs lane now moves only its left floating identity to the right, while the
  existing right-side actions remain anchored in place. The pane drag handle moves into the lane,
  directly above its tab items, so it no longer covers terminal content.
- Fixed the freezes and runaway memory growth introduced with the new sidebar. The conversation
  title shown on each session row was rescanning and fully parsing every Claude session file of the
  project — up to hundreds of MB — every 12 seconds, on the thread that serves the whole UI. Rows
  now read only their own session file, off the main thread, and stop once the title is known.
- Session scans no longer load a whole record into memory, so a single oversized message can no
  longer abort the app with an out-of-memory error and take every open terminal down with it.
- Closing the app no longer crashes or becomes unresponsive mid-shutdown. Process-tree cleanup now
  runs outside the native event loop, while a frontend deadline destroys the window if the native
  quit request does not settle, so slow Windows process termination cannot hold the interface open.
- The corrected Windows installer now identifies itself as 1.5.1 so it reliably upgrades existing
  1.5.0 installations instead of entering same-version maintenance mode.
- Sidebar visibility and widths now change only after explicit user input, so startup and automatic
  layout adjustments cannot close a sidebar or overwrite its saved size; pending workspace changes
  are also flushed before the native window closes.
- Prevented private browser panes from failing to start when development-mode effect remounts
  briefly overlap while a previous native webview is closing.
- Fixed the Git initialization button contrast across accent colors by using the theme's matching
  foreground token.
- Fixed project-name overflow so long paths use a clean ellipsis without colliding with status
  badges in either visual style.
- Fixed backup imports by excluding locked WebView runtime caches, ignoring those entries in legacy
  archives, validating the archive before deleting local data, and closing active terminals before
  restoration.
- Clean sidebar group headers now only expand or collapse the tree instead of also adding every
  project in the group to the workspace.
- GitHub repository cloning no longer depends on a hardcoded `D:\Projects` directory. The selected
  destination is now respected, with `~/Alethe/<repository>` as the cross-platform fallback.
- Background agents now report completion through the lightweight off-screen activity channel.
- Lightweight background output is accumulated between updates instead of being discarded, so
  activity detection and Codex busy-session recovery remain reliable off screen.
- Output written while an agent pane restores its history is replayed after the restore instead of
  leaving a permanent gap.
- Remote Control no longer drops accented characters when a UTF-8 sequence crosses a buffer cut.
- Memory-pressure spawn blocking now queues every new request. The reduced concurrency ceiling only
  controls how many existing waiters may be released.
- Synchronized the bundled GSD plugin version with its actual v11 content so older worktrees receive
  automatic updates.
- Main terminals can no longer claim a GSD child conversation merely because GSD monitoring was
  disabled after its sentinel file had been created.
- New GSD plugin instances clear stale synchronization markers left by crashed or closed processes.
- Terminal hover and click coordinates are remeasured after app zoom changes, keeping xterm.js link
  detection aligned with the pointer.
- Development builds on Linux now also apply the Alethe icon at runtime. Packaged builds remain the
  reliable icon source for compositors that prefer desktop-file lookup.
- Linux now sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` before creating the webview, avoiding the known
  WebKitGTK DMA-BUF animation and fractional-scaling issues documented by Tauri.
- Linux animations now prefer compositable properties and avoid `transition: all` and animated width.
- GSD child sessions are read-only across xterm input, paste, prompt history, and force-kill shortcuts.
- OpenCode no longer emits unsupported OSC 66 width queries in xterm.js because spawns set the
  documented `OPENTUI_FORCE_EXPLICIT_WIDTH=false` compatibility flag.
- OpenCode redraw nudges after spawn and resize now share a 400 ms lock, preventing overlapping TUI
  redraws.
- The `windowsPty` xterm.js option is now enabled only on Windows, fixing dense TUI redraws on Linux
  and macOS.
- Scrollback resynchronization now cuts only at valid UTF-8 character boundaries.
- Conflict-resolution model selections are no longer overwritten by background project updates while
  the edit dialog is open.
- The full project form now inherits a folder selected on the empty-workspace screen, and truncated
  paths expose their complete value on hover.
- Git initialization and refresh actions use consistent full-width stacking in narrow sidebars.
- Windows orphan-process cleanup now logs Job Object failures, records root processes, and cleans
  verified leftovers after an unclean shutdown.
- Merge diff summaries and test briefings now include uncommitted worktree changes, not only commits
  between branches.
- GSD Sync sessions now appear in Tasks for OpenCode terminals even when worktree isolation is off.
- GSD test procedures include files committed on the current worktree since it diverged from
  `main` or `master`.
- Provider model search no longer pollutes another provider's cache during rapid switching, preserves
  one selection per provider, and accepts custom searched models with Enter.
- Off-screen agent terminals no longer render full output continuously. They receive lightweight
  activity updates and restore complete scrollback immediately when shown, without pausing agents.
- Migrating existing terminals now restarts each live pane in its new worktree instead of leaving the
  visible process in the old directory.
- Worktree migration now reinstalls GSD monitoring and uses the latest unsaved project configuration.
- Enabling GSD monitoring creates a missing `.planning/` directory instead of failing silently.
- The **Open folder as project** button now uses a visible text color in every theme.
- Terminal hover links now support mixed-case protocols such as `Https://` and bare deployment
  domains such as `example.vercel.app`, while excluding file names and email addresses.
- Workspace panel sizes now persist per profile and workspace screen for outer project containers and
  nested terminal splits in Auto, Spotlight, and Sidebar layouts.
- Sidebar drag-and-drop now keeps list geometry stable, separates reordering from group nesting, and
  uses theme-native insertion lines and subtle neutral targets.
- The topbar widgets no longer jump sideways when you hover them. The pencil button that opens the
  widget settings used to expand from zero width on hover, pushing every pill 26px to the left —
  enough for the pill you were reaching for to slide out from under the cursor, which dropped the
  hover, collapsed the button and shifted everything back, flickering in place. Its slot is now
  reserved at all times and only the button itself fades in.

## [1.5.0] — 2026-08-09

### Added

- Added authenticated LAN Remote Control for browsing agent chats, watching live output, and sending
  one message at a time from a mobile browser.
- Added Remote Control enable and disable controls, device limits, token regeneration, named devices,
  session metadata, one-hour default expiry, and individual revocation.
- Added Agent Sandbox job and thread identifiers, structured spawn acknowledgements, persistent Codex
  app-server threads, parent-to-worker relationships, and reply relay back to the Claude planner.
- Added persistent Agent Sandbox projects with project folders, live session restoration, project
  switching, on-demand workers, and regular project terminal synchronization.
- Added regular shell workers to Agent Sandbox so long-running development servers remain visible as
  plain terminal panes.
- Added development and installer icon themes independent from the interface theme.
- Added **Erase all data (fresh install)** after backup export for a complete local reset.

### Changed

- CLI detection during onboarding is time-boxed per provider so slow PATH entries cannot freeze setup.
- New profiles reach onboarding cleanly, and parking terminals no longer blocks account switching.
- The default profile image and generated app icons now use the dark Alethe artwork.
- Agent Sandbox project creation entry points are hidden behind a build flag while the feature is
  archived.
- The startup screen now shares the Home background and ASCII-art treatment.
- Profile export now includes the complete profile, including Todos, history, metrics, preferences,
  tokens, scrollback, and all other stored data.
- Account switching closes each pseudoconsole before waiting for its final scrollback flush and can
  resume parked sessions without restarting the app.
- The Accounts modal has clearer hierarchy, spacing, and profile creation controls.
- Project dropdowns use the Todo List's viewport-safe portal behavior, path containment, truncation,
  Escape handling, and consistent styling.
- Concurrent panes cannot resume the same Codex conversation, and active-writer errors split across
  output chunks recover reliably.
- Agent Sandbox workers run unrestricted and non-interactively by default. Claude uses
  `--dangerously-skip-permissions`; Codex uses unrestricted approvals.
- Sandbox workers use readiness-aware prompt delivery, delayed bracketed paste, separate submission,
  settle detection, deadline fallback, and supported prompt arguments.
- Automated Claude and Codex workers default to Haiku where applicable, preserve their own working
  directories, skip Codex trust checks for the selected Sandbox folder, and report structured errors
  without exposing task text.
- Automated workers move from Working to Done or Error based on streamed output, while submitted
  prompts are cleared to prevent duplicate execution after HMR.
- Sandbox stop and project-switch operations invalidate in-flight spawns, and startup failures release
  the retry guard.
- Windows Sandbox path comparison is case-insensitive and ignores trailing separators.
- Agent Sandbox panes use the same terminal headers, dimensions, backgrounds, and xterm surface as
  regular workspace terminals, with resize and Focus mode support.
- The real planner-to-worker proof of concept replaces mocked communication: Claude plans, Codex works,
  and `/spawn` creates a visible terminal in the session.
- Development-only Welcome, Theme Picker, and Redo Onboarding actions are hidden in production.
- New users receive the default purple avatar when they do not select a custom image.
- Todo items now animate on entry, hover, drag, and reorder targeting.
- Markdown viewer comments and their shortcut are temporarily disabled while the feature is repaired.
- Empty-workspace defaults, disabled-button contrast, sidebar drag previews, and sidebar transitions
  received clearer visual feedback.
- Agent Sandbox evolved from a temporary draggable PTY demonstration into a full-screen, compact,
  design-system-aligned terminal canvas with real providers and messaging.
- Sidebar drop targets now exist only during an active DnD-kit drag.
- Top bar controls, tabs, status pills, and window actions now share consistent spacing, height, and
  radius values; the customization control no longer reserves space while hidden.
- Remote WebSocket clients authenticate before counting toward limits, bind to the selected LAN
  address, strip control characters, and receive restrictive security headers.
- Remote addresses remain hidden behind a generic placeholder until QR pairing completes.
- Form dropdowns now use the compact 32 px system-wide standard.
- Remote security policy, session lifetime, LAN status, and device revocation moved to a dedicated
  Preferences category, leaving the QR dialog focused on quick access.

## [1.4.1] — 2026-08-07

### Fixed

- Corrected release notes in the **What's New** dialog and GitHub release so they use this repository's
  `CHANGELOG.md` instead of a stale external copy.

## [1.4.0] — 2026-08-07

Graphify became optional, the `alethe` command gained direct project opening, and this release delivered
a broad stability and security pass across AgentCanvas networking, image paste, session restoration,
memory controls, and Linux/macOS parity for Antigravity and OpenCode.

### Added

- Added an optional Graphify preference without rewriting agent MCP configuration.
- Added the `alethe` terminal command to open the current or selected directory in the existing app
  window, creating a project only when necessary.
- Added documented code standards and ESLint/Prettier commands.
- Added double-click file opening from File Explorer and monospaced diff panes from Git Control.
- Added **About & Updates** with installed-version details, update checks, download progress, visible
  errors, and a sidebar version shortcut.
- Added real Merge Center review: project validation commands, dedicated reviewer agents, direct
  feedback delivery, heuristic API-contract checks, stack detection, and isolated live health probes.
- Added in-app Git repository initialization with a safe initial commit for features that require Git.
- Added a GSD Planning Completion Gate that always leaves accept, review, and reject decisions available
  to the user and exposes real validation failures.
- Added automatic OpenCode GSD state maintenance for `task.md`, `status.md`, and `progress.md`, plus an
  isolated child session for `goal.md`, `plan.md`, and structured test procedures.
- Added double-click Focus mode for every pane title.
- Added configurable GSD Sync model fallback chains based first on the model that just succeeded in the
  parent conversation.
- Added a project-scoped, read-only GSD Sync viewer with passive completion indication; it was later
  moved into the Tasks sidebar.
- Added code-aware GSD validation planning based on the real changed-file list and structured
  preparation, action, and verification steps in `.planning/procedure.json`.
- Added broader GSD activity triggers so edits and shell work synchronize even without a native task
  list update.
- Added a pre-spawn system-memory headroom check with a 45-second upper bound.
- Added prominent Git initialization to the sidebar and project editor, including empty-repository
  commits and transparent initialization before isolated-agent worktree creation.

### Changed

- GSD Sync sessions moved from a separate right-side drawer into the existing Tasks sidebar.
- Internal quality work moved project persistence off Tokio's blocking path, reduced Ghostty polling,
  consolidated provider session and usage helpers, and standardized the Claude Code label.
- Terminal themes moved from the Terminal settings page to Preferences → Appearance.

### Fixed

- Secured the AgentCanvas local HTTP listener with a per-launch `X-Alethe-Token` and limited request
  bodies to 1 MB.
- Closed sidebars no longer reserve width in the main content area; only top-bar control space remains.
- Stabilized the pane-area Zustand fallback to prevent React #185 during project hydration.
- Disabled unstable xterm.js WebGL rendering in the Windows WebView to avoid teardown races.
- Sidebar resize persistence no longer rebuilds `defaultSize` during the resize event.
- GSD test briefings are scoped to the files changed in the current session and exclude Alethe-generated
  `.opencode/`, `opencode.json`, and `.planning/` infrastructure.
- Graphify and GSD setup commands now run on blocking worker threads instead of freezing Tauri IPC when
  spawning agents.
- PTY write, resize, suspend, kill, and process-tree termination no longer block the Tauri dispatcher or
  hold the global session lock during slow work; process kills have a three-second timeout.
- GSD planning gates skip unsupported providers, install monitoring retroactively for existing OpenCode
  worktrees, and replay task updates queued during an active synchronization cycle.
- Multi-Agent telemetry continues after receiver lag and displays real load failures.
- Onboarding agent detection no longer gets stuck under React StrictMode, and CLI/model discovery runs
  on blocking workers with a six-second per-agent safety limit.
- The Multi-Agent & Telemetry page now reads real `.planning/task.md` data, removes the non-functional
  plugin manager, and routes all visible text through localization.
- The Merge Center has its own maximum height and scroll area so multiple cards cannot push the project
  list out of view.
- Rejecting or accepting worktrees now stops agent processes before deletion, runs Git operations on
  blocking workers, and tracks cleanup failures as recoverable orphaned worktrees.
- Concurrent GSD Sync polling merges only entries resolved by each poll instead of replacing shared
  state, preventing child sessions from flickering or disappearing.
- PTY spawn and scrollback attachment now run on blocking workers so one slow terminal cannot freeze all
  app IPC.
- Deleting a worktree agent also deletes its hidden GSD viewer terminal and PTY.
- Repository-root discovery excludes GSD viewer panes and can resolve the shared Git root from any
  existing worktree.
- GSD viewer panes trust Alethe-tracked child session IDs that OpenCode intentionally omits from normal
  session listings.
- Merge Center **Accept** now performs the real analyze, prepare, resolve, validate, and fast-forward
  merge flow; **Reject** removes the worktree while preserving its branch.
- Automatic worktree isolation applies only to new agents. Existing terminal migration is explicit,
  suspends the PTY, checks uncommitted changes, and reports complete, partial, or failed results.
- Existing-terminal migration validates that the folder is a Git repository before doing any work and
  shows the localized isolation warning instead of a raw Rust error.
- Git initialization seeds a `.gitignore` for common generated and secret directories before staging,
  preventing `node_modules` and similar trees from freezing the app.
- Windows verbatim `\\?\` prefixes are removed from worktree and merge paths before they reach shells,
  session matching, or PTY spawn.
- Session detection for isolated OpenCode, Codex, and Antigravity agents keeps retrying while the
  terminal remains open instead of expiring after 30 seconds.
- New Terminal and Home quick-launch paths once again provision worktrees when automatic isolation is
  enabled and surface provisioning failures in a toast.
- New isolated worktrees always derive from the real repository root instead of nesting under the most
  recently used worktree.
- Test Briefing now shows the real branch file diff and actual validation command results.
- The default Merge Center badge now says **Awaiting action** instead of claiming review readiness.
- Image paste works again for OpenCode, Claude Code, and Codex from screenshots, web images, and Explorer
  files by sending a file path to the PTY.
- Antigravity CLI detection now checks the real `agy` binary on Linux and macOS.
- Closing or restarting terminals now kills complete process trees on Linux and macOS as well as
  Windows.
- Working-directory comparison is centralized and only normalizes case and separators for Windows
  paths.
- Keyboard shortcut labels follow the active platform consistently across Home and the sidebar.
- OpenCode panes claim, persist, and resume their own session IDs instead of falling back to another
  pane's most recent conversation.
- Antigravity sessions use each conversation's timestamp and compare directory boundaries correctly.
- OpenCode directory matching remains case-sensitive on Linux and macOS.
- Enabled `@xterm/addon-unicode11` so emoji and symbol widths match terminal applications.
- **Resume last session** restarts agents through the normal spawn queue and memory supervisor, with
  confirmation when multiple panes will restart.
- The implemented Antigravity usage card now appears in AI Usage Details.
- Antigravity credentials are read from the exact `gemini:antigravity` Windows Credential Manager target
  as UTF-8, allowing real quota display.
- Protected xterm.js renderer changes, writes, and scrolling against disposed-renderer races after
  graphics context loss; PTY suspension now removes the session only after shutdown confirmation.
- Merge Center cards now truncate long status, branch, and action text correctly in narrow sidebars.
- Missing OpenCode sessions with a server-assigned `parent_id` are treated as inconclusive instead of
  being discarded as orphaned.
- Rainbow container borders now draw inside the box with the correct radius, showing the full edge
  animation instead of only the corners.
- Closing Tasks no longer collapses the left Merge Center sidebar after removal of the old GSD drawer.
- A broad silent-failure audit moved Git/session/agent/backup operations off the Tauri dispatcher,
  preserves corrupted metrics instead of overwriting them, exposes restart and hook failures, and keeps
  GSD polling alive when one session fails.

## [1.3.0] — 2026-07-27

This release integrates multi-provider Graphify and macOS contributions, redesigns Home, loading, and
the sidebar, and adds Antigravity support.

### Added

- Added multi-provider Graphify as an MCP server for Claude, Codex, and OpenCode, with a per-project
  graph viewer, project configuration, non-destructive config merging, and graph snapshots.
- Added an opt-in native Ghostty terminal backend on macOS through an NSView layered over the WebView.
- Added AppKit-level rounded window corners on macOS.
- Added Antigravity (`agy`) CLI detection, spawn and resume by conversation, session discovery, and a
  dedicated usage widget.
- Added experimental window opacity control.

### Changed

- Strengthened merge and worktree state with monotonic `projects.json` writes, Git-lock classification,
  backoff, orphan tracking and cleanup, and an auto-finalizing merge state machine.
- Added macOS Keychain discovery for Claude tokens and prevented `EDITOR=vi` from leaking from npm into
  development shells.
- Redesigned Home with interactive ASCII artwork, smooth dashboard transitions, a mini-terminal quick
  launcher, a compact Spotify dock, clearer usage and focus panels, and real streak/activity data.
- Rebuilt the loading screen with animated Alethe ASCII branding and dot-matrix progress.
- Reorganized the Projects sidebar around a fixed active-project card, a flat project list, colored
  monograms, always-visible menus, activity indicators, and reduced metadata clutter.
- Terminal links now exclude explanatory text, input failures recover the PTY, Codex restart preserves
  the conversation, and input focus recovers after mounting, interaction, or graphics loss.
- Unrestricted mode became a prominent one-click control in the Add AI dialog.
- Memory management now monitors by default; intelligent LRU behavior requires explicit opt-in.
- The new-terminal dialog gained card selection, a prominent folder field, and recent-folder shortcuts.
- Automatic resume removes orphaned Claude, Codex, and Antigravity conversation IDs before spawn.

### Fixed

- Windows paths are escaped correctly as TOML strings in `graphify_codex_config_write`.
- The merge finalization fallback stops polling after entering a failed state.

### Removed

- Removed the **Loose/Ungrouped** section label above ungrouped sidebar projects.
- Removed the parked-terminal text notice from the overlay; the resume action remains available.

[Unreleased]: https://github.com/Kc1t/alethe-agents/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/Kc1t/alethe-agents/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/Kc1t/alethe-agents/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/Kc1t/alethe-agents/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Kc1t/alethe-agents/releases/tag/v1.3.0
