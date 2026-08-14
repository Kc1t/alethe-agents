# Alethe Overview

Alethe is a desktop workspace for running coding agents and shells side by side. It turns terminals into persistent workspace units: each pane has its own cwd, PTY, scrollback, tabs, layout state, and local resume data.

The app is local-first. Projects, preferences, layouts, scrollback, sessions, and Spotify credentials stay on the user's machine unless an optional cloud service is added later.

## What It Provides

- A project-based workspace for Shell, Claude Code, Codex, and OpenCode.
- Real PTYs managed by a Rust/Tauri backend.
- Split-pane project containers with automatic and custom grid layouts.
- Groups and subgroups for larger workspaces.
- Multiple sub-tabs inside each terminal.
- Persisted local state across restarts.
- Session resume for supported agent CLIs.
- Memory controls for disabling terminals and suspending groups.
- Backup export/import for local data.

## Stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2 |
| Backend | Rust |
| Frontend | React 18, TypeScript, Vite |
| State | Zustand |
| Terminal | `xterm.js` |
| PTY | `portable-pty` |
| Layout | `react-resizable-panels`, CSS grid |
| Drag and drop | `@dnd-kit/core` |
| Persistence | Local JSON files and scrollback files |

## Core Model

```text
Group
└── Project
    └── Terminal
        ├── Shell tab
        ├── Claude Code tab
        └── Codex tab
```

- **Group**: a logical collection of projects.
- **Project**: a work unit with terminals, layout, color, and workspace state.
- **Container**: the visual representation of an opened project.
- **Pane**: a terminal rendered inside a container.
- **Terminal**: a persistent unit with cwd, sub-tabs, PTY state, and scrollback.
- **Sub-tab**: an internal tab inside a terminal, usually mapped to one agent or shell.

## Persistence

Alethe stores app data under the platform app-data directory. Each local profile/account has its own isolated data folder.

Typical files include:

- `profiles.json`: local account/profile registry.
- `profiles/<profileId>/projects.json`: projects, groups, workspace state, preferences, and CLI paths.
- `profiles/<profileId>/scrollback/`: terminal scrollback snapshots.
- `profiles/<profileId>/spotify_tokens.json`: local Spotify token cache, when configured.
- `profiles/<profileId>/spawn.log`: local spawn and diagnostic log.

Legacy root-level data is copied into a timestamped `.migration-backups/legacy-*`
recovery directory before it is migrated into the default profile. The original
entries are cleaned up only after the typed profile registry commits successfully.

## Shared Local Core

Desktop and browser clients use one local Alethe Core authority. The embedded
Desktop server and the standalone `alethe-server` both bind to
`127.0.0.1:1423`; the process that owns the endpoint owns the profile/project
repositories and the live PTY registry. A runtime handshake verifies the app
identifier, instance ID, and an opaque data-root fingerprint before a client
uses that authority. Clients never infer a data root from the working directory
or from whichever application folder already exists.

Profile catalog changes, active-profile changes, and project revisions are sent
through one authenticated WebSocket stream. Each connection starts with a full
snapshot and receives another snapshot after reconnect or broadcast lag. Project
saves carry an explicit profile ID and expected backend revision; stale writes
are rejected and preserved as recovery copies instead of overwriting newer data.

Every portable PTY is owned by an explicit profile ID and immutable scrollback
path. Browser and Desktop viewers attach to the same live process, while output
fan-out and cursor-based scrollback recovery cover reloads, disconnects, and
stream gaps. A PTY remains alive while its owning core process remains alive.
A normal authority shutdown, Ctrl+C, or Unix SIGTERM terminates registered child
processes. Windows also uses a kill-on-close Job Object; Linux and macOS terminate
the registered tree and PTY process group during managed shutdown. An uncatchable
process kill cannot run application cleanup. Survival across a full core shutdown
would require a separately installed per-user daemon and is not part of the current
lifecycle contract; such a daemon needs an RFC covering singleton discovery,
authentication, upgrades, data-root ownership, crash recovery, and shutdown on
every supported OS. Native Ghostty surfaces remain a macOS Desktop capability;
browser terminals use the portable PTY transport.

Visibility and read-priority flags are currently session-wide. Multiple viewers
remain data-safe through activity events and snapshot resync, but the last viewer
to update visibility can affect delivery latency for the other viewers.

The full local API is loopback-only and validates Host, Origin, runtime identity,
and a rotating short-lived local session for HTTP and WebSocket operations. LAN
access remains an explicit Remote Control capability with its own security model;
it does not expose the local core API.

Storage and portable PTY ownership are independent of the window compositor.
Windows, macOS, and Linux use the same core contracts; X11 and Wayland affect the
Linux WebView/display layer, not the profile namespace or PTY persistence model.

## Development

```sh
npm install
npm run app
npm run build
npm run tauri -- build
```

Build artifacts are written to:

```text
src-tauri/target/release/bundle/
```

## Current Scope

Alethe is currently focused on the local desktop app. Windows is the most tested platform, while Linux and macOS builds are supported by the release workflow and need broader real-machine validation.

Cloud sync, hosted backup, billing, and online services are intentionally separate from the local app.
