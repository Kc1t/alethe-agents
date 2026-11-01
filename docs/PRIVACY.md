# Privacy and data flow

This document describes the behavior of the current Alethe `main` branch. It is a technical data-flow
guide, not a policy for Anthropic, OpenAI, Google, GitHub, Spotify, Discord, an MCP publisher, or any
other third party.

## Local-first, not local-only

Alethe is **local-first, not local-only**. Workspace state is stored on the user's machine and Alethe
does not require an Alethe cloud account, but the app has automatic and user-triggered network
surfaces. Coding-agent CLIs and other tools started inside its terminals can also use the network
under their own terms and configuration.

There is no first-party Alethe analytics uploader in the audited source. That does not make the app
network-free: update checks and provider usage polling are on by default, and other integrations
connect when enabled or used.

## Local data, retention, export, and deletion

Alethe uses Tauri's platform-specific application local-data directory. It keeps a profile registry at
the root and isolates most state under `profiles/<profileId>/`. Typical data includes:

- `projects.json`: projects, groups, terminal and layout state, preferences, custom CLI paths, and
  recent items;
- `scrollback/*.bin`: terminal scrollback snapshots;
- `activity-stats.json`: local activity summaries;
- `spawn.log`: process-launch and suspension diagnostics, including command/launcher representations,
  a PATH preview, identifiers, and timing data;
- `github_sync.json` and `cloud_sync.json`: non-secret sync metadata (account login, plan, device id)
  when GitHub Gist Sync or Alethe Cloud is connected; the credentials themselves live in the
  operating-system keyring;
- `sync-state.json`: the last version of each Alethe Cloud scope this device synced, used to merge
  changes from other devices;
- `plugins/` and `plugin-data/<pluginId>.json`: installed local plugins and the record each one keeps
  through its storage API;
- `handoffs/<handoffId>/context.md`: a temporary cross-agent context packet when a handoff is used;
- `mcp/registry-cache.json` and MCP backup files: registry results and backups made while managing
  agent configuration; and
- root-level `logs/`: crash and frontend errors, resource snapshots, lifecycle messages, and
  `telemetry.jsonl` shared by the application installation.

Alethe also reads or modifies data outside its own directory when a feature requires it: repositories,
agent session histories, agent configuration and credential stores, MCP/skill directories, user-chosen
todo or export locations, and operating-system credential stores. The embedded browser uses a private
webview, but the operating-system webview and sites may still maintain process-level caches or other
state outside Alethe's profile directory.

### Retention

Most profile data remains until it is overwritten, the profile is deleted, or app data is reset.
There is no general time-based retention policy for local data. Alethe Cloud keeps synced documents
until the account is deleted, revisions for at most 30 days, revoked devices for 30 days, and data
from Supporter-only features for 30 days after a subscription ends. Crash and frontend errors keep at most 20 files per
prefix, and the newest 500 event traces are retained in memory. Profile `spawn.log`, root
`resource.log`, `app-events.log`, and `telemetry.jsonl` are append-only and currently have no rotation
or size cap. Scrollback and logs may contain commands, output, paths, timing/resource facts, error
messages, or payloads supplied by app features.

### Export and deletion controls

- **Backup export/import** writes a ZIP to a location the user chooses. A profile export includes the
  profile tree and handoff artifacts, except `.log` and `.tmp` files, embedded-webview runtime data,
  the shared browser session (`browser-session/`), MCP configuration backups (`mcp/backups/`),
  downloaded models and tools (`speech-models/`, `tools/`), and the device-bound Alethe Cloud files
  (`cloud_sync.json`, `sync-state.json`). Profile `spawn.log` is therefore excluded. Importing a backup
  keeps this device's Alethe Cloud session and resets its sync state, so the next sync merges without
  deleting anything. A file another program holds open is skipped and named instead of failing the
  export. The archive also carries `alethe-backup.json` with the profile name and the profile's local
  interface state (terminal prompt history, open Markdown tabs, folded settings sections), and the
  exported `projects.json` embeds the profile photo and project, group, and tab icons that were stored
  as links, so exporting downloads those images. Importing restores all of it. Treat exported backups
  as sensitive and delete old copies yourself.
- **Settings export/import** (Sync → File) writes a `.alethe` file with the same include-listed
  preferences, plugin state, project settings, and MCP/skill list that Alethe Cloud syncs. It never
  contains API keys, MCP secret values, terminals, or scrollback. Importing merges into local data and
  shows what will change first.
- **Log export** writes the files in the root `logs/` directory to a user-chosen ZIP. Review and redact
  it before sharing. It does not include profile `spawn.log`.
- **Delete profile** removes that profile directory; Alethe prevents deletion of the last profile.
- **Reset/factory reset** removes active-profile data or, for the full reset, the app local-data root.
  The reset is best effort while files are open, and the app should be relaunched afterward.
- **Spotify disconnect** removes the stored Spotify tokens. **GitHub Sync logout** clears its stored
  token but leaves non-secret sync metadata in `github_sync.json`.
- **Alethe Cloud sign out** revokes this device's session on the server and removes the local token,
  metadata, and sync state. **Download my cloud data** saves everything the server holds for the
  account as JSON. **Delete account** removes the account, its devices, synced documents, and
  revisions from the server and cancels an active subscription; local data is not touched.

Deleting Alethe data does not delete copies already exported or synced, repositories, coding-agent
histories/configuration, operating-system credentials, remote GitHub Gists, the Alethe Cloud account,
or data held by external services. Remove those at their source as well.

## Secrets and credentials

Alethe keeps integration credentials it owns in the operating-system keyring (service
`com.kc1t.alethe`, one entry per profile), and migrates older plaintext copies there on load:

- The Spotify client secret and the Spotify access and refresh tokens. The Spotify client ID stays in
  `projects.json`.
- The GitHub personal access token used by GitHub Gist Sync.
- The Alethe Cloud session token.
- The Fish Audio API key saved for the Agent Voice plugin. The plugin can set or clear it but never
  reads it back; only the backend uses it.

Some values are still plaintext: the 9router endpoint key in `projects.json`, and, when the Jev plugin
is installed, its OpenRouter decisions key in `plugin-data/alethe.jev.json`. Alethe Cloud and settings
exports never include them, but profile backups do. Uninstalling the plugin deletes its record.
- MCP credentials remain in the agent configuration files where the user adds them. Alethe masks
  environment values in normal MCP views and reveals one value only on explicit request, but config
  files and Alethe-created MCP backups can still contain plaintext secrets.
- Claude usage polling reads a token from `CLAUDE_OAUTH_TOKEN`, Claude Code's credentials file, or the
  OS keyring. Antigravity usage polling reads the `agy` credential from the OS keyring. Alethe uses
  these values for the request and does not intentionally copy them into Alethe profile persistence.
- Codex usage polling reads the ChatGPT access token and account ID that the Codex CLI stores in
  `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`). Alethe only reads that file and never
  refreshes or rewrites it; when the token is missing or rejected it falls back to a short-lived
  `codex app-server` subprocess, which keeps Codex responsible for its own authentication storage.

File protection therefore depends on OS account permissions and the security of any destination to
which a backup is copied. Do not place profile data, exports, logs, or agent configs in a public or
untrusted location.

## Local telemetry and diagnostics

The backend subscribes to Alethe's internal event bus on every launch. Each event, including its
arbitrary JSON `data` payload, is appended to `logs/telemetry.jsonl`; counts and selected numeric
fields are also kept in memory, with the newest 500 event traces retained in memory. The current
source contains no telemetry upload client or first-party analytics endpoint.

Crash, frontend, resource, app-lifecycle, and spawn diagnostics are also local. They can include stack
traces, process/resource facts, paths, messages, command/launcher representations, PATH previews,
identifiers, and terminal launch timings. Log export is a manual local operation; Alethe does not
automatically send the archive. Inspect both the archive and any separately shared `spawn.log` before
attaching them to an issue or email.

## Network and process inventory

"Default" below means a clean profile on the current `main` branch. A feature being visible or enabled
does not necessarily mean it sends a request before the stated trigger.

| Surface | Exact current default | What happens and where data goes |
|---|---|---|
| Automatic update check | **On** | Once app state hydrates, Alethe checks `https://github.com/Kc1t/alethe-agents/releases/latest/download/latest.json`. Download and installation happen only after the user accepts an available update; updater artifacts are signature-checked by the configured Tauri updater key. This is separate from platform publisher signing: current Windows installers are not code-signed and macOS builds are not notarized. There is currently no preference that disables the startup check. |
| Older versions | **On demand** | Clicking **Show older versions** in Preferences → About requests the release list from `https://api.github.com/repos/Kc1t/alethe-agents/releases`. Installing one downloads that release's `latest.json` and installer from `https://github.com/Kc1t/alethe-agents/releases`, checked against the same Tauri updater key as an update, and only after the user confirms. |
| Backup export | **On demand** | Exporting a backup downloads the images that the profile photo and project, group, and tab icons reference by URL, to embed them in the archive. A link that cannot be downloaded stays a link. |
| Provider usage polling | **On** | While the title bar is mounted, Alethe schedules Claude, Codex, and Antigravity usage reads shortly after startup and every five minutes; ticks are skipped while the window is unfocused/hidden. The three topbar indicators default visible. Claude sends its bearer credential to `https://api.anthropic.com/api/oauth/usage`; Antigravity sends its bearer credential to `https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`; Codex sends its bearer credential to `https://chatgpt.com/backend-api/wham/usage` and, when reset credits are available, to `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits` for their titles and expiry, falling back to a short-lived `codex app-server` subprocess when that read fails. While the orchestrator or agent canvas is open, they also read Codex usage every minute through the same 60-second cache as the title bar, so all three share at most one Codex read per minute. The current visibility preferences hide indicators but do not gate the polling effects. |
| Discord Rich Presence | **On** | Every 30 seconds, Alethe sends generic activity text (Alethe and the current app view, not project names) to the local Discord desktop IPC client. Discord controls any onward network publication under the Discord account's settings and terms. It can be disabled in Preferences. |
| Spotify Now Playing | **Off / unconfigured** | No Spotify request succeeds on a clean profile because credentials and OAuth tokens are absent. Connecting opens Spotify authorization, temporarily listens only on `127.0.0.1:8888`, exchanges/refreshes tokens at `accounts.spotify.com`, and polls current or recent playback at `api.spotify.com` when a Now Playing widget is enabled. Returned cover-image URLs may cause requests to Spotify's image host. |
| Alethe Cloud | **Off / signed out** | Signing in uses the GitHub device flow (`github.com/login/device/code`, `github.com/login/oauth/access_token`) and requests no GitHub scopes. The resulting GitHub token is sent once to the Alethe Cloud server (`https://cloud.kc1t.com`, hosted on Cloudflare Workers and D1), which reads the public GitHub profile and discards it; the server returns its own session token and registers the device by host name, platform, and app version. Synced data is limited to include-listed preferences, plugin enable state, project settings with the Git remote URL (embedded credentials are stripped), the folder each computer uses for the project (relative to its home folder) together with that computer's host name and a random installation id kept in the root `machine-id` file, and the MCP/skill list without secret values. Terminals, scrollback, API keys, and MCP secret values are never sent. Documents are stored as plaintext JSON, not end-to-end encrypted, with the previous version kept (free plan) or 30 days of versions (Supporter). On the free plan Alethe syncs when the user clicks Sync now or signs in, and checks once at startup whether another device changed something. On the Supporter plan it also syncs automatically after synced data changes, when the window gains focus, and every five minutes while focused. |
| Alethe Cloud billing | **Only when subscribing** | Supporter checkout and subscription management open Polar pages in the system browser. Polar is the merchant of record and processes payment details; Alethe Cloud only receives the subscription state for the GitHub account (`gh:<GitHub user id>`). |
| GitHub Sync | **Off / disconnected; manual** | Legacy and being retired: new connections are no longer offered, and a connected profile can only download. Pull downloads `projects.json` and, if present, `activity-stats.json` from the secret GitHub Gist uploaded earlier. A secret Gist is access-controlled by GitHub, not end-to-end encrypted by Alethe. |
| MCP registry | **MCP feature on; search on demand** | Local agent configs are scanned without registry traffic. Searching the add flow queries `https://registry.modelcontextprotocol.io/v0/servers` and caches the first page of up to 20 search terms under the profile. Adding a result writes agent configuration; package runtimes or remote URLs connect later when an agent/MCP client runs them. |
| MCP health checks and server tools | **On demand** | A Check action launches the selected coding-agent CLI so that CLI can test configured servers. The generic health probe may start a user-configured server command and probe it on an ephemeral loopback port. Those subprocesses and MCP servers can contact their configured hosts. |
| Embedded web content | **Browser feature on; no page open** | A page is loaded only after the user adds a URL. The desktop build creates an incognito native webview with autofill off; JavaScript is **on by default** for each pane. The visited site and all resources it embeds receive ordinary network requests and can observe data normally exposed by the OS webview and network. Incognito mode is not anonymity and does not stop the site from collecting data. |
| LAN Remote Control | **Off** | When enabled, Alethe binds plain HTTP and WebSocket listeners to the detected LAN interface, choosing ports in `9340–9360` (WebSocket starts at the next port range). Pairing is opened explicitly for two minutes and uses a token; clean-profile limits are one device, one-hour sessions, read-only access on, and shell input off. Terminal/workspace metadata and scrollback are then available to authenticated paired devices. A paired device that is not read-only can also start a Claude Code or Codex terminal in an existing project, and sees the orchestrator workers (task, status, summary, time, cost) running inside projects that share at least one terminal. Use only on a trusted LAN; the transport is not TLS-encrypted. |
| Agent-event hook listener | **On, loopback only** | At backend startup Alethe listens on the first available address from `127.0.0.1:9123–9143`. Requests require an in-memory `X-Alethe-Token`; Alethe writes a temporary hook configuration only when an agent workflow requests it. Hook payloads can feed the local event bus and therefore local telemetry. |
| AI Memory bridge | **Off** | The feature default is disabled. Detection, when requested, checks the local `ai-memory` executable and `127.0.0.1:49374`; configured agent sessions run the third-party `ai-memory mcp` subprocess over stdio. Its own storage and network behavior belong to that tool. |
| Agent Voice speech | **Plugin not installed** | Only with the external Agent Voice plugin installed, enabled and given a Fish Audio key: each line it speaks (the opening sentences of an agent's reply, up to about 25 words, or a fixed line when a shell exits) is sent with the key to `https://api.fish.audio/v1/tts` by the Alethe backend, which streams the audio back. With Reply by voice on, the microphone opens after a voice ends and the recording is transcribed on the device. |
| Development server | **Development only** | `npm run dev` and `npm run app` start Vite with hot-module reload on a loopback development port. This server and development CSP are not part of packaged releases; do not expose the development server to an untrusted network. |
| Git remotes, installers, and external links | **On demand** | Clone, fetch/pull/push, agent install/update/uninstall, and opened links run only after a user action. Alethe delegates to Git, package managers/vendor installers, or the system browser; those tools contact the user-selected remote or their package/vendor services and apply their own credential and telemetry rules. |

## Coding-agent CLIs and other subprocesses

Claude Code, Codex, Copilot, Antigravity, OpenCode, Mimo, Freebuff, shells, Git, package managers, MCP
servers, Graphify, and user-entered commands are separate processes. Alethe supplies their command-line
arguments, selected working directory, PTY input/output, and an inherited or constructed environment.
They may read repositories and home-directory configuration, use credentials they own, retain their
own histories, and contact provider or tool endpoints. Alethe's local-first design does not proxy,
block, audit, or make those subprocesses local-only. Review each tool's permissions, privacy terms,
configuration, and unrestricted/approval mode before launching it.

## Handoff artifacts and redaction limits

A Claude-to-Codex or Codex-to-Claude handoff reads the selected provider's local session history and
builds an editable Markdown context packet. The dialog offers two scopes and remembers the last one
chosen. **Full conversation**, the default, can include user and assistant messages, clipped tool
calls/output, working-directory and Git metadata including the names of changed files, and the source
session identifier. **Only my messages** includes the user-authored messages, the working directory,
branch, commit, a count of changed entries and a numeric diff summary, and the source session
identifier; assistant messages, tool calls and tool output are left out. Before showing the draft,
Alethe applies regular-expression redaction for several common token, credential, header, and
private-key patterns, and applies it again to the edited packet when it is saved.

That redaction is best effort, not a guarantee. Unusual secrets, confidential prose, source code,
paths, identifiers, or credentials split across text can remain. Review and edit the draft before
starting the target agent. Materializing a handoff writes
`handoffs/<handoffId>/context.md`, owner-only on Unix and never over an existing file; Alethe requests cleanup after the first target turn or when the pane
closes, but a crash or interrupted flow can leave the file behind until manual/profile deletion. The
target agent then reads the packet and may send its contents to that agent's provider under the
provider's terms.

## Embedded content, CSP, and privileged commands

Remote pages are placed in separate incognito native webviews, while the main Alethe UI invokes the
Tauri backend. The production configuration currently sets `csp` to `null`. A Content Security Policy,
when configured, is **defense in depth**, not privileged-command containment and not an authorization
boundary for Tauri commands. Treat content from web pages, repositories, terminal output, handoff
packets, agent histories, and MCP metadata as untrusted regardless of CSP.

## Third-party services

External requests disclose ordinary connection metadata such as IP address, time, TLS and HTTP
metadata, plus the request-specific account credential or content described above. Third parties set
their own retention, logging, training, and deletion rules. Consult and configure the relevant
provider before enabling an integration or launching a tool.

For a suspected security problem, follow [`SECURITY.md`](../SECURITY.md). For a non-security bug or
documentation correction, use the
[public issue tracker](https://github.com/Kc1t/alethe-agents/issues).
