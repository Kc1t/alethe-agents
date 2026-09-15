# Alethe guide for the agent helping its user

You are reading this because the person asked how to use or configure Alethe, the desktop app you
are running inside. Answer by pointing to the exact place in the app. Two rules:

- Never edit Alethe's own files (its `projects.json`, profiles, scrollback). The running app keeps
  them in memory and writes them back, so an outside edit is overwritten or corrupts the workspace.
  Walk the person through the app instead.
- If something is not covered here, say so. Do not invent a menu, a setting or a shortcut.

## The model

- **Group**: a collection of projects. Groups can nest, have a color and an icon, and be suspended.
- **Project**: a folder the person works in, with its terminals, layout and color.
- **Terminal**: a persistent unit with a working directory, scrollback and one or more sub-tabs.
- **Sub-tab**: a tab inside a terminal, usually one agent or one shell.
- **Container**: how an opened project is drawn in the workspace. **Pane**: one terminal inside it.

The left sidebar holds Home, groups, projects and terminals in one tree, with drag and drop and a
context menu on every row.

## Opening things

- `Ctrl+T` opens **New session**. Its first field, **Open as**, picks a plain terminal or an
  orchestration; then the agent, then the folder. **Advanced** holds permissions, 9router routing,
  the runtime profile and a manual folder path. **Create more** keeps the dialog open after it
  opens a terminal. `Ctrl+Enter` confirms.
- `Ctrl+Alt+T` repeats the last terminal configuration without opening the dialog.
- `Ctrl+Shift+A` adds a Markdown pane or a browser pane.
- Terminal types: Shell, WSL, Claude Code, Codex, OpenCode, Copilot, Antigravity, Mimo, Freebuff
  and Kiro CLI. An agent whose CLI is not found can be pointed at a launcher by hand.
- Clicking a Markdown, text or image link inside a terminal offers **Open in grid**.

## Layouts

Layouts apply per project, per group and to the whole workspace: **Auto** (one pane full size, two
side by side, more in a grid), **Spotlight** (one main pane with the rest stacked beside it),
**Sidebar** (a narrow list with one large active pane) and **Custom grid** (a visual editor for
columns, rows, spans and proportions). Containers can be collapsed, reordered by dragging, or put in
fullscreen; flat mode mixes panes from several projects.

## Orchestration

- Turn it on in **Preferences -> Features -> Agent orchestration** (off by default), or choose
  **Open as: Orchestration** in New session, which turns it on. The planner is a Claude Code or
  Codex terminal; the optional **Goal** becomes its first message.
- The **orchestration board** sits next to the planner. It shows each planner as a tab, every run
  and worker as a card, and Claude's own subagents and any shell the planner leaves running in
  the background.
- A worker that needs permission shows **Waiting on you** and leads the board. Its card offers
  approve once, approve for the session, decline or abort.
- A worker card can show the diff it produced; one that worked in its own worktree can be applied
  to the branch from the card.
- The board header warns when Claude or Codex is close to its usage limit.

## Preferences

| Page | What it holds |
| --- | --- |
| Account | The local profile, language and Alethe accounts. |
| Organization | Archived groups, restorable without losing their projects. |
| Appearance | Interface colors, themes and scale. |
| Remote Control | LAN access, security policies and connected devices. |
| Features | Which optional modules are visible (list below). |
| Plugins | Extensions that add themes, panes, sidebar tabs and commands. |
| Terminal and agents | Terminal appearance and which agents are available. |
| Integrations | External services, including 9router and Spotify. |
| Multi-Agent & Telemetry | Real-time metrics, event traces and structured logs. |
| About & updates | The installed version and software updates. |

**Features** toggles: Browser (websites as panes), Graphify (the code graph), MCP & Skills (every
agent's MCP servers and skills in one panel), Playwright browser (which browser the Playwright MCP
server drives), Agent orchestration, GSD Sync (OpenCode planning sessions, only in projects with an
OpenCode terminal) and AI Memory (long-term memory shared across agents; needs the ai-memory server).

**Plugins** ships Todo List, Theme Pack and Git Control, and can install local plugins or ones
from the catalogue. A pane whose plugin is disabled says so instead of opening.

**9router** (Integrations) is a local proxy that spreads Claude Code, Codex and OpenCode traffic
across providers with fallback. The page installs or detects it, starts and stops it, opens its
dashboard and holds its key and port. Routing is off by default. Per agent it is chosen in New
session -> Advanced, and only terminals opened after a change take the new route.

## Keyboard shortcuts

On macOS `Ctrl` reads as `Cmd`. Most shortcuts are ignored while typing in a field.

| Shortcut | Action |
| --- | --- |
| `Ctrl+T` | New session |
| `Ctrl+Alt+T` | Repeat the last terminal configuration |
| `Ctrl+Shift+T` | Reopen the last closed tab |
| `Ctrl+Shift+A` | Add a Markdown or browser pane |
| `Ctrl+W` | Close or hide the first pane in the active container |
| `Ctrl+P` | Find and jump to a terminal |
| `Ctrl+Shift+P` / `Ctrl+Shift+G` | New project / new group |
| `Ctrl+Shift+H` | Switch between Home and the workspace |
| `Ctrl+B` | Show or hide the left sidebar |
| `Ctrl+1` ... `Ctrl+9` | Jump to the Nth project |
| `Alt+Left` / `Alt+Right` | Back and forward through workspace history |
| `Shift+Tab`, `Ctrl+PageUp` / `Ctrl+PageDown` | Move between terminals |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle project tabs |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | Zoom in, out, reset |
| `R` | Restart the selected terminal (focus on the UI, not the terminal) |
| `Esc` | Close a modal or leave fullscreen |

## Memory

A terminal, a whole project or a group can be disabled or suspended to free memory, and
reactivated later. The title bar shows RAM use. When memory runs low Alethe parks a terminal and
says so; restarting it picks up where it left off.

## Continuity and data

- Agent sessions and scrollback come back after a restart; history opens from an agent pane.
- Backups export the local state as a `.zip`; importing one replaces the current state.
- Each local account keeps its own data folder under the app-data directory (`%APPDATA%\Alethe`
  on Windows): projects and preferences, scrollback, and a `spawn.log` that records how every
  terminal was launched. When a terminal fails to start, `spawn.log` is the first place to look,
  and the app can open it for the person.
