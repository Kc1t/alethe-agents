# Alethe Overview

Alethe is a desktop workspace for running coding agents and shells side by side. It turns terminals into persistent workspace units: each pane has its own cwd, PTY, scrollback, tabs, layout state, and local resume data.

The app is local-first, not local-only. Its primary workspace state is stored on the user's machine, while update checks, provider usage polling, optional integrations, embedded web content, LAN remote control, and coding-agent subprocesses have the data flows documented in the [privacy guide](PRIVACY.md). See the repository [security policy](../SECURITY.md) for private vulnerability reporting.

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
- `profiles/<profileId>/github_sync.json`: GitHub Sync token and metadata, when configured.
- `profiles/<profileId>/spawn.log`: command, launcher, path-preview, timing, and PTY diagnostics.
- `profiles/<profileId>/handoffs/` and `mcp/`: temporary handoff packets, registry cache, and MCP backups.
- root-level `logs/`: telemetry, crash, frontend, resource, and lifecycle diagnostics shared by the
  installation.

Retention, export exclusions, plaintext credential storage, and deletion limits are documented in
[`PRIVACY.md`](PRIVACY.md); “local” does not mean every local artifact is automatically included in a
profile backup or removed from external copies.

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

Alethe does not require an Alethe cloud account. Current first-party and third-party network surfaces, their defaults, and local retention/deletion behavior are documented in [`PRIVACY.md`](PRIVACY.md).
