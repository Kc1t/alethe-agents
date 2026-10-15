# Voice conversation with Claude Code — Design

Date: 2026-10-14
Status: Phase 1 implemented (working tree, 2026-10-14). Approved: §4 and §6 approved in
conversation; §7–§11 reviewed on 2026-10-14 against the code and the Claude Code hooks reference
(https://code.claude.com/docs/en/hooks), with corrections folded in.

## 1. What this is

Talk to a Claude Code session running in an Alethe pane, and hear it back. A global shortcut opens a
small floating HUD with a live waveform; you speak; the transcript goes straight into the target
Claude PTY. While Claude works, Alethe speaks what it is doing. When Claude needs a permission, you
answer by voice or on the HUD. Text stops being the only channel; it becomes a conversation.

## 2. What already exists

Verified by reading the code on 2026-10-14. Most of the input half is built.

- **Offline STT.** `src-tauri/src/speech.rs` runs sherpa-onnx transducer models (Zipformer
  GigaSpeech EN, Zipformer small EN, Parakeet TDT v3 — the multilingual one, which covers
  Portuguese). Models download into `{app_data}/speech-models/{id}`, SHA-checked. Commands are
  registered at `lib.rs:522-532`; TS wrappers in `src/lib/tauri/speech.ts`.
- **Mic capture with a level meter.** `speech_capture.rs` captures through cpal on every platform,
  mono 16 kHz, 60 s cap, peak level in an `AtomicU32` read by `speech_capture_level`.
- **A voice bar with a spectrum.** `src/components/VoiceCommand/index.tsx` — Ctrl+Shift+Space bar,
  F9 push-to-talk, spectrum from polling the level every 60 ms. It routes what you say through Jev
  (`src-tauri/src/jev.rs`, a cloud call that needs `voiceCommandApiKey`) to one of `new_project`,
  `focus_terminal`, `send_prompt`, `reuse_terminal`, `kill_terminal`, `nothing`
  (`src/lib/voiceCommand.ts:198-218`). History in `voiceHistoryStore` / `VoiceHistoryPanel`.
- **Dictation.** `src/components/DictationButton/index.tsx`, Cmd/Ctrl+E, writes text into the active
  PTY without submitting.
- **Writing a prompt into a Claude PTY.** `writePty` (`src/lib/tauri/pty.ts:51`). The robust
  submit is bracketed paste through `writePtyChunked`, a 150 ms wait, `\r`, and `\r` retries at
  1.2/3/6 s (`useXtermSession.ts:1617-1625`).
- **Claude Code hooks.** `agent_events.rs` runs a token-authenticated tiny_http listener on
  127.0.0.1:9123-9143 and writes a per-terminal settings file of `type: "http"` hooks
  (`agent_hooks_settings_path`, `agent_events.rs:90`), passed as `claude --settings <path>`
  (`src/lib/sessionLaunch.ts:79`). The user's own `settings.json` is never touched. Every payload
  is emitted to the frontend as `agent-hook` with `plannerId` (= PTY id). The `session` variant
  only carries `SessionStart` and `UserPromptSubmit`; the `full` (orchestrator) variant adds tool,
  subagent, task and `Stop` events.
- **Transcript reading.** `handoff.rs::transcript_snapshot` (`:525`) parses the Claude JSONL into
  user / assistant / tool-result events with an mtime revision for cheap polling.

Missing: TTS, an OS-level shortcut (every binding today is a window `keydown` listener), a floating
or transparent window, end-of-speech detection, Claude permission-prompt handling, and
`NSMicrophoneUsageDescription` in the macOS bundle.

## 3. Goals

- One global shortcut opens the HUD from any app, not only when Alethe is focused.
- Capture by push-to-talk or by toggle with end-of-speech detection — the user picks.
- What you say lands in the target Claude session with no cloud hop in between.
- Alethe speaks Claude's own words as it works, with short status fills during long silences.
- Permission prompts can be answered by voice or on the HUD, respecting the session's own
  permission settings.
- Works on macOS, Windows and Linux; macOS gets native extras.

## 4. Decisions

Made in conversation, in this order:

1. **Core feature, not a plugin.** The HUD window, the global shortcut and the Rust audio parts
   cannot live in a plugin (`write_pty` is forbidden to plugins, `permissions.ts:33`).
2. **Cross-platform core plus macOS extras.** Core: sherpa-onnx STT, the `tts` crate, Tauri global
   shortcut and window. macOS extras: Premium / Personal Voice voices, and Apple `SpeechAnalyzer`
   as an STT engine in a later phase (§12).
3. **Capture mode is a preference.** Push-to-talk (hold the shortcut) or toggle (press once; the
   HUD stops on end of speech or on a second press).
4. **HUD in the SuperWhisper style.** Small borderless floating window with the live waveform;
   when capture ends it transcribes and sends.
5. **STT engine is a preference behind a `Transcriber` trait.** sherpa-onnx is the default;
   `SpeechAnalyzer` is the macOS option. Expected speech: Portuguese with English technical terms,
   so Parakeet TDT v3 (`parakeet-tdt-0.6b-v3-int8`) is the default model for this feature.
6. **Target session.** Default: the active Claude pane, else the most recently focused one.
   Switchable from the HUD or by voice through Jev (§7.2). Resuming an old session stays Alethe's
   existing resume flow.
7. **Permissions are inherited from the session.** Alethe only sees a request when the session
   itself would ask. How it is answered — voice, HUD, or both — is a preference. Destructive
   commands require a HUD confirmation by default (a preference the user can turn off).
8. **Narration = Claude's own text + status fill.** Speak the assistant text Claude writes between
   tools and its final answer; after N seconds of silence, speak a short templated status from the
   tool events ("still running the tests"). Verbosity is a preference. LLM summarisation is out of
   scope.
9. **Barge-in.** When the user starts speaking, TTS stops immediately.
10. **One HUD for conversation and Jev commands.** The `VoiceCommand` bar moves out of the main
    window into the HUD. Conversation is the default path and goes straight to the PTY; Jev runs
    only behind a trigger word ("Alethe, …") or a modifier on the shortcut, and only if an API key
    is set. Dictation (Cmd/Ctrl+E) is unchanged.
11. **Speaking mid-task queues by default.** The message is typed into the Claude TUI, which queues
    it for its next input point. A leading keyword ("stop", "espera", "cancela", configurable) or a
    modifier sends `Esc` first, which interrupts Claude; any text after the keyword is then sent.
    The default (queue or interrupt) is a preference.

## 5. Non-goals

- **Narrating sessions outside Alethe** (a bare CLI, the VS Code panel). That needs hooks in the
  user's global `settings.json`, which Alethe deliberately never writes. Future work.
- **Agents other than Claude Code.** The design keys on Claude hooks and transcripts. Codex and
  others can follow once the controller exists.
- **LLM-summarised narration.** Adds latency and a cloud call per few seconds.
- **Wake word / always listening.** The shortcut starts every capture.

## 6. Architecture

### Rust (`src-tauri/src/`)

| Unit | New / extend | Responsibility |
|---|---|---|
| `voice_hud.rs` | new | Build, show and hide the `voice-hud` window; register the global shortcut and forward press/release |
| `tts.rs` | new | Speak, stop, list voices; emit start/end events |
| `speech_capture.rs` | extend | End-of-speech detection for toggle mode |
| `speech.rs` | extend | `Transcriber` trait; sherpa-onnx is the first implementation |
| `agent_events.rs` | extend | `voice` hook events; held `PermissionRequest` responses; voice targets |
| `handoff.rs` | extend | Expose `transcript_snapshot` as a Tauri command |

**`voice_hud.rs`.** Creates the window with `WebviewWindowBuilder` (async, as `orchestrator.rs:333`
does, to avoid the Windows deadlock): `transparent(true)`, `decorations(false)`,
`always_on_top(true)`, `focused(false)`, `skip_taskbar(true)`, `visible_on_all_workspaces(true)`,
centred near the bottom of the active screen. It needs `macOSPrivateApi: true` in
`tauri.conf.json` (required for transparency) and a capability file
`capabilities/voice-hud.json` scoped to the `voice-hud` label with only the commands the HUD calls.
On macOS the window must not steal focus from the app the user is in: set it non-activating
through objc2 (or adopt `tauri-nspanel` if objc2 cannot do it on a Tauri-owned `NSWindow`).
The global shortcut uses `tauri-plugin-global-shortcut`; the accelerator comes from preferences
and is re-registered when it changes. Press and release are both forwarded as
`voice://shortcut {state: "pressed" | "released", modifier: bool}`.

**`tts.rs`.** Wraps the `tts` crate (AVSpeechSynthesizer on macOS, WinRT on Windows,
speech-dispatcher on Linux). Commands: `tts_speak(text, voice?, rate?)`, `tts_stop()`,
`tts_voices()`. Events: `tts://start`, `tts://end` (with an utterance id). On macOS, `tts_voices`
includes Premium / Enhanced voices; Personal Voice needs an authorization request through objc2
the first time it is selected.

**`speech_capture.rs`.** Adds end-of-speech detection using sherpa-onnx's Silero VAD (already a
dependency, no new crate). Emits `speech://end-of-speech` after a configurable trailing silence
(default 1.2 s) once speech has been detected. Push-to-talk ignores it.

**`speech.rs`.** Introduces `trait Transcriber { fn transcribe(&self, pcm: &[f32]) -> Result<String> }`
and moves the current sherpa path behind it, with no behaviour change. The engine is chosen from
preferences.

**`agent_events.rs`.**
- `agent_hooks_settings_path` gains a `voice: Option<bool>` argument. The variant is still chosen by
  the orchestrator feature (`claudeMcpConfigs.ts:102`); `voice: true` adds the union of
  `PreToolUse`, `PostToolUse`, `Stop` and `PermissionRequest` to whichever variant
  is written (the `full` variant already has the first three; no event is registered twice). Hooks
  are written at terminal launch, so turning voice on applies to Claude terminals opened afterwards
  — the preference says so.
- `PermissionRequest` gets its own hook entry with `timeout: 300`, separate from the 5 s entry the
  other events share.
- The listener loop is serial (`agent_events.rs:504`; only `/mcp` spawns a thread), so a held
  response would block every other hook. A `PermissionRequest` is therefore handed off: the
  `tiny_http::Request` moves into a pending map keyed by a request id, the loop continues, and the
  payload is emitted as `agent-hook` with `permissionRequestId`. The map is a plain struct generic
  over a responder, so it is unit-testable without sockets.
- Holding is selective. `voice_set_targets(pty_ids)` tells Rust which PTYs a voice conversation is
  targeting; a `PermissionRequest` from any other PTY gets an empty 200 immediately — no decision,
  so the TUI shows its normal prompt.
- `agent_permission_decide(request_id, behavior, message?)` responds to a held request; `behavior`
  is `allow`, `deny`, or `defer` (an empty 200, so the TUI asks). It rejects unknown or
  already-answered ids.
- Whenever Rust releases a held request on its own (deadline, the PTY leaving the voice targets,
  shutdown) it emits `agent-permission://released {requestId, reason}`, so the HUD card goes away.
- A held request is released with an empty 200 by Rust itself after 290 s, before the 300 s hook
  timeout, because what Claude does on a hook timeout is not documented ("the hook is canceled").
  Releasing first keeps the fallback deterministic: the normal TUI prompt.
- On `ExitRequested` (`lib.rs:636`), every held request is answered with an empty 200.
- Events registered only because of `voice` (absent from the variant itself) carry an extra
  `X-Alethe-Voice-Only: 1` header, and the listener tags their payload `voiceOnly: true`. The
  orchestrator canvas bridge (`useAgentHookBridge`) and the sandbox relay
  (`agentSandboxStore.ts:554`) skip `voiceOnly` payloads, so a plain session with voice on does not
  start feeding the board with tool and background-shell nodes.
- Logging: for `PreToolUse`, `PostToolUse` and `PermissionRequest`, log only the event name and
  `tool_name` — their payloads carry commands and file contents. Other events keep the current
  4000-char log.

**`handoff.rs`.** `transcript_snapshot` (`:525`) is `pub(crate)` and only used by the remote-control
server today. A new command `agent_transcript_snapshot(provider, cwd, session_id, since)` wraps it
(limit 160, as the remote server uses), with a TS wrapper in `src/lib/tauri/`.

**Window checks.** Capability files do not restrict custom commands today (`build.rs` has no app
manifest, so every `invoke_handler` command is callable from every window). The new sensitive
commands — `agent_permission_decide` and `voice_set_targets` — take the calling `WebviewWindow` and
reject any label other than `main`. Closing the general gap (an app manifest with per-command
permissions) is out of scope for this feature and is tracked separately.

### Frontend (`src/`)

| Unit | New / extend | Responsibility |
|---|---|---|
| `stores/voiceConversationStore.ts` + `lib/voice/controller.ts` | new | State machine, target session, queue/interrupt, barge-in, Jev trigger |
| `lib/agentInputRegistry.ts` | new | Per-PTY `submit(text)` / `interrupt()` registered by `useXtermSession` |
| `lib/voice/routing.ts` | new | Trigger-word and interrupt-word matching on the transcript |
| `lib/voice/narrator.ts` | new | Turn hook events and transcript text into a speech queue |
| `lib/voice/permissions.ts` | new | Classify requests (destructive or not), parse spoken answers |
| `VoiceHud` window route | new | Thin view: waveform, state, transcript, target, permission card |
| `VoiceCommand` | extend | Moves into the HUD; Jev path kept |
| Preferences | extend | "Voice conversation" section |

**Agent input registry.** The robust submit (bracketed paste through `writePtyChunked`, 150 ms,
`\r`, retries at 1.2/3/6 s) is inline in `useXtermSession.ts:1621-1628`, and the completion monitor
is a closure-local whose `arm()` is private. The controller cannot reach either from outside. The
paste-wait-return part moves into a shared helper, and `useXtermSession` registers, per PTY id, a
`submit(text)` that uses the terminal's own bracketed-paste mode and arms its completion monitor (a
new public `armForSubmit()` on `AgentCompletionMonitor`), and an `interrupt()` that writes `Esc`. It
unregisters on exit and on dispose. The initial-prompt path calls the same helper and keeps its
retries.

The voice submit sends **no** extra `\r` retries. They exist for a CLI still drawing its first
screen; a voice send goes to a session that is already running, and a stray `\r` landing on a
permission dialog that opens a few seconds later would select its default option — approving a
tool call nobody approved.

**Controller placement.** The controller runs in the **main window**, where the stores and PTY ids
are. The HUD is a thin view: it receives state through a Tauri event (`voice://state`) and sends
user actions back (`voice://action`). Because the main window may be hidden or minimised while the
user works elsewhere, its `backgroundThrottling` is disabled so timers and polls keep running.

**State machine.**
`idle → listening → transcribing → sending → working (narrating) → idle`, with `awaiting-permission`
reachable from `working`, and `listening` reachable from `working` (talking mid-task).

**Routing in `main.tsx`.** The `voice-hud` label renders `VoiceHud`, the same way
`OrchestrationWindow` is routed today (`main.tsx:51-73`).

## 7. Data flow

### 7.1 Speak

1. Shortcut pressed → `voice://shortcut` → controller starts `speech_start_capture` and shows the
   HUD; `tts_stop()` if Alethe is speaking (barge-in).
2. HUD polls `speech_capture_level` every 60 ms for the waveform (reusing the `VoiceCommand`
   spectrum).
3. Capture ends on shortcut release (push-to-talk), on a second press, or on
   `speech://end-of-speech` (toggle).
4. `speech_stop_and_transcribe` → text. Empty or whitespace → back to idle, nothing sent.

### 7.2 Route

1. If the text starts with the Jev trigger word, or the modifier was held → strip the trigger and
   run the existing Jev path (`jevDecide` → plan → confirm if needed). Without an API key the HUD
   says Jev is not configured.
2. If it starts with an interrupt keyword → `interrupt()` the target (writes `Esc`), wait 300 ms; if
   text follows, continue with that text.
3. Otherwise → send to the target.

Matching (`lib/voice/routing.ts`) works on the first word of a normalised transcript: lower-case,
accents and punctuation stripped. STT spells a name like "Alethe" many ways ("Alethea", "a lethe",
"Aletí"), so the trigger matches when the first word — or the first two words joined — equals the
trigger, one of its listed variants, or is within edit distance 1 of it. An interrupt keyword
matches only as the first word followed by punctuation, a comma, or the end of the transcript, so
"stop, use pnpm" interrupts and "stop words are…" does not. "para" is not a default keyword: in
Portuguese it starts ordinary sentences ("Para isso, use pnpm").

### 7.3 Send

Resolve the target (decision 6). The active pane is `uiStore.activeTerminal`; it is a Claude pane
when its active sub-tab has `type === 'claude'` (the tab carries the `ptyId`). "Most recently
focused" has no source today (`PtyRuntime.lastFocusedAt` is only set at registration), so the
controller keeps its own last-Claude-PTY id by subscribing to `activeTerminal`. If no Claude pane
exists, the HUD says so and offers the Jev path ("open Claude in project X"). Send through the
target's `agentInputRegistry` entry, which pastes, waits 150 ms and presses Enter once (no retries,
see §6), and arms the completion monitor so the pane status shows `working`. If the target has no entry (PTY gone), re-resolve once; if
still none, keep the text in the HUD.

### 7.4 Narrate

- Sources: `agent-hook` events for the target `plannerId`, and assistant text between tools from
  `agent_transcript_snapshot`, polled by revision every 700 ms while the state is `working` (an
  unchanged revision returns no messages, so the poll is cheap). The `session_id` and `cwd` come from
  the target sub-tab (`SubTab.sessionId`, `cwd`), which `useXtermSession` already keeps current
  from the `SessionStart` / `UserPromptSubmit` hooks. The transcript is written
  asynchronously and may lag; that only delays intermediate narration.
- New assistant text blocks are queued for speech in order. Markdown syntax (headings, emphasis,
  links, inline code backticks) is stripped before speaking. Code blocks, file contents and long
  lists are not read aloud: they are replaced by a short phrase ("I wrote a code block in
  auth.ts").
- If nothing has been spoken for N seconds (default 8) and a tool is running, speak a templated
  status from the latest `PreToolUse` ("running the tests", "editing auth.ts").
- `Stop` → speak its `last_assistant_message` (the final response text, carried in the hook
  payload; respecting verbosity), skipping it if the transcript poll already queued the same text,
  then go to `idle`.
- Verbosity levels: `silent` (nothing), `final` (only the end of the turn), `normal` (assistant text
  + fills), `detailed` (also every tool start).
- While TTS plays, the mic is not capturing (capture only starts on the shortcut), so there is no
  echo loop in push-to-talk. In toggle mode capture starts after `tts_stop()`.

### 7.5 Approve

1. `PermissionRequest` arrives with a request id → state `awaiting-permission`; the HUD shows the
   card (tool, command or path); the narrator speaks a short request ("wants to run npm install
   express — allow?"). The payload is `tool_name`, `tool_input` and `permission_suggestions` (no
   `tool_use_id`). It fires only when the session would actually ask, so decision 7 holds by
   construction. The card has an "answer in the terminal" action that releases the hold with an
   empty 200, for the case where the TUI does not show its prompt while a hook is pending (§13).
2. Answer channel from preferences: voice, HUD, or both (first answer wins).
3. Voice answers: allow ("yes", "pode", "allow"), deny ("no", "não"), or deny with a reason
   ("no, use pnpm") — the reason goes back as the deny message, so Claude sees it as an
   instruction.
4. **Destructive requests** (`rm -rf`, `git push --force`, `git reset --hard`, `DROP`, deleting
   outside the project — the list lives in `lib/voice/permissions.ts`) require a HUD click
   by default; a spoken "yes" is not enough, because a misheard word would run them.
5. `agent_permission_decide(request_id, allow | deny, message?)` responds to the held hook with:
   `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`,
   or `"behavior":"deny"` plus `"message"` when a reason was spoken. (`decision` also supports
   `updatedInput` and `updatedPermissions` for allow and `interrupt` for deny; this feature does not
   use them.) An empty 200 means no decision: the TUI shows its normal prompt.

## 8. Preferences

New fields in `Preferences` (`src/lib/types.ts`), with defaults in `DEFAULT_PREFERENCES`, sanitised in
`projectsStore.migrations.ts`, listed in `PreferencesModal` `searchItems`, and rendered in a new
`VoiceConversationSection` next to `VoiceDictationSection` in `IntegrationsPage.tsx`:

The STT model and the microphone are the dictation ones (`dictationModelId`,
`dictationMicrophoneId`, default `parakeet-tdt-0.6b-v3-int8`): one download and one mic choice
serve both features. In phase 1 `toggle` means press to start and press again to stop; end-of-speech
detection joins it in phase 3.

| Field | Default |
|---|---|
| `voiceConversationEnabled` | `false` |
| `voiceShortcut` | `CmdOrCtrl+Shift+Space` |
| `voiceCaptureMode` | `'push-to-talk'` (`'toggle'`) |
| `voiceEndOfSpeechMs` | `1200` — added in phase 3 |
| `voiceSttEngine` | `'sherpa'` (`'apple'` on macOS) — added in phase 4 |
| `voiceTtsVoice` / `voiceTtsRate` | system default / `1.0` |
| `voiceVerbosity` | `'normal'` |
| `voiceFillAfterMs` | `8000` |
| `voiceApprovalChannel` | `'both'` (`'voice'`, `'hud'`) |
| `voiceDestructiveNeedsHud` | `true` |
| `voiceMidTaskDefault` | `'queue'` (`'interrupt'`) |
| `voiceInterruptWords` | `['stop', 'espera', 'cancela']` |
| `voiceJevTrigger` | `'alethe'` |

None of these is secret. Device-independent fields are added to `SYNCED_PREFERENCE_KEYS`
(`cloudSync.ts:9`): enabled, shortcut, capture mode, end-of-speech, verbosity, fill delay, approval
channel, destructive-needs-HUD, mid-task default, interrupt words, Jev trigger. The STT engine
and the TTS voice and rate (system voices differ per OS) are not synced. Every label goes through
`t()` in `en.ts`, `pt-BR.ts` and `zh-CN.ts`.

## 9. Error handling

- **No mic permission / no input device** → the HUD shows the existing "mic silent" warning and a
  link to system settings; nothing is sent.
- **STT model not downloaded** → the HUD offers the download (existing `speech_download_model`
  flow) instead of capturing.
- **Shortcut registration fails** (taken by another app) → toast plus a pointer to the preference;
  the in-app shortcut still works.
- **Target PTY exited** between capture and send → re-resolve the target; if none, keep the text in
  the HUD so it is not lost.
- **Hook listener down** → narration and voice approval are unavailable; sending still works. The
  HUD says narration is off.
- **Held permission times out** → Rust releases it with an empty 200 at 290 s, before the 300 s hook
  timeout, so Claude shows its TUI prompt; the HUD card disappears and says so.
- **Target PTY exits while a permission is held** → the controller drops it from the voice targets;
  Rust releases its held requests.
- **Alethe quits with held permissions** → pending responses are answered with an empty 200 on
  shutdown, so Claude shows its normal prompt.
- **TTS engine unavailable** (e.g. no speech-dispatcher on Linux) → narration is shown as text in the
  HUD instead of spoken.

## 10. Security

- Capability files do not restrict custom commands today (no app manifest in `build.rs`), so
  "the HUD is not given `write_pty`" cannot be enforced by a capability file. The HUD gets its own
  capability file for the core and plugin permissions it needs; the new sensitive commands
  (`agent_permission_decide`, `voice_set_targets`) check that the caller's window label is `main`.
  The HUD never writes to a PTY — it sends `voice://action` and the main-window controller writes.
  The general gap (any window can call any command, including `write_pty` from the orchestration
  window today) is pre-existing and tracked separately.
- `agent_permission_decide` accepts only request ids that are currently pending.
- Destructive-command confirmation defaults to a HUD click (§7.5).
- The CSP in `tauri.conf.json` is unchanged; `securityPolicy.test.ts` must still pass. The HUD
  route renders transcript text as text, never as HTML.
- Hook payloads are logged today at up to 4000 chars (`agent_events.rs:688`). `PreToolUse`,
  `PostToolUse` and `PermissionRequest` payloads carry commands and file contents, so for those the
  log keeps only the event name and `tool_name`.
- macOS bundle: there is no `Info.plist` today, so a bundled build has no
  `NSMicrophoneUsageDescription` (this already affects dictation). Phase 1 adds
  `src-tauri/Info.plist` with it; phase 4 adds `NSSpeechRecognitionUsageDescription`.

## 11. Testing

- **Unit (vitest).** Controller state machine transitions; routing (trigger word with STT
  variants and edit distance, interrupt words only before punctuation or end, plain text);
  `permissions.ts` destructive classification and spoken-answer parsing (PT and EN); narrator:
  markdown and code-block stripping, fill timing with fake timers, verbosity filtering, no double
  speech of the final text; agent input registry: register, submit arms the monitor, unregister.
- **Unit (Rust).** `agent_hooks_settings_path` with `voice: true` for both variants — the union of
  events, no duplicates, the 300 s `PermissionRequest` entry; pending-permission map — decide,
  release at deadline, unknown id, double decide, non-target PTY answered at once, shutdown drain;
  decision body shape; end-of-speech detection on recorded PCM fixtures (speech then silence).
- **Listener audit.** Every `agent-hook` listener in the frontend is checked against `Stop` /
  `PreToolUse` / `PostToolUse` arriving from non-orchestrator sessions, which they never saw before.
- **Manual on each OS.** Global shortcut from another app; HUD does not steal focus; TTS voices
  list; a full loop: ask Claude to edit a file, hear narration, approve a Bash command by voice,
  refuse a destructive one by voice and confirm it is held for the HUD.

## 12. Phases

1. **Loop on the main window.** Agent input registry, controller, narrator, TTS, voice hook events,
   held permissions, transcript command, preferences, `Info.plist` with the mic description —
   triggered by an in-window shortcut (the `voiceShortcut` chord, matched on `keydown`), shown in a
   `VoiceConversationView` docked in the main window. That view takes the state and an action
   callback as props, so phase 2 mounts the same component in the HUD window. While voice
   conversation is on, the chord belongs to it and the `VoiceCommand` bar opens only through the
   Jev path (trigger word, or the text sent to it). Proves the conversation end to end.
2. **HUD and global shortcut (implemented, see `2026-10-14-voice-hud-design.md`).** `voice-hud`
   window, `tauri-plugin-global-shortcut`, macOS non-activating panel, `backgroundThrottling` off.
   Moving `VoiceCommand` into the HUD was not part of it; the bar stays in the main window.
3. **Toggle mode.** VAD end-of-speech. Silero VAD needs its own model file (`silero_vad.onnx`),
   downloaded through the existing SHA-checked model flow; confirm the VAD API of `sherpa-onnx`
   1.13.6 before starting.
4. **macOS extras.** Personal / Premium voices; `SpeechAnalyzer` behind `Transcriber`. This needs a
   Swift bridge (SpeechAnalyzer is Swift-only), which the build does not have today.

Each phase ends with a `docs/CHANGELOG.md` entry under `[Unreleased]`.

## 13. Risks and open questions

- **Non-activating HUD on macOS.** Tauri creates an `NSWindow`, not an `NSPanel`; if objc2 style
  changes are not enough, `tauri-nspanel` is the fallback. Validate first in phase 2.
- **Claude TUI queueing.** Text typed while Claude is busy is queued by the TUI today; if a Claude
  Code release changes that, mid-task sends need the interrupt path. Check the current behaviour
  when implementing §7.3.
- **TUI while a hook is held.** Unknown whether the TUI shows its permission prompt while a
  `PermissionRequest` hook is pending, or waits. If it waits, the user at the terminal can only
  answer through the HUD — hence the "answer in the terminal" release action (§7.5). Check
  manually in phase 1.
- **Linux build dependency.** The `tts` crate needs `libspeechd-dev` (speech-dispatcher) at build
  time; CI and `CONTRIBUTING.md` must list it.
- **Narration quality in Portuguese.** System voices vary by OS; the preference lets users pick, but
  the default voice should match the UI locale.
