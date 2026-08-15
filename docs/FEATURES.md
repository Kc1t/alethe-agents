# Alethe Features

This document summarizes the main product capabilities in the public desktop app.

## Workspace

- Open multiple projects at the same time.
- Render opened projects as containers in the workspace.
- Close containers without killing their PTYs.
- Collapse containers into compact headers.
- Put one container in fullscreen.
- Use flat mode to combine panes from multiple projects.
- Reorder containers and panes with drag and drop.
- Restore opened containers and recent tabs across restarts.

## Layouts

Alethe supports layouts at project, group, and workspace level.

- **Auto**: one pane full size, two panes side by side, three or more in a grid.
- **Spotlight**: one primary pane with secondary panes stacked beside it.
- **Sidebar**: a narrow pane list with one larger active pane.
- **Custom grid**: visual editor for columns, rows, spans, and proportions.

Custom grids support `colSpan`, `rowSpan`, drag-and-drop swapping, and resizable row/column fractions.

## Terminals and PTYs

- Real backend PTYs through `portable-pty`.
- Shell, Claude Code, Codex, and OpenCode terminal types.
- Spawn, attach, write, resize, restart, and kill through Tauri commands.
- Persisted scrollback per PTY.
- Automatic terminal resize through `ResizeObserver` and `xterm-fit`.
- In-terminal search.
- Native copy/paste behavior.
- Prompt history per terminal.
- Restart overlay when a process exits.

## Terminal Sub-Tabs

- Multiple sub-tabs inside one terminal pane.
- Each sub-tab can have its own agent type, cwd, and PTY.
- The sub-tab lane can be hidden or shown.
- Multi-tab terminals force the lane visible.
- New tabs can be created as Shell, Claude Code, Codex, or OpenCode.

## Agents and Launchers

- CLI launcher resolution before spawning an agent.
- Windows launcher lookup across PATH, npm, pnpm, Volta, fnm, nvm-windows, Bun, Cargo, Scoop, Chocolatey, and common Node.js paths.
- Manual launcher override when a CLI cannot be found.
- Per-agent unrestricted mode flags:
  - Claude Code: `--dangerously-skip-permissions`
  - Codex: `--dangerously-bypass-approvals-and-sandbox`
  - OpenCode: `--dangerously-skip-permissions`

## Local Accounts

- Multiple local accounts/profiles in one app installation.
- Each profile has isolated projects, preferences, sessions, scrollback, caches, and Spotify tokens.
- The active account is visible in the title bar.
- Users can create, switch, rename, and delete local accounts.

## Resume and History

- Persist active Claude/Codex/OpenCode sessions for local resume.
- Reattach scrollback after app restart.
- List local Claude session metadata when available.
- Open history modals from agent panes.

## Project Sidebar

- Home, groups, subgroups, projects, and terminals in one navigation tree.
- Group colors, optional icons, collapse state, and suspend state.
- Project colors and terminal counts.
- Terminal agent icons and sub-tab counts.
- Context menus for groups, projects, and terminals.
- Drag and drop for moving projects, groups, and terminals.

## Memory Controls

- Disable one terminal to free resources.
- Disable a whole project.
- Suspend a group by disabling its terminals and closing its containers.
- Reactivate suspended groups.
- RAM indicator in the title bar.
- Backend memory stats for the app, WebView, and child PTY processes.

## Home and Continuity

- Personalized greeting and date.
- Recent projects and terminals.
- Quick actions for project, group, and terminal creation.
- Claude usage/activity widgets when available.
- Spotify Now Playing when configured.

![Home view with recent projects and quick actions](screenshots/home-view.png)

## Search and Navigation

- Jump modal for terminals.
- Filter by project name, terminal name, and cwd.
- Keyboard navigation with arrows and Enter.
- Keyboard shortcuts:

  On macOS, `Ctrl` is read as `Cmd` (`e.ctrlKey || e.metaKey`), so the table
  below is the same on both platforms. Most shortcuts are ignored while focus
  is in an editable field; `Esc`, zoom, and the `Ctrl`-prefixed shortcuts are
  the exceptions.

  | Shortcut | Action |
  | --- | --- |
  | `Ctrl+T` | Open the new-terminal modal |
  | `Ctrl+Shift+T` | Reopen the last closed tab |
  | `Ctrl+Shift+A` | Add a Markdown or browser pane |
  | `Ctrl+W` | Close/hide the first pane in the active container |
  | `Ctrl+P` | Find/jump |
  | `Ctrl+Shift+P` | New project |
  | `Ctrl+Shift+G` | New group |
  | `Ctrl+Shift+H` | Toggle between Home and the workspace |
  | `Ctrl+1` … `Ctrl+9` | Jump to the Nth project in sidebar order |
  | `Alt+Left` / `Alt+Right` | Navigate persistent workspace history |
  | `Shift+Tab` | Focus the next terminal in the current group/project |
  | `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle project tabs without reordering them |
  | `Ctrl++` / `Ctrl+-` / `Ctrl+0` | UI zoom in, out, reset (numpad variants included) |
  | `R` | Restart the selected terminal when focus is on the UI, not inside the terminal |
  | `Esc` | Close the open modal, or leave fullscreen |

## System Integration

- Custom title bar.
- Open cwd in the system file explorer.
- Open cwd in VS Code.
- Open the local app-data folder.
- Open the spawn log.
- Reset local app data.

## Backup

- Export local state as a `.zip`.
- Include `projects.json` and scrollback files.
- Import backup by replacing local state.
- Protect against zip-slip during import.
- Use atomic project-file writes to reduce corruption risk.

## Spotify

- OAuth Authorization Code flow with local callback.
- Callback URL: `http://127.0.0.1:8888/callback`.
- User-provided Spotify Client ID and Client Secret.
- Local token persistence and automatic refresh.
- Now Playing widgets on Home and the sidebar.

## Agent Planning

Agent Planning / Agent Canvas is experimental. It provides a visual control surface for coordinating agent sessions and workers from inside Alethe.
