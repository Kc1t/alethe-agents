<a id="readme-top"></a>

<br />
<div align="center">
  <a href="https://github.com/Kc1t/alethe-agents">
    <img src="./src/assets/theme-icons/elite-indigo.png" alt="Alethe Logo" width="160">
  </a>

  <h1 align="center">Alethe</h1>

  <p align="center">
    <b>The multi-agent coding workspace.</b>
    <br />
    Run Claude Code, Codex, Copilot and your shells side by side — in one local-first desktop app.
  </p>

  <p align="center">
    <a href="https://github.com/Kc1t/alethe-agents/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Kc1t/alethe-agents/ci.yml?branch=main&label=ci&style=flat-square"></a>
    <a href="https://github.com/Kc1t/alethe-agents/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/Kc1t/alethe-agents?style=flat-square"></a>
    <a href="https://github.com/Kc1t/alethe-agents/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/Kc1t/alethe-agents?style=flat-square"></a>
    <a href="https://github.com/Kc1t/alethe-agents/graphs/contributors"><img alt="Contributors" src="https://img.shields.io/github/contributors/Kc1t/alethe-agents?style=flat-square"></a>
    <a href="https://github.com/Kc1t/alethe-agents/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/Kc1t/alethe-agents?style=flat-square"></a>
    <a href="https://github.com/Kc1t/alethe-agents/issues"><img alt="Open issues" src="https://img.shields.io/github/issues/Kc1t/alethe-agents?style=flat-square"></a>
  </p>

  <p align="center">
    <a href="https://github.com/Kc1t/alethe-agents/releases">Download</a>
    ·
    <a href="https://github.com/Kc1t/alethe-agents/issues/new?labels=bug">Report Bug</a>
    ·
    <a href="https://github.com/Kc1t/alethe-agents/issues/new?labels=enhancement">Request Feature</a>
    ·
    <a href="./SECURITY.md">Security</a>
    ·
    <a href="./docs/PRIVACY.md">Privacy</a>
    ·
    <a href="#contributing">Contribute</a>
  </p>
</div>

> [!IMPORTANT]
> Alethe is an early public release. The desktop app is free, open source, and local-first, not
> local-only: update checks and provider usage polling are on by default, while other network features
> are optional or action-triggered. Manual GitHub Gist Sync is already available; first-party hosted
> sync or cloud backup may be offered separately later. See the
> [privacy and data-flow guide](./docs/PRIVACY.md).

<div align="center">
  <img src="./docs/assets/alethe-preview.gif" alt="Alethe multi-agent coding workspace preview" width="760">
</div>

## What Alethe Is

One agent in one terminal is easy. Five agents across three repositories is the actual job — and
that is where terminal tabs stop working: sessions get lost, MCP servers drift out of sync between
agents, and nobody knows which agent is doing what, where.

**Alethe is a desktop workspace built for that.** Every agent runs in a real PTY inside a persistent
project layout, keeps its own session and history, and stays alive when you rearrange the UI. On top
of that, Alethe manages the things agents share: their CLIs, their MCP servers, their skills, and the
conversations you move between them.

Cross-platform (Windows, macOS, Linux), local-first, built with Tauri, Rust, React, and `xterm.js`.
“Local-first” describes workspace persistence, not an internet-free guarantee; see
[`docs/PRIVACY.md`](./docs/PRIVACY.md) for current network defaults, credentials, and retention.

## Supported Platforms

<table>
  <tr>
    <th width="33.33%">macOS</th>
    <th width="33.33%">Windows</th>
    <th width="33.33%">Linux</th>
  </tr>
  <tr>
    <td align="center">
      <img src="./docs/screenshots/alethe-macos.png" alt="Alethe running on macOS" width="100%">
    </td>
    <td align="center">
      <img src="./docs/screenshots/alethe-windows.png" alt="Alethe running on Windows" width="100%">
    </td>
    <td align="center">
      <img src="./docs/screenshots/alethe-linux.png" alt="Alethe running on Linux" width="100%">
    </td>
  </tr>
  <tr>
    <td align="center">Available on macOS</td>
    <td align="center">Available on Windows</td>
    <td align="center">Available on Linux</td>
  </tr>
</table>

## Agents

| Agent | CLI | |
|---|---|---|
| **Claude Code** | `claude` | Session resume, usage cards, local history |
| **Codex** | `codex` | Session resume, usage cards |
| **GitHub Copilot CLI** | `copilot` | |
| **Antigravity** | `agy` | Usage cards |
| **OpenCode** | `opencode` | Session resume |
| **Mimo** | `mimo` | |
| **Freebuff** | `freebuff` | |
| **Shell** | pwsh / bash / zsh | The plain terminal, same pane model |

Missing CLIs can be installed, updated, and uninstalled from inside Alethe — it probes the machine
for Node, npm, WinGet, Scoop, and Chocolatey and offers only the methods that actually work there,
preferring each vendor's official installer. Already-installed CLIs are discovered across PATH,
registry, npm/pnpm/Volta/fnm/nvm/Bun/Cargo/Scoop/Chocolatey, and can be pointed at a custom path.

## What It Does

**Run agents in parallel**

- Projects, groups, and subgroups organize repositories; each open project becomes a container with
  its own panes.
- One agent per pane, or several agents as sub-tabs inside the same pane — each with its own PTY,
  working directory, and session.
- Auto, spotlight, sidebar, and custom grid layouts, editable directly on the grid.
- Closing a container hides it; the process keeps running.

**Keep the context**

- Sessions of Claude Code, Codex, and OpenCode resume after a crash or a restart.
- **Recent chats** lists the conversations of a pane's working directory and reopens any of them.
- A Claude Code conversation can be **handed off to Codex** (and back) through a locally redacted
  context packet — no copy-pasting the thread by hand. Redaction is best effort, so review the packet
  before starting the target agent.
- Scrollback is persisted per PTY, so reattaching shows what happened before.

**Manage what the agents share**

- **MCP tab**: every MCP server configured on the machine, grouped by server and showing which agents
  have it — read from Claude Code, Codex, OpenCode, and Antigravity configs. Add, remove, copy a
  server from one agent to another, search the official registry, and ask each agent to verify it can
  really reach a server. Every write is backed up, re-parsed, and committed atomically.
- **Skills tab**: the skills installed for each agent, with links and shared stores resolved so a
  shared skill shows up once.
- **Graphify**: a code graph of the project, served to the agents as an MCP server.

**Stay in control**

- RAM readout in the title bar; disable a terminal or suspend a whole group to get memory back.
- Git panel per project — status, stage, commit, branches, diffs in a pane — plus worktrees for
  parallel tasks.
- Content panes beside the terminals: file explorer, Markdown, diffs, images, video, embedded browser.
- Todos per project, isolated profiles, local backup export/import, 14 UI and terminal themes,
  EN and pt-BR.
- **Remote Control**: an authenticated LAN web view, paired by QR code, to follow and answer agents
  from your phone. It is off by default and uses unencrypted HTTP/WebSocket transport on the LAN, so
  enable it only on a trusted network. Clean profiles are read-only; answering agents requires a
  separate input opt-in, and shell input has its own additional opt-in.
- Spotify Now Playing, using your own Spotify app credentials in **Preferences ▸ Spotify** with
  `http://127.0.0.1:8888/callback` as the redirect URI. Current releases store those credentials in
  local profile files; see the privacy guide before exporting or sharing profile data.

## Core Concepts

| | |
|---|---|
| **Group** | A collection of projects that opens, collapses, and suspends together. |
| **Project** | A saved working context: terminals, layout, color, local state. |
| **Container** | The visible frame of an opened project. Closing it does not kill anything. |
| **Pane** | A terminal view inside a container. |
| **Sub-tab** | A separate agent or shell session inside the same pane. |
| **PTY** | The real backend process, alive independently of the UI. |

## Product Philosophy

A focused core with optional capabilities, closer to Obsidian than to a maximalist IDE. Non-essential
features ship behind feature flags or opt-in settings, and a clean installation stays a first-class
experience. Coherence over volume.

## Install

Use the published installers from [Releases](https://github.com/Kc1t/alethe-agents/releases).

> [!WARNING]
> Windows builds are **not code-signed yet**, so Defender may flag `alethe.exe` as
> `Trojan:Win32/Bearfoos.A!ml` and quarantine it. The `!ml` suffix denotes a machine-learning
> heuristic rather than a publisher signature, and terminal-multiplexer behavior such as spawning
> child processes and creating PTYs can produce false positives. Verify that the download came from
> the official Releases page; do not bypass a warning for an artifact from another source.

To recover it: **Windows Security → Virus & threat protection → Protection history → Actions →
Restore**, then add an exclusion for `%LOCALAPPDATA%\Alethe` (and `src-tauri/target` if you build
from source). Reports of incorrect detection go to
[Microsoft Security Intelligence](https://www.microsoft.com/wdsi/filesubmission). macOS builds are
not notarized yet either — right-click the app and choose **Open** to bypass Gatekeeper. Signing and
notarization are on the [roadmap](#roadmap).

## Run From Source

```sh
git clone https://github.com/Kc1t/alethe-agents.git
cd alethe-agents
npm install
npm run app
```

Requirements: Node.js 18+, Rust stable, Visual Studio Build Tools on Windows, Tauri system
dependencies on Linux:

```sh
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

```sh
npm run app          # desktop app with hot reload
npm run dev          # frontend only
npm run build        # typecheck + build frontend
npm run tauri build  # installers → src-tauri/target/release/bundle/
```

## Terminal Command

Install the `alethe` command from **Settings ▸ Integrations ▸ Terminal command**:

```bash
alethe                # opens the current folder as a project
alethe ~/some/project # opens the given folder
```

If the folder is already a project, it is brought into the workspace instead of duplicated. If Alethe
is already running, the existing window is focused. The command lands in `~/.local/bin/alethe`
(macOS/Linux) or `%LOCALAPPDATA%\Alethe\bin\alethe.cmd` (Windows) — reinstall it after moving the app.

## Roadmap

- [x] Multi-agent workspace with projects, groups, containers, and sub-tabs.
- [x] Real PTYs with spawn, attach, resize, scrollback, and session resume.
- [x] Agent install/update/uninstall, MCP and skills management.
- [x] Releases for Windows, Linux, and macOS.
- [ ] Windows release signing and macOS notarization.
- [ ] Broader Linux/macOS validation on real machines.
- [ ] First-party hosted cloud sync/backup (manual GitHub Gist Sync is already available).

## Contributing

Contributions are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, project layout, and
house rules. The easiest ways to help:

- Pick an issue labeled [`good first issue`](https://github.com/Kc1t/alethe-agents/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) or [`help wanted`](https://github.com/Kc1t/alethe-agents/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) — comment to claim it.
- Report a bug with clear reproduction steps, or request a feature with the workflow it improves.
- Improve docs, screenshots, and platform validation — Linux and macOS are the least tested.

For larger changes, open an issue first so the direction can be discussed.

## Built with Alethe

Projects and products built with Alethe as the workspace — agents running in parallel, shells alongside them, sessions resumed across days.

<!-- showcase:start -->

_Nothing here yet._ Built something with Alethe? Add it to [`SHOWCASE.md`](SHOWCASE.md) — it's one line and a pull request, and you end up in the contributors list too.

<!-- showcase:end -->

See [`SHOWCASE.md`](SHOWCASE.md) for the full list and how to submit.

## Watch Alethe in Action

See Alethe in real development workflows and learn how to orchestrate coding agents in parallel.

<table>
  <tr>
    <th width="38%">Video</th>
    <th>What you will see</th>
  </tr>
  <tr>
    <td>
      <a href="https://www.youtube.com/watch?v=8jvrucR7QCU&amp;t=54s">
        <img src="https://i.ytimg.com/vi/8jvrucR7QCU/hqdefault.jpg" alt="Stop Using One AI Agent at a Time: Orchestrate AI Agents" width="100%">
      </a>
    </td>
    <td>
      <strong><a href="https://www.youtube.com/watch?v=8jvrucR7QCU&amp;t=54s">Stop Using One AI Agent at a Time: Orchestrate AI Agents</a></strong>
      <br><br>
      A practical introduction to coordinating multiple AI coding agents instead of working with only one at a time.
      <br><br>
      <sub>Kauã Miguel - Dev · Portuguese</sub>
    </td>
  </tr>
  <tr>
    <td>
      <a href="https://www.youtube.com/watch?v=reUN7CkMbgM&amp;t=100s">
        <img src="https://i.ytimg.com/vi/reUN7CkMbgM/hqdefault.jpg" alt="A Day in the Life of a Software Developer — Devlog 1" width="100%">
      </a>
    </td>
    <td>
      <strong><a href="https://www.youtube.com/watch?v=reUN7CkMbgM&amp;t=100s">A Day in the Life of a Software Developer — Devlog 1</a></strong>
      <br><br>
      A real-world developer workflow showing Alethe as part of the day-to-day coding process.
      <br><br>
      <sub>Guilherme Dev · Portuguese</sub>
    </td>
  </tr>
</table>

## Contributors

Thanks to everyone helping shape Alethe.

<p align="center">
  <!-- contributors:start -->
  <a href="https://github.com/Kc1t"><img src="https://github.com/Kc1t.png?size=100" width="80" height="80" alt="Kc1t" title="Kc1t" /></a>
  <a href="https://github.com/MiguelSilvaPorto"><img src="https://github.com/MiguelSilvaPorto.png?size=100" width="80" height="80" alt="MiguelSilvaPorto" title="MiguelSilvaPorto" /></a>
  <a href="https://github.com/HayatoG"><img src="https://github.com/HayatoG.png?size=100" width="80" height="80" alt="HayatoG" title="HayatoG" /></a>
  <a href="https://github.com/slegarraga"><img src="https://github.com/slegarraga.png?size=100" width="80" height="80" alt="slegarraga" title="slegarraga" /></a>
  <a href="https://github.com/lucapohl-angel"><img src="https://github.com/lucapohl-angel.png?size=100" width="80" height="80" alt="lucapohl-angel" title="lucapohl-angel" /></a>
  <a href="https://github.com/potatoiscompiled"><img src="https://github.com/potatoiscompiled.png?size=100" width="80" height="80" alt="potatoiscompiled" title="potatoiscompiled" /></a>
  <a href="https://github.com/Jbnado"><img src="https://github.com/Jbnado.png?size=100" width="80" height="80" alt="Jbnado" title="Jbnado" /></a>
  <a href="https://github.com/chintanparmar011"><img src="https://github.com/chintanparmar011.png?size=100" width="80" height="80" alt="chintanparmar011" title="chintanparmar011" /></a>
  <a href="https://github.com/AshSgDe29071999"><img src="https://github.com/AshSgDe29071999.png?size=100" width="80" height="80" alt="AshSgDe29071999" title="AshSgDe29071999" /></a>
  <a href="https://github.com/rlevidev"><img src="https://github.com/rlevidev.png?size=100" width="80" height="80" alt="rlevidev" title="rlevidev" /></a>
  <a href="https://github.com/mapsiva"><img src="https://github.com/mapsiva.png?size=100" width="80" height="80" alt="mapsiva" title="mapsiva" /></a>
  <a href="https://github.com/moisesz10"><img src="https://github.com/moisesz10.png?size=100" width="80" height="80" alt="moisesz10" title="moisesz10" /></a>
  <a href="https://github.com/Bakurin0"><img src="https://github.com/Bakurin0.png?size=100" width="80" height="80" alt="Bakurin0" title="Bakurin0" /></a>
  <a href="https://github.com/SrAmaral"><img src="https://github.com/SrAmaral.png?size=100" width="80" height="80" alt="SrAmaral" title="SrAmaral" /></a>
  <a href="https://github.com/diegoliveiraa"><img src="https://github.com/diegoliveiraa.png?size=100" width="80" height="80" alt="diegoliveiraa" title="diegoliveiraa" /></a>
  <a href="https://github.com/1arley"><img src="https://github.com/1arley.png?size=100" width="80" height="80" alt="1arley" title="1arley" /></a>
  <a href="https://github.com/VicktorMS"><img src="https://github.com/VicktorMS.png?size=100" width="80" height="80" alt="VicktorMS" title="VicktorMS" /></a>
  <a href="https://github.com/rad4manthys"><img src="https://github.com/rad4manthys.png?size=100" width="80" height="80" alt="rad4manthys" title="rad4manthys" /></a>
  <a href="https://github.com/lucianoschirmer"><img src="https://github.com/lucianoschirmer.png?size=100" width="80" height="80" alt="lucianoschirmer" title="lucianoschirmer" /></a>
  <a href="https://github.com/lb1192176991-lab"><img src="https://github.com/lb1192176991-lab.png?size=100" width="80" height="80" alt="lb1192176991-lab" title="lb1192176991-lab" /></a>
  <a href="https://github.com/hgshreyas"><img src="https://github.com/hgshreyas.png?size=100" width="80" height="80" alt="hgshreyas" title="hgshreyas" /></a>
  <a href="https://github.com/fernando-c-lima"><img src="https://github.com/fernando-c-lima.png?size=100" width="80" height="80" alt="fernando-c-lima" title="fernando-c-lima" /></a>
  <a href="https://github.com/feejunior"><img src="https://github.com/feejunior.png?size=100" width="80" height="80" alt="feejunior" title="feejunior" /></a>
  <a href="https://github.com/eudehh"><img src="https://github.com/eudehh.png?size=100" width="80" height="80" alt="eudehh" title="eudehh" /></a>
  <a href="https://github.com/tomatotomata"><img src="https://github.com/tomatotomata.png?size=100" width="80" height="80" alt="tomatotomata" title="tomatotomata" /></a>
  <a href="https://github.com/ThiagoSales17"><img src="https://github.com/ThiagoSales17.png?size=100" width="80" height="80" alt="ThiagoSales17" title="ThiagoSales17" /></a>
  <a href="https://github.com/opedrooz"><img src="https://github.com/opedrooz.png?size=100" width="80" height="80" alt="opedrooz" title="opedrooz" /></a>
  <a href="https://github.com/devmatheusmota"><img src="https://github.com/devmatheusmota.png?size=100" width="80" height="80" alt="devmatheusmota" title="devmatheusmota" /></a>
  <a href="https://github.com/JohnPss"><img src="https://github.com/JohnPss.png?size=100" width="80" height="80" alt="JohnPss" title="JohnPss" /></a>
  <a href="https://github.com/GabrielKLopes"><img src="https://github.com/GabrielKLopes.png?size=100" width="80" height="80" alt="GabrielKLopes" title="GabrielKLopes" /></a>
  <a href="https://github.com/floze-the-genius"><img src="https://github.com/floze-the-genius.png?size=100" width="80" height="80" alt="floze-the-genius" title="floze-the-genius" /></a>
  <a href="https://github.com/aryansk"><img src="https://github.com/aryansk.png?size=100" width="80" height="80" alt="aryansk" title="aryansk" /></a>
  <!-- contributors:end -->
</p>

## License

The source code is distributed under **AGPL-3.0-or-later**. See [`LICENSE`](LICENSE) for details.
Official hosted services, such as sync, backup, billing, or cloud features, may be proprietary and
offered separately. The **Alethe** name, logo, and official branding are reserved for official builds
— see [`TRADEMARK.md`](TRADEMARK.md).

## Community

- Security reports: [`SECURITY.md`](SECURITY.md)
- Privacy and data flows: [`docs/PRIVACY.md`](docs/PRIVACY.md)
- Maintainer: [Kc1t](https://github.com/Kc1t)
- Project: <https://github.com/Kc1t/alethe-agents>
- Bugs and feature requests: <https://github.com/Kc1t/alethe-agents/issues>
