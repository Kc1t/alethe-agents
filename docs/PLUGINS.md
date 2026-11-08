# Plugin System (RFC-012)

Alethe loads features as plugins so the core does not have to own every one of them. Official
plugins ship inside the app, are enabled by default, and can be turned off. Turning one off removes
its surfaces immediately — no restart.

A plugin **announces** what it contributes in its manifest, and **implements** it in code. That
split is what lets the shell draw a plugin's sidebar tab before the plugin has been loaded, and only
load it when someone actually opens it.

## The two transports

| | Bundled | Local |
|---|---|---|
| Lives in | `src/plugins/<id>/`, shipped in the app bundle | `<profile>/plugins/<id>/` on disk — the directory name must equal the manifest `id` |
| Loaded by | a code-split `import()` from the app origin | a `<script>` served over `alethe-plugin://` |
| Binds against | the app's modules directly | `window.alethe` |
| Trust | first-party | unreviewed; installs disabled, enabling asks first |

Both go through the **same** `activate(context)` contract. Only the transport differs, so a bundled
plugin exercises the real API rather than a privileged shortcut.

## Manifest

```jsonc
{
  "id": "alethe.git-control",
  "name": "Git Control",
  "version": "1.0.0",
  "apiVersion": 1,
  "kind": "ui",                 // ui | theme | agentType | skill | validationPipeline
  "description": "…",
  "entry": "main.js",           // local plugins only
  "styles": "styles.css",       // optional, local plugins only
  "capabilities": ["ui.sidebarTab", "ui.command", "invoke:git_*"],

  "activation": ["onView:git", "onCommand:git.reveal"],

  "contributes": {
    "views": [
      { "id": "git", "container": "leftSidebar", "title": "Source Control",
        "titleKey": "ui.sidebar.git", "panelTitleKey": "ui.sidebar.sourceControl",
        "icon": "git-branch", "order": 10 }
    ],
    "commands": [
      { "id": "git.reveal", "title": "Source Control", "icon": "git-branch",
        "keywords": "git commit branch diff status" }
    ]
  }
}
```

`id` accepts `[A-Za-z0-9._-]` and is validated on the Rust side against path traversal. `entry` and
`styles` must be plain file names. Contribution ids follow the same shape and must be unique within
a manifest.

The app speaks plugin API **3**, and `apiVersion` is the lowest version a plugin needs. A manifest
above the running version is refused, on install and on activation; older manifests keep working.
Version 2 added overlays, settings sections, `context.workspace`, `context.listen`,
`context.ui.toast` and `context.useT`. Version 3 added `context.terminals`, `context.agents`,
`context.components`, `context.locale` and streaming through `context.invoke`. A plugin that uses any
of them declares that `apiVersion` and its catalogue entry the same `minApiVersion`: older apps then
hide the listing and refuse a manual import instead of activating a plugin that would call APIs they
do not have.

**Unknown keys are rejected, not ignored** (`deny_unknown_fields`, top level and inside
`contributes`). A manifest written for a future `apiVersion` must fail loudly rather than load with
half its meaning lost.

`icon` names an entry in the curated map in `src/lib/plugins/icons.ts`. A manifest names an icon; it
never supplies a component. An unknown name falls back to a generic puzzle icon.

## Activation

Nothing is loaded at startup unless it asks to be.

| Event | Fires |
|---|---|
| `onStartupFinished` | once the plugin host has finished discovery |
| `onView:<id>` | the first time that declared view is rendered |
| `onCommand:<id>` | the first time that declared command runs |

An empty or absent `activation` list means `["onStartupFinished"]`, so a plugin that declares
nothing still behaves the way it always did. An event pointing at a view or command the manifest
does not declare is a manifest error, reported in the Plugins page rather than ignored.

A declared view or command **always** activates its plugin on demand, whatever `activation` says;
the list decides what happens at startup. Concurrent activations are coalesced, so a plugin is
loaded once no matter how many surfaces reach for it at the same time.

An installed-but-never-opened plugin therefore costs one manifest read.

## Capabilities

A capability is an exact token (`ui.theme`) or a prefix with a single trailing `*`
(`invoke:git_*`). A bare `*` is rejected, so no manifest can claim everything by accident. A plugin
that contributes something it did not declare fails activation with `capability_denied`; declaring
views without `ui.sidebarTab`, or commands without `ui.command`, fails before anything is
registered.

`context.invoke` additionally refuses a hard-coded set of commands regardless of what the manifest
says — PTY spawn/write, validation command execution, the projects file writer, filesystem writes
and deletes, secret reveal, and the plugin commands themselves. See
`src/lib/plugins/permissions.ts`.

> **Honest limit.** A plugin runs in the app's own webview, so this gate is a guard rail, not a
> sandbox: enforcement is advisory. Treat installing a local plugin the way you would treat running
> any other program. Real isolation would mean a child webview — the app already does that for
> browser panes — and is the path if a public registry ever exists.

## Writing a plugin

```ts
import type { PluginContext, PluginModule } from '../../lib/plugins'

const plugin: PluginModule = {
  activate(context: PluginContext) {
    context.registerView('git', GitTab)          // implements a declared view
    context.registerCommand('git.reveal', run)   // implements a declared command
    context.registerMessages('en', { title: 'My Panel' })
    context.contributes.theme({ /* … */ })       // themes and panes stay imperative
    context.ui.revealView('git')                 // opens its own tab, wherever it is placed
  },
  deactivate() {
    // Optional. Everything registered through `context` is disposed for you.
  },
}

export default plugin
```

### Examples

| Example | Where | What it shows |
|---|---|---|
| Hello | `docs/examples/hello-plugin/` | the smallest local plugin, no build step |
| Scratch Notes | `docs/examples/notes-plugin/` | plain JavaScript, a sidebar tab, translated strings and a command |
| Agent Voice | [`Kc1t/alethe-agent-voice`](https://github.com/Kc1t/alethe-agent-voice) | an **external** plugin on API 3: it reads agent output through `context.terminals`, types spoken replies back, streams audio from a host command through a function argument, and draws the app's own agent icons and dropdowns from `context.components`; the Fish Audio key stays behind narrow `agent_voice_*` commands in the core |
| Jev | [`Kc1t/alethe-jev`](https://github.com/Kc1t/alethe-jev) | an **external** plugin with a real toolchain: its own repository, TypeScript, React and CSS Modules built by Vite into one IIFE, overlays, settings sections, a sidebar view, the workspace API, `context.voice` for capture and transcription, and a reproducible release zip listed in the catalogue |

Start from Jev's `vite.config.ts` and `scripts/package.mjs` when a plugin outgrows a single
hand-written `main.js`.

### Opening your own view or modal

`context.ui` is the only way a plugin moves the app, and it moves nothing that is not its own:

```ts
context.ui.revealView('git')          // reveals a view this plugin declared
context.ui.openModal('git.settings')  // opens a modal this plugin contributed
```

`revealView` opens whichever sidebar currently holds the view, honouring a placement the person
chose over the container the manifest declared. Both refuse an id the plugin does not own, the same
way `registerView` does — a plugin steering another plugin's interface would be worse than not
steering at all.

This exists because a local plugin has no other route. A bundled plugin could always import the
app's stores directly, being part of the same build; a plugin loaded over `alethe-plugin://` gets
`window.alethe` and its context and nothing else. Without `context.ui`, a command that reveals its
own panel — the first thing any plugin author writes — was possible only for our own plugins.

`registerView` and `registerCommand` refuse an id the manifest does not declare — announcing is the
manifest's job, implementing is the code's. Everything registered through the context returns a
`Disposable` and is tracked; deactivation disposes in reverse order, so disabling a plugin fully
undoes it. If `activate` throws, whatever it registered is rolled back and the error surfaces in
Preferences → Plugins.

Messages are namespaced to `plugin.<id>.` automatically, and a plugin can never shadow a core key.
`context.t('title')` resolves `plugin.<id>.title`.

## Storage

`context.storage` is a plugin's own persisted record — a JSON object, one per plugin, per profile.

```ts
const items = await context.storage.get('items', [])
await context.storage.set('items', [...items, item])
await context.storage.remove('items')
await context.storage.clear()
```

It lives in `<profile>/plugin-data/<id>.json`, **not** inside the plugin's directory. Two reasons,
both of which would bite later: everything under `plugins/<id>/` is reachable over
`alethe-plugin://`, so a plugin's data would be fetchable as an asset; and a reimport replaces that
directory, which would take the user's data with it. Data therefore survives an upgrade, and an
uninstall removes it — that is the user asking for the plugin gone.

Writes are read-modify-write and queue per plugin, so two concurrent `set` calls cannot lose a
value. A body must be a JSON object and is capped at 1 MB; a corrupt file reads as an empty record
rather than throwing, so a plugin still starts.

## Contribution points

| Point | Declared in | Capability | Registers |
|---|---|---|---|
| `views` | manifest | `ui.sidebarTab` | a tab in the left or right sidebar |
| `commands` | manifest | `ui.command` | an entry in the command palette (Ctrl+P) |
| `contributes.theme` | code | `ui.theme` | tokens, picker swatch, terminal palette |
| `contributes.pane` | code | `ui.pane` | a workspace pane for one `Terminal.kind` |
| `contributes.modal` | code | `ui.modal` | a modal the shell mounts when `openModal` matches its id |
| `contributes.agentProvider` | code | `agent.provider` | a new agent CLI: label, binary, unrestricted flag, accent, icon |
| `contributes.overlay` | code | `ui.overlay` | a component mounted over the whole window while the plugin is active |
| `contributes.settings` | code | `ui.settings` | a section on Preferences → Integrations (default) or Voice, listed by settings search |

Themes, panes, agent providers, overlays and settings stay imperative because none of them is
revealed by a tab: a theme applies as soon as it exists, a pane only renders for a terminal that
already carries its kind, a provider only matters once someone opens a terminal with it, and overlays
and settings sections are simply present while the plugin runs.

### Overlays

An overlay is mounted once, outside every panel, for as long as the plugin is active. It owns its own
visibility and keyboard handling: a voice bar listens for its shortcut and renders `null` until then.
Each overlay sits inside its own error boundary that renders nothing on failure, so a broken overlay
disappears instead of covering the window.

### Settings sections

```ts
context.contributes.settings({
  id: 'jev.key',
  title: () => context.t('settings.keyTitle'),
  description: () => context.t('settings.keyHint'),
  keywords: 'voice api key',
  component: KeySetting,
})
```

`title` and `description` are functions so the section follows the current language. The shell draws
the heading and the fold toggle; the component renders the controls only. The settings search matches
the title, the description and `keywords`, and jumps to the section by its `id`.

Set `category: 'voice'` to render beneath the core Preferences → Voice content. Omit `category`
(or use `'integrations'`) for the existing Integrations placement. The component mounts only on
its selected page, and search opens that category.

### Workspace, terminals, toasts and events

| API | Capability | Does |
|---|---|---|
| `context.workspace.snapshot()` | `workspace.read` | live projects, plain terminals (agent, folder, running, busy), enabled agents, and what has focus |
| `context.workspace.focusTerminal(id)` | `workspace.control` | brings a terminal forward and flashes its pane |
| `context.workspace.openAgentTerminal(projectId, options)` | `workspace.control` | opens an enabled agent in the project's folder, optionally typing a first prompt |
| `context.workspace.closeTerminal(id)` | `workspace.control` | closes a terminal, ending its process |
| `context.workspace.writeToTerminal(id, text)` | `terminal.write` | types into the running tab of a terminal |
| `context.ui.toast({ title, body })` | none | shows a notification and keeps it in the history |
| `context.listen(event, handler)` | `listen:<event>` | subscribes to an app event; `listen:speech*` covers every `speech…` event |
| `context.useT()` | none | the hook form of `context.t`, re-rendering when the language changes |
| `context.locale()` | none | the language the app is shown in |
| `context.appearance()` | none | `{ theme, visualStyle, reducedMotion }` from current app preferences |
| `context.onAppearanceChange(handler)` | none | emits the appearance object only when one of those values changes; returns a tracked Disposable |
| `context.ui.suspendKeybindings()` | none | returns a tracked Disposable; app shortcuts remain suspended until every hold is disposed |

The snapshot never carries PTY ids, and the workspace calls only reach terminals of non-archived
projects. Typing into a terminal is the same power as running a command there, which is why
`terminal.write` is its own capability and the trust dialog names it; `write_pty` itself stays on the
forbidden list for `context.invoke`. Event subscriptions are disposed with the plugin.

### Terminal sessions

`context.terminals` sees each running tab of a terminal as a **session**, so an agent in a background
tab is visible too.

| API | Capability | Does |
|---|---|---|
| `sessions()` | `terminal.read` | running sessions of non-archived projects: terminal, project, name, agent, whether it is a shell, and its status (`working`, `waiting`, …) |
| `onChange(handler)` | `terminal.read` | fires when session metadata, visibility, order, or status changes; not on every byte of output |
| `onOutput(id, handler)` | `terminal.read` | the raw output of a session, escape sequences included |
| `onExit(id, handler)` | `terminal.read` | the exit code and reason once the process ends |
| `size(id)` | `terminal.read` | the columns and rows last sent to the process, which is what its output is drawn for |
| `write(id, text)` | `terminal.write` | types into that session |
| `submit(id, text)` | `terminal.write` | pastes into a mounted agent with its bracketed-paste mode, checks for choice prompts, arms completion detection, and sends one Enter |
| `interrupt(id)` | `terminal.write` | sends Escape to a running agent, including a background tab |
| `readScreen(id, lines)` | `terminal.read` | rendered scrollback/screen tail, soft-wrapped rows joined; `null` while unmounted; positive integer line count capped at 2,000 |
| `focus(id)` | `terminal.write` | reveals the workspace pane and selected sub-tab, waits for mounting and screen replay, and focuses it |
| `restart(id)` | `terminal.restart` | restarts an enabled agent pane through the same resume path as its restart button |

A session id is opaque and is replaced when the tab's process is, so a plugin that keys its state by
session id never mixes the output of two processes. PTY ids are never handed out. Reading output is
reading whatever the terminal shows, secrets included, which is why `terminal.read` is its own
capability and the trust dialog names it.

Sessions additionally carry `projectName`, `tabName`, `cwd`, `tabActive` (front sub-tab), `visible`
(output streaming in the workspace), `agentSessionId` (conversation id or `null`), and `order`
(zero-based sidebar project order, then pane order, then sub-tab order). `disabled` lets pickers
exclude disabled panes from restart offers. Hidden projects absent
from the sidebar follow the listed projects so existing session enumeration still includes them.
The `agent` field identifies the harness and `shell` distinguishes shells. Use the existing
workspace snapshot for the focused terminal.

Await `focus(id)` before submitting to a background tab. Submission refuses hidden panes and
recognized approval/startup menus; a menu appearing during paste is checked again before Enter.
Refusals expose `error.code`: `unknown_session`, `not_an_agent`, `not_mounted`, `pane_hidden`,
`prompt_open`, or `terminal_disabled` (restart). Invalid screen counts throw
`invalid_screen_lines`; PTY and restart failures propagate. The screen guard recognizes known
CLI menu patterns; it is not a parser for every third-party TUI.

Text typed through `write` or `workspace.writeToTerminal` counts as input the agent received, exactly
like the keyboard: a prompt ending in Enter marks the agent as working and arms the same completion
detection.

### Voice: context.voice

This is an additive **API 3** feature. Declare `apiVersion: 3` and the matching catalogue
`minApiVersion`, and require an app build that supplies `context.voice`. Earlier API 3 builds do
not have it: check `if (!context.voice)` before using it and explain the app requirement in your
plugin's install instructions. The API number alone does not detect this addition.

| API | Capability | Result / behavior |
|---|---|---|
| `inputDevices()` | `voice.listen` | input devices: `deviceId`, `label`, `isDefault` |
| `nativeLocales()` | `voice.listen` | native locales: `id`, `name`, `installed` |
| `modelStates(locale?)` | `voice.listen` | model status, `kind` (`stt` or `tts`), progress, error, downloaded and total bytes |
| `prepare({ modelId, provider?, locale? })` | `voice.listen` | prepares a transcription engine; resolves to a boolean |
| `startCapture(deviceId?)`, `captureLevel()` | `voice.listen` | starts the shared microphone capture; polls its audio level |
| `vadStatus()`, `prepareVad()` | `voice.listen` | nullable VAD status (`level`, `voice`, `heardMs`, `silenceMs`, `segments`); prepares VAD and resolves to a boolean |
| `stopCapture()` | `voice.listen` | captured `samples`, `sampleRate`, `peak` |
| `stopAndTranscribe(options)` | `voice.listen` | transcript; options: `modelId`, `provider?`, `locale?`, `fallbackLocale?`, `usage?` |
| `transcribePartial({ modelId, locale? })` | `voice.listen` | transcript from the current capture's tail, using a local/native engine |
| `speak(text, options?)` | `voice.speak` | utterance id (number); options: `provider?`, `model?`, `voice?`, `rate?`, `server?` |
| `prefetch(text, options?)` | `voice.speak` | warms speech audio; same options except `server`, which the backend does not accept |
| `stop()`, `pause()`, `resume()`, `setMuted(boolean)` | `voice.speak` | controls shared playback |
| `voices({ provider?, model?, server? }?)` | `voice.speak` | voices: `id`, `name`, `language` |
| `onStart(handler)`, `onEnd(handler)` | `voice.speak` | `tts://start` / `tts://end`: `{ id: number }` |
| `onProgress(handler)` | `voice.speak` | `tts://progress`: `{ id, charOffset }`; offset counts Unicode code points |
| `setTargets(sessionIds)` | `voice.converse` + `agent.approve` | resolves opaque sessions and calls `voice_set_targets({ ptyIds })`; empty array releases held permission requests |
| `hookedSessions()` | `voice.converse` | calls `agent_voice_hooked_ptys` and returns only known live opaque session ids |
| `setConversationHooks(enabled)` | `voice.converse` | holds the host flag that adds Claude voice hooks on future launches, resumes, and restarts |
| `hud.show(placement)`, `hud.hide()` | `voice.hud` | shows or hides the shared floating HUD |
| `hud.publish(state)` | `voice.hud` | publishes the HUD's serialized state string unchanged |
| `hud.onAction(handler)` | `voice.hud` | `voice-hud://action` string payload |
| `hud.onMoved(handler)` | `voice.hud` | `voice-hud://moved`: `{ monitor, x, y, bounds }` |
| `hud.setShortcut(accelerator)` | `voice.hud` | sets the shared global shortcut; `null` unregisters it |
| `hud.onShortcut(handler)` | `voice.hud` | `voice://shortcut`: pressed/released `state` and boolean `jev` |
| `providers()` | none | provider catalog (`provider`, `keyUrl`, `models`, `voices`) plus boolean `hasKey`; never a credential |
| `openSettings()` | none | opens Preferences on category `voice` |

Command methods return promises and propagate backend errors; `openSettings()` returns immediately.
Event methods return a `Disposable` and register it in `context.subscriptions`, including when
registration is still pending at deactivation. Failed listener registration is recorded in the Audit
Center and its subscription is removed.

STT providers are `local`, `apple`, `openai`, `elevenlabs`, `gemini`, and `openrouter`.
TTS providers replace `apple` with `system` and also include `server`. Omitting a provider preserves
the backend's defaults. `server` is a configured server id, never a URL or credential.
`prepareVad()` may download the VAD model. `providers()` reads key availability locally without
calling provider test endpoints; the OS keychain may ask for access.

HUD placement is `{ kind: 'preset', preset }` with `bottom-center`, `bottom-left`, `bottom-right`,
`top-center`, `top-left`, or `top-right`, or `{ kind: 'custom', custom: { monitor, x, y, bounds? } }`.
Custom `x` and `y` are screen fractions; bounds are `{ x, y, width, height }` in physical pixels.
Capture, playback, HUD, and shortcut are shared app resources, so plugins must coordinate their use.

#### HUD state and actions

The core renders the `voice-hud` window; it does not mount the app shell, activate plugins, or
write `projects.json`. A plugin owns the conversation controller and publishes a complete JSON
string with `context.voice.hud.publish(JSON.stringify(state))`. The contract is defined by
`src/lib/voice/hudState.ts` (`HudViewState`, `encodeHudState`, `decodeHudState`, and
`decodeHudAction`). The Rust relay forwards strings unchanged and retains the latest snapshot.

`HudViewState` has this shape:

```ts
type VoiceTarget = {
  ptyId: string
  projectId: string
  terminalId: string
  tabId: string
  tabActive: boolean
  agent?: string
  label: string
  cwd: string
  sessionId: string | null
}

type HudViewState = {
  state: {
    capture: 'idle' | 'listening' | 'transcribing' | 'sending'
    turn: 'idle' | 'working' | 'awaiting-permission'
    target: VoiceTarget | null
    pinnedPtyId: string | null
    transcript: string
    narration: string
    narrationSpokenOffset: number | null
    permission: { requestId: string; tool: string; subject: string; destructive: boolean } | null
    notice: { text: string } | { key: string; params?: Record<string, string | number> } | null
    muted: boolean
    narrationPaused: boolean
    narrationActive: boolean
  }
  targets: VoiceTarget[]
  current?: VoiceTarget | null
  restartable?: VoiceTarget[]
  hint: string
  approvalChannel: 'both' | 'voice' | 'hud'
  destructiveNeedsHud: boolean
  rate: number
  language: 'en' | 'pt-BR' | 'zh-CN'
  uiTheme: string
  visualStyle: 'normal' | 'clean'
  reducedMotion?: boolean
}
```

`targets` lists selectable sessions, `current` labels the resolved session, and `restartable`
lists sessions that need a restart to acquire voice hooks. The `ptyId` field is an opaque routing
value supplied by the publisher, echoed in actions; this HUD contract does not grant access to
backend PTYs or expose their ids through the terminal API. Map it to a plugin-owned session id.
`state.target` is retained for compatibility. Capture takes precedence over turn in the phase label.
`narrationSpokenOffset` counts Unicode code points, not UTF-16 units. Null disables highlighting.

Supply already translated plugin notices as `{ text }`: the HUD does not register plugin messages.
The `{ key, params }` form only accepts core i18n keys. `hint`, target labels, transcripts, narration,
and permission subjects are also displayed as supplied. Publish language, theme id (including a
registered plugin theme id), visual style, and reduced-motion preference whenever they change.
The HUD reads the saved profile once for theme definitions; subsequent appearance updates come
from the published state, without saving them back.

Older states may omit `current`, `restartable`, and `reducedMotion`. Missing narration control
booleans default to false; a missing or non-finite spoken offset becomes null. Malformed JSON or
an invalid required envelope is ignored. The codec checks the envelope, not every nested field;
publish the complete shape above. Before the first valid state the HUD shows Ready and Close.
The speed buttons offer 1, 1.25, 1.5, and 2. HUD approval buttons appear for `both` and `hud`,
and for destructive requests guarded by `destructiveNeedsHud` even in `voice` mode; deferring to
the terminal is always available. The controller remains responsible for authorizing each action.

`context.voice.hud.onAction(handler)` receives a JSON string. Parse it with error handling and
validate it against the following `decodeHudAction` union before dispatching:

```ts
type HudAction =
  | { kind: 'answer'; requestId: string; answer: { kind: 'allow' } | { kind: 'deny'; message?: string } | { kind: 'defer' } }
  | { kind: 'pin'; ptyId: string | null }
  | { kind: 'restart-session'; ptyId: string }
  | { kind: 'rate'; rate: number }
  | { kind: 'stop-speaking' }
  | { kind: 'toggle-mute' }
  | { kind: 'toggle-pause' }
  | { kind: 'dismiss' }
```

Answer request ids and restart session ids must be non-empty strings; pinning null follows the
active pane. The codec accepts rates from 0.5 through 2, rejects unknown kinds or invalid fields,
and strips extra fields. The current UI emits allow, deny (without a message), or defer for the
visible request id. Closing sends `dismiss`; the plugin must handle it and call `hud.hide()`.
Actions never directly control capture, playback, terminals, or window visibility.
`onMoved` receives an object, rather than a JSON string: `{ monitor: string, x: number, y: number,
bounds: { x: number, y: number, width: number, height: number } }`. The fractions are relative to
the monitor's work area; bounds use physical pixels. Save it as the `custom` placement if desired.

The core owns provider keys and voice-server configuration. Send users to `openSettings()` to manage
them; no typed method accepts or returns keys. Cloud transcription uses
`stopAndTranscribe` with a cloud `provider`, and the core reads that provider's saved key.
`agent_voice_set_key` remains available through its existing explicit invoke permission for the
published Agent Voice plugin.

### Agent observation and permission decisions

| API | Capability | Contract |
|---|---|---|
| `context.agents.onHook(handler)` | `agent.observe` | tracked `agent-hook` listener; replaces the internal `plannerId` with opaque `sessionId`, drops events outside live tabs, and retains hook fields such as `hook_event_name`, `session_id`, `tool_name`, `tool_input`, `permissionRequestId` |
| `context.agents.transcript(sessionId, cursor?)` | `agent.observe` | Claude/Codex `agent_transcript_snapshot` for the session's cwd and known conversation id; pass `revision` back as the numeric cursor |
| `context.agents.decidePermission(requestId, behavior, message?)` | `agent.approve` | `agent_permission_decide`: `allow`, `deny`, or `defer`; optional denial explanation; backend rejects expired/already-decided requests |
| `context.agents.onPermissionReleased(handler)` | `agent.approve` | tracked `agent-permission://released` listener: `{ requestId, reason }` |

A transcript returns `{ conversationId, revision, unchanged, firstIndex, messages }`. An unchanged
revision has no messages. Each message contains `role`, `text`, and optional tool/question fields;
tool summaries contain `name` and optional `command`, `path`, `description`. Other harnesses throw
`transcript_unsupported:<agent>`; use their terminal screen instead. The existing backend returns
an empty snapshot when none is available and may select the latest conversation in that cwd when
the requested conversation cannot be found.

The trust dialog explicitly discloses seeing agent activity and approving agent actions. Merely
observing hooks does not grant permission to decide. `setTargets` also requires `agent.approve`
because it causes Rust to hold permission prompts for a plugin answer. Targets and hook holds are
released on plugin deactivation or failed activation. Voice targets, like playback and the HUD,
are shared app state; coordinate writers.

`setConversationHooks(true)` does not retrofit an already-running Claude process: compare
`hookedSessions()` with `terminals.sessions()` and offer an explicit `restart(id)` that resumes
its conversation. The hook flag is transient and remains enabled while any active plugin holds it.
New launches after the last hold is released use the default hooks again.

These are additive API 3 methods; `PLUGIN_API_VERSION` stays 3. Feature-detect the methods when
supporting older API 3 hosts. All new listeners and shortcut holds enter `context.subscriptions`
and are released when activation fails or the plugin is disabled. No preference or plugin storage
schema changes are introduced. This change supplies the host bridge for the external `alethe.voice`
plugin; its conversation UI, narration, selection/read-aloud integration, and settings are not
bundled into the host.

### Agents and shared components

`context.agents.label(agent)` and `context.agents.accent(agent)` give an agent's display name and a
CSS color that follows the active theme. `context.components` hands out two of the app's own
components, so a plugin does not redraw them by hand:

| Component | Props |
|---|---|
| `AgentIcon` | `agent`, `size?` — the official mark, in the variant for the current theme |
| `Dropdown` | `value`, `options: { value, label }[]`, `onChange`, `ariaLabel`, `disabled?` — the themed dropdown used across Preferences |

They render with the host's React, which a local plugin could not bundle anyway: a second copy of
`react-dom` would not share the host's tree, so a menu drawn through a portal would never appear.

### Streaming from a host command

A function passed in the arguments of `context.invoke` becomes a channel: the command streams
messages to it while the call is running. `invoke` resolves when the command returns, and messages
can still arrive briefly after that.

```ts
const total = await context.invoke<number>('agent_voice_tts', {
  text,
  voiceId,
  model,
  onChunk: (pcm: ArrayBuffer) => player.push(pcm),
})
```

A plugin therefore never imports `@tauri-apps/api`, whose channel format must match the app's own
Tauri version.

### Agent providers

`AgentType` is open (`BuiltinAgentType | (string & {})`), the same shape as `Theme`. A provider
supplies its id, display name, CLI binary, unrestricted-mode flag and accent token; the launcher,
the pickers, the icons and the colors all resolve through `src/lib/agentProviders.ts`, falling back
safely for an id nobody registered. Adding an agent CLI is a plugin, not nine edits across the core.

Provider names are not translated — they are product names, like an extension's display name.

### Views

A view gets the focused surface as props:

```ts
type SidebarTabProps = {
  projectId: string | null
  cwd: string | null
  ptyId: string | null
  terminalName: string | null
}
```

Every field is null when there is no usable terminal; the view renders its own empty state. Anything
else it needs it reads from the stores directly. The shell draws the panel header, so a view renders
its body only — that is what lets the same component serve either sidebar.

A view's container comes from the manifest and can be overridden per user. The `projects` and
`files` tabs are not contributions: they are the sidebar's own structure, not features mounted
inside it. Contributed tabs sit alongside them, and the shells fall back to `projects` when the
active tab's plugin is disabled.

### Panes

Core panes go through the same registry (`src/components/WorkspaceView/corePanes.tsx`), so there is
one lookup path and a plugin cannot silently shadow a built-in kind. A pane whose provider is
missing renders an "unavailable" placeholder rather than falling back to a terminal — falling back
would attach a shell to that pane's working directory, which is a different thing entirely.

## Registering a bundled plugin

Add it to `BUNDLED_PLUGINS` in `src/plugins/index.ts`:

```ts
{
  manifest: MY_MANIFEST,
  load: () => import('./my-plugin/main').then((module) => module.default),
}
```

Vite code-splits it into its own chunk. Nothing else is needed.

## Local plugins and `alethe-plugin://`

A local plugin's assets are served by a custom URI scheme whose root is **fixed per plugin**:
`alethe-plugin://<pluginId>/<path>`, resolved by `src-tauri/src/plugin_assets.rs`. This is preferred
over Tauri's `assetProtocol`, whose scope is configurable and therefore weaker.

The resolver rejects an invalid plugin id, `..` segments, absolute paths, drive and UNC prefixes,
backslashes, and percent-encoded traversal; it canonicalizes both the plugin directory and the
target and refuses anything that lands outside — which is what defeats a symlink pointing elsewhere.
Content type comes from the extension only, never sniffed, so a `.txt` holding script text is served
inert.

The scheme is allowed in `script-src`, `style-src`, `font-src` and `img-src`, in both its
`alethe-plugin:` and `http://alethe-plugin.localhost` forms. **Windows and Android reach a custom
scheme only through the `.localhost` form**, so the loader builds the URL per platform.

The two shapes differ in where the plugin id sits, which the handler has to reconcile:

| Platform | What the page requests | What reaches the handler | Plugin id |
|---|---|---|---|
| macOS, Linux | `alethe-plugin://<id>/<path>` | same | the host |
| Windows, Android | `http://alethe-plugin.localhost/<id>/<path>` | `alethe-plugin://localhost/<id>/<path>` | first path segment |

Tauri rewrites the `.localhost` form and the host arrives as the literal string `localhost`, not as
`alethe-plugin.localhost`. `split_target` in `plugin_assets.rs` handles both and is covered by a
test, because getting it wrong fails silently: the script simply never loads. No remote
origin and no `eval` were added; `src/securityPolicy.test.ts` asserts each directive literally,
including those negatives.

**Importing.** Preferences → Plugins → *Import plugin* opens a folder picker and copies the
directory in (`plugin_import_dir`). The manifest is validated before anything is written, declared
assets must exist, symlinks are refused, and the copy is bounded (200 files, 10 MB, 5 levels). The
plugin arrives disabled; re-importing over an existing id keeps whatever the user had chosen.

`src/lib/plugins/localTransport.ts` injects the `<script>`, hands the plugin `window.alethe`
(`apiVersion`, `react`, `jsxRuntime`, `registerPlugin`), and waits for the plugin to register
itself. Nothing is evaluated from a string. A plugin that fails to load, or never registers within
ten seconds, is reported as an activation error and leaves no script or stylesheet behind.

The global is string-keyed because the production bundle is minified with `mangle.toplevel` — a
plugin cannot import from the host by module name.

## The catalogue

Preferences → Plugins lists plugins published by other people. The index is a single file,
`plugins.json`, at the root of this repository, read from
`raw.githubusercontent.com/Kc1t/alethe-agents/main/plugins.json`:

```jsonc
{
  "schema": 1,
  "plugins": [
    {
      "id": "acme.panel",
      "name": "Panel",
      "description": "…",
      "author": "acme",
      "repo": "acme/alethe-panel",
      "downloadUrl": "https://github.com/acme/alethe-panel/releases/latest",
      "version": "1.0.0",
      "minApiVersion": 1,
      "capabilities": ["ui.sidebarTab"]
    }
  ]
}
```

An entry with a `package` can be installed from inside the app; one without it is a pointer, and
*Get plugin* opens the author's page for a manual download and import.

**Installing from the app is not a weaker path than importing by hand.** The manual route has no
integrity check at all — a zip from a link is whatever the link served today. The `package.sha256`
in the index pins the bytes to what the reviewer of the pull request saw, so the installed plugin is
verifiable in a way a hand-dropped folder never was. The power granted is identical either way; only
the evidence differs.

What installing does *not* do is grant permission to run. The plugin lands disabled, exactly like an
imported one, and turning it on still goes through the trust dialog listing its capabilities.

A listing is dropped, not shown, when its id is not a plain id, its name is empty, its
`downloadUrl` is not `https`, its `minApiVersion` is above this build, or it carries a `package`
whose URL is not `https` or whose `sha256` is not 64 hex characters. `plugin_catalog_open`
re-checks the URL against the cached catalogue, so a link can never be turned into a general
opener, and it launches the browser without a shell in the chain. The command is on the
forbidden list, so no plugin can call it.

`plugin_install_from_catalog` takes only an id. The URL and the hash are read from the cached index
inside Rust, so a caller cannot aim it at something the catalogue never listed. Beyond the hash, the
unpacking refuses archive entries that escape the destination (`..`, absolute paths, drive letters,
UNC roots), caps the download, the unpacked size and the entry count, and requires the `id` inside
the archive's own `plugin.json` to match the id being installed — without that last check a listing
could ship an archive claiming to be a plugin the user already trusted and replace it.

The index is cached in `<profile>/plugins/catalog-cache.json` for six hours. When the network
fails the cache is served and flagged stale — a directory the user cannot reach is more useful
stale than empty. The fetch happens in Rust, so no CSP change was needed.

Keeping the index in the app repository is the simple starting point — moving it to its own
repository later changes one constant and keeps the URL shape.

### Publishing a plugin

The plugin lives in its author's repository; nothing is hosted here. Getting listed is a pull
request against `main` adding one entry to `plugins.json`.

1. Publish the plugin somewhere a person can download it — a release asset, or a folder in the
   repository. The link must be reachable without signing in.
2. Open a pull request adding one object to `plugins`, keeping the file valid JSON.
3. Once it is merged, the entry reaches everyone within six hours, or immediately on *Refresh*.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Must match the `id` in `plugin.json`. Letters, digits, `-`, `_`, `.` only. |
| `name` | yes | Shown in the list. |
| `downloadUrl` | yes | `https` only. Where *Get plugin* sends the user. |
| `description` | no | One line. |
| `author` | no | Shown as *By …*. |
| `repo` | no | `owner/name`, displayed only — never used to build a path. |
| `version` | no | Shown next to the name. |
| `minApiVersion` | no | Defaults to `1`. Older apps hide the entry instead of failing on it. To keep an older release for older apps, list it again under the same `id` after the newer one: each app offers the first entry it can run. |
| `capabilities` | no | Copy them from `plugin.json` so the list can show what the plugin asks for. |
| `package.url` | no | `https` link to a zip. Adding it makes the plugin installable from the app. |
| `package.sha256` | with `package` | 64 hex characters over the exact zip bytes. |

An entry that breaks the rules is **dropped silently** rather than shown, so a listing that never
appears is usually a malformed `id`, an empty `name`, a non-`https` link, or a `minApiVersion`
above the running build. `capabilities` here is a label for the user: the app enforces the ones in
the installed `plugin.json`, not the ones claimed in the index.

Review is a human reading the pull request. Listing is not an endorsement and not an audit — the
plugin still arrives switched off and still goes through the trust dialog, which is why the
catalogue can afford to be an open directory.

An empty `plugins` array is a valid index and the correct thing to publish while nothing is ready:
the app shows an empty catalogue instead of an error.

`builtIn` lists the plugins that ship inside the app (`id`, `name`, `description`, `version`,
`capabilities`). The app ignores it; the website's plugin page reads it so it can show every plugin
from this one file. `src/plugins/catalogue.test.ts` fails when it drifts from `BUNDLED_PLUGINS`.

`package` is optional and older builds ignore it, so adding one does not need a schema bump and does
not break an app that predates installing.

### Building the package

The zip holds the plugin directory — `plugin.json` at the root, or inside a single wrapping folder,
which is the shape a forge's "download zip" produces. Anything else is refused as ambiguous.

```powershell
Compress-Archive -Path my-plugin\* -DestinationPath my-plugin.zip
(Get-FileHash my-plugin.zip -Algorithm SHA256).Hash.ToLower()
```

```bash
zip -r my-plugin.zip my-plugin
sha256sum my-plugin.zip
```

Attach the zip to a release and put that URL in `package.url`. **Re-hash whenever the zip changes**:
a stale hash does not install a stale plugin, it fails the check and installs nothing.

The plugin's `main.js` must be a bundle that binds against `window.alethe` rather than importing the
host. Do not bundle React — take it from `window.alethe.react`, which is why the surface is
string-keyed: the app is minified with `mangle.toplevel`, so nothing is reachable by module name.
`docs/examples/notes-plugin/` is a working plugin in plain JavaScript with no build step at all, and
is the shortest way to see the contract. Jev (`alethe.jev`, in `Kc1t/alethe-jev`) is the full-size
case: TypeScript and CSS Modules built by Vite into one IIFE that takes React from
`window.alethe.react`, using overlays, settings sections, a sidebar view, the workspace API and `context.voice`. When a
built-in feature moves out like this, `legacyMigration.ts` hands its old preferences to the plugin's
storage as `legacyPreferences`, and the plugin converts them once. Secrets do not travel that way:
the OpenRouter key Jev 1.0 kept in its storage is moved into the keychain at startup, and blanked
there once Jev 1.1 or newer, which reads the keychain, is installed.

## Where things live

| Path | Role |
|---|---|
| `src/lib/plugins/host.ts` | discovery, declaration, activation, enable/disable, the plugin context |
| `src/lib/plugins/registry.ts` | `ContributionList` and the contribution registries |
| `src/lib/plugins/permissions.ts` | capability matching and the forbidden-command list |
| `src/lib/plugins/localTransport.ts` | `window.alethe` and the local `<script>` loader |
| `src/lib/plugins/storage.ts` | `context.storage` — the per-plugin persisted record |
| `src/lib/plugins/workspace.ts` | `context.workspace` — snapshot, terminal control and input |
| `src/lib/plugins/terminals.ts` | `context.terminals` — sessions, their output, exit, size and input |
| `src/lib/plugins/agents.ts` | agent hook observation, transcript snapshots, and permission decisions |
| `src/lib/plugins/presentation.tsx` | agent labels/accents and shared `context.components` |
| `src/lib/plugins/voice.ts` | typed voice services, conversation targets, and hook holds |
| `src/lib/plugins/legacyMigration.ts` | hands settings of features that became plugins to their storage |
| `src/components/ContributedOverlays/` | mounts every contributed overlay behind its own error boundary |
| `src/components/modals/preferences/ContributedSettings.tsx` | renders contributed settings sections |
| `src/lib/plugins/icons.ts` | the icon names a manifest may use |
| `src/lib/themeTokens.ts` | theme token sanitization and stylesheet injection |
| `src/lib/tauri/plugins.ts` | IPC bindings |
| `src-tauri/src/plugins.rs` | manifest storage, id validation, enable/disable state |
| `src-tauri/src/plugin_assets.rs` | `alethe-plugin://` path resolution and safety |
| `src/components/ContributedView/` | renders a declared view, activating it on reveal |
| `src/components/modals/preferences/PluginsPage.tsx` | the management UI |
| `src/components/ContributedModals/` | mounts the contributed modal matching `openModal` |
| `src-tauri/src/plugin_catalog.rs` | the catalogue index: fetch, cache and validation |
| `src-tauri/src/plugin_package.rs` | download, checksum and safe unpacking of a package |
| `src/components/modals/preferences/PluginCatalog.tsx` | the catalogue UI |
| `plugins.json` | the published index |
| `src/plugins/` | bundled plugins |

Enable/disable state lives in `<profile>/plugins/state.json` and covers bundled plugins too, so the
choice survives an app update. The two sources are treated differently on purpose: a **bundled**
plugin runs unless it is listed as disabled, while a **local** plugin runs only once it is listed as
enabled. Dropping a folder into the plugins directory therefore grants nothing by itself — the
plugin shows up switched off and enabling it goes through the trust dialog.
