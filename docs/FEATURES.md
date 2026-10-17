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

## Local Telemetry and Privacy

- Runtime metrics and recent traces stay in memory for the Multi-Agent views.
- The local `logs/telemetry.jsonl` file contains only event envelope fields and finite numeric
  `duration_ms`, `cost_usd`, and `memory_mb` values; arbitrary event data is never persisted.
- The telemetry log is capped at 2 MiB by replacing old content before a new entry would cross the
  limit, and is created with owner-only permissions on Unix.
- Alethe has no telemetry uploader; this data stays on the device.

## Backup

- Export local state as a `.zip`.
- Include `projects.json` and scrollback files.
- Import backup by replacing local state.
- Protect against zip-slip during import.
- Use atomic project-file writes to reduce corruption risk.

## Speech models

- Preferences → Voice picks the speech-to-text model per use: Dictation, and Conversation (also
  used by the Jev voice bar). A local model is the default; a cloud provider is used only when
  chosen for that use (see Voice providers).
- **Apple (native)** appears on Mac only: on-device recognition, no download, one language chosen
  once. On macOS 26 a language that is not installed can be installed from the picker.
- **Parakeet** is multilingual (about 670 MB download); **Zipformer** is English.
- A Mac that never picked a model moves to Apple (native) once, unless Parakeet is already downloaded.
- **Hugging Face search.** In the local models view, a search mode queries Hugging Face for more
  voices and recognizers (only while the search tab is open). Only models Alethe can run are
  listed: Piper, Kokoro and Kitten voices; Whisper, SenseVoice, Paraformer, Zipformer, Parakeet,
  NeMo CTC, Moonshine and Dolphin recognizers. Results use the same table, details and pausable
  downloads as built-in models; tiers marked "≈" are estimates and the size shows "…" while a
  result's files are checked (the first 10 results of each page right away, any other one when its
  details open). A multi-voice model that narrates gets a speaker picker. A Hugging Face
  model that is not ready can be removed from its row. Downloaded models live in
  `profiles/<profileId>/speech-models/hf--{author}--{repo}/` under the app's local data directory.

## Voice Conversation

- Opt-in under Preferences → Voice; it transcribes with the provider chosen in the Conversation tab
  (a local model by default) and uses the dictation microphone. Its hooks apply to Claude panes
  opened after it is turned on.
- Agents: any agent Alethe runs in a pane can be talked to (Claude Code, Codex, OpenCode, the other
  built-ins and custom agents; never a shell). Claude Code gets the full narration and voice
  approvals through its hooks. Codex is narrated from its session transcript. Any other agent is
  driven through its terminal: its turn ends when its output goes quiet and its reply is read off
  the screen; when it stops on its own approval menu, voice says it is asking in the terminal.
- Capture: the in-window shortcut Ctrl+Shift+Space (⌘⇧Space on macOS) works as push-to-talk (hold)
  or toggle (press, press). Adding Alt sends the request to Jev.
- Target: the active agent pane by default, changeable from the picker on the panel, which names
  the agent of each session.
- Panel: docked at the bottom of the main window with a live waveform, transcript, narration text and
  a permission card (Allow / Deny / Answer in the terminal). Drag the strip at its top to move it
  anywhere inside the window; it comes back there and stays inside the window when it is resized.
  Preferences → Voice → Conversation → Panel position puts it back at the bottom center.
- Narration: one toggle per kind of thing spoken — text between steps, thinking (Claude Code with
  thinking on, Codex's reasoning summaries; other agents don't expose it), actions ("Running the
  tests."), status after a silence, the final answer, permission requests and questions the agent
  asks you. The presets Silent, Final answer only, Normal and Detailed set the toggles at once;
  any other mix shows as Custom. The narration provider, voice and speed are selectable, and
  "Speaking while Claude works" chooses whether your message queues for Claude's next turn or
  interrupts it first. Permission requests are not spoken while the approval channel is Panel only.
- Permissions: answer by voice in English or Portuguese; "no, <reason>" sends the reason to Claude.
  Destructive commands (`rm -rf`, `git push --force`, `git reset --hard`, SQL `DROP`, writes outside
  the project, ...) need a click by default. Voice holds back its Enter while Claude's own numbered
  permission menu is showing (best-effort screen check before the paste and again before Enter).
- Interrupt: starting with "stop", "espera" or "cancela" interrupts Claude before the rest is sent.
- Jev: starting with "Alethe, ..." routes the request to Jev.
- Anywhere on the system: the shortcut is global. With Alethe in the background a floating HUD shows
  the same waveform, transcript, narration and permission card (bottom center of the screen under the
  mouse by default, six positions in Preferences, draggable, resettable) and hides 4 seconds after the
  turn; its close button hides it until the next press. On macOS it is a non-activating panel, so
  answering a permission there keeps your app focused, and it appears over full-screen apps. The
  shortcut is recorded by pressing it (Esc cancels; combinations taken by the OS or another app are
  refused). Narration speed is 1x to 2x, from the panel or the HUD.
- Narration controls on the panel and the HUD: Mute (same pace, no sound, for the session), Pause /
  Resume (anything new queues meanwhile; the system voice starts again from the sentence it had
  reached) and Stop
  (drops the rest). Pressing the shortcut still stops and clears narration. A tap too short to
  record shows "Hold the shortcut while you speak" instead of an error.
- Spoken-word highlight: the narration text on the panel and the HUD marks the word being spoken
  (accent color, soft glow) and what was already said (muted tint), scrolling to keep the word in
  view. Exact for cloud voices and Piper; estimated from the speaking time for the system voice.
- Claude sessions started while voice was off show in the picker as needing a restart, with a
  **Restart** action that resumes the same conversation with voice. Turning voice on offers to
  restart all of them at once.
- Read aloud: right-clicking a terminal offers **Read aloud** and **Copy** for a selection, or
  **Read copied text aloud** and **Paste** without one; Ctrl+Shift+L (⌘⇧L) reads the focused
  terminal's selection, else the clipboard (the shortcut is changeable in Preferences; it works
  inside Alethe and cannot take the voice shortcut's chord). Agents that draw their own selection (Claude Code full
  screen, OpenCode) are covered through what they copy (OSC 52 or the clipboard); Option+drag
  (Shift+drag elsewhere) forces a terminal selection over them. Text is spoken with the narration
  voice and shown on the panel or the HUD with the narration controls. Only while voice conversation
  is on; otherwise right-click copies or pastes at once.
- Platform notes: Linux builds need `libspeechd-dev`; the macOS bundle declares microphone usage.

### Voice providers

- Preferences → Voice has one tab per use: Dictation, Conversation and Narration. Each use picks its
  own provider, so dictation can stay on this device while narration uses a cloud voice. The tabs
  show the same provider cards as the providers grid (local and cloud groups); the card a use runs on
  is marked **In use**, and each card picks its model from a searchable list. **Compare models** on
  a tab opens the local models table filtered to that use.
- The Voice page opens with an **In use** summary of what each use runs on, with warnings when it
  cannot work (model not downloaded, downloading or paused, missing or invalid key, no Apple language
  or one not installed). A chosen local model that cannot run yet shows a warning on its card
  instead of **In use**. The providers grid is titled **Accounts and models**.
- Local models are a comparison table: languages, speed and accuracy tiers (curated catalog data from
  published benchmarks, not measured in the app), size, status (not downloaded, downloading, paused,
  verifying, unpacking, downloaded), **Used in** and **Selected for**. A row expands into strengths,
  limits, the full language list and **Use for …** buttons. Voices rate quality instead of accuracy,
  and the recommended voice is the one in the app language. While downloading, the status shows the
  time left. Removing a model that is in use switches that use to another downloaded model of the
  same kind, or to its default.
- Downloads can be paused, resumed and cancelled. Pause is persistent and derived from the partial
  files on disk, so a paused model stays paused after closing Alethe and nothing resumes on its own.
  Only one download runs at a time; cancel deletes the whole partial model; a read that stalls for
  30 seconds ends the attempt so it can be resumed.
- Cloud provider pages show their models in the same table, with voices by language and, for
  OpenRouter, its input / output prices in dollars per million units, as on its site ("$0.50 / $6
  per 1M"). The Apple
  Speech page shows the permission status and lists installed languages apart from those available
  to install; the System voice page lists voices per language and has a single Test button.
- Local (default, nothing leaves the device): Parakeet, Zipformer, Whisper base and small, Moonshine
  base (English), Apple Speech (macOS) for recognition; Piper voices "Faber (pt-BR)" and "Amy
  (en-US)" and the system voice for narration.
- Cloud (your own key): OpenAI, ElevenLabs, Google Gemini and OpenRouter. OpenRouter lists every
  live transcription and speech model, with each model's own voices; the list is public, so it shows
  before a key is saved, locked until one is. Audio or text leaves the device only for a use set to a
  cloud provider.
- Narration voices are grouped by language: voices in the app language come first, then
  multilingual voices (they speak the language of the text), then the rest. Picking a narration
  model whose voices do not include the current one selects a voice in the app language.
- Keys are stored in the system keychain per profile and are never shown again after saving; a
  provider page can save, test and remove a key. A key is read from the keychain only when a cloud
  voice is used (at most once per run), so a keychain prompt never appears at launch. What narration speaks and the filler delay live in the
  Narration tab, and **Test voice** previews the chosen voice.
- Fallback: if a cloud provider fails, dictation and conversation use Apple Speech (when ready with
  a language set), otherwise the first downloaded local model; narration uses the system voice. A
  toast names the provider that failed and why. A local failure never falls back to the cloud.
- Downloaded models live in `<app data>/speech-models/<id>` and are managed from the provider page.
- Local voice servers: Preferences → Voice → Local servers adds a text-to-speech server you run
  yourself (OpenAI-compatible such as Chatterbox or Kokoro-FastAPI, or Fish Speech), on this
  computer or your local network, as a narration voice. Optional API keys stay in the system
  keychain, public addresses are refused, and the system voice takes over if the server is
  unavailable. See [docs/VOICE.md](VOICE.md#local-voice-servers).

## Spotify

- OAuth Authorization Code flow with local callback.
- Callback URL: `http://127.0.0.1:8888/callback`.
- User-provided Spotify Client ID and Client Secret.
- Local token persistence and automatic refresh.
- Now Playing widgets on Home and the sidebar.

## Agent Planning

Agent Planning / Agent Canvas is experimental. It provides a visual control surface for coordinating agent sessions and workers from inside Alethe.

Its agents follow a permission mode set in **Preferences → Terminal and agents → Agent Canvas permissions**: **Ask** (default) keeps each agent's own permission checks, and a background worker with nobody to answer has the action refused; **Bypass** lets agents run commands and edit files without asking. The mode is not synced between machines.
