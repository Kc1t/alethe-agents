# Guiding the install of ai-memory — Design

Date: 2026-09-25 (rewritten the same day; see §1)
Status: approved in conversation, pending spec review

## 1. What this replaces

The first version of this spec opened by saying Alethe and
[ai-memory](https://github.com/akitaonrails/ai-memory) "know nothing about each other". That was
false, and it was found out one task into implementation: `src-tauri/src/ai_memory.rs` already
existed — 195 lines from `main`, declared at `lib.rs:5` — and the integration is live. The spec was
written from `router9.rs` as a template without ever grepping for `ai_memory`.

This rewrite keeps what the first version got right (the release assets, the hash chain, the hook
composition, all verified by running the real binary) and drops what it invented: a parallel status
type, a second MCP registration path, a new Preferences section, and a consent switch separate from
the feature toggle.

## 2. What already works

Verified by reading the shipped code:

- `ai_memory_detect` (`ai_memory.rs:81`) returns `AiMemoryStatus { installed, running, command,
  endpoint, version }`, with a loopback health check against `127.0.0.1:49374`.
- `ai_memory_mcp_config_path`, `ai_memory_opencode_config_write` and `ai_memory_codex_config_write`
  write the MCP registration per agent — Claude through an ephemeral `--mcp-config`, Codex and
  OpenCode through in-repo config files.
- `useXtermSession.ts:1136-1156` runs all of that at terminal launch: when
  `enabledFeatures.aiMemory` is on and the command is claude, codex or opencode, it detects the
  binary and writes that agent's config. If the binary is missing it shows one toast —
  `aiMemory.notInstalledTitle` — and, because `aiMemoryMissingWarned` is module-level
  (`useXtermSession.ts:121`), **only once per app run**.
- The feature has an entry in `FEATURES` (`src/lib/features.ts:54`), a `BrainCircuit` icon, an
  onboarding entry, and defaults to off.

So querying memory already works, end to end, for three agents. Nothing in this design touches it.

## 3. The problem

You can turn the feature on with nothing installed. Alethe accepts the switch, writes no config, and
tells you once — in a toast, from inside a terminal, after the fact. The person who wanted memory is
left with a feature that says "enabled" and does nothing, and no route to fixing it.

9router set the pattern for the opposite: an external binary Alethe helps install, keeps in the
profile folder, reports the state of, and can start and stop. ai-memory needs the same, and one
thing more that 9router has no equivalent of — the capture side, which is hooks.

## 4. Goals

- Turning the feature on **leads to a working install**, from inside the app.
- Start it and stop it, and say whether it is running.
- Capture what agents do, not just answer their queries — the hooks half of ai-memory.
- Say what capture means before it starts.
- Work on every platform Alethe supports that upstream publishes a build for.

## 5. Non-goals

- **Not a second MCP path.** The per-agent config writing in §2 works; this design adds nothing
  beside it. The first version of this spec proposed registering through `mcp_store` as well, which
  would have left two mechanisms writing the same registration.
- **Not a new status type.** `AiMemoryStatus` exists; it gains fields, it is not replaced.
- **Not a new Preferences section.** §6.1 explains where this goes instead.
- **Not a separate consent switch.** The feature toggle is the consent.
- **Not a plugin.** A plugin cannot spawn a process, write a settings file or open a port —
  `spawn_pty`, `write_pty`, `write_text_file` and `delete_filesystem_entry` are all in
  `FORBIDDEN_COMMANDS` (`src/lib/plugins/permissions.ts:32`).
- **Not `ai-memory run`.** That subcommand launches the agent itself; Alethe is the launcher.

## 6. The design

### 6.1 Where it lives: under the toggle that turns it on

`FeaturesPage.tsx:51` already does this for another feature: `feature.id === 'playwright' && enabled`
renders a sub-panel of that feature's own controls directly beneath its switch. ai-memory gets the
same treatment.

Turn AI Memory on, and the panel below it says whether the binary was found and offers what is
missing: **Install** when there is none, the running state and **Start** / **Stop** when there is,
the port, and where its data lives. The guidance arrives at the moment the person asked for the
feature — not later, in a toast, from a terminal.

This replaces the first version's new section in Integrations. A second place to configure a feature
whose switch lives here would mean finding the switch and then finding the controls somewhere else.

**Turning it on with nothing installed stays allowed.** The sub-panel is what makes that state
useful, and refusing the switch until a binary exists would be a toggle that rejects the click that
asks for help. The existing once-per-run toast stays as the backstop for someone who never opens
Preferences.

### 6.2 One switch

Turning the feature on is the consent. The copy under the switch says what gets recorded — every
prompt and every tool call from agents Alethe launches — and where it lives: a git-versioned
markdown wiki plus a SQLite index, both on this machine, both readable without Alethe.

Two switches for one decision was the first version's mistake. A person who turns on "AI Memory" and
then has to find "let agents capture to memory" has been asked the same question twice, and the
second one reads like a trap.

### 6.3 Install

`AiMemoryStatus` gains what the panel needs: whether the copy is one Alethe installed or one found on
`PATH`, and whether upstream publishes a build for this machine at all.

The asset is chosen by platform **and** architecture, verified against the `.sha256` the release
publishes, and unpacked into the profile folder beside 9router's copy. Windows on ARM has no asset:
the panel says upstream publishes no build for this machine and offers no button, rather than
downloading a 404.

**A copy the person installed themselves wins.** `ai_memory_detect` already resolves a command off
`PATH`; when it finds one, Alethe uses it and says so. Someone already running this service has a
data directory and a configuration, and shadowing it with our own copy would split their memory in
two. Only a copy Alethe installed is told where to keep its data.

### 6.4 Lifecycle

`serve --transport http --bind 127.0.0.1:<port>`, started and stopped from the panel. The counts come
from the binary's own `status` — pages, sessions, observations — so the panel reports what the
service says rather than what Alethe assumes.

The port is configurable. Something already answering on it, that Alethe did not start, is reported
as exactly that: most likely the person's own instance, which is a reason to leave it alone rather
than fight for the bind.

### 6.5 Capture: the hooks

This is the half that does not exist, and the reason the whole design is worth building.

Alethe already writes a Claude settings file per terminal — namespaced by listener port and planner
id, with `"type": "http"` hooks carrying a token back to Alethe — and launches Claude with
`--settings <that file>` (`agent_events.rs:71`, `sessionLaunch.ts:79`). ai-memory's
`install-hooks --agent claude-code` prints `"type": "command"` hooks that run
`ai-memory hook --event <event>`.

So Alethe composes those into its own file, and never runs `install-hooks --apply`.

One writer owns that file; the person's `~/.claude/settings.json` is never touched; the scope is per
terminal, so memory can be on for one project and off for another; and stopping the integration
simply stops writing them.

**This was tested before being designed.** A session ran with ai-memory's hooks in a project
`.claude/settings.json` and a second hook passed through `--settings`: the `--settings` hook fired
*and* ai-memory captured the session — 1 session, 4 observations, 1 page. It matches the documented
behaviour: `--settings` "merges JSON you pass … with your settings files", and "when you set the same
list key in more than one file, Claude Code combines the lists instead of picking one".

Claude first. Codex and OpenCode take their hooks a different way, and ai-memory ships scripts for
both — each is its own piece of work, and this design does not claim a generality nobody has run.

## 7. What was verified against the real binary

ai-memory **2.4.0**, on this machine:

- Assets for Linux `x86_64`/`aarch64`, macOS `x86_64`/`aarch64`, Windows `x86_64`. **No Windows
  `aarch64`.** Every asset publishes a `.sha256`; the Windows zip's matched the served bytes.
- The Windows zip holds `ai-memory.exe` (46,249,984 bytes) plus hook scripts in `.sh` and `.ps1` for
  claude-code, codex, cursor, opencode and kiro-cli.
- `serve --transport http` bound `127.0.0.1:49374`; an MCP `initialize` returned
  `protocolVersion 2024-11-05`, `capabilities.tools`, `serverInfo ai-memory 2.4.0`.
- `install-hooks` and `install-mcp` **print without applying**.
- Hook events for claude-code: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `PreCompact`, `Stop`, `SessionEnd`, `SubagentStart`, `SubagentStop`.

**Not verified:** the `http` + `command` combination specifically — the test used two `command`
hooks, because Alethe's listener was not running; hook *type* takes no part in the merge. Nothing was
run on Linux or macOS.

## 8. Testing

- Pure functions, unit-tested: the asset for a platform and architecture, including the case with
  none; composing ai-memory's hook entries into Alethe's hooks object without losing either side's;
  choosing between a managed copy and one on `PATH`; whether the panel offers Install, Start, or
  neither.
- Rust: the download verifies the published hash and refuses a mismatch without leaving a file
  behind — sharing `plugin_package.rs`'s verifier rather than writing a second one.
- By hand: turn the feature on with nothing installed and follow the panel to a working install; ask
  an agent something and confirm with `status` that it was captured; turn the feature off, open a new
  terminal, and confirm nothing new is captured while the terminal already open keeps working.

## 9. Alternatives rejected

- **A section in Integrations beside 9router** (the first version's choice). Splits one feature
  across two screens: the switch in Features, the controls elsewhere.
- **Refusing the toggle until a binary exists.** Tidier state, and it rejects the click that is
  asking for help.
- **A separate consent switch.** Asks one question twice.
- **Registering through `mcp_store` as well.** A second mechanism writing the same registration,
  competing with the `--mcp-config` file the existing code already writes.
- **Bundling the binary.** No install step, and Alethe ships and answers for a 46 MB third-party
  binary.
- **Docker only.** Requires Docker Desktop on Windows and macOS for no gain: native builds exist for
  every platform Alethe supports but one.
