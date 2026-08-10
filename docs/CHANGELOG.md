# Changelog

Notable user-facing changes to **Alethe** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/). Dates use UTC.

> **Rule:** every feature addition, change, or removal must be recorded under
> `[Unreleased]` in the same task. During a release, `[Unreleased]` becomes the new
> dated version and a new empty `[Unreleased]` section is added at the top.

## [Unreleased]

### Changed

- Standardized the entire changelog in English and made English the explicit default language for
  versioned repository content and commit messages.
- Replaced the active project's ambiguous terminal `+` icon with an always-visible, labeled
  **New terminal** action using a terminal-specific icon.
- Restored browser panes in the workspace grid. **Add browser** is available from the app menu
  and each project's three-dot menu, opens a dedicated URL and settings dialog, and runs every
  page in a native incognito webview whose cookies, cache, autofill, and site storage are discarded
  when the pane closes.
- Added a live Remote Control device counter to the top bar with direct access to the connection
  panel.
- The animated rainbow border now indicates focus for every workspace container instead of being
  only a project color effect. Focused containers show the animated border; unfocused containers
  return to their configured project color.

### Fixed

- GitHub repository cloning no longer depends on a hardcoded `D:\Projects` directory. The selected
  destination is now respected, with `~/Alethe/<repository>` as the cross-platform fallback.
- Removed the unused WebGL terminal rendering path and dependency. Terminals continue to use the
  Canvas 2D renderer without a behavior change.
- Background agents now report completion through the lightweight off-screen activity channel.
- Lightweight background output is accumulated between updates instead of being discarded, so
  activity detection and Codex busy-session recovery remain reliable off screen.
- Output written while an agent pane restores its history is replayed after the restore instead of
  leaving a permanent gap.
- Remote Control no longer drops accented characters when a UTF-8 sequence crosses a buffer cut.
- Visible-pane calculations now run once per state update and are shared instead of running once per
  open pane.
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
- Linux animations now prefer compositable properties and avoid `transition: all`, animated width,
  and the costly rainbow-border hue rotation.
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
- The project editor now warns when its folder is not a Git repository and offers initialization
  without leaving the dialog.
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
- Off-screen terminal history loading is deferred until the pane becomes visible, and heavy TUI
  writes are processed in 16 KB chunks instead of 64 KB chunks.
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
