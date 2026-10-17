# Voice Conversation — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Talk to the active Claude Code pane from inside the Alethe main window, hear it narrate its work, and answer its permission prompts by voice or on a docked panel.

**Architecture:** Rust gains four pieces: voice hook events in the per-terminal Claude settings file, a held `PermissionRequest` map that answers Claude later, a transcript command, and a TTS module. The frontend gains pure modules under `src/lib/voice/` (routing, permissions, narrator, target, state machine), an agent input registry so code outside the xterm hook can submit to a PTY, and a controller in the main window that ties capture → STT → route → submit → narrate → approve together. A docked `VoiceConversationView` shows it. Phase 2 moves that same view into a floating HUD window.

**Tech Stack:** Tauri 2 (Rust, `tiny_http`, `tts` 0.26.3, sherpa-onnx STT already present), React 18 + TypeScript, Zustand, Vitest (jsdom), CSS Modules.

**Spec:** [`docs/superpowers/specs/2026-10-14-voice-conversation-design.md`](../specs/2026-10-14-voice-conversation-design.md) — read §4, §6, §7 and §10 before starting any task.

## Global Constraints

- **Never commit, push, tag or release.** `CLAUDE.md` §3.2: changes stay in the working tree; the owner commits. Every task ends with a checkpoint step, not a commit.
- **Never stop or restart the running app or dev server** (`npm run app` / Vite). Rely on HMR. Rust changes are verified with `cargo test`/`cargo check`, not by relaunching the app.
- **i18n:** every visible string goes through `t()`. Each new key goes into `src/lib/i18n/messages/en.ts`, `pt-BR.ts` and `zh-CN.ts`; `npm run build` fails when one is missing.
- **Styling:** one `.module.css` per component; colors, radii and shadows only through `src/styles/theme.css` tokens (`--bg`, `--fg`, `--accent`, `--status-*`, `--border`, `--radius-*`, `--shadow-*` …). No hardcoded colors, no gradients.
- **Language:** English for code, comments, docs and changelog. Comments only where behaviour is non-obvious. Translate any Portuguese comment in a block you edit.
- **CSP:** `src-tauri/tauri.conf.json` CSP is unchanged; `src/securityPolicy.test.ts` must still pass.
- **Default STT model** for the feature is the dictation model, default `parakeet-tdt-0.6b-v3-int8`.
- **Default interrupt words:** `['stop', 'espera', 'cancela']` — never `para`.
- **Permission hook:** `timeout: 300` in the settings file; Rust releases a held request itself at **290 s**.
- **Voice submit sends exactly one `\r`** after the paste. No retries (a stray `\r` would approve a later permission dialog).
- **Sensitive commands** (`agent_permission_decide`, `voice_set_targets`) reject any calling window whose label is not `main`.
- **Logging:** `PreToolUse`, `PostToolUse`, `PermissionRequest` payloads are logged as event name + `tool_name` only.
- **Changelog:** user-facing entry under `## [Unreleased]` in `docs/CHANGELOG.md` (Task 14).
- Test commands: `npx vitest run <file>` for one frontend file, `npm test` for all; `cargo test --manifest-path src-tauri/Cargo.toml --lib <filter>` for Rust; `npm run build` typechecks and validates i18n.

## Review Focus

1. **Quick tap on push-to-talk** (shortcut released before the mic finished opening) → capture must still stop and nothing must stay recording. Pinned in Task 11 (`releaseAfterStart`) with a unit test on the controller's start/release ordering.
2. **The user repeats the exact same prompt twice** → narration must not re-read the previous turn's answer. Pinned by the absolute `firstIndex` cursor (Task 4) and the narrator cursor test in Task 9.
3. **A spoken "yes" to `rm -rf` or `git push --force`** → must not approve; the panel must ask for a click. Pinned in Task 8 (`answerAllowed` test) and Task 11 (controller uses it).
4. **Claude's target pane is closed while a permission is held** → the hold must be released (empty 200) and the card must disappear. Pinned in Task 3 (`set_targets` releases) and Task 11 (`agent-permission://released` handling).
5. **A plain session with voice on, orchestrator off** → the orchestrator canvas must not grow tool / background-shell nodes from voice-only events. Pinned in Task 2 (`voiceOnly` tag) with a bridge test.

---

### Task 1: Voice conversation preferences (data model)

**Files:**
- Modify: `src/lib/types.ts` (types near `Preferences` at `:730`, fields after `voiceCommandApiKey` at `:856`, defaults after `voiceCommandApiKey: ''` at `:1053`)
- Modify: `src/stores/projectsStore.migrations.ts` (inside `normalizePreferences`, after the dictation fields at `:193-208`)
- Modify: `src/lib/cloudSync.ts:9-46` (`SYNCED_PREFERENCE_KEYS`)
- Test: `src/stores/projectsStore.migrations.test.ts`

**Interfaces:**
- Produces (in `src/lib/types.ts`):
  ```ts
  export type VoiceCaptureMode = 'push-to-talk' | 'toggle'
  export type VoiceVerbosity = 'silent' | 'final' | 'normal' | 'detailed'
  export type VoiceApprovalChannel = 'both' | 'voice' | 'hud'
  export type VoiceMidTaskDefault = 'queue' | 'interrupt'
  // Preferences fields:
  voiceConversationEnabled: boolean
  voiceShortcut: string
  voiceCaptureMode: VoiceCaptureMode
  voiceTtsVoice: string | null
  voiceTtsRate: number
  voiceVerbosity: VoiceVerbosity
  voiceFillAfterMs: number
  voiceApprovalChannel: VoiceApprovalChannel
  voiceDestructiveNeedsHud: boolean
  voiceMidTaskDefault: VoiceMidTaskDefault
  voiceInterruptWords: string[]
  voiceJevTrigger: string
  ```

- [ ] **Step 1: Write the failing test** — append to `src/stores/projectsStore.migrations.test.ts`, inside `describe('preference normalization', …)`:

```ts
  it('backfills voice conversation preferences with safe defaults', () => {
    const preferences = normalizePreferences({})
    expect(preferences).toMatchObject({
      voiceConversationEnabled: false,
      voiceShortcut: 'CmdOrCtrl+Shift+Space',
      voiceCaptureMode: 'push-to-talk',
      voiceTtsVoice: null,
      voiceTtsRate: 1,
      voiceVerbosity: 'normal',
      voiceFillAfterMs: 8000,
      voiceApprovalChannel: 'both',
      voiceDestructiveNeedsHud: true,
      voiceMidTaskDefault: 'queue',
      voiceInterruptWords: ['stop', 'espera', 'cancela'],
      voiceJevTrigger: 'alethe',
    })
  })

  it('repairs voice conversation preferences that are out of range or the wrong shape', () => {
    const preferences = normalizePreferences({
      voiceCaptureMode: 'shout',
      voiceTtsVoice: '   ',
      voiceTtsRate: 9,
      voiceVerbosity: 'loud',
      voiceFillAfterMs: 10,
      voiceApprovalChannel: 'telepathy',
      voiceMidTaskDefault: 'explode',
      voiceInterruptWords: [' STOP ', '', 42, 'Espera'],
      voiceJevTrigger: '  ',
      voiceShortcut: '',
    } as unknown as Partial<Preferences>)
    expect(preferences).toMatchObject({
      voiceCaptureMode: 'push-to-talk',
      voiceTtsVoice: null,
      voiceTtsRate: 2,
      voiceVerbosity: 'normal',
      voiceFillAfterMs: 3000,
      voiceApprovalChannel: 'both',
      voiceMidTaskDefault: 'queue',
      voiceInterruptWords: ['stop', 'espera'],
      voiceJevTrigger: 'alethe',
      voiceShortcut: 'CmdOrCtrl+Shift+Space',
    })
  })

  it('keeps an explicitly empty interrupt word list', () => {
    expect(normalizePreferences({ voiceInterruptWords: [] }).voiceInterruptWords).toEqual([])
  })
```

Add `type Preferences` to the existing `../lib/types` import at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stores/projectsStore.migrations.test.ts`
Expected: FAIL — TypeScript/assertion errors on the unknown `voice*` fields.

- [ ] **Step 3: Add the types, fields and defaults** in `src/lib/types.ts`.

Above `export type Preferences = {`:

```ts
export type VoiceCaptureMode = 'push-to-talk' | 'toggle'
export type VoiceVerbosity = 'silent' | 'final' | 'normal' | 'detailed'
export type VoiceApprovalChannel = 'both' | 'voice' | 'hud'
export type VoiceMidTaskDefault = 'queue' | 'interrupt'
```

After `voiceCommandApiKey: string` inside `Preferences`:

```ts
  /** Talk to the active Claude pane and hear it narrate. Uses the dictation model and mic. */
  voiceConversationEnabled: boolean
  /** Accelerator for voice conversation, e.g. `CmdOrCtrl+Shift+Space`. */
  voiceShortcut: string
  voiceCaptureMode: VoiceCaptureMode
  /** System voice id for narration, or null for the system default. */
  voiceTtsVoice: string | null
  /** Narration speed as a multiple of the engine's normal rate (0.5–2). */
  voiceTtsRate: number
  voiceVerbosity: VoiceVerbosity
  /** Silence before a short status is spoken while a tool runs (3–60 s). */
  voiceFillAfterMs: number
  voiceApprovalChannel: VoiceApprovalChannel
  /** Destructive commands need a click on the panel even after a spoken yes. */
  voiceDestructiveNeedsHud: boolean
  voiceMidTaskDefault: VoiceMidTaskDefault
  /** Leading words that interrupt Claude (Esc) before the rest is sent. */
  voiceInterruptWords: string[]
  /** Leading word that routes the rest of the transcript to Jev. */
  voiceJevTrigger: string
```

After `voiceCommandApiKey: '',` inside `DEFAULT_PREFERENCES`:

```ts
  voiceConversationEnabled: false,
  voiceShortcut: 'CmdOrCtrl+Shift+Space',
  voiceCaptureMode: 'push-to-talk',
  voiceTtsVoice: null,
  voiceTtsRate: 1,
  voiceVerbosity: 'normal',
  voiceFillAfterMs: 8000,
  voiceApprovalChannel: 'both',
  voiceDestructiveNeedsHud: true,
  voiceMidTaskDefault: 'queue',
  voiceInterruptWords: ['stop', 'espera', 'cancela'],
  voiceJevTrigger: 'alethe',
```

- [ ] **Step 4: Normalize them** in `src/stores/projectsStore.migrations.ts`. Add these helpers above `normalizePreferences`:

```ts
const VOICE_VERBOSITIES = ['silent', 'final', 'normal', 'detailed'] as const
const VOICE_APPROVAL_CHANNELS = ['both', 'voice', 'hud'] as const

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function normalizeVoiceWords(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_PREFERENCES.voiceInterruptWords]
  const words = value
    .filter((word): word is string => typeof word === 'string')
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean)
  return [...new Set(words)].slice(0, 10)
}

function trimmedOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}
```

Then, in the object `normalizePreferences` returns, right after `dictationMicrophoneLabel: …,`:

```ts
    voiceConversationEnabled: Boolean(preferences.voiceConversationEnabled),
    voiceShortcut: trimmedOr(preferences.voiceShortcut, DEFAULT_PREFERENCES.voiceShortcut),
    voiceCaptureMode: preferences.voiceCaptureMode === 'toggle' ? 'toggle' : 'push-to-talk',
    voiceTtsVoice:
      typeof preferences.voiceTtsVoice === 'string' && preferences.voiceTtsVoice.trim()
        ? preferences.voiceTtsVoice.trim()
        : null,
    voiceTtsRate: clampNumber(preferences.voiceTtsRate, 0.5, 2, DEFAULT_PREFERENCES.voiceTtsRate),
    voiceVerbosity: oneOf(preferences.voiceVerbosity, VOICE_VERBOSITIES, 'normal'),
    voiceFillAfterMs: Math.round(
      clampNumber(preferences.voiceFillAfterMs, 3000, 60000, DEFAULT_PREFERENCES.voiceFillAfterMs),
    ),
    voiceApprovalChannel: oneOf(preferences.voiceApprovalChannel, VOICE_APPROVAL_CHANNELS, 'both'),
    voiceDestructiveNeedsHud: preferences.voiceDestructiveNeedsHud !== false,
    voiceMidTaskDefault: preferences.voiceMidTaskDefault === 'interrupt' ? 'interrupt' : 'queue',
    voiceInterruptWords: normalizeVoiceWords(preferences.voiceInterruptWords),
    voiceJevTrigger: trimmedOr(preferences.voiceJevTrigger, DEFAULT_PREFERENCES.voiceJevTrigger)
      .toLowerCase(),
```

`preferences` here is the `{...DEFAULT_PREFERENCES, ...raw}` spread that the function already builds, so a missing field arrives as its default.

- [ ] **Step 5: Sync the device-independent fields.** In `src/lib/cloudSync.ts`, add after `'dictationEnabled',`:

```ts
  'voiceConversationEnabled',
  'voiceShortcut',
  'voiceCaptureMode',
  'voiceVerbosity',
  'voiceFillAfterMs',
  'voiceApprovalChannel',
  'voiceDestructiveNeedsHud',
  'voiceMidTaskDefault',
  'voiceInterruptWords',
  'voiceJevTrigger',
```

`voiceTtsVoice` and `voiceTtsRate` stay local: system voices differ per machine.

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/stores/projectsStore.migrations.test.ts src/lib/cloudSync.test.ts`
Expected: PASS (if `cloudSync.test.ts` does not exist, run only the migrations file).

- [ ] **Step 7: Checkpoint** — leave the changes in the working tree. Do not commit.

---

### Task 2: Voice hook events in the Claude settings file

**Files:**
- Modify: `src-tauri/src/agent_events.rs:89-169` (`agent_hooks_settings_path`), the generic `/hook` branch of `start_listener` (`:640-697`), tests module at the end
- Modify: `src/lib/tauri/agents.ts:57-69` (`agentHooksSettingsPath`)
- Modify: `src/lib/claudeMcpConfigs.ts:102` (caller)
- Modify: `src/stores/agentCanvasStore.ts:5-31` (`AgentHookPayload`)
- Modify: `src/hooks/useAgentHookBridge.ts`, `src/stores/agentSandboxStore.ts:554`
- Modify: `src/stores/agentSandboxStore.ts:211` (pass `false` for voice)
- Test: `src-tauri/src/agent_events.rs` (tests module), `src/lib/tauri/agents.test.ts`, `src/hooks/useAgentHookBridge.test.ts` (new)

**Interfaces:**
- Produces (Rust, `agent_events.rs`): `fn build_hooks(endpoint: &str, token: &str, planner_id: &str, orchestrator: bool, voice: bool) -> serde_json::Map<String, serde_json::Value>`; `fn hook_log_line(event: &str, tool: Option<&str>, body: &str) -> String`; `const PERMISSION_HOOK_TIMEOUT_SECS: u64 = 300`.
- Produces (TS): `agentHooksSettingsPath(plannerId: string, orchestrator = true, aiMemory?: {enabled: boolean; port: number} | null, voice?: boolean): Promise<string>` — `voice` undefined means the live `voiceConversationEnabled` preference.
- Produces (TS): `AgentHookPayload` gains `voiceOnly?: boolean`, `permissionRequestId?: string`, `cwd?: string`.

- [ ] **Step 1: Write the failing Rust tests** — append inside `mod tests` at the end of `agent_events.rs`:

```rust
    use super::{build_hooks, hook_log_line, PERMISSION_HOOK_TIMEOUT_SECS};

    fn events(hooks: &serde_json::Map<String, serde_json::Value>) -> Vec<String> {
        let mut names: Vec<String> = hooks.keys().cloned().collect();
        names.sort();
        names
    }

    fn entry<'a>(
        hooks: &'a serde_json::Map<String, serde_json::Value>,
        event: &str,
    ) -> &'a serde_json::Value {
        &hooks[event][0]["hooks"][0]
    }

    #[test]
    fn session_variant_without_voice_only_tracks_the_session() {
        let hooks = build_hooks("http://127.0.0.1:9123", "tok", "pty-1", false, false);
        assert_eq!(events(&hooks), vec!["SessionStart", "UserPromptSubmit"]);
    }

    #[test]
    fn voice_adds_tool_stop_and_permission_events_to_the_session_variant() {
        let hooks = build_hooks("http://127.0.0.1:9123", "tok", "pty-1", false, true);
        assert_eq!(
            events(&hooks),
            vec![
                "PermissionRequest",
                "PostToolUse",
                "PreToolUse",
                "SessionStart",
                "Stop",
                "UserPromptSubmit"
            ]
        );
        assert_eq!(entry(&hooks, "PermissionRequest")["timeout"], PERMISSION_HOOK_TIMEOUT_SECS);
        assert_eq!(entry(&hooks, "PreToolUse")["timeout"], 5);
        assert_eq!(entry(&hooks, "PreToolUse")["headers"]["X-Alethe-Voice-Only"], "1");
        assert!(entry(&hooks, "SessionStart")["headers"].get("X-Alethe-Voice-Only").is_none());
    }

    #[test]
    fn voice_on_the_full_variant_registers_no_event_twice() {
        let hooks = build_hooks("http://127.0.0.1:9123", "tok", "pty-1", true, true);
        for event in ["PreToolUse", "PostToolUse", "Stop"] {
            assert_eq!(hooks[event].as_array().unwrap().len(), 1, "{event} registered twice");
            assert!(
                entry(&hooks, event)["headers"].get("X-Alethe-Voice-Only").is_none(),
                "{event} belongs to the orchestrator variant, so it is not voice-only"
            );
        }
        assert_eq!(entry(&hooks, "PermissionRequest")["headers"]["X-Alethe-Voice-Only"], "1");
        assert!(hooks.contains_key("SubagentStart"));
    }

    #[test]
    fn every_hook_carries_the_token_and_the_planner() {
        let hooks = build_hooks("http://127.0.0.1:9123", "tok", "pty-1", true, true);
        for (event, _) in hooks.iter() {
            let headers = &entry(&hooks, event)["headers"];
            assert_eq!(headers["X-Alethe-Token"], "tok", "{event}");
            assert_eq!(headers["X-Alethe-Planner"], "pty-1", "{event}");
            assert_eq!(entry(&hooks, event)["url"], "http://127.0.0.1:9123/hook");
        }
    }

    #[test]
    fn tool_and_permission_payloads_are_logged_without_their_content() {
        let body = r#"{"tool_input":{"command":"export TOKEN=secret"}}"#;
        let line = hook_log_line("PreToolUse", Some("Bash"), body);
        assert!(!line.contains("secret"));
        assert!(line.contains("PreToolUse") && line.contains("Bash"));
        assert!(!hook_log_line("PermissionRequest", Some("Bash"), body).contains("secret"));
        assert!(!hook_log_line("PostToolUse", Some("Read"), body).contains("secret"));
        assert!(hook_log_line("SessionStart", None, body).contains("secret"));
    }
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib agent_events::tests`
Expected: FAIL to compile — `build_hooks`, `hook_log_line`, `PERMISSION_HOOK_TIMEOUT_SECS` not found.

- [ ] **Step 3: Extract `build_hooks` and add the voice events.** In `agent_events.rs`, below `agent_canvas_mirror`, add:

```rust
const HOOK_TIMEOUT_SECS: u64 = 5;
/// Claude waits on this hook while a voice conversation decides; Alethe answers it itself at
/// `PERMISSION_HOLD` (290 s), before this timeout, because what Claude does on a hook timeout is
/// undocumented.
const PERMISSION_HOOK_TIMEOUT_SECS: u64 = 300;

const ORCHESTRATOR_EVENTS: [&str; 8] = [
    "SubagentStart",
    "SubagentStop",
    "PreToolUse",
    "PostToolUse",
    "TeammateIdle",
    "TaskCreated",
    "TaskCompleted",
    // Lists what is still running when a turn ends, which is how the board notices a background
    // worker whose own end event never came. `/hook` answers with an empty body, so this never
    // blocks the agent from stopping.
    "Stop",
];

const VOICE_EVENTS: [&str; 4] = ["PreToolUse", "PostToolUse", "Stop", "PermissionRequest"];

/// The hook entries for one Claude terminal. Events present only because of `voice` carry
/// `X-Alethe-Voice-Only`, so the orchestrator board can ignore them.
fn build_hooks(
    endpoint: &str,
    token: &str,
    planner_id: &str,
    orchestrator: bool,
    voice: bool,
) -> serde_json::Map<String, serde_json::Value> {
    let entry = |timeout: u64, voice_only: bool| {
        let mut headers = serde_json::json!({
            "X-Alethe-Token": token,
            "X-Alethe-Planner": planner_id,
        });
        if voice_only {
            headers["X-Alethe-Voice-Only"] = serde_json::Value::String("1".to_string());
        }
        serde_json::json!([
            { "hooks": [ {
                "type": "http",
                "url": format!("{endpoint}/hook"),
                "timeout": timeout,
                "headers": headers
            } ] }
        ])
    };

    // Both carry `session_id`, the only authoritative answer to which conversation a pane sits on
    // once `/clear` or an in-CLI `/resume` moves it off the id it was launched with.
    let mut hooks = serde_json::Map::new();
    hooks.insert("SessionStart".to_string(), entry(HOOK_TIMEOUT_SECS, false));
    hooks.insert("UserPromptSubmit".to_string(), entry(HOOK_TIMEOUT_SECS, false));
    if orchestrator {
        for event in ORCHESTRATOR_EVENTS {
            hooks.insert(event.to_string(), entry(HOOK_TIMEOUT_SECS, false));
        }
    }
    if voice {
        for event in VOICE_EVENTS {
            if hooks.contains_key(event) {
                continue;
            }
            let timeout = if event == "PermissionRequest" {
                PERMISSION_HOOK_TIMEOUT_SECS
            } else {
                HOOK_TIMEOUT_SECS
            };
            hooks.insert(event.to_string(), entry(timeout, true));
        }
    }
    hooks
}
```

Then rewrite `agent_hooks_settings_path` to take `voice: Option<bool>` and use `build_hooks`. Replace everything from `let variant = …` down to the end of the `if orchestrator { … }` block with:

```rust
    let voice = voice.unwrap_or(false);
    let variant = match (orchestrator, voice) {
        (true, false) => "full",
        (true, true) => "full-voice",
        (false, false) => "session",
        (false, true) => "session-voice",
    };
    let path = hook_settings_dir()?.join(format!(
        "alethe-agent-hooks-{port}-{variant}-{safe_planner}.json"
    ));
    let mut hooks = build_hooks(&endpoint, init_token(), &planner_id, orchestrator, voice);

    let mut settings = serde_json::Map::new();
    if orchestrator {
        settings.insert(
            "teammateMode".to_string(),
            serde_json::Value::String("in-process".to_string()),
        );
    }
```

Add `voice: Option<bool>,` to the parameter list after `ai_memory_port: Option<u16>,`. The ai-memory merge and the write that follow stay as they are. Also translate the two Portuguese error strings in this function and in `agent_hooks_endpoint` to `"the agent listener is not available yet"`.

- [ ] **Step 4: Add `hook_log_line` and the voice-only tag to the listener.** Add next to `build_hooks`:

```rust
/// These payloads carry commands and file contents, so only their names reach the log.
const CONTENT_BEARING_EVENTS: [&str; 3] = ["PreToolUse", "PostToolUse", "PermissionRequest"];

fn hook_log_line(event: &str, tool: Option<&str>, body: &str) -> String {
    if CONTENT_BEARING_EVENTS.contains(&event) {
        return format!("[agent_events] payload: {event} tool={}", tool.unwrap_or("?"));
    }
    let preview: String = body.chars().take(4000).collect();
    format!("[agent_events] payload: {preview}")
}
```

In `start_listener`'s generic branch (`Ok(mut payload) => { … }`), right after the `sourceAgent` insertion, add:

```rust
                    if request
                        .headers()
                        .iter()
                        .any(|h| h.field.equiv("X-Alethe-Voice-Only"))
                    {
                        if let Some(object) = payload.as_object_mut() {
                            object.insert("voiceOnly".to_string(), serde_json::Value::Bool(true));
                        }
                    }
```

and replace

```rust
                    let preview: String = body.chars().take(4000).collect();
                    eprintln!("[agent_events] payload: {preview}");
```

with

```rust
                    let event_name = payload
                        .get("hook_event_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let tool_name = payload
                        .get("tool_name")
                        .and_then(|v| v.as_str())
                        .map(ToOwned::to_owned);
                    eprintln!("{}", hook_log_line(&event_name, tool_name.as_deref(), &body));
```

- [ ] **Step 5: Run the Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib agent_events`
Expected: PASS (all tests in the module, including the existing private-file and Codex ones).

- [ ] **Step 6: Write the failing TS tests** — in `src/lib/tauri/agents.test.ts`, change the store mock so the voice preference can be toggled:

```ts
let aiMemoryEnabled = true
let voiceEnabled = false
vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      preferences: {
        enabledFeatures: { aiMemory: aiMemoryEnabled },
        voiceConversationEnabled: voiceEnabled,
      },
    }),
  },
}))
```

reset `voiceEnabled = false` in `beforeEach`, and add:

```ts
  it('asks for the voice hooks when voice conversation is on', async () => {
    voiceEnabled = true
    await agentHooksSettingsPath('p', false)
    expect(invoke).toHaveBeenCalledWith(
      'agent_hooks_settings_path',
      expect.objectContaining({ orchestrator: false, voice: true }),
    )
  })

  it('lets a caller opt out of the voice hooks', async () => {
    voiceEnabled = true
    await agentHooksSettingsPath('p', true, null, false)
    expect(invoke).toHaveBeenCalledWith(
      'agent_hooks_settings_path',
      expect.objectContaining({ voice: false }),
    )
  })
```

- [ ] **Step 7: Run to verify they fail**

Run: `npx vitest run src/lib/tauri/agents.test.ts`
Expected: FAIL — `voice` missing from the invoke payload.

- [ ] **Step 8: Implement the wrapper.** In `src/lib/tauri/agents.ts`, extend `agentHooksSettingsPath`:

```ts
/** Live voice-conversation preference; imported lazily for the same reason as `liveAiMemoryPrefs`. */
async function liveVoicePref(): Promise<boolean> {
  const { useProjectsStore } = await import('../../stores/projectsStore')
  return Boolean(useProjectsStore.getState().preferences.voiceConversationEnabled)
}

export async function agentHooksSettingsPath(
  plannerId: string,
  orchestrator = true,
  aiMemory?: { enabled: boolean; port: number } | null,
  voice?: boolean,
): Promise<string> {
  if (aiMemory === undefined) aiMemory = await liveAiMemoryPrefs()
  if (voice === undefined) voice = await liveVoicePref()
  return invoke<string>('agent_hooks_settings_path', {
    plannerId,
    orchestrator,
    aiMemoryEnabled: aiMemory?.enabled ?? false,
    aiMemoryPort: aiMemory?.port ?? null,
    voice,
  })
}
```

Add one sentence to its JSDoc: "`voice` adds the tool, stop and permission hooks voice conversation listens to; it defaults to the live preference and applies to terminals launched afterwards." `claudeMcpConfigs.ts:102` keeps calling `agentHooksSettingsPath(ptyId, enabledFeatures.orchestrator)` — the default picks the preference up. In `src/stores/agentSandboxStore.ts:211` change the call to `agentHooksSettingsPath('sandbox-demo', true, null, false)`.

- [ ] **Step 9: Skip voice-only payloads on the board.** In `src/stores/agentCanvasStore.ts`, add to `AgentHookPayload`:

```ts
  /** Registered only because voice conversation is on; the orchestrator board ignores it. */
  voiceOnly?: boolean
  /** PermissionRequest held by Alethe for a voice answer (agent_events.rs). */
  permissionRequestId?: string
  cwd?: string
```

In `src/hooks/useAgentHookBridge.ts`, inside the listener, replace the ingest line with:

```ts
      trackClaudeSessionHook(event.payload)
      if (!event.payload.voiceOnly) useAgentCanvasStore.getState().ingest(event.payload)
```

In `src/stores/agentSandboxStore.ts:554`, first line of the callback after the generation check:

```ts
      if (payload.voiceOnly === true) return
```

- [ ] **Step 10: Test the bridge** — create `src/hooks/useAgentHookBridge.test.ts`:

```ts
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listeners } = vi.hoisted(() => ({
  listeners: [] as Array<(event: { payload: Record<string, unknown> }) => void>,
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((_name: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
    listeners.push(handler)
    return Promise.resolve(() => undefined)
  }),
}))
const ingest = vi.fn()
vi.mock('../stores/agentCanvasStore', () => ({
  useAgentCanvasStore: { getState: () => ({ ingest }) },
}))
vi.mock('../lib/claudeSessionTracking', () => ({ trackClaudeSessionHook: vi.fn() }))

import { useAgentHookBridge } from './useAgentHookBridge'

describe('useAgentHookBridge', () => {
  beforeEach(() => {
    listeners.length = 0
    ingest.mockClear()
  })

  it('feeds the board orchestrator events but not voice-only ones', async () => {
    renderHook(() => useAgentHookBridge())
    await Promise.resolve()
    listeners[0]({ payload: { hook_event_name: 'PreToolUse', plannerId: 'p' } })
    listeners[0]({ payload: { hook_event_name: 'PreToolUse', plannerId: 'p', voiceOnly: true } })
    expect(ingest).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 11: Run the TS tests**

Run: `npx vitest run src/lib/tauri/agents.test.ts src/hooks/useAgentHookBridge.test.ts`
Expected: PASS

- [ ] **Step 12: Checkpoint** — working tree only, no commit.

---

### Task 3: Held `PermissionRequest` responses

**Files:**
- Modify: `src-tauri/src/agent_events.rs` (new section + listener branch + sweeper thread)
- Modify: `src-tauri/src/lib.rs:309-315` (register commands), `:636-647` (`ExitRequested`)
- Modify: `src/lib/tauri/agents.ts` (wrappers)
- Test: `src-tauri/src/agent_events.rs` (`mod permission_tests`), `src/lib/tauri/agents.test.ts`

**Interfaces:**
- Consumes: `PERMISSION_HOOK_TIMEOUT_SECS` (Task 2).
- Produces (Rust): `PendingPermissions` with `is_target(&str) -> bool`, `set_targets(Vec<String>) -> Vec<String>`, `hold(String, Box<dyn PermissionResponder>, Instant) -> String`, `decide(&str, PermissionBehavior, Option<&str>) -> Result<(), String>`, `release_expired(Instant) -> Vec<String>`, `release_all() -> Vec<String>`; `permission_decision_body(PermissionBehavior, Option<&str>) -> Option<String>`; commands `agent_permission_decide(request_id, behavior, message?)`, `voice_set_targets(pty_ids)`; `pub fn release_all_permissions(app: &AppHandle)`; event `agent-permission://released` with `{ requestId: string, reason: 'timeout' | 'untargeted' | 'shutdown' }`.
- Produces (TS, `src/lib/tauri/agents.ts`):
  ```ts
  export type PermissionBehavior = 'allow' | 'deny' | 'defer'
  export function agentPermissionDecide(requestId: string, behavior: PermissionBehavior, message?: string): Promise<void>
  export function voiceSetTargets(ptyIds: string[]): Promise<void>
  export type PermissionReleased = { requestId: string; reason: 'timeout' | 'untargeted' | 'shutdown' }
  export function onAgentPermissionReleased(handler: (event: PermissionReleased) => void): Promise<UnlistenFn>
  ```

- [ ] **Step 1: Write the failing Rust tests** — append to `agent_events.rs`:

```rust
#[cfg(test)]
mod permission_tests {
    use super::{
        permission_decision_body, require_main_window, PendingPermissions, PermissionBehavior,
        PermissionResponder, PERMISSION_HOLD,
    };
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    type Answers = Arc<Mutex<Vec<Option<String>>>>;

    struct Recorder(Answers);

    impl PermissionResponder for Recorder {
        fn answer(self: Box<Self>, body: Option<String>) {
            self.0.lock().unwrap().push(body);
        }
    }

    fn held(pending: &PendingPermissions, planner: &str, answers: &Answers, now: Instant) -> String {
        pending.hold(planner.to_string(), Box::new(Recorder(answers.clone())), now)
    }

    #[test]
    fn allow_answers_with_the_documented_decision_shape() {
        let body = permission_decision_body(PermissionBehavior::Allow, Some("ignored")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["hookSpecificOutput"]["hookEventName"], "PermissionRequest");
        assert_eq!(value["hookSpecificOutput"]["decision"]["behavior"], "allow");
        assert!(value["hookSpecificOutput"]["decision"].get("message").is_none());
    }

    #[test]
    fn deny_carries_the_spoken_reason() {
        let body = permission_decision_body(PermissionBehavior::Deny, Some(" use pnpm ")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert_eq!(value["hookSpecificOutput"]["decision"]["message"], "use pnpm");
    }

    #[test]
    fn defer_answers_with_no_decision() {
        assert_eq!(permission_decision_body(PermissionBehavior::Defer, None), None);
    }

    #[test]
    fn a_decision_answers_the_held_request_once() {
        let pending = PendingPermissions::default();
        let answers: Answers = Arc::default();
        let id = held(&pending, "pty-1", &answers, Instant::now());

        pending.decide(&id, PermissionBehavior::Allow, None).unwrap();
        assert_eq!(answers.lock().unwrap().len(), 1);
        assert!(answers.lock().unwrap()[0].as_deref().unwrap().contains("allow"));
        assert!(pending.decide(&id, PermissionBehavior::Deny, None).is_err());
        assert_eq!(answers.lock().unwrap().len(), 1);
    }

    #[test]
    fn an_unknown_id_is_refused() {
        let pending = PendingPermissions::default();
        assert!(pending.decide("nope", PermissionBehavior::Allow, None).is_err());
    }

    #[test]
    fn a_request_past_its_deadline_is_released_without_a_decision() {
        let pending = PendingPermissions::default();
        let answers: Answers = Arc::default();
        let start = Instant::now();
        let id = held(&pending, "pty-1", &answers, start);

        assert!(pending.release_expired(start + Duration::from_secs(10)).is_empty());
        let released = pending.release_expired(start + PERMISSION_HOLD);
        assert_eq!(released, vec![id]);
        assert_eq!(*answers.lock().unwrap(), vec![None]);
    }

    #[test]
    fn hold_is_shorter_than_the_hook_timeout() {
        assert!(PERMISSION_HOLD.as_secs() < super::PERMISSION_HOOK_TIMEOUT_SECS);
    }

    #[test]
    fn only_targeted_terminals_are_held_and_leaving_the_targets_releases() {
        let pending = PendingPermissions::default();
        let answers: Answers = Arc::default();
        assert!(!pending.is_target("pty-1"));
        assert!(pending.set_targets(vec!["pty-1".to_string()]).is_empty());
        assert!(pending.is_target("pty-1"));
        assert!(!pending.is_target("pty-2"));

        let id = held(&pending, "pty-1", &answers, Instant::now());
        let released = pending.set_targets(Vec::new());
        assert_eq!(released, vec![id]);
        assert_eq!(*answers.lock().unwrap(), vec![None]);
        assert!(!pending.is_target("pty-1"));
    }

    #[test]
    fn shutdown_releases_everything() {
        let pending = PendingPermissions::default();
        let answers: Answers = Arc::default();
        held(&pending, "a", &answers, Instant::now());
        held(&pending, "b", &answers, Instant::now());
        assert_eq!(pending.release_all().len(), 2);
        assert_eq!(*answers.lock().unwrap(), vec![None, None]);
    }

    #[test]
    fn only_the_main_window_may_decide() {
        assert!(require_main_window("main").is_ok());
        assert!(require_main_window("orchestration-x").is_err());
        assert!(require_main_window("voice-hud").is_err());
    }

    #[test]
    fn behavior_parsing_refuses_unknown_values() {
        assert_eq!(PermissionBehavior::parse("allow").unwrap(), PermissionBehavior::Allow);
        assert_eq!(PermissionBehavior::parse("deny").unwrap(), PermissionBehavior::Deny);
        assert_eq!(PermissionBehavior::parse("defer").unwrap(), PermissionBehavior::Defer);
        assert!(PermissionBehavior::parse("yes").is_err());
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib agent_events::permission_tests`
Expected: FAIL to compile — the new items do not exist.

- [ ] **Step 3: Implement the pending map.** Add to `agent_events.rs`, below `hook_log_line`:

```rust
/// How long a `PermissionRequest` is held for a voice answer before Alethe answers it with no
/// decision, which makes Claude show its own prompt.
const PERMISSION_HOLD: Duration = Duration::from_secs(290);
const PERMISSION_RELEASED_EVENT: &str = "agent-permission://released";

/// Answers a held hook request. `None` is an empty 200: no decision.
pub(crate) trait PermissionResponder: Send {
    fn answer(self: Box<Self>, body: Option<String>);
}

impl PermissionResponder for tiny_http::Request {
    fn answer(self: Box<Self>, body: Option<String>) {
        let result = match body {
            Some(body) => {
                let header = tiny_http::Header::from_bytes("Content-Type", "application/json")
                    .expect("static header");
                (*self).respond(tiny_http::Response::from_string(body).with_header(header))
            }
            None => (*self).respond(tiny_http::Response::empty(200)),
        };
        if let Err(error) = result {
            eprintln!("[agent_events] permission answer failed: {error}");
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PermissionBehavior {
    Allow,
    Deny,
    Defer,
}

impl PermissionBehavior {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "allow" => Ok(Self::Allow),
            "deny" => Ok(Self::Deny),
            "defer" => Ok(Self::Defer),
            other => Err(format!("unknown permission behavior: {other}")),
        }
    }
}

/// The `PermissionRequest` hook output Claude Code reads (code.claude.com/docs/en/hooks).
fn permission_decision_body(behavior: PermissionBehavior, message: Option<&str>) -> Option<String> {
    let mut decision = match behavior {
        PermissionBehavior::Defer => return None,
        PermissionBehavior::Allow => serde_json::json!({ "behavior": "allow" }),
        PermissionBehavior::Deny => serde_json::json!({ "behavior": "deny" }),
    };
    if behavior == PermissionBehavior::Deny {
        if let Some(message) = message.map(str::trim).filter(|m| !m.is_empty()) {
            decision["message"] = serde_json::Value::String(message.to_string());
        }
    }
    Some(
        serde_json::json!({
            "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision }
        })
        .to_string(),
    )
}

struct HeldPermission {
    planner: String,
    deadline: Instant,
    responder: Box<dyn PermissionResponder>,
}

/// Permission requests waiting for a voice or panel answer. The listener loop is serial, so a
/// request is parked here instead of blocking every other hook while the person decides.
#[derive(Default)]
pub(crate) struct PendingPermissions {
    held: std::sync::Mutex<std::collections::HashMap<String, HeldPermission>>,
    targets: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl PendingPermissions {
    pub(crate) fn is_target(&self, planner: &str) -> bool {
        self.targets
            .lock()
            .map(|targets| targets.contains(planner))
            .unwrap_or(false)
    }

    /// Replaces the voice targets and releases what was held for a terminal that left them.
    pub(crate) fn set_targets(&self, planners: Vec<String>) -> Vec<String> {
        let next: std::collections::HashSet<String> = planners.into_iter().collect();
        if let Ok(mut targets) = self.targets.lock() {
            *targets = next.clone();
        }
        self.release_where(|held| !next.contains(&held.planner))
    }

    pub(crate) fn hold(
        &self,
        planner: String,
        responder: Box<dyn PermissionResponder>,
        now: Instant,
    ) -> String {
        let id = nanoid::nanoid!(16);
        let held = HeldPermission {
            planner,
            deadline: now + PERMISSION_HOLD,
            responder,
        };
        match self.held.lock() {
            Ok(mut map) => {
                map.insert(id.clone(), held);
            }
            Err(_) => held.responder.answer(None),
        }
        id
    }

    pub(crate) fn decide(
        &self,
        id: &str,
        behavior: PermissionBehavior,
        message: Option<&str>,
    ) -> Result<(), String> {
        let held = self
            .held
            .lock()
            .map_err(|_| "the permission map is poisoned".to_string())?
            .remove(id)
            .ok_or_else(|| format!("no pending permission request {id}"))?;
        held.responder.answer(permission_decision_body(behavior, message));
        Ok(())
    }

    pub(crate) fn release_expired(&self, now: Instant) -> Vec<String> {
        self.release_where(|held| held.deadline <= now)
    }

    pub(crate) fn release_all(&self) -> Vec<String> {
        self.release_where(|_| true)
    }

    /// Answers outside the lock, so a slow socket never blocks a concurrent decide.
    fn release_where(&self, mut predicate: impl FnMut(&HeldPermission) -> bool) -> Vec<String> {
        let released: Vec<(String, HeldPermission)> = match self.held.lock() {
            Ok(mut map) => {
                let ids: Vec<String> = map
                    .iter()
                    .filter(|(_, held)| predicate(held))
                    .map(|(id, _)| id.clone())
                    .collect();
                ids.into_iter()
                    .filter_map(|id| map.remove(&id).map(|held| (id, held)))
                    .collect()
            }
            Err(_) => Vec::new(),
        };
        released
            .into_iter()
            .map(|(id, held)| {
                held.responder.answer(None);
                id
            })
            .collect()
    }
}

fn pending_permissions() -> &'static PendingPermissions {
    static PENDING: OnceLock<PendingPermissions> = OnceLock::new();
    PENDING.get_or_init(PendingPermissions::default)
}

fn emit_released(app: &AppHandle, ids: &[String], reason: &str) {
    for id in ids {
        let _ = app.emit(
            PERMISSION_RELEASED_EVENT,
            serde_json::json!({ "requestId": id, "reason": reason }),
        );
    }
}

/// Every window can call every custom command (no app manifest in build.rs), so commands that
/// answer for the person check who is calling.
fn require_main_window(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err(format!("window {label} may not answer agent permissions"))
    }
}

#[tauri::command]
pub fn agent_permission_decide(
    webview: tauri::WebviewWindow,
    request_id: String,
    behavior: String,
    message: Option<String>,
) -> Result<(), String> {
    require_main_window(webview.label())?;
    let behavior = PermissionBehavior::parse(&behavior)?;
    pending_permissions().decide(&request_id, behavior, message.as_deref())
}

#[tauri::command]
pub fn voice_set_targets(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    pty_ids: Vec<String>,
) -> Result<(), String> {
    require_main_window(webview.label())?;
    let released = pending_permissions().set_targets(pty_ids);
    emit_released(&app, &released, "untargeted");
    Ok(())
}

/// Called on exit: Claude shows its own prompt instead of waiting on a closed app.
pub fn release_all_permissions(app: &AppHandle) {
    emit_released(app, &pending_permissions().release_all(), "shutdown");
}
```

- [ ] **Step 4: Hold in the listener.** In `start_listener`, right after `eprintln!("[agent_events] ouvindo em …")`, start the deadline sweeper (and translate that log line to `"[agent_events] listening on {}"`):

```rust
        let sweeper = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            let released = pending_permissions().release_expired(Instant::now());
            emit_released(&sweeper, &released, "timeout");
        });
```

In the generic branch, read the planner once before the existing `plannerId` insertion and reuse it:

```rust
                    let planner = request
                        .headers()
                        .iter()
                        .find(|h| h.field.equiv("X-Alethe-Planner"))
                        .map(|h| h.value.as_str().to_string());
                    if let Some(planner) = planner.clone() {
                        if let Some(object) = payload.as_object_mut() {
                            object.insert("plannerId".to_string(), serde_json::Value::String(planner));
                        }
                    }
```

(this replaces the existing `if let Some(planner) = request.headers()…` block). Then, after the `hook_log_line` print added in Task 2 and before `app.emit("agent-hook", …)`, add:

```rust
                    if event_name == "PermissionRequest" {
                        if let Some(planner) =
                            planner.filter(|planner| pending_permissions().is_target(planner))
                        {
                            let id = pending_permissions().hold(
                                planner,
                                Box::new(request),
                                Instant::now(),
                            );
                            if let Some(object) = payload.as_object_mut() {
                                object.insert(
                                    "permissionRequestId".to_string(),
                                    serde_json::Value::String(id),
                                );
                            }
                            if let Err(e) = app.emit("agent-hook", &payload) {
                                eprintln!("[agent_events] could not emit agent-hook: {e}");
                            }
                            continue;
                        }
                    }
```

A request from a terminal no voice conversation targets falls through to the existing empty 200, so Claude shows its own prompt at once.

- [ ] **Step 5: Register and drain.** In `src-tauri/src/lib.rs`, add after `agent_events::agent_canvas_mirror,`:

```rust
            agent_events::agent_permission_decide,
            agent_events::voice_set_targets,
```

and inside `if let tauri::RunEvent::ExitRequested { .. } = event {`, as its first line:

```rust
                agent_events::release_all_permissions(_app_handle);
```

- [ ] **Step 6: Run the Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib agent_events`
Expected: PASS

- [ ] **Step 7: TS wrappers — failing test first.** Append to `src/lib/tauri/agents.test.ts`:

```ts
import { agentPermissionDecide, voiceSetTargets } from './agents'

describe('permission commands', () => {
  beforeEach(() => invoke.mockClear())

  it('sends a deny with its reason', async () => {
    await agentPermissionDecide('req-1', 'deny', 'use pnpm')
    expect(invoke).toHaveBeenCalledWith('agent_permission_decide', {
      requestId: 'req-1',
      behavior: 'deny',
      message: 'use pnpm',
    })
  })

  it('sends no message for an allow', async () => {
    await agentPermissionDecide('req-1', 'allow')
    expect(invoke).toHaveBeenCalledWith('agent_permission_decide', {
      requestId: 'req-1',
      behavior: 'allow',
      message: null,
    })
  })

  it('replaces the voice targets', async () => {
    await voiceSetTargets(['pty-1'])
    expect(invoke).toHaveBeenCalledWith('voice_set_targets', { ptyIds: ['pty-1'] })
  })
})
```

(merge the import into the file's existing `import { agentHooksSettingsPath } from './agents'`.)

Run: `npx vitest run src/lib/tauri/agents.test.ts` — Expected: FAIL (functions missing).

- [ ] **Step 8: Implement the wrappers** in `src/lib/tauri/agents.ts` (add `import { listen, type UnlistenFn } from '@tauri-apps/api/event'` if not imported):

```ts
export type PermissionBehavior = 'allow' | 'deny' | 'defer'

/** Answers a PermissionRequest Alethe is holding for a voice conversation (agent_events.rs). */
export async function agentPermissionDecide(
  requestId: string,
  behavior: PermissionBehavior,
  message?: string,
): Promise<void> {
  await invoke('agent_permission_decide', { requestId, behavior, message: message ?? null })
}

/** The PTYs whose permission requests Alethe holds for a voice answer; others get Claude's prompt. */
export async function voiceSetTargets(ptyIds: string[]): Promise<void> {
  await invoke('voice_set_targets', { ptyIds })
}

export type PermissionReleased = {
  requestId: string
  reason: 'timeout' | 'untargeted' | 'shutdown'
}

export function onAgentPermissionReleased(
  handler: (event: PermissionReleased) => void,
): Promise<UnlistenFn> {
  return listen<PermissionReleased>('agent-permission://released', (event) =>
    handler(event.payload),
  )
}
```

Run: `npx vitest run src/lib/tauri/agents.test.ts` — Expected: PASS.

- [ ] **Step 9: Checkpoint** — working tree only, no commit.

---

### Task 4: Transcript snapshot command with an absolute cursor

**Files:**
- Modify: `src-tauri/src/handoff.rs:90-97` (`TranscriptSnapshot`), `:525-574` (`transcript_snapshot`), tests
- Modify: `src-tauri/src/lib.rs` (register after `handoff::complete_agent_handoff,`)
- Modify: `src/lib/tauri/handoff.ts`
- Test: `src-tauri/src/handoff.rs` (tests module — `grep -n "mod tests" src-tauri/src/handoff.rs`; create `#[cfg(test)] mod snapshot_tail_tests` if none fits)

**Interfaces:**
- Produces (Rust): `TranscriptSnapshot.first_index: usize` (serialized `firstIndex`) — the absolute index of `messages[0]` among all events of the file; `fn tail<T>(items: Vec<T>, limit: usize) -> (usize, Vec<T>)`; command `agent_transcript_snapshot(provider: String, cwd: String, session_id: Option<String>, since: Option<u64>) -> TranscriptSnapshot`.
- Produces (TS):
  ```ts
  export type TranscriptEvent = { role: 'user' | 'assistant' | 'tool' | 'tool-result' | 'question'; text: string }
  export type TranscriptSnapshot = { sessionId: string | null; revision: number; unchanged: boolean; firstIndex: number; messages: TranscriptEvent[] }
  export function agentTranscriptSnapshot(provider: 'claude' | 'codex', cwd: string, sessionId: string | null, since: number | null): Promise<TranscriptSnapshot>
  ```

- [ ] **Step 1: Write the failing test** in `handoff.rs`:

```rust
#[cfg(test)]
mod snapshot_tail_tests {
    use super::tail;

    #[test]
    fn a_short_list_starts_at_zero() {
        assert_eq!(tail(vec![1, 2, 3], 5), (0, vec![1, 2, 3]));
    }

    // The voice narrator counts events by absolute position, so dropping the head must say how
    // many were dropped.
    #[test]
    fn a_long_list_keeps_its_tail_and_reports_where_it_starts() {
        assert_eq!(tail(vec![1, 2, 3, 4, 5], 2), (3, vec![4, 5]));
    }
}
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib snapshot_tail_tests` — Expected: FAIL (`tail` missing).

- [ ] **Step 2: Implement.** In `handoff.rs`, add above `transcript_snapshot`:

```rust
fn tail<T>(mut items: Vec<T>, limit: usize) -> (usize, Vec<T>) {
    let dropped = items.len().saturating_sub(limit);
    items.drain(..dropped);
    (dropped, items)
}
```

Add `pub first_index: usize,` to `TranscriptSnapshot` (after `unchanged`). Set `first_index: 0` in the two early returns of `transcript_snapshot`, and replace

```rust
    let mut messages = match provider { … };
    if messages.len() > limit {
        messages.drain(..messages.len() - limit);
    }
    Ok(TranscriptSnapshot { session_id: Some(id), revision, unchanged: false, messages })
```

with

```rust
    let events = match provider {
        Provider::Claude => claude_events(&path)?,
        Provider::Codex => codex_events(&path)?,
    };
    let (first_index, messages) = tail(events, limit);
    Ok(TranscriptSnapshot {
        session_id: Some(id),
        revision,
        unchanged: false,
        first_index,
        messages,
    })
```

The remote page (`remote/http.rs`) serializes the snapshot as-is; the extra field is harmless there.

Then add the command at the end of the snapshot section:

```rust
const VOICE_TRANSCRIPT_EVENTS: usize = 160;

/// The voice narrator's view of a session transcript. `since` makes an unchanged file cheap.
#[tauri::command]
pub async fn agent_transcript_snapshot(
    provider: String,
    cwd: String,
    session_id: Option<String>,
    since: Option<u64>,
) -> Result<TranscriptSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        transcript_snapshot(&provider, &cwd, session_id.as_deref(), since, VOICE_TRANSCRIPT_EVENTS)
    })
    .await
    .map_err(|error| format!("agent_transcript_snapshot: {error}"))?
}
```

`TranscriptSnapshot` is `pub(crate)`; a command return type only needs `Serialize`, so this compiles. Register `handoff::agent_transcript_snapshot,` in `lib.rs` after `handoff::complete_agent_handoff,`.

- [ ] **Step 3: Run Rust tests and a check**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib handoff`
Expected: PASS

- [ ] **Step 4: TS wrapper** — append to `src/lib/tauri/handoff.ts`:

```ts
export type TranscriptEvent = {
  role: 'user' | 'assistant' | 'tool' | 'tool-result' | 'question'
  text: string
}

export type TranscriptSnapshot = {
  sessionId: string | null
  revision: number
  unchanged: boolean
  /** Absolute index of `messages[0]` among every event of the transcript. */
  firstIndex: number
  messages: TranscriptEvent[]
}

export function agentTranscriptSnapshot(
  provider: 'claude' | 'codex',
  cwd: string,
  sessionId: string | null,
  since: number | null,
): Promise<TranscriptSnapshot> {
  return invoke<TranscriptSnapshot>('agent_transcript_snapshot', {
    provider,
    cwd,
    sessionId,
    since,
  })
}
```

Run: `npx tsc --noEmit -p .` (or `npm run build` if there is no root tsconfig for `tsc -p .`) — Expected: no new type errors.

- [ ] **Step 5: Checkpoint** — working tree only, no commit.

---

### Task 5: Text-to-speech module, build dependencies, macOS mic description

**Files:**
- Create: `src-tauri/src/tts.rs`
- Modify: `src-tauri/Cargo.toml` (`[dependencies]`), `src-tauri/src/lib.rs` (`mod tts;`, register commands after `speech::speech_transcribe,`)
- Create: `src/lib/tauri/tts.ts`; Modify: `src/lib/tauri/index.ts` (`export * from './tts'`)
- Create: `src-tauri/Info.plist`
- Modify: `.github/workflows/ci.yml:68`, `.github/workflows/release.yml:46`, `CONTRIBUTING.md:80-81`
- Test: `src-tauri/src/tts.rs` (tests), `src/bundleInfoPlist.test.ts` (new)

**Interfaces:**
- Produces (Rust): commands `tts_speak(text: String, voice: Option<String>, rate: Option<f32>) -> u64`, `tts_stop()`, `tts_voices() -> Vec<TtsVoice>`; events `tts://start {id}` and `tts://end {id}` (only on engines with utterance callbacks).
- Produces (TS, `src/lib/tauri/tts.ts`):
  ```ts
  export type TtsVoice = { id: string; name: string; language: string }
  export function ttsSpeak(text: string, voice: string | null, rate: number): Promise<number>
  export function ttsStop(): Promise<void>
  export function ttsVoices(): Promise<TtsVoice[]>
  export function onTtsEnd(handler: (id: number) => void): Promise<UnlistenFn>
  ```

- [ ] **Step 1: Write the failing Rust test** — create `src-tauri/src/tts.rs` with only the test first:

```rust
#[cfg(test)]
mod tests {
    use super::scaled_rate;

    #[test]
    fn the_rate_multiplier_scales_the_engine_rate_within_its_bounds() {
        assert_eq!(scaled_rate(1.0, 0.1, 2.0, 1.0), 1.0);
        assert_eq!(scaled_rate(1.0, 0.1, 2.0, 1.5), 1.5);
        assert_eq!(scaled_rate(1.0, 0.1, 2.0, 4.0), 2.0);
        assert_eq!(scaled_rate(0.5, 0.0, 1.0, 0.1), 0.05);
        assert_eq!(scaled_rate(0.5, 0.2, 1.0, 0.1), 0.2);
    }
}
```

Add `mod tts;` to `lib.rs` (alphabetical, after `mod telemetry;`).

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib tts::tests` — Expected: FAIL (`scaled_rate` missing).

- [ ] **Step 2: Add the dependency.** In `src-tauri/Cargo.toml`, after the `sherpa-onnx` line:

```toml
# Narration for voice conversation: AVSpeechSynthesizer (macOS), WinRT (Windows),
# speech-dispatcher (Linux, needs libspeechd-dev at build time).
tts = "0.26.3"
```

- [ ] **Step 3: Implement `tts.rs`** above the tests module:

```rust
//! Speech output for voice conversation. The `tts` crate's handle is not thread-safe (it wraps an
//! `Rc`), and AVSpeechSynthesizer delivers its callbacks on the main run loop, so the engine lives
//! on the main thread and every command hops there.

use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsVoice {
    id: String,
    name: String,
    language: String,
}

thread_local! {
    static ENGINE: RefCell<Option<tts::Tts>> = const { RefCell::new(None) };
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// One utterance at a time: each speak interrupts the previous one, so the callbacks report this.
static CURRENT_ID: AtomicU64 = AtomicU64::new(0);

fn scaled_rate(normal: f32, min: f32, max: f32, multiplier: f32) -> f32 {
    (normal * multiplier).clamp(min, max)
}

fn create_engine(app: &AppHandle) -> Result<tts::Tts, String> {
    let engine = tts::Tts::default().map_err(|e| format!("tts_unavailable: {e}"))?;
    if engine.supported_features().utterance_callbacks {
        let begin = app.clone();
        let _ = engine.on_utterance_begin(Some(Box::new(move |_| {
            let _ = begin.emit("tts://start", serde_json::json!({ "id": CURRENT_ID.load(Ordering::SeqCst) }));
        })));
        let end = app.clone();
        let _ = engine.on_utterance_end(Some(Box::new(move |_| {
            let _ = end.emit("tts://end", serde_json::json!({ "id": CURRENT_ID.load(Ordering::SeqCst) }));
        })));
    }
    Ok(engine)
}

/// Runs `work` against the engine on the main thread and hands its result back.
async fn with_engine<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce(&mut tts::Tts) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = ENGINE.with(|slot| {
            let mut slot = slot.borrow_mut();
            if slot.is_none() {
                *slot = Some(create_engine(&handle)?);
            }
            work(slot.as_mut().expect("engine just created"))
        });
        let _ = sender.send(result);
    })
    .map_err(|e| e.to_string())?;
    receiver
        .await
        .map_err(|_| "tts: the main thread dropped the request".to_string())?
}

#[tauri::command]
pub async fn tts_speak(
    app: AppHandle,
    text: String,
    voice: Option<String>,
    rate: Option<f32>,
) -> Result<u64, String> {
    with_engine(app, move |engine| {
        let features = engine.supported_features();
        if let (Some(id), true) = (voice.as_deref(), features.voice) {
            if let Some(found) = engine
                .voices()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|candidate| candidate.id() == id)
            {
                engine.set_voice(&found).map_err(|e| e.to_string())?;
            }
        }
        if let (Some(multiplier), true) = (rate, features.rate) {
            let next = scaled_rate(engine.normal_rate(), engine.min_rate(), engine.max_rate(), multiplier);
            engine.set_rate(next).map_err(|e| e.to_string())?;
        }
        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        CURRENT_ID.store(id, Ordering::SeqCst);
        engine.speak(text, true).map_err(|e| e.to_string())?;
        Ok(id)
    })
    .await
}

#[tauri::command]
pub async fn tts_stop(app: AppHandle) -> Result<(), String> {
    with_engine(app, |engine| {
        if engine.supported_features().stop {
            engine.stop().map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn tts_voices(app: AppHandle) -> Result<Vec<TtsVoice>, String> {
    with_engine(app, |engine| {
        if !engine.supported_features().voice {
            return Ok(Vec::new());
        }
        Ok(engine
            .voices()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|voice| TtsVoice {
                id: voice.id(),
                name: voice.name(),
                language: voice.language().to_string(),
            })
            .collect())
    })
    .await
}
```

If `const { RefCell::new(None) }` is rejected by the toolchain, use `RefCell::new(None)` without `const`. Register in `lib.rs` after `speech::speech_transcribe,`:

```rust
            tts::tts_speak,
            tts::tts_stop,
            tts::tts_voices,
```

- [ ] **Step 4: Run Rust tests and a full check**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib tts::tests`
Expected: PASS
Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: no errors (warnings allowed only if they already existed).

- [ ] **Step 5: TS wrapper** — create `src/lib/tauri/tts.ts`:

```ts
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type TtsVoice = { id: string; name: string; language: string }

/** Speaks `text`, interrupting anything already playing. Resolves to the utterance id. */
export function ttsSpeak(text: string, voice: string | null, rate: number): Promise<number> {
  return invoke<number>('tts_speak', { text, voice, rate })
}

export async function ttsStop(): Promise<void> {
  await invoke('tts_stop')
}

export function ttsVoices(): Promise<TtsVoice[]> {
  return invoke<TtsVoice[]>('tts_voices')
}

/** Fires when an utterance finishes, on engines that report it; callers keep their own timeout. */
export function onTtsEnd(handler: (id: number) => void): Promise<UnlistenFn> {
  return listen<{ id: number }>('tts://end', (event) => handler(event.payload.id))
}
```

Add `export * from './tts'` to `src/lib/tauri/index.ts` (alphabetical, after `./speech`).

- [ ] **Step 6: Linux build dependency.** Append ` libspeechd-dev` to the `apt-get install -y …` lines in `.github/workflows/ci.yml:68` and `.github/workflows/release.yml:46`, and to the `sudo apt install -y …` line in `CONTRIBUTING.md:81`, adding one sentence under it: "`libspeechd-dev` provides speech-dispatcher, which voice conversation uses for narration on Linux."

- [ ] **Step 7: macOS microphone description — failing test first.** Create `src/bundleInfoPlist.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// Tauri merges src-tauri/Info.plist into the macOS bundle. Without the usage description, macOS
// denies the microphone to a bundled build, which breaks dictation and voice conversation.
describe('macOS bundle Info.plist', () => {
  it('explains why Alethe uses the microphone', () => {
    const plist = readFileSync(resolve('src-tauri/Info.plist'), 'utf8')
    expect(plist).toContain('<key>NSMicrophoneUsageDescription</key>')
    expect(plist).toMatch(/<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]{20,}<\/string>/)
  })
})
```

Run: `npx vitest run src/bundleInfoPlist.test.ts` — Expected: FAIL (file missing).

Create `src-tauri/Info.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSMicrophoneUsageDescription</key>
  <string>Alethe uses the microphone for on-device dictation and voice conversation with your agents.</string>
</dict>
</plist>
```

Run: `npx vitest run src/bundleInfoPlist.test.ts src/securityPolicy.test.ts` — Expected: PASS.

- [ ] **Step 8: Checkpoint** — working tree only, no commit.

---

### Task 6: Agent input registry and the shared submit helper

**Files:**
- Create: `src/lib/agentInputRegistry.ts`
- Modify: `src/lib/agentPromptDelivery.ts` (add `pasteAndSubmit`)
- Modify: `src/lib/agentCompletionMonitor.ts` (public `armForSubmit`)
- Modify: `src/components/XTermView/useXtermSession.ts` (`:325` locals, `:884` and `:1355` monitor creation, exit handlers `:913-921` and the spawn-path equivalents, initial prompt `:1621-1628`, effect cleanup)
- Test: `src/lib/agentInputRegistry.test.ts`, `src/lib/agentPromptDelivery.test.ts` (create or extend), `src/lib/agentCompletionMonitor.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  // src/lib/agentInputRegistry.ts
  export type AgentInput = { submit: (text: string) => Promise<void>; interrupt: () => Promise<void> }
  export function registerAgentInput(ptyId: string, input: AgentInput): () => void
  export function agentInputFor(ptyId: string): AgentInput | null
  // src/lib/agentPromptDelivery.ts
  export const SUBMIT_SETTLE_MS = 150
  export type PromptSubmitIo = { writeChunked: (text: string) => Promise<void>; write: (data: string) => Promise<void>; sleep: (ms: number) => Promise<void> }
  export function pasteAndSubmit(text: string, io: PromptSubmitIo): Promise<void>
  // AgentCompletionMonitor
  armForSubmit(prompt: string): void
  ```

- [ ] **Step 1: Write the failing tests.**

`src/lib/agentInputRegistry.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { agentInputFor, registerAgentInput } from './agentInputRegistry'

const input = () => ({ submit: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined) })

describe('agent input registry', () => {
  it('finds what a pane registered and forgets it on unregister', () => {
    const first = input()
    const unregister = registerAgentInput('pty-1', first)
    expect(agentInputFor('pty-1')).toBe(first)
    unregister()
    expect(agentInputFor('pty-1')).toBeNull()
  })

  // A respawned pane registers again under the same id before the old one cleans up.
  it('a stale unregister does not remove a newer registration', () => {
    const stale = registerAgentInput('pty-2', input())
    const fresh = input()
    registerAgentInput('pty-2', fresh)
    stale()
    expect(agentInputFor('pty-2')).toBe(fresh)
  })
})
```

`src/lib/agentPromptDelivery.test.ts` (create if absent; otherwise add the `describe`):

```ts
import { describe, expect, it } from 'vitest'

import { pasteAndSubmit, SUBMIT_SETTLE_MS } from './agentPromptDelivery'

describe('pasteAndSubmit', () => {
  it('pastes, waits, then presses Enter exactly once', async () => {
    const calls: string[] = []
    await pasteAndSubmit('fix the build', {
      writeChunked: async (text) => void calls.push(`paste:${text}`),
      write: async (data) => void calls.push(`write:${JSON.stringify(data)}`),
      sleep: async (ms) => void calls.push(`sleep:${ms}`),
    })
    expect(calls).toEqual(['paste:fix the build', `sleep:${SUBMIT_SETTLE_MS}`, 'write:"\\r"'])
  })
})
```

`src/lib/agentCompletionMonitor.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('./notifications', () => ({ notifyAgentDone: vi.fn() }))

import { AgentCompletionMonitor } from './agentCompletionMonitor'

describe('AgentCompletionMonitor.armForSubmit', () => {
  it('marks the pane working for a prompt that never went through the keyboard', () => {
    const onStatusChange = vi.fn()
    const monitor = new AgentCompletionMonitor({ ptyId: 'p', agent: 'claude', onStatusChange })
    monitor.armForSubmit('  run the tests  ')
    expect(onStatusChange).toHaveBeenCalledWith('working')
  })

  it('ignores an empty prompt and a disposed monitor', () => {
    const onStatusChange = vi.fn()
    const monitor = new AgentCompletionMonitor({ ptyId: 'p', agent: 'claude', onStatusChange })
    monitor.armForSubmit('   ')
    monitor.dispose()
    monitor.armForSubmit('hello')
    expect(onStatusChange).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/agentInputRegistry.test.ts src/lib/agentPromptDelivery.test.ts src/lib/agentCompletionMonitor.test.ts`
Expected: FAIL — modules/functions missing.

- [ ] **Step 3: Implement.**

`src/lib/agentInputRegistry.ts`:

```ts
/**
 * How code outside a pane types into its agent. `useXtermSession` registers each Claude PTY with
 * a submit that knows the terminal's bracketed-paste mode and arms its completion monitor, which a
 * bare `writePty` cannot do.
 */
export type AgentInput = {
  submit: (text: string) => Promise<void>
  interrupt: () => Promise<void>
}

const inputs = new Map<string, AgentInput>()

export function registerAgentInput(ptyId: string, input: AgentInput): () => void {
  inputs.set(ptyId, input)
  return () => {
    if (inputs.get(ptyId) === input) inputs.delete(ptyId)
  }
}

export function agentInputFor(ptyId: string): AgentInput | null {
  return inputs.get(ptyId) ?? null
}
```

In `src/lib/agentPromptDelivery.ts`, append:

```ts
export const SUBMIT_SETTLE_MS = 150

export type PromptSubmitIo = {
  writeChunked: (text: string) => Promise<void>
  write: (data: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
}

/** Pastes a prompt and submits it with one Enter, after the TUI has taken the paste in. */
export async function pasteAndSubmit(text: string, io: PromptSubmitIo): Promise<void> {
  await io.writeChunked(text)
  await io.sleep(SUBMIT_SETTLE_MS)
  await io.write('\r')
}
```

In `src/lib/agentCompletionMonitor.ts`, add after `handleInput`:

```ts
  /** Arms for a prompt submitted programmatically (voice), which `handleInput` never sees. */
  armForSubmit(prompt: string): void {
    if (this.disposed) return
    const trimmed = prompt.trim()
    if (trimmed) this.arm(trimmed)
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/agentInputRegistry.test.ts src/lib/agentPromptDelivery.test.ts src/lib/agentCompletionMonitor.test.ts`
Expected: PASS

- [ ] **Step 5: Wire `useXtermSession`.** Add imports:

```ts
import { registerAgentInput } from '../../lib/agentInputRegistry'
import { deliverOpenCodePrompt, pasteAndSubmit } from '../../lib/agentPromptDelivery'
```

(the second replaces the existing `deliverOpenCodePrompt` import). Next to `let completionMonitor: AgentCompletionMonitor | null = null` (`:325`), add:

```ts
    let unregisterAgentInput: (() => void) | null = null
    const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))
    // Voice conversation submits through this, never through raw writes: it needs the paste mode
    // and the completion monitor, and it must not send the extra Enters the first prompt uses.
    const registerClaudeInput = (id: string) => {
      unregisterAgentInput?.()
      unregisterAgentInput = registerAgentInput(id, {
        submit: async (text) => {
          completionMonitor?.armForSubmit(text)
          await pasteAndSubmit(text, {
            writeChunked: (value) => writePtyChunked(id, value, terminal.modes.bracketedPasteMode),
            write: (data) => writePty(id, data),
            sleep,
          })
        },
        interrupt: () => writePty(id, '\x1b'),
      })
    }
    const unregisterClaudeInput = () => {
      unregisterAgentInput?.()
      unregisterAgentInput = null
    }
```

Right after each of the two `completionMonitor = new AgentCompletionMonitor({ … })` blocks (attach `:884`, spawn `:1355`), add:

```ts
        if (command === 'claude') registerClaudeInput(existingId) // `response.id` in the spawn path
```

At every place that disposes the monitor (`grep -n "completionMonitor?.dispose()" src/components/XTermView/useXtermSession.ts`), add `unregisterClaudeInput()` on the next line. In the effect's cleanup (`return () => { … }` at the end of the effect), add `unregisterClaudeInput()`.

Replace the initial-prompt submit (`:1621-1628`):

```ts
                await writePtyChunked(response.id, prompt, terminal.modes.bracketedPasteMode)
                await new Promise((resolve) => window.setTimeout(resolve, 150))
                await writePty(response.id, '\r')
```

with

```ts
                await pasteAndSubmit(prompt, {
                  writeChunked: (value) =>
                    writePtyChunked(response.id, value, terminal.modes.bracketedPasteMode),
                  write: (data) => writePty(response.id, data),
                  sleep,
                })
```

keeping the `for (const delay of [1_200, 3_000, 6_000])` retry loop and its comment below it unchanged.

- [ ] **Step 6: Typecheck and run the terminal tests**

Run: `npm run build`
Expected: succeeds.
Run: `npx vitest run src/components/XTermView src/lib/agentInputRegistry.test.ts`
Expected: PASS

- [ ] **Step 7: Checkpoint** — working tree only, no commit.

---

### Task 7: Transcript routing (Jev trigger, interrupt words)

**Files:**
- Create: `src/lib/voice/routing.ts`
- Test: `src/lib/voice/routing.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type VoiceRoute = { kind: 'empty' } | { kind: 'jev'; text: string } | { kind: 'send'; text: string; interrupt: boolean }
  export type RoutingOptions = { jevTrigger: string; interruptWords: string[]; midTaskDefault: VoiceMidTaskDefault; busy: boolean; jevModifier: boolean }
  export function normalizeWord(word: string): string
  export function editDistance(a: string, b: string): number
  export function matchesTrigger(candidate: string, trigger: string): boolean
  export function routeTranscript(raw: string, options: RoutingOptions): VoiceRoute
  ```

- [ ] **Step 1: Write the failing tests** — `src/lib/voice/routing.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { editDistance, matchesTrigger, normalizeWord, routeTranscript, type RoutingOptions } from './routing'

const options = (overrides: Partial<RoutingOptions> = {}): RoutingOptions => ({
  jevTrigger: 'alethe',
  interruptWords: ['stop', 'espera', 'cancela'],
  midTaskDefault: 'queue',
  busy: false,
  jevModifier: false,
  ...overrides,
})

describe('normalizeWord', () => {
  it('drops case, accents and punctuation', () => {
    expect(normalizeWord('Não,')).toBe('nao')
    expect(normalizeWord('ALETÍ!')).toBe('aleti')
  })
})

describe('editDistance', () => {
  it('counts single edits', () => {
    expect(editDistance('alethe', 'alethe')).toBe(0)
    expect(editDistance('alethe', 'alethea')).toBe(1)
    expect(editDistance('alethe', 'athlete')).toBeGreaterThan(1)
  })
})

describe('matchesTrigger', () => {
  it('accepts the ways STT spells the trigger', () => {
    for (const spelled of ['alethe', 'alethea', 'aleti', 'alete', 'aletheia']) {
      expect(matchesTrigger(spelled, 'alethe')).toBe(true)
    }
    expect(matchesTrigger('athlete', 'alethe')).toBe(false)
    expect(matchesTrigger('', 'alethe')).toBe(false)
  })
})

describe('routeTranscript', () => {
  it('sends plain speech to Claude without interrupting', () => {
    expect(routeTranscript('fix the failing test', options())).toEqual({
      kind: 'send',
      text: 'fix the failing test',
      interrupt: false,
    })
  })

  it('ignores silence', () => {
    expect(routeTranscript('   ', options())).toEqual({ kind: 'empty' })
  })

  it('routes the trigger word to Jev, however STT spelled it', () => {
    expect(routeTranscript('Alethe, open Claude in billing', options())).toEqual({
      kind: 'jev',
      text: 'open Claude in billing',
    })
    expect(routeTranscript('Alethea open a terminal', options())).toEqual({
      kind: 'jev',
      text: 'open a terminal',
    })
    expect(routeTranscript('A lethe, focus the API pane', options())).toEqual({
      kind: 'jev',
      text: 'focus the API pane',
    })
  })

  it('routes everything to Jev while the modifier is held', () => {
    expect(routeTranscript('open the docs', options({ jevModifier: true }))).toEqual({
      kind: 'jev',
      text: 'open the docs',
    })
  })

  it('interrupts on a leading keyword followed by punctuation or the end', () => {
    expect(routeTranscript('Stop, use pnpm instead.', options())).toEqual({
      kind: 'send',
      text: 'use pnpm instead.',
      interrupt: true,
    })
    expect(routeTranscript('Espera.', options())).toEqual({ kind: 'send', text: '', interrupt: true })
    expect(routeTranscript('stop', options())).toEqual({ kind: 'send', text: '', interrupt: true })
  })

  it('does not interrupt when the keyword is part of a sentence', () => {
    expect(routeTranscript('stop words are filtered out', options())).toEqual({
      kind: 'send',
      text: 'stop words are filtered out',
      interrupt: false,
    })
  })

  it('does not treat "para" as an interrupt by default', () => {
    expect(routeTranscript('Para isso, use pnpm', options())).toEqual({
      kind: 'send',
      text: 'Para isso, use pnpm',
      interrupt: false,
    })
  })

  it('interrupts mid-task only when that is the default', () => {
    expect(routeTranscript('add a test', options({ busy: true }))).toMatchObject({ interrupt: false })
    expect(
      routeTranscript('add a test', options({ busy: true, midTaskDefault: 'interrupt' })),
    ).toMatchObject({ interrupt: true })
    expect(
      routeTranscript('add a test', options({ busy: false, midTaskDefault: 'interrupt' })),
    ).toMatchObject({ interrupt: false })
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/voice/routing.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — `src/lib/voice/routing.ts`:

```ts
import type { VoiceMidTaskDefault } from '../types'

export type VoiceRoute =
  | { kind: 'empty' }
  | { kind: 'jev'; text: string }
  | { kind: 'send'; text: string; interrupt: boolean }

export type RoutingOptions = {
  jevTrigger: string
  interruptWords: string[]
  midTaskDefault: VoiceMidTaskDefault
  /** Claude is mid-turn on the target. */
  busy: boolean
  /** The Jev modifier was held with the shortcut. */
  jevModifier: boolean
}

/** Ways STT writes a trigger it has never heard as a word. Keyed by the normalized trigger. */
const TRIGGER_VARIANTS: Record<string, string[]> = {
  alethe: ['alethea', 'aletheia', 'aleth', 'alethi', 'aleti', 'alete', 'alethey', 'alethia'],
}

export function normalizeWord(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]
}

export function matchesTrigger(candidate: string, trigger: string): boolean {
  const wanted = normalizeWord(trigger)
  if (!wanted || !candidate) return false
  if (candidate === wanted) return true
  if ((TRIGGER_VARIANTS[wanted] ?? []).includes(candidate)) return true
  return wanted.length >= 4 && editDistance(candidate, wanted) <= 1
}

const LEADING_PUNCTUATION = /^[\s,.:;!?…-]+/u

/** The transcript after the trigger, or null when it does not start with the trigger. */
function afterTrigger(text: string, trigger: string): string | null {
  const tokens = text.split(/\s+/)
  if (matchesTrigger(normalizeWord(tokens[0] ?? ''), trigger)) {
    return tokens.slice(1).join(' ').replace(LEADING_PUNCTUATION, '')
  }
  // "A lethe" — STT sometimes splits the name in two.
  if (tokens.length >= 2 && matchesTrigger(normalizeWord(tokens[0] + tokens[1]), trigger)) {
    return tokens.slice(2).join(' ').replace(LEADING_PUNCTUATION, '')
  }
  return null
}

/**
 * The transcript after an interrupt word, or null. The word only counts on its own — followed by
 * punctuation or the end — so "stop words are…" is a sentence, not an interrupt.
 */
function afterInterrupt(text: string, words: string[]): string | null {
  const match = text.match(/^([\p{L}\p{N}'-]+)(?:[,.;:!?…]+|$)\s*(.*)$/su)
  if (!match) return null
  const wanted = new Set(words.map(normalizeWord).filter(Boolean))
  return wanted.has(normalizeWord(match[1])) ? match[2].trim() : null
}

export function routeTranscript(raw: string, options: RoutingOptions): VoiceRoute {
  const text = raw.trim()
  if (!text) return { kind: 'empty' }
  if (options.jevModifier) return { kind: 'jev', text }

  const jev = afterTrigger(text, options.jevTrigger)
  if (jev !== null) return { kind: 'jev', text: jev }

  const rest = afterInterrupt(text, options.interruptWords)
  if (rest !== null) return { kind: 'send', text: rest, interrupt: true }

  return {
    kind: 'send',
    text,
    interrupt: options.busy && options.midTaskDefault === 'interrupt',
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/voice/routing.test.ts`
Expected: PASS

- [ ] **Step 5: Checkpoint** — working tree only, no commit.

---

### Task 8: Permission classification and spoken answers

**Files:**
- Create: `src/lib/voice/permissions.ts`
- Test: `src/lib/voice/permissions.test.ts`

**Interfaces:**
- Consumes: `normalizeWord` (Task 7), `VoiceApprovalChannel` (Task 1).
- Produces:
  ```ts
  export type PermissionPayload = { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string }
  export type PermissionAnswer = { kind: 'allow' } | { kind: 'deny'; message?: string } | { kind: 'defer' }
  export type SpokenAnswer = PermissionAnswer | { kind: 'unclear' }
  export function describeRequest(payload: PermissionPayload): { tool: string; subject: string }
  export function isDestructive(payload: PermissionPayload): boolean
  export function parseSpokenAnswer(text: string): SpokenAnswer
  export function answerAllowed(answer: PermissionAnswer, destructive: boolean, options: { channel: VoiceApprovalChannel; destructiveNeedsHud: boolean }, source: 'voice' | 'hud'): boolean
  ```

- [ ] **Step 1: Write the failing tests** — `src/lib/voice/permissions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { answerAllowed, describeRequest, isDestructive, parseSpokenAnswer } from './permissions'

const bash = (command: string, cwd = '/work/app') => ({
  tool_name: 'Bash',
  tool_input: { command },
  cwd,
})

describe('describeRequest', () => {
  it('names the command, file or URL a request is about', () => {
    expect(describeRequest(bash('npm install express'))).toEqual({
      tool: 'Bash',
      subject: 'npm install express',
    })
    expect(
      describeRequest({ tool_name: 'Edit', tool_input: { file_path: '/work/app/src/auth.ts' } }),
    ).toEqual({ tool: 'Edit', subject: '/work/app/src/auth.ts' })
    expect(
      describeRequest({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }),
    ).toEqual({ tool: 'WebFetch', subject: 'https://example.com' })
  })
})

describe('isDestructive', () => {
  it.each([
    'rm -rf node_modules',
    'rm -r build',
    'sudo rm -fr /tmp/x',
    'git push --force origin main',
    'git push -f',
    'git push --force-with-lease',
    'git reset --hard HEAD~3',
    'git clean -fdx',
    'git branch -D feature',
    'psql -c "DROP TABLE users"',
    'mysql -e "truncate table logs"',
    'Remove-Item -Recurse -Force dist',
    'rmdir /s /q build',
    'dd if=/dev/zero of=/dev/sda',
  ])('flags %s', (command) => {
    expect(isDestructive(bash(command))).toBe(true)
  })

  it.each(['npm install express', 'git push origin main', 'git status', 'rm notes.txt', 'ls -rf'])(
    'lets %s through',
    (command) => {
      expect(isDestructive(bash(command))).toBe(false)
    },
  )

  it('flags writes outside the project and allows writes inside it', () => {
    const write = (file_path: string) => ({
      tool_name: 'Write',
      tool_input: { file_path },
      cwd: '/work/app',
    })
    expect(isDestructive(write('/work/app/src/a.ts'))).toBe(false)
    expect(isDestructive(write('/etc/hosts'))).toBe(true)
    expect(isDestructive(write('/work/application/x.ts'))).toBe(true)
  })

  it('compares Windows paths without case or slash differences', () => {
    expect(
      isDestructive({
        tool_name: 'Edit',
        tool_input: { file_path: 'c:\\Work\\App\\src\\a.ts' },
        cwd: 'C:/work/app',
      }),
    ).toBe(false)
  })
})

describe('parseSpokenAnswer', () => {
  it.each(['yes', 'Yes.', 'yeah', 'sure', 'allow', 'ok', 'sim', 'pode', 'Pode sim.', 'claro'])(
    'hears %s as allow',
    (text) => {
      expect(parseSpokenAnswer(text)).toEqual({ kind: 'allow' })
    },
  )

  it.each(['no', 'No.', 'não', 'nope', 'deny', 'negado'])('hears %s as deny', (text) => {
    expect(parseSpokenAnswer(text)).toEqual({ kind: 'deny' })
  })

  it('keeps the reason of a deny so Claude reads it as an instruction', () => {
    expect(parseSpokenAnswer('No, use pnpm instead')).toEqual({
      kind: 'deny',
      message: 'use pnpm instead',
    })
    expect(parseSpokenAnswer('Não, roda só os testes de auth')).toEqual({
      kind: 'deny',
      message: 'roda só os testes de auth',
    })
  })

  it('does not hear a qualified yes as an approval', () => {
    expect(parseSpokenAnswer('yes but only in the test folder')).toEqual({ kind: 'unclear' })
    expect(parseSpokenAnswer('maybe')).toEqual({ kind: 'unclear' })
    expect(parseSpokenAnswer('')).toEqual({ kind: 'unclear' })
  })
})

describe('answerAllowed', () => {
  const both = { channel: 'both' as const, destructiveNeedsHud: true }

  it('refuses a spoken yes to a destructive request by default', () => {
    expect(answerAllowed({ kind: 'allow' }, true, both, 'voice')).toBe(false)
    expect(answerAllowed({ kind: 'allow' }, true, both, 'hud')).toBe(true)
  })

  it('accepts a spoken no to a destructive request', () => {
    expect(answerAllowed({ kind: 'deny' }, true, both, 'voice')).toBe(true)
  })

  it('accepts a spoken yes to a destructive request when the person turned the guard off', () => {
    expect(
      answerAllowed({ kind: 'allow' }, true, { channel: 'both', destructiveNeedsHud: false }, 'voice'),
    ).toBe(true)
  })

  it('follows the approval channel', () => {
    const hudOnly = { channel: 'hud' as const, destructiveNeedsHud: true }
    const voiceOnly = { channel: 'voice' as const, destructiveNeedsHud: true }
    expect(answerAllowed({ kind: 'allow' }, false, hudOnly, 'voice')).toBe(false)
    expect(answerAllowed({ kind: 'allow' }, false, voiceOnly, 'hud')).toBe(false)
    // The guard needs a click, so the panel answers a destructive request even in voice-only mode.
    expect(answerAllowed({ kind: 'allow' }, true, voiceOnly, 'hud')).toBe(true)
  })

  it('always lets the person hand the question back to the terminal', () => {
    expect(answerAllowed({ kind: 'defer' }, true, both, 'hud')).toBe(true)
    expect(
      answerAllowed({ kind: 'defer' }, false, { channel: 'voice', destructiveNeedsHud: true }, 'hud'),
    ).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/voice/permissions.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — `src/lib/voice/permissions.ts`:

```ts
import type { VoiceApprovalChannel } from '../types'
import { normalizeWord } from './routing'

export type PermissionPayload = {
  tool_name?: string
  tool_input?: Record<string, unknown>
  cwd?: string
}

export type PermissionAnswer = { kind: 'allow' } | { kind: 'deny'; message?: string } | { kind: 'defer' }
export type SpokenAnswer = PermissionAnswer | { kind: 'unclear' }

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

export function describeRequest(payload: PermissionPayload): { tool: string; subject: string } {
  const tool = payload.tool_name ?? 'tool'
  const input = payload.tool_input ?? {}
  const subject =
    str(input.command) ??
    str(input.file_path) ??
    str(input.notebook_path) ??
    str(input.path) ??
    str(input.url) ??
    str(input.pattern) ??
    JSON.stringify(input).slice(0, 200)
  return { tool, subject }
}

/**
 * Commands a misheard "yes" must never run. Matching is on the raw command line; it errs towards
 * flagging, since a false positive only costs a click.
 */
const DESTRUCTIVE_COMMANDS: RegExp[] = [
  /\brm\s+(?:-[a-z]*[rf][a-z]*\s+)+/i,
  /\bgit\s+push\b[^\n]*\s(?:--force(?:-with-lease)?|-f)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+branch\s+-D\b/,
  /\bdrop\s+(?:table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bremove-item\b[^\n]*-recurse\b/i,
  /\b(?:rmdir|rd|del)\s+\/s\b/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bdd\s+if=/i,
]

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed
}

function isInside(path: string, root: string): boolean {
  const file = normalizePath(path)
  const base = normalizePath(root)
  return file === base || file.startsWith(`${base}/`)
}

export function isDestructive(payload: PermissionPayload): boolean {
  const input = payload.tool_input ?? {}
  if (payload.tool_name === 'Bash' || payload.tool_name === 'PowerShell') {
    const command = str(input.command) ?? ''
    return DESTRUCTIVE_COMMANDS.some((pattern) => pattern.test(command))
  }
  if (payload.tool_name && FILE_TOOLS.has(payload.tool_name)) {
    const file = str(input.file_path) ?? str(input.notebook_path)
    const cwd = str(payload.cwd)
    return Boolean(file && cwd && !isInside(file, cwd))
  }
  return false
}

const ALLOW_WORDS = new Set(['yes', 'yeah', 'yep', 'sure', 'allow', 'ok', 'okay', 'approve', 'sim', 'pode', 'claro', 'manda', 'permite', 'permitir'])
const DENY_WORDS = new Set(['no', 'nope', 'deny', 'nao', 'negado', 'nega', 'recusa'])
/** Words that may follow an allow without changing it ("pode sim", "yes please"). */
const ALLOW_FILLERS = new Set([...ALLOW_WORDS, 'please', 'go', 'ahead', 'do', 'it', 'por', 'favor', 'vai'])

export function parseSpokenAnswer(text: string): SpokenAnswer {
  const trimmed = text.trim()
  const [first = '', ...rest] = trimmed.split(/\s+/)
  const word = normalizeWord(first)
  if (DENY_WORDS.has(word)) {
    const message = rest.join(' ').replace(/^[\s,.:;!?…-]+/u, '').trim()
    return message ? { kind: 'deny', message } : { kind: 'deny' }
  }
  if (ALLOW_WORDS.has(word)) {
    const extra = rest.map(normalizeWord).filter(Boolean)
    return extra.every((token) => ALLOW_FILLERS.has(token)) ? { kind: 'allow' } : { kind: 'unclear' }
  }
  return { kind: 'unclear' }
}

export function answerAllowed(
  answer: PermissionAnswer,
  destructive: boolean,
  options: { channel: VoiceApprovalChannel; destructiveNeedsHud: boolean },
  source: 'voice' | 'hud',
): boolean {
  if (answer.kind === 'defer') return true
  const guarded = destructive && options.destructiveNeedsHud
  if (source === 'voice') {
    if (options.channel === 'hud') return false
    return !(guarded && answer.kind === 'allow')
  }
  return options.channel !== 'voice' || guarded
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/voice/permissions.test.ts`
Expected: PASS. If one `isDestructive` case fails, fix the pattern, not the test — every listed command is one the spec (§7.5) says must need a click.

- [ ] **Step 5: Checkpoint** — working tree only, no commit.

---

### Task 9: Narrator

**Files:**
- Create: `src/lib/voice/narrator.ts`
- Test: `src/lib/voice/narrator.test.ts`

**Interfaces:**
- Consumes: `TranscriptEvent` (Task 4), `VoiceVerbosity` (Task 1), `MessageKey` from `src/lib/i18n/messages/en`.
- Produces:
  ```ts
  export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string
  export type ToolCall = { tool_name?: string; tool_input?: Record<string, unknown> }
  export function speakableText(markdown: string, t: Translate): string
  export function statusFill(tool: ToolCall, t: Translate): string
  export function newAssistantTexts(snapshot: { firstIndex: number; messages: TranscriptEvent[] }, cursor: number): { texts: string[]; cursor: number }
  export function estimateSpeechMs(text: string, rate: number): number
  export type NarratorDeps = { speak: (text: string) => Promise<void>; stop: () => void; t: Translate; verbosity: () => VoiceVerbosity; fillAfterMs: () => number; now?: () => number }
  export class Narrator { beginTurn(): void; onAssistantText(texts: string[]): void; onToolStart(tool: ToolCall): void; onToolEnd(): void; announce(text: string): void; onStop(finalText: string): Promise<void>; stop(): void; dispose(): void }
  ```
- Uses i18n keys (added in Task 12): `voice.narration.codeBlock`, `.table`, `.moreItems`, `.link`, `.runningTests`, `.runningCommand`, `.runningShell`, `.editing`, `.reading`, `.searching`, `.browsing`, `.delegating`, `.working`. Tests use a fake `t` that returns the key plus params, so they do not depend on Task 12.

- [ ] **Step 1: Write the failing tests** — `src/lib/voice/narrator.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  estimateSpeechMs,
  Narrator,
  newAssistantTexts,
  speakableText,
  statusFill,
  type Translate,
} from './narrator'

const t: Translate = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key)

describe('speakableText', () => {
  it('strips markdown and replaces code blocks', () => {
    const text = '## Done\n\nI fixed **auth** in `login.ts`.\n\n```ts\nconst a = 1\n```\nSee [the docs](https://x.y).'
    expect(speakableText(text, t)).toBe('Done I fixed auth in login.ts. voice.narration.codeBlock See the docs.')
  })

  it('shortens long lists and drops tables', () => {
    const list = Array.from({ length: 8 }, (_, i) => `- item ${i + 1}`).join('\n')
    expect(speakableText(list, t)).toBe('item 1 item 2 item 3 voice.narration.moreItems:{"count":5}')
    expect(speakableText('| a | b |\n|---|---|\n| 1 | 2 |', t)).toBe('voice.narration.table')
  })

  it('replaces bare URLs', () => {
    expect(speakableText('Open https://example.com/x now', t)).toBe('Open voice.narration.link now')
  })
})

describe('statusFill', () => {
  it('describes what the running tool is doing', () => {
    expect(statusFill({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, t)).toBe(
      'voice.narration.runningTests',
    )
    expect(
      statusFill({ tool_name: 'Bash', tool_input: { command: 'cargo build', description: 'Build the app' } }, t),
    ).toBe('voice.narration.runningCommand:{"what":"Build the app"}')
    expect(statusFill({ tool_name: 'Bash', tool_input: { command: 'ls' } }, t)).toBe(
      'voice.narration.runningShell',
    )
    expect(statusFill({ tool_name: 'Edit', tool_input: { file_path: '/a/b/auth.ts' } }, t)).toBe(
      'voice.narration.editing:{"file":"auth.ts"}',
    )
    expect(statusFill({ tool_name: 'Grep', tool_input: {} }, t)).toBe('voice.narration.searching')
    expect(statusFill({ tool_name: 'Mystery' }, t)).toBe('voice.narration.working:{"tool":"Mystery"}')
  })
})

describe('newAssistantTexts', () => {
  const event = (role: 'user' | 'assistant' | 'tool', text: string) => ({ role, text })

  it('returns assistant text past the cursor and moves the cursor to the end', () => {
    const snapshot = {
      firstIndex: 10,
      messages: [event('assistant', 'old'), event('user', 'go'), event('tool', 'Bash: x'), event('assistant', 'new')],
    }
    expect(newAssistantTexts(snapshot, 11)).toEqual({ texts: ['new'], cursor: 14 })
  })

  // The same prompt asked twice: the cursor, not the prompt text, decides what is new.
  it('never returns events from before the cursor, even when the tail moved', () => {
    const snapshot = { firstIndex: 50, messages: [event('assistant', 'repeat answer')] }
    expect(newAssistantTexts(snapshot, 51)).toEqual({ texts: [], cursor: 51 })
  })
})

describe('estimateSpeechMs', () => {
  it('grows with the text and shrinks with the rate', () => {
    expect(estimateSpeechMs('hello', 1)).toBeLessThan(estimateSpeechMs('hello there, how are you', 1))
    expect(estimateSpeechMs('hello there', 2)).toBeLessThan(estimateSpeechMs('hello there', 1))
  })
})

describe('Narrator', () => {
  let spoken: string[]
  let verbosity: 'silent' | 'final' | 'normal' | 'detailed'
  let narrator: Narrator

  beforeEach(() => {
    vi.useFakeTimers()
    spoken = []
    verbosity = 'normal'
    narrator = new Narrator({
      speak: async (text) => void spoken.push(text),
      stop: vi.fn(),
      t,
      verbosity: () => verbosity,
      fillAfterMs: () => 8000,
      now: () => Date.now(),
    })
    narrator.beginTurn()
  })

  afterEach(() => {
    narrator.dispose()
    vi.useRealTimers()
  })

  it('speaks assistant text in order', async () => {
    narrator.onAssistantText(['First.', 'Second.'])
    await vi.runOnlyPendingTimersAsync()
    expect(spoken).toEqual(['First.', 'Second.'])
  })

  it('speaks a status after a silence while a tool runs', async () => {
    narrator.onToolStart({ tool_name: 'Bash', tool_input: { command: 'npm test' } })
    await vi.advanceTimersByTimeAsync(7000)
    expect(spoken).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    expect(spoken).toEqual(['voice.narration.runningTests'])
  })

  it('stays quiet about tools once the tool ended', async () => {
    narrator.onToolStart({ tool_name: 'Bash', tool_input: { command: 'npm test' } })
    narrator.onToolEnd()
    await vi.advanceTimersByTimeAsync(20000)
    expect(spoken).toEqual([])
  })

  it('speaks only the final answer in final mode', async () => {
    verbosity = 'final'
    narrator.onAssistantText(['Thinking out loud.'])
    narrator.onToolStart({ tool_name: 'Grep' })
    await vi.advanceTimersByTimeAsync(20000)
    const done = narrator.onStop('All done.')
    await vi.runOnlyPendingTimersAsync()
    await done
    expect(spoken).toEqual(['All done.'])
  })

  it('does not repeat the final answer the transcript already delivered', async () => {
    narrator.onAssistantText(['All done.'])
    const done = narrator.onStop('All done.')
    await vi.runOnlyPendingTimersAsync()
    await done
    expect(spoken).toEqual(['All done.'])
  })

  it('says nothing in silent mode but still announces permission questions', async () => {
    verbosity = 'silent'
    narrator.onAssistantText(['Hidden.'])
    narrator.announce('Allow npm install?')
    const done = narrator.onStop('Hidden too.')
    await vi.runOnlyPendingTimersAsync()
    await done
    expect(spoken).toEqual(['Allow npm install?'])
  })

  it('also speaks every tool start in detailed mode', async () => {
    verbosity = 'detailed'
    narrator.onToolStart({ tool_name: 'Read', tool_input: { file_path: '/x/README.md' } })
    await vi.runOnlyPendingTimersAsync()
    expect(spoken).toEqual(['voice.narration.reading:{"file":"README.md"}'])
  })

  it('drops what is queued when the person starts talking', async () => {
    const stop = vi.fn()
    const slow = new Narrator({
      speak: () => new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      stop,
      t,
      verbosity: () => 'normal',
      fillAfterMs: () => 8000,
    })
    slow.beginTurn()
    slow.onAssistantText(['One.', 'Two.', 'Three.'])
    slow.stop()
    expect(stop).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    slow.dispose()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/voice/narrator.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — `src/lib/voice/narrator.ts`:

```ts
import type { MessageKey } from '../i18n/messages/en'
import type { TranscriptEvent } from '../tauri/handoff'
import type { VoiceVerbosity } from '../types'

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string
export type ToolCall = { tool_name?: string; tool_input?: Record<string, unknown> }

const MAX_LIST_ITEMS = 3
const FILL_CHECK_MS = 1000

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

/** Turns Claude's markdown into something worth hearing: no syntax, no code, no tables. */
export function speakableText(markdown: string, t: Translate): string {
  const lines = markdown
    .replace(/```[\s\S]*?(?:```|$)/g, `\n${t('voice.narration.codeBlock')}\n`)
    .split('\n')
  const out: string[] = []
  let listItems = 0
  let inTable = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^\|.*\|$/.test(line)) {
      if (!inTable) out.push(t('voice.narration.table'))
      inTable = true
      continue
    }
    inTable = false
    const item = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/)
    if (item) {
      listItems += 1
      if (listItems <= MAX_LIST_ITEMS) out.push(item[1])
      continue
    }
    if (listItems > MAX_LIST_ITEMS) {
      out.push(t('voice.narration.moreItems', { count: listItems - MAX_LIST_ITEMS }))
    }
    listItems = 0
    if (line) out.push(line)
  }
  if (listItems > MAX_LIST_ITEMS) {
    out.push(t('voice.narration.moreItems', { count: listItems - MAX_LIST_ITEMS }))
  }
  return out
    .join(' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, t('voice.narration.link'))
    .replace(/^#{1,6}\s+/g, '')
    .replace(/\s#{1,6}\s+/g, ' ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(\S.*?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export function statusFill(tool: ToolCall, t: Translate): string {
  const input = tool.tool_input ?? {}
  switch (tool.tool_name) {
    case 'Bash':
    case 'PowerShell': {
      const command = str(input.command) ?? ''
      if (/\b(test|tests|vitest|jest|pytest|cargo test)\b/.test(command)) {
        return t('voice.narration.runningTests')
      }
      const what = str(input.description)
      return what ? t('voice.narration.runningCommand', { what }) : t('voice.narration.runningShell')
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return t('voice.narration.editing', {
        file: basename(str(input.file_path) ?? str(input.notebook_path) ?? ''),
      })
    case 'Read':
      return t('voice.narration.reading', { file: basename(str(input.file_path) ?? '') })
    case 'Grep':
    case 'Glob':
      return t('voice.narration.searching')
    case 'WebFetch':
    case 'WebSearch':
      return t('voice.narration.browsing')
    case 'Task':
    case 'Agent':
      return t('voice.narration.delegating')
    default:
      return t('voice.narration.working', { tool: tool.tool_name ?? '?' })
  }
}

/** Assistant text at or past `cursor` (an absolute event index), and where the next read starts. */
export function newAssistantTexts(
  snapshot: { firstIndex: number; messages: TranscriptEvent[] },
  cursor: number,
): { texts: string[]; cursor: number } {
  const end = snapshot.firstIndex + snapshot.messages.length
  const texts = snapshot.messages
    .filter((message, offset) => snapshot.firstIndex + offset >= cursor && message.role === 'assistant')
    .map((message) => message.text)
  return { texts, cursor: Math.max(cursor, end) }
}

/** How long an engine without end callbacks gets before the queue moves on. */
export function estimateSpeechMs(text: string, rate: number): number {
  return Math.min(60_000, (1_500 + text.length * 75) / Math.max(0.5, rate))
}

export type NarratorDeps = {
  /** Resolves when the utterance ended or was stopped. */
  speak: (text: string) => Promise<void>
  stop: () => void
  t: Translate
  verbosity: () => VoiceVerbosity
  fillAfterMs: () => number
  now?: () => number
}

export class Narrator {
  private queue: string[] = []
  private speaking = false
  private generation = 0
  private tool: ToolCall | null = null
  private lastActivityAt = 0
  private lastQueued = ''
  private fillTimer: ReturnType<typeof setInterval> | null = null
  private idleWaiters: Array<() => void> = []

  constructor(private readonly deps: NarratorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  beginTurn(): void {
    this.tool = null
    this.lastQueued = ''
    this.lastActivityAt = this.now()
    this.clearFill()
    this.fillTimer = setInterval(() => this.maybeFill(), FILL_CHECK_MS)
  }

  onAssistantText(texts: string[]): void {
    const level = this.deps.verbosity()
    if (level !== 'normal' && level !== 'detailed') return
    for (const text of texts) this.enqueue(speakableText(text, this.deps.t))
  }

  onToolStart(tool: ToolCall): void {
    this.tool = tool
    if (this.deps.verbosity() === 'detailed') this.enqueue(statusFill(tool, this.deps.t))
  }

  onToolEnd(): void {
    this.tool = null
  }

  /** Permission questions are heard whatever the verbosity, ahead of anything queued. */
  announce(text: string): void {
    this.enqueue(text, true)
  }

  onStop(finalText: string): Promise<void> {
    this.tool = null
    this.clearFill()
    if (this.deps.verbosity() !== 'silent') {
      const spoken = speakableText(finalText, this.deps.t)
      if (spoken && spoken !== this.lastQueued) this.enqueue(spoken)
    }
    return this.whenIdle()
  }

  /** Barge-in: the person started talking. */
  stop(): void {
    this.generation += 1
    this.queue = []
    this.deps.stop()
  }

  dispose(): void {
    this.stop()
    this.clearFill()
    this.resolveIdle()
  }

  private enqueue(text: string, front = false): void {
    const trimmed = text.trim()
    if (!trimmed) return
    if (front) this.queue.unshift(trimmed)
    else this.queue.push(trimmed)
    if (!front) this.lastQueued = trimmed
    this.lastActivityAt = this.now()
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.speaking) return
    this.speaking = true
    const generation = this.generation
    try {
      while (this.queue.length > 0 && generation === this.generation) {
        const next = this.queue.shift()!
        await this.deps.speak(next).catch(() => undefined)
        this.lastActivityAt = this.now()
      }
    } finally {
      this.speaking = false
      if (this.queue.length > 0) void this.drain()
      else this.resolveIdle()
    }
  }

  private whenIdle(): Promise<void> {
    if (!this.speaking && this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private resolveIdle(): void {
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  private maybeFill(): void {
    const level = this.deps.verbosity()
    if (!this.tool || this.speaking || this.queue.length > 0) return
    if (level !== 'normal' && level !== 'detailed') return
    if (this.now() - this.lastActivityAt < this.deps.fillAfterMs()) return
    this.enqueue(statusFill(this.tool, this.deps.t))
  }

  private clearFill(): void {
    if (this.fillTimer !== null) clearInterval(this.fillTimer)
    this.fillTimer = null
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/voice/narrator.test.ts`
Expected: PASS. The `speakableText` expectations pin the exact output; if a regex produces stray spaces, adjust the implementation until the strings match.

- [ ] **Step 5: Checkpoint** — working tree only, no commit.

---

### Task 10: Target resolution, state machine, conversation store

**Files:**
- Create: `src/lib/voice/target.ts`, `src/lib/voice/stateMachine.ts`, `src/stores/voiceConversationStore.ts`
- Test: `src/lib/voice/target.test.ts`, `src/lib/voice/stateMachine.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // target.ts
  export type VoiceTarget = { ptyId: string; projectId: string; terminalId: string; label: string; cwd: string; sessionId: string | null }
  export function listClaudeTargets(projects: Project[], alive: (ptyId: string) => boolean): VoiceTarget[]
  export function resolveTarget(candidates: VoiceTarget[], context: { pinnedPtyId: string | null; activeTerminalId: string | null; lastClaudePtyId: string | null }): VoiceTarget | null
  // stateMachine.ts
  export type VoiceCapture = 'idle' | 'listening' | 'transcribing' | 'sending'
  export type VoiceTurn = 'idle' | 'working' | 'awaiting-permission'
  export type VoicePhase = VoiceCapture | VoiceTurn
  export type CaptureEvent = 'press' | 'captured' | 'transcribed' | 'nothing' | 'done' | 'failed'
  export type TurnEvent = 'sent' | 'permission' | 'answered' | 'stopped' | 'reset'
  export function nextCapture(state: VoiceCapture, event: CaptureEvent): VoiceCapture
  export function nextTurn(state: VoiceTurn, event: TurnEvent): VoiceTurn
  export function displayPhase(capture: VoiceCapture, turn: VoiceTurn): VoicePhase
  // voiceConversationStore.ts
  export type VoiceNotice = { key: MessageKey; params?: Record<string, string | number> }
  export type VoicePermissionCard = { requestId: string; tool: string; subject: string; destructive: boolean }
  export const useVoiceConversationStore: UseBoundStore<…> // state below + patch(partial)
  ```
  Store state: `capture: VoiceCapture; turn: VoiceTurn; target: VoiceTarget | null; pinnedPtyId: string | null; transcript: string; narration: string; permission: VoicePermissionCard | null; notice: VoiceNotice | null; patch: (next: Partial<…>) => void`.

- [ ] **Step 1: Write the failing tests.**

`src/lib/voice/stateMachine.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { displayPhase, nextCapture, nextTurn } from './stateMachine'

describe('capture', () => {
  it('runs press → listening → transcribing → sending → idle', () => {
    let state = nextCapture('idle', 'press')
    expect(state).toBe('listening')
    state = nextCapture(state, 'captured')
    expect(state).toBe('transcribing')
    state = nextCapture(state, 'transcribed')
    expect(state).toBe('sending')
    expect(nextCapture(state, 'done')).toBe('idle')
  })

  it('goes back to idle on silence or failure, from anywhere', () => {
    expect(nextCapture('transcribing', 'nothing')).toBe('idle')
    for (const state of ['listening', 'transcribing', 'sending'] as const) {
      expect(nextCapture(state, 'failed')).toBe('idle')
    }
  })

  it('ignores events that do not apply', () => {
    expect(nextCapture('idle', 'captured')).toBe('idle')
    expect(nextCapture('listening', 'press')).toBe('listening')
  })
})

describe('turn', () => {
  it('runs sent → working → awaiting-permission → working → idle', () => {
    let state = nextTurn('idle', 'sent')
    expect(state).toBe('working')
    state = nextTurn(state, 'permission')
    expect(state).toBe('awaiting-permission')
    state = nextTurn(state, 'answered')
    expect(state).toBe('working')
    expect(nextTurn(state, 'stopped')).toBe('idle')
  })

  it('keeps working when more is said mid-task, and resets when the target is gone', () => {
    expect(nextTurn('working', 'sent')).toBe('working')
    expect(nextTurn('awaiting-permission', 'reset')).toBe('idle')
    expect(nextTurn('idle', 'permission')).toBe('idle')
  })
})

describe('displayPhase', () => {
  it('shows capture over the turn, so talking mid-task reads as listening', () => {
    expect(displayPhase('listening', 'working')).toBe('listening')
    expect(displayPhase('idle', 'awaiting-permission')).toBe('awaiting-permission')
    expect(displayPhase('idle', 'idle')).toBe('idle')
  })
})
```

`src/lib/voice/target.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { Project } from '../types'
import { listClaudeTargets, resolveTarget } from './target'

const project = {
  id: 'p1',
  name: 'Billing',
  archived: false,
  terminals: [
    {
      id: 't1',
      name: 'Claude',
      kind: 'terminal',
      cwd: '/work/billing',
      activeTabId: 'a',
      tabs: [{ id: 'a', type: 'claude', name: 'Claude', cwd: '/work/billing', ptyId: 'pty-1', sessionId: 's1' }],
    },
    {
      id: 't2',
      name: 'Shell',
      kind: 'terminal',
      cwd: '/work/billing',
      activeTabId: 'b',
      tabs: [{ id: 'b', type: 'shell', name: 'Shell', cwd: '/work/billing', ptyId: 'pty-2' }],
    },
    {
      id: 't3',
      name: 'Claude 2',
      kind: 'terminal',
      cwd: '/work/billing/api',
      activeTabId: 'c',
      tabs: [{ id: 'c', type: 'claude', name: 'Claude', cwd: '', ptyId: 'pty-3' }],
    },
  ],
} as unknown as Project

describe('listClaudeTargets', () => {
  it('lists live Claude panes only, with their cwd and session', () => {
    const targets = listClaudeTargets([project], (id) => id !== 'pty-9')
    expect(targets.map((target) => target.ptyId)).toEqual(['pty-1', 'pty-3'])
    expect(targets[0]).toMatchObject({ projectId: 'p1', terminalId: 't1', cwd: '/work/billing', sessionId: 's1', label: 'Billing · Claude' })
    expect(targets[1].cwd).toBe('/work/billing/api')
  })

  it('skips a Claude pane whose PTY is not alive', () => {
    expect(listClaudeTargets([project], (id) => id !== 'pty-1').map((t) => t.ptyId)).toEqual(['pty-3'])
  })
})

describe('resolveTarget', () => {
  const targets = listClaudeTargets([project], () => true)

  it('prefers the pinned pane, then the active one, then the last Claude pane used', () => {
    expect(resolveTarget(targets, { pinnedPtyId: 'pty-3', activeTerminalId: 't1', lastClaudePtyId: null })?.ptyId).toBe('pty-3')
    expect(resolveTarget(targets, { pinnedPtyId: null, activeTerminalId: 't1', lastClaudePtyId: 'pty-3' })?.ptyId).toBe('pty-1')
    expect(resolveTarget(targets, { pinnedPtyId: null, activeTerminalId: 't2', lastClaudePtyId: 'pty-3' })?.ptyId).toBe('pty-3')
  })

  it('falls back to the only Claude pane, and gives up when there are several and no hint', () => {
    expect(resolveTarget(targets.slice(0, 1), { pinnedPtyId: null, activeTerminalId: null, lastClaudePtyId: null })?.ptyId).toBe('pty-1')
    expect(resolveTarget(targets, { pinnedPtyId: null, activeTerminalId: null, lastClaudePtyId: null })).toBeNull()
  })

  it('ignores a pinned or remembered pane that is gone', () => {
    expect(resolveTarget(targets, { pinnedPtyId: 'pty-9', activeTerminalId: 't1', lastClaudePtyId: null })?.ptyId).toBe('pty-1')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/voice/stateMachine.test.ts src/lib/voice/target.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement.**

`src/lib/voice/stateMachine.ts`:

```ts
/**
 * Voice conversation is two machines side by side: capturing what the person says, and Claude's
 * turn. They overlap on purpose — the person may talk while Claude works.
 */
export type VoiceCapture = 'idle' | 'listening' | 'transcribing' | 'sending'
export type VoiceTurn = 'idle' | 'working' | 'awaiting-permission'
export type VoicePhase = VoiceCapture | VoiceTurn

export type CaptureEvent = 'press' | 'captured' | 'transcribed' | 'nothing' | 'done' | 'failed'
export type TurnEvent = 'sent' | 'permission' | 'answered' | 'stopped' | 'reset'

const CAPTURE: Record<VoiceCapture, Partial<Record<CaptureEvent, VoiceCapture>>> = {
  idle: { press: 'listening' },
  listening: { captured: 'transcribing', failed: 'idle' },
  transcribing: { transcribed: 'sending', nothing: 'idle', failed: 'idle' },
  sending: { done: 'idle', failed: 'idle' },
}

const TURN: Record<VoiceTurn, Partial<Record<TurnEvent, VoiceTurn>>> = {
  idle: { sent: 'working' },
  working: { sent: 'working', permission: 'awaiting-permission', stopped: 'idle', reset: 'idle' },
  'awaiting-permission': { sent: 'awaiting-permission', answered: 'working', stopped: 'idle', reset: 'idle' },
}

export function nextCapture(state: VoiceCapture, event: CaptureEvent): VoiceCapture {
  return CAPTURE[state][event] ?? state
}

export function nextTurn(state: VoiceTurn, event: TurnEvent): VoiceTurn {
  return TURN[state][event] ?? state
}

export function displayPhase(capture: VoiceCapture, turn: VoiceTurn): VoicePhase {
  return capture !== 'idle' ? capture : turn
}
```

`src/lib/voice/target.ts`:

```ts
import type { Project } from '../types'

export type VoiceTarget = {
  ptyId: string
  projectId: string
  terminalId: string
  label: string
  cwd: string
  sessionId: string | null
}

export function listClaudeTargets(projects: Project[], alive: (ptyId: string) => boolean): VoiceTarget[] {
  const targets: VoiceTarget[] = []
  for (const project of projects) {
    if (project.archived) continue
    for (const terminal of project.terminals) {
      if (terminal.kind && terminal.kind !== 'terminal') continue
      const tab = terminal.tabs.find((item) => item.id === terminal.activeTabId) ?? terminal.tabs[0]
      if (!tab || tab.type !== 'claude' || !tab.ptyId || !alive(tab.ptyId)) continue
      targets.push({
        ptyId: tab.ptyId,
        projectId: project.id,
        terminalId: terminal.id,
        label: `${project.name} · ${terminal.name}`,
        cwd: tab.cwd || terminal.cwd,
        sessionId: tab.sessionId ?? null,
      })
    }
  }
  return targets
}

/** Spec decision 6: a pane the person picked, else the active Claude pane, else the last one. */
export function resolveTarget(
  candidates: VoiceTarget[],
  context: { pinnedPtyId: string | null; activeTerminalId: string | null; lastClaudePtyId: string | null },
): VoiceTarget | null {
  const byPty = (id: string | null) => (id ? candidates.find((item) => item.ptyId === id) : undefined)
  return (
    byPty(context.pinnedPtyId) ??
    candidates.find((item) => item.terminalId === context.activeTerminalId) ??
    byPty(context.lastClaudePtyId) ??
    (candidates.length === 1 ? candidates[0] : null)
  )
}
```

`src/stores/voiceConversationStore.ts`:

```ts
import { create } from 'zustand'

import type { MessageKey } from '../lib/i18n/messages/en'
import type { VoiceCapture, VoiceTurn } from '../lib/voice/stateMachine'
import type { VoiceTarget } from '../lib/voice/target'

export type VoiceNotice = { key: MessageKey; params?: Record<string, string | number> }

export type VoicePermissionCard = {
  requestId: string
  tool: string
  subject: string
  destructive: boolean
}

type VoiceConversationData = {
  capture: VoiceCapture
  turn: VoiceTurn
  target: VoiceTarget | null
  /** A pane the person picked on the panel; wins over the active pane until it closes. */
  pinnedPtyId: string | null
  /** Last thing heard; kept when it could not be sent, so it is not lost. */
  transcript: string
  /** Last thing narrated, shown as text too (and only as text when TTS is unavailable). */
  narration: string
  permission: VoicePermissionCard | null
  notice: VoiceNotice | null
}

type VoiceConversationState = VoiceConversationData & {
  patch: (next: Partial<VoiceConversationData>) => void
}

export const INITIAL_VOICE_CONVERSATION: VoiceConversationData = {
  capture: 'idle',
  turn: 'idle',
  target: null,
  pinnedPtyId: null,
  transcript: '',
  narration: '',
  permission: null,
  notice: null,
}

export const useVoiceConversationStore = create<VoiceConversationState>((set) => ({
  ...INITIAL_VOICE_CONVERSATION,
  patch: (next) => set(next),
}))
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/voice/stateMachine.test.ts src/lib/voice/target.test.ts`
Expected: PASS

- [ ] **Step 5: Checkpoint** — working tree only, no commit.

---

### Task 11: Conversation controller

**Files:**
- Create: `src/lib/voice/controller.ts`
- Modify: `src/stores/uiStore.ts` (add `voiceCommandRequest` + `openVoiceCommand`)
- Test: `src/lib/voice/controller.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–10: `agentInputFor`; `agentPermissionDecide`, `voiceSetTargets`, `onAgentPermissionReleased`, `agentTranscriptSnapshot`, `ttsSpeak`, `ttsStop`, `onTtsEnd`, `speechPrepare`, `speechStartCapture`, `speechStopAndTranscribe`, `speechStopCapture` (all from `../tauri`); `routeTranscript`; `describeRequest`, `isDestructive`, `parseSpokenAnswer`, `answerAllowed`, `PermissionAnswer`; `Narrator`, `newAssistantTexts`, `estimateSpeechMs`; `listClaudeTargets`, `resolveTarget`; `nextCapture`, `nextTurn`; `useVoiceConversationStore`.
- Produces:
  ```ts
  export class VoiceConversationController {
    start(): Promise<void>
    dispose(): void
    press(options: { jev: boolean }): Promise<void>
    release(): Promise<void>
    answer(answer: PermissionAnswer): Promise<void>   // from the panel
    pinTarget(ptyId: string | null): void
    stopSpeaking(): void
    dismiss(): void                                    // clears notice/transcript/narration
  }
  // uiStore
  voiceCommandRequest: { text: string; nonce: number } | null
  openVoiceCommand: (text: string) => void
  ```
- Uses i18n keys (added in Task 12): `voice.conv.modelMissing`, `voice.conv.heardNothing`, `voice.conv.noTarget`, `voice.conv.targetGone`, `voice.conv.jevNotConfigured`, `voice.conv.ttsUnavailable`, `voice.conv.permissionAsk`, `voice.conv.answerUnclear`, `voice.conv.voiceApprovalBlocked`, `voice.conv.permissionReleased`, `voice.conv.failed`.

- [ ] **Step 1: Add the Jev hand-off to `uiStore`.** In `src/stores/uiStore.ts`, add to the state type (next to `activeTerminal`):

```ts
  /** Text voice conversation hands to the Jev command bar (trigger word or modifier). */
  voiceCommandRequest: { text: string; nonce: number } | null
  openVoiceCommand: (text: string) => void
```

initial value `voiceCommandRequest: null,` and the action:

```ts
  openVoiceCommand: (text) => set({ voiceCommandRequest: { text, nonce: Date.now() } }),
```

- [ ] **Step 2: Write the failing tests** — `src/lib/voice/controller.test.ts`. They pin the orderings that are easy to get wrong: a quick tap, barge-in, interrupt-then-send, a destructive spoken yes, a released hold.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  speechPrepare: vi.fn(async () => true),
  speechStartCapture: vi.fn(async () => undefined),
  speechStopAndTranscribe: vi.fn(async () => 'fix the build'),
  speechStopCapture: vi.fn(async () => ({ samples: [], sampleRate: 16000, peak: 0 })),
  ttsSpeak: vi.fn(async () => 1),
  ttsStop: vi.fn(async () => undefined),
  onTtsEnd: vi.fn(async () => () => undefined),
  agentPermissionDecide: vi.fn(async () => undefined),
  voiceSetTargets: vi.fn(async () => undefined),
  onAgentPermissionReleased: vi.fn(async (handler: (e: { requestId: string }) => void) => {
    released = handler
    return () => undefined
  }),
  agentTranscriptSnapshot: vi.fn(async () => ({ sessionId: 's1', revision: 1, unchanged: false, firstIndex: 0, messages: [] })),
}))
let released: (e: { requestId: string }) => void = () => undefined
let hook: (e: { payload: Record<string, unknown> }) => void = () => undefined
vi.mock('../tauri', () => tauri)
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, handler: typeof hook) => {
    hook = handler
    return () => undefined
  }),
}))

const input = { submit: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined) }
vi.mock('../agentInputRegistry', () => ({ agentInputFor: vi.fn(() => input) }))

const target = { ptyId: 'pty-1', projectId: 'p', terminalId: 't', label: 'P · Claude', cwd: '/w', sessionId: 's1' }
vi.mock('./target', () => ({
  listClaudeTargets: vi.fn(() => [target]),
  resolveTarget: vi.fn(() => target),
}))

const prefs = {
  voiceCaptureMode: 'push-to-talk',
  dictationModelId: 'parakeet-tdt-0.6b-v3-int8',
  dictationMicrophoneId: null,
  voiceJevTrigger: 'alethe',
  voiceInterruptWords: ['stop', 'espera', 'cancela'],
  voiceMidTaskDefault: 'queue',
  voiceVerbosity: 'silent',
  voiceFillAfterMs: 8000,
  voiceTtsVoice: null,
  voiceTtsRate: 1,
  voiceApprovalChannel: 'both',
  voiceDestructiveNeedsHud: true,
  voiceCommandApiKey: '',
}
vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: { getState: () => ({ preferences: prefs, projects: [] }), subscribe: vi.fn(() => () => undefined) },
}))
vi.mock('../../stores/terminalsStore', () => ({
  useTerminalsStore: { getState: () => ({ byPtyId: { 'pty-1': { alive: true } } }), subscribe: vi.fn(() => () => undefined) },
}))
const openVoiceCommand = vi.fn()
vi.mock('../../stores/uiStore', () => ({
  useUiStore: {
    getState: () => ({ activeTerminal: { projectId: 'p', terminalId: 't' }, openVoiceCommand }),
    subscribe: vi.fn(() => () => undefined),
  },
}))

import { INITIAL_VOICE_CONVERSATION, useVoiceConversationStore } from '../../stores/voiceConversationStore'
import { VoiceConversationController } from './controller'

const state = () => useVoiceConversationStore.getState()

describe('VoiceConversationController', () => {
  let controller: VoiceConversationController

  beforeEach(async () => {
    vi.clearAllMocks()
    useVoiceConversationStore.setState(INITIAL_VOICE_CONVERSATION)
    tauri.speechStopAndTranscribe.mockResolvedValue('fix the build')
    controller = new VoiceConversationController()
    await controller.start()
  })

  it('sends what was said to the target pane and starts the turn', async () => {
    await controller.press({ jev: false })
    expect(state().capture).toBe('listening')
    await controller.release()
    expect(input.submit).toHaveBeenCalledWith('fix the build')
    expect(input.interrupt).not.toHaveBeenCalled()
    expect(state().turn).toBe('working')
    expect(state().capture).toBe('idle')
    expect(tauri.voiceSetTargets).toHaveBeenCalledWith(['pty-1'])
  })

  // Push-to-talk released before the mic finished opening must still stop the capture.
  it('handles a release that arrives while the capture is still starting', async () => {
    let finishStart: () => void = () => undefined
    tauri.speechStartCapture.mockImplementationOnce(() => new Promise<void>((resolve) => (finishStart = resolve)))
    const pressing = controller.press({ jev: false })
    await Promise.resolve()
    const releasing = controller.release()
    finishStart()
    await pressing
    await releasing
    await vi.waitFor(() => expect(tauri.speechStopAndTranscribe).toHaveBeenCalled())
    expect(state().capture).toBe('idle')
  })

  it('stops speech when the person starts talking', async () => {
    await controller.press({ jev: false })
    expect(tauri.ttsStop).toHaveBeenCalled()
  })

  it('interrupts first when the transcript starts with an interrupt word', async () => {
    tauri.speechStopAndTranscribe.mockResolvedValueOnce('Stop, use pnpm')
    await controller.press({ jev: false })
    await controller.release()
    expect(input.interrupt).toHaveBeenCalled()
    expect(input.submit).toHaveBeenCalledWith('use pnpm')
  })

  it('keeps the transcript and says why when silence was heard', async () => {
    tauri.speechStopAndTranscribe.mockResolvedValueOnce('   ')
    await controller.press({ jev: false })
    await controller.release()
    expect(input.submit).not.toHaveBeenCalled()
    expect(state().notice?.key).toBe('voice.conv.heardNothing')
  })

  it('does not capture when the speech model is missing', async () => {
    tauri.speechPrepare.mockResolvedValueOnce(false)
    await controller.press({ jev: false })
    expect(tauri.speechStartCapture).not.toHaveBeenCalled()
    expect(state().notice?.key).toBe('voice.conv.modelMissing')
  })

  it('says Jev is not configured when there is no API key', async () => {
    tauri.speechStopAndTranscribe.mockResolvedValueOnce('Alethe, open Claude in billing')
    await controller.press({ jev: false })
    await controller.release()
    expect(openVoiceCommand).not.toHaveBeenCalled()
    expect(state().notice?.key).toBe('voice.conv.jevNotConfigured')
  })

  describe('permissions', () => {
    const askToRun = async (command: string) => {
      await controller.press({ jev: false })
      await controller.release()
      hook({
        payload: {
          hook_event_name: 'PermissionRequest',
          plannerId: 'pty-1',
          permissionRequestId: 'req-1',
          tool_name: 'Bash',
          tool_input: { command },
          cwd: '/w',
        },
      })
    }

    it('shows the card and accepts a spoken yes for a safe command', async () => {
      await askToRun('npm install express')
      expect(state().permission).toMatchObject({ requestId: 'req-1', destructive: false })
      expect(state().turn).toBe('awaiting-permission')
      tauri.speechStopAndTranscribe.mockResolvedValueOnce('yes')
      await controller.press({ jev: false })
      await controller.release()
      expect(tauri.agentPermissionDecide).toHaveBeenCalledWith('req-1', 'allow', undefined)
      expect(state().permission).toBeNull()
      expect(state().turn).toBe('working')
    })

    it('refuses a spoken yes for a destructive command and waits for a click', async () => {
      await askToRun('rm -rf node_modules')
      tauri.speechStopAndTranscribe.mockResolvedValueOnce('yes')
      await controller.press({ jev: false })
      await controller.release()
      expect(tauri.agentPermissionDecide).not.toHaveBeenCalled()
      expect(state().notice?.key).toBe('voice.conv.voiceApprovalBlocked')
      await controller.answer({ kind: 'allow' })
      expect(tauri.agentPermissionDecide).toHaveBeenCalledWith('req-1', 'allow', undefined)
    })

    it('sends a spoken reason with a deny', async () => {
      await askToRun('npm install express')
      tauri.speechStopAndTranscribe.mockResolvedValueOnce('no, use pnpm')
      await controller.press({ jev: false })
      await controller.release()
      expect(tauri.agentPermissionDecide).toHaveBeenCalledWith('req-1', 'deny', 'use pnpm')
    })

    it('drops the card when Alethe released the hold', async () => {
      await askToRun('npm install express')
      released({ requestId: 'req-1' })
      expect(state().permission).toBeNull()
      expect(state().notice?.key).toBe('voice.conv.permissionReleased')
    })
  })

  it('ends the turn on Stop and stops holding permissions', async () => {
    await controller.press({ jev: false })
    await controller.release()
    hook({ payload: { hook_event_name: 'Stop', plannerId: 'pty-1', last_assistant_message: 'Done.' } })
    await vi.waitFor(() => expect(state().turn).toBe('idle'))
    expect(tauri.voiceSetTargets).toHaveBeenLastCalledWith([])
  })

  it('ignores hooks from other panes and from subagents', async () => {
    await controller.press({ jev: false })
    await controller.release()
    hook({ payload: { hook_event_name: 'Stop', plannerId: 'pty-2' } })
    hook({ payload: { hook_event_name: 'Stop', plannerId: 'pty-1', agent_id: 'sub' } })
    expect(state().turn).toBe('working')
  })
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/lib/voice/controller.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement** — `src/lib/voice/controller.ts`:

```ts
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { AgentHookPayload } from '../../stores/agentCanvasStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { useVoiceConversationStore, type VoiceNotice } from '../../stores/voiceConversationStore'
import { agentInputFor } from '../agentInputRegistry'
import { getLocale, translate } from '../i18n'
import { DEFAULT_SPEECH_MODEL_ID } from '../speech/audio'
import {
  agentPermissionDecide,
  agentTranscriptSnapshot,
  onAgentPermissionReleased,
  onTtsEnd,
  speechPrepare,
  speechStartCapture,
  speechStopAndTranscribe,
  speechStopCapture,
  ttsSpeak,
  ttsStop,
  voiceSetTargets,
} from '../tauri'
import { estimateSpeechMs, Narrator, newAssistantTexts, type Translate } from './narrator'
import {
  answerAllowed,
  describeRequest,
  isDestructive,
  parseSpokenAnswer,
  type PermissionAnswer,
} from './permissions'
import { routeTranscript } from './routing'
import { nextCapture, nextTurn } from './stateMachine'
import { listClaudeTargets, resolveTarget, type VoiceTarget } from './target'

const TRANSCRIPT_POLL_MS = 700
/** Claude's TUI needs a moment after Esc before it takes new input. */
const INTERRUPT_SETTLE_MS = 300
const SPOKEN_SUBJECT_CHARS = 120

const store = () => useVoiceConversationStore.getState()
const prefs = () => useProjectsStore.getState().preferences
const t: Translate = (key, params) => translate(getLocale(), key, params)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const failure = (cause: unknown): VoiceNotice => ({
  key: 'voice.conv.failed',
  params: { reason: cause instanceof Error ? cause.message : String(cause) },
})

/**
 * Runs in the main window, where the stores and PTYs are. The view only renders
 * `voiceConversationStore` and calls these methods.
 */
export class VoiceConversationController {
  private unlisteners: UnlistenFn[] = []
  private narrator: Narrator
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private revision: number | null = null
  private cursor: number | null = null
  private lastClaudePtyId: string | null = null
  private jevPending = false
  private starting = false
  private releaseAfterStart = false
  private ttsUnavailable = false
  private endWaiters = new Map<number, () => void>()

  constructor() {
    this.narrator = new Narrator({
      speak: (text) => this.speak(text),
      stop: () => this.stopSpeech(),
      t,
      verbosity: () => prefs().voiceVerbosity,
      fillAfterMs: () => prefs().voiceFillAfterMs,
    })
  }

  async start(): Promise<void> {
    this.unlisteners.push(
      await listen<AgentHookPayload>('agent-hook', (event) => this.onHook(event.payload)),
      await onAgentPermissionReleased((event) => this.onReleased(event.requestId)),
      await onTtsEnd((id) => this.endWaiters.get(id)?.()),
    )
    this.unlisteners.push(
      useUiStore.subscribe((ui) => {
        const active = this.targets().find((item) => item.terminalId === ui.activeTerminal?.terminalId)
        if (active) this.lastClaudePtyId = active.ptyId
      }),
      useTerminalsStore.subscribe(() => this.checkTargetAlive()),
    )
  }

  dispose(): void {
    for (const off of this.unlisteners) off()
    this.unlisteners = []
    this.stopPolling()
    this.narrator.dispose()
    void voiceSetTargets([]).catch(() => undefined)
  }

  async press(options: { jev: boolean }): Promise<void> {
    if (store().capture === 'listening') {
      if (prefs().voiceCaptureMode === 'toggle') await this.release()
      return
    }
    if (store().capture !== 'idle' || this.starting) return
    this.narrator.stop()
    this.starting = true
    this.releaseAfterStart = false
    try {
      const p = prefs()
      const ready = await speechPrepare(p.dictationModelId || DEFAULT_SPEECH_MODEL_ID).catch(() => false)
      if (!ready) {
        store().patch({ notice: { key: 'voice.conv.modelMissing' } })
        return
      }
      await speechStartCapture(p.dictationMicrophoneId)
      this.jevPending = options.jev
      store().patch({ capture: nextCapture(store().capture, 'press'), notice: null, transcript: '' })
    } catch (cause) {
      store().patch({ notice: failure(cause) })
    } finally {
      this.starting = false
    }
    if (this.releaseAfterStart) await this.release()
  }

  async release(): Promise<void> {
    if (this.starting) {
      this.releaseAfterStart = true
      return
    }
    if (store().capture !== 'listening') return
    store().patch({ capture: nextCapture('listening', 'captured') })
    let text = ''
    try {
      text = (await speechStopAndTranscribe(prefs().dictationModelId || DEFAULT_SPEECH_MODEL_ID)).trim()
    } catch (cause) {
      await speechStopCapture().catch(() => undefined)
      store().patch({ capture: nextCapture('transcribing', 'failed'), notice: failure(cause) })
      return
    }
    if (!text) {
      store().patch({ capture: nextCapture('transcribing', 'nothing'), notice: { key: 'voice.conv.heardNothing' } })
      return
    }
    store().patch({ capture: nextCapture('transcribing', 'transcribed'), transcript: text })
    try {
      await this.handleTranscript(text)
    } catch (cause) {
      store().patch({ notice: failure(cause) })
    } finally {
      store().patch({ capture: nextCapture('sending', 'done') })
    }
  }

  /** An answer clicked on the panel. */
  async answer(answer: PermissionAnswer): Promise<void> {
    await this.decide(answer, 'hud')
  }

  pinTarget(ptyId: string | null): void {
    store().patch({ pinnedPtyId: ptyId })
  }

  stopSpeaking(): void {
    this.narrator.stop()
  }

  dismiss(): void {
    store().patch({ notice: null, transcript: '', narration: '' })
  }

  private targets(): VoiceTarget[] {
    const runtime = useTerminalsStore.getState().byPtyId
    return listClaudeTargets(useProjectsStore.getState().projects, (id) => Boolean(runtime[id]?.alive))
  }

  private currentTarget(): VoiceTarget | null {
    return resolveTarget(this.targets(), {
      pinnedPtyId: store().pinnedPtyId,
      activeTerminalId: useUiStore.getState().activeTerminal?.terminalId ?? null,
      lastClaudePtyId: this.lastClaudePtyId,
    })
  }

  private async handleTranscript(text: string): Promise<void> {
    if (store().permission) {
      const answer = parseSpokenAnswer(text)
      if (answer.kind === 'unclear') {
        store().patch({ notice: { key: 'voice.conv.answerUnclear' } })
        return
      }
      await this.decide(answer, 'voice')
      store().patch({ transcript: '' })
      return
    }
    const p = prefs()
    const route = routeTranscript(text, {
      jevTrigger: p.voiceJevTrigger,
      interruptWords: p.voiceInterruptWords,
      midTaskDefault: p.voiceMidTaskDefault,
      busy: store().turn !== 'idle',
      jevModifier: this.jevPending,
    })
    if (route.kind === 'empty') return
    if (route.kind === 'jev') {
      if (!p.voiceCommandApiKey) {
        store().patch({ notice: { key: 'voice.conv.jevNotConfigured' } })
        return
      }
      useUiStore.getState().openVoiceCommand(route.text)
      store().patch({ transcript: '' })
      return
    }
    await this.send(route.text, route.interrupt)
  }

  private async send(text: string, interrupt: boolean): Promise<void> {
    let target = this.currentTarget()
    let input = target ? agentInputFor(target.ptyId) : null
    if (!target || !input) {
      // The pane may have respawned between capture and send.
      target = this.currentTarget()
      input = target ? agentInputFor(target.ptyId) : null
    }
    if (!target) {
      store().patch({ notice: { key: 'voice.conv.noTarget', params: { trigger: prefs().voiceJevTrigger } } })
      return
    }
    if (!input) {
      store().patch({ notice: { key: 'voice.conv.targetGone' } })
      return
    }
    if (interrupt) {
      await input.interrupt()
      await sleep(INTERRUPT_SETTLE_MS)
    }
    if (!text) {
      store().patch({ transcript: '' })
      return
    }
    const midTurn = store().turn !== 'idle' && store().target?.ptyId === target.ptyId
    if (!midTurn) await this.beginTurn(target)
    await input.submit(text)
    store().patch({ target, turn: nextTurn(store().turn, 'sent'), transcript: '' })
    await voiceSetTargets([target.ptyId])
    this.startPolling()
  }

  /** Marks where this turn starts in the transcript, so narration never re-reads an older turn. */
  private async beginTurn(target: VoiceTarget): Promise<void> {
    this.revision = null
    this.cursor = null
    try {
      const snapshot = await agentTranscriptSnapshot('claude', target.cwd, target.sessionId, null)
      this.cursor = snapshot.firstIndex + snapshot.messages.length
      this.revision = snapshot.revision
    } catch {
      // No transcript: intermediate narration stays off this turn; the final answer still comes
      // from the Stop hook.
    }
    this.narrator.beginTurn()
  }

  private onHook(payload: AgentHookPayload): void {
    const target = store().target
    if (!target || payload.plannerId !== target.ptyId || store().turn === 'idle') return
    if (payload.agent_id) return
    switch (payload.hook_event_name) {
      case 'PreToolUse':
        this.narrator.onToolStart({ tool_name: payload.tool_name, tool_input: payload.tool_input })
        break
      case 'PostToolUse':
        this.narrator.onToolEnd()
        break
      case 'PermissionRequest':
        this.onPermission(payload)
        break
      case 'Stop':
        void this.endTurn(payload.last_assistant_message ?? '')
        break
    }
  }

  private onPermission(payload: AgentHookPayload): void {
    const requestId = payload.permissionRequestId
    if (!requestId) return
    const { tool, subject } = describeRequest(payload)
    const destructive = isDestructive(payload)
    store().patch({
      permission: { requestId, tool, subject, destructive },
      turn: nextTurn(store().turn, 'permission'),
    })
    if (prefs().voiceApprovalChannel !== 'hud') {
      this.narrator.announce(
        t('voice.conv.permissionAsk', { tool, subject: subject.slice(0, SPOKEN_SUBJECT_CHARS) }),
      )
    }
  }

  private async decide(answer: PermissionAnswer, source: 'voice' | 'hud'): Promise<void> {
    const card = store().permission
    if (!card) return
    const p = prefs()
    const options = { channel: p.voiceApprovalChannel, destructiveNeedsHud: p.voiceDestructiveNeedsHud }
    if (!answerAllowed(answer, card.destructive, options, source)) {
      store().patch({ notice: { key: 'voice.conv.voiceApprovalBlocked' } })
      return
    }
    const behavior = answer.kind
    try {
      await agentPermissionDecide(card.requestId, behavior, answer.kind === 'deny' ? answer.message : undefined)
      store().patch({ permission: null, notice: null, turn: nextTurn(store().turn, 'answered') })
    } catch {
      // Already released (deadline, pane closed): Claude is asking in the terminal.
      store().patch({
        permission: null,
        notice: { key: 'voice.conv.permissionReleased' },
        turn: nextTurn(store().turn, 'answered'),
      })
    }
  }

  private onReleased(requestId: string): void {
    if (store().permission?.requestId !== requestId) return
    store().patch({
      permission: null,
      notice: { key: 'voice.conv.permissionReleased' },
      turn: nextTurn(store().turn, 'answered'),
    })
  }

  private async endTurn(finalText: string): Promise<void> {
    await this.pollTranscript()
    this.stopPolling()
    await this.narrator.onStop(finalText)
    store().patch({ turn: nextTurn(store().turn, 'stopped'), permission: null })
    await voiceSetTargets([]).catch(() => undefined)
  }

  private checkTargetAlive(): void {
    const target = store().target
    if (!target || store().turn === 'idle') return
    if (useTerminalsStore.getState().byPtyId[target.ptyId]?.alive) return
    this.stopPolling()
    this.narrator.stop()
    store().patch({ turn: nextTurn(store().turn, 'reset'), permission: null, target: null })
    void voiceSetTargets([]).catch(() => undefined)
  }

  private startPolling(): void {
    if (this.pollTimer !== null) return
    this.pollTimer = setInterval(() => void this.pollTranscript(), TRANSCRIPT_POLL_MS)
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private async pollTranscript(): Promise<void> {
    const target = store().target
    if (this.polling || !target || this.cursor === null) return
    this.polling = true
    try {
      const fresh = this.targets().find((item) => item.ptyId === target.ptyId) ?? target
      const snapshot = await agentTranscriptSnapshot('claude', fresh.cwd, fresh.sessionId, this.revision)
      this.revision = snapshot.revision
      if (snapshot.unchanged) return
      const next = newAssistantTexts(snapshot, this.cursor)
      this.cursor = next.cursor
      this.narrator.onAssistantText(next.texts)
    } catch {
      // An unreadable transcript only costs intermediate narration.
    } finally {
      this.polling = false
    }
  }

  private async speak(text: string): Promise<void> {
    store().patch({ narration: text })
    if (this.ttsUnavailable) return
    const rate = prefs().voiceTtsRate
    try {
      const id = await ttsSpeak(text, prefs().voiceTtsVoice, rate)
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          this.endWaiters.delete(id)
          resolve()
        }
        const timer = setTimeout(done, estimateSpeechMs(text, rate))
        this.endWaiters.set(id, done)
      })
    } catch {
      this.ttsUnavailable = true
      store().patch({ notice: { key: 'voice.conv.ttsUnavailable' } })
    }
  }

  private stopSpeech(): void {
    void ttsStop().catch(() => undefined)
    for (const done of [...this.endWaiters.values()]) done()
  }
}
```

Note: `answer.kind` for an allowed answer is `'allow' | 'deny' | 'defer'`, which matches `PermissionBehavior` from Task 3.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/voice/controller.test.ts`
Expected: PASS. If the quick-tap test is flaky, the bug is in `press`/`release` ordering, not in the test: `release()` during `starting` must set `releaseAfterStart`, and `press()` must call `release()` after `starting` is cleared.

- [ ] **Step 6: Typecheck**

Run: `npm run build`
Expected: fails only on the missing `voice.conv.*` / `voice.narration.*` i18n keys (added in Task 12). Any other error must be fixed now.

- [ ] **Step 7: Checkpoint** — working tree only, no commit.

---

### Task 12: Docked conversation view, shortcut, spectrum, Jev hand-off, i18n

**Files:**
- Create: `src/lib/voice/shortcut.ts`, `src/lib/voice/shortcut.test.ts`
- Create: `src/components/VoiceSpectrum/index.tsx`, `src/components/VoiceSpectrum/VoiceSpectrum.module.css`
- Create: `src/components/VoiceConversation/VoiceConversationView.tsx`, `src/components/VoiceConversation/index.tsx`, `src/components/VoiceConversation/VoiceConversation.module.css`
- Modify: `src/components/VoiceCommand/index.tsx` (use `VoiceSpectrum`; chord yields to voice conversation; accept `voiceCommandRequest`)
- Modify: `src/components/VoiceCommand/VoiceCommand.module.css` (remove `.spectrum*` rules moved out)
- Modify: `src/App.tsx:675` (mount `VoiceConversation`)
- Modify: `src/lib/i18n/messages/en.ts`, `pt-BR.ts`, `zh-CN.ts`
- Test: `src/lib/voice/shortcut.test.ts`, `src/components/VoiceConversation/VoiceConversationView.test.tsx`

**Interfaces:**
- Consumes: `VoiceConversationController` (Task 11), `useVoiceConversationStore`, `displayPhase` (Task 10), `listClaudeTargets` (Task 10).
- Produces:
  ```ts
  // shortcut.ts
  export type Accelerator = { mod: boolean; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean; code: string }
  export type KeyState = { code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }
  export function parseAccelerator(value: string): Accelerator | null
  export function matchesAccelerator(event: KeyState, accelerator: Accelerator, mac: boolean): { matched: boolean; jev: boolean }
  export function isAcceleratorRelease(event: Pick<KeyState, 'code'>, accelerator: Accelerator, mac: boolean): boolean
  // VoiceSpectrum
  export function VoiceSpectrum(props: { live: boolean; onSilent?: (silent: boolean) => void }): JSX.Element
  // VoiceConversationView (pure; phase 2 mounts it in the HUD)
  export type VoiceConversationAction = { kind: 'answer'; answer: PermissionAnswer } | { kind: 'pin'; ptyId: string | null } | { kind: 'stop-speaking' } | { kind: 'dismiss' }
  export function VoiceConversationView(props: { state: VoiceConversationViewState; targets: VoiceTarget[]; hint: string; approvalChannel: VoiceApprovalChannel; destructiveNeedsHud: boolean; onAction: (action: VoiceConversationAction) => void }): JSX.Element | null
  ```

- [ ] **Step 1: Shortcut tests first** — `src/lib/voice/shortcut.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { isAcceleratorRelease, matchesAccelerator, parseAccelerator } from './shortcut'

const key = (code: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe('parseAccelerator', () => {
  it('reads modifiers and the key', () => {
    expect(parseAccelerator('CmdOrCtrl+Shift+Space')).toEqual({
      mod: true, ctrl: false, meta: false, shift: true, alt: false, code: 'Space',
    })
    expect(parseAccelerator('Ctrl+Alt+K')?.code).toBe('KeyK')
    expect(parseAccelerator('F9')?.code).toBe('F9')
    expect(parseAccelerator('Shift+5')?.code).toBe('Digit5')
  })

  it('refuses what it cannot bind', () => {
    expect(parseAccelerator('')).toBeNull()
    expect(parseAccelerator('Ctrl+Shift')).toBeNull()
    expect(parseAccelerator('Hyper+K')).toBeNull()
    expect(parseAccelerator('Ctrl+Banana')).toBeNull()
  })
})

describe('matchesAccelerator', () => {
  const chord = parseAccelerator('CmdOrCtrl+Shift+Space')!

  it('maps CmdOrCtrl to Cmd on macOS and Ctrl elsewhere', () => {
    expect(matchesAccelerator(key('Space', { metaKey: true, shiftKey: true }), chord, true).matched).toBe(true)
    expect(matchesAccelerator(key('Space', { ctrlKey: true, shiftKey: true }), chord, false).matched).toBe(true)
    expect(matchesAccelerator(key('Space', { ctrlKey: true, shiftKey: true }), chord, true).matched).toBe(false)
  })

  it('reads an extra Alt as the Jev modifier', () => {
    expect(matchesAccelerator(key('Space', { ctrlKey: true, shiftKey: true, altKey: true }), chord, false)).toEqual({
      matched: true,
      jev: true,
    })
  })

  it('needs every modifier', () => {
    expect(matchesAccelerator(key('Space', { ctrlKey: true }), chord, false).matched).toBe(false)
  })
})

describe('isAcceleratorRelease', () => {
  const chord = parseAccelerator('CmdOrCtrl+Shift+Space')!
  it('ends push-to-talk when the key or any of its modifiers comes up', () => {
    expect(isAcceleratorRelease({ code: 'Space' }, chord, false)).toBe(true)
    expect(isAcceleratorRelease({ code: 'ShiftLeft' }, chord, false)).toBe(true)
    expect(isAcceleratorRelease({ code: 'ControlRight' }, chord, false)).toBe(true)
    expect(isAcceleratorRelease({ code: 'MetaLeft' }, chord, true)).toBe(true)
    expect(isAcceleratorRelease({ code: 'KeyA' }, chord, false)).toBe(false)
  })
})
```

Run: `npx vitest run src/lib/voice/shortcut.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 2: Implement `shortcut.ts`:**

```ts
export type Accelerator = {
  /** CmdOrCtrl: Cmd on macOS, Ctrl elsewhere. */
  mod: boolean
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
  /** `KeyboardEvent.code`, which does not change with Alt or the keyboard layout. */
  code: string
}

export type KeyState = {
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

const MODIFIERS: Record<string, keyof Omit<Accelerator, 'code'>> = {
  cmdorctrl: 'mod',
  commandorcontrol: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  super: 'meta',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
}

function keyCode(key: string): string | null {
  if (/^space$/i.test(key)) return 'Space'
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase()
  return null
}

export function parseAccelerator(value: string): Accelerator | null {
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean)
  const last = parts.pop()
  if (!last) return null
  const code = keyCode(last)
  if (!code) return null
  const accelerator: Accelerator = { mod: false, ctrl: false, meta: false, shift: false, alt: false, code }
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()]
    if (!modifier) return null
    accelerator[modifier] = true
  }
  return accelerator
}

export function matchesAccelerator(
  event: KeyState,
  accelerator: Accelerator,
  mac: boolean,
): { matched: boolean; jev: boolean } {
  const ctrl = accelerator.ctrl || (accelerator.mod && !mac)
  const meta = accelerator.meta || (accelerator.mod && mac)
  const matched =
    event.code === accelerator.code &&
    event.ctrlKey === ctrl &&
    event.metaKey === meta &&
    event.shiftKey === accelerator.shift &&
    (accelerator.alt ? event.altKey : true)
  return { matched, jev: matched && !accelerator.alt && event.altKey }
}

export function isAcceleratorRelease(
  event: Pick<KeyState, 'code'>,
  accelerator: Accelerator,
  mac: boolean,
): boolean {
  if (event.code === accelerator.code) return true
  const ctrl = accelerator.ctrl || (accelerator.mod && !mac)
  const meta = accelerator.meta || (accelerator.mod && mac)
  return (
    (ctrl && event.code.startsWith('Control')) ||
    (meta && event.code.startsWith('Meta')) ||
    (accelerator.shift && event.code.startsWith('Shift')) ||
    (accelerator.alt && event.code.startsWith('Alt'))
  )
}
```

Run: `npx vitest run src/lib/voice/shortcut.test.ts` — Expected: PASS.

- [ ] **Step 3: Extract the spectrum.** Create `src/components/VoiceSpectrum/index.tsx`:

```tsx
import { useEffect, useState } from 'react'

import { speechCaptureLevel } from '../../lib/tauri'
import styles from './VoiceSpectrum.module.css'

const LEVEL_POLL_MS = 60
const SPECTRUM_BARS = 40
const SILENT_LEVEL = 0.005
const SILENT_POLLS_BEFORE_WARNING = 12
const SILENCE: number[] = Array.from({ length: SPECTRUM_BARS }, () => 0)

/** Live mic level as a scrolling bar spectrum; polls only while `live`. */
export function VoiceSpectrum({
  live,
  onSilent,
}: {
  live: boolean
  onSilent?: (silent: boolean) => void
}) {
  const [levels, setLevels] = useState<number[]>(SILENCE)

  useEffect(() => {
    if (!live) {
      setLevels(SILENCE)
      return
    }
    let silentPolls = 0
    const id = window.setInterval(() => {
      void speechCaptureLevel()
        .then((next) => {
          setLevels((previous) => [...previous.slice(1), next])
          if (next > SILENT_LEVEL) {
            silentPolls = 0
            onSilent?.(false)
            return
          }
          silentPolls += 1
          if (silentPolls > SILENT_POLLS_BEFORE_WARNING) onSilent?.(true)
        })
        .catch(() => undefined)
    }, LEVEL_POLL_MS)
    return () => window.clearInterval(id)
  }, [live, onSilent])

  return (
    <div className={styles.spectrum} data-live={live} role="presentation">
      {levels.map((value, index) => (
        <span
          key={index}
          className={styles.spectrumBar}
          style={{ transform: `scaleY(${1 + Math.min(1, value * 4) * 11})` }}
        />
      ))}
    </div>
  )
}
```

Move the `.spectrum`, `.spectrum[data-live='true']`, `.spectrumBar` and `.spectrum[data-live='true'] .spectrumBar` rules from `VoiceCommand.module.css:156-182` into `src/components/VoiceSpectrum/VoiceSpectrum.module.css` unchanged. In `VoiceCommand/index.tsx`: delete `LEVEL_POLL_MS`, `SPECTRUM_BARS`, `SILENT_LEVEL`, `SILENT_POLLS_BEFORE_WARNING`, `SILENCE`, the `levels` state, every `setLevels(…)` call, and the level-polling `useEffect`; replace the `<div className={styles.spectrum} …>…</div>` block with `<VoiceSpectrum live={recording} onSilent={setMicSilent} />` (import it from `'../VoiceSpectrum'`); drop `speechCaptureLevel` from its imports. Keep `micSilent` state — `onSilent` now drives it.

- [ ] **Step 4: Let the chord and Jev requests reach `VoiceCommand`.** In `VoiceCommand/index.tsx`:

```tsx
  const conversationEnabled = useProjectsStore((s) => s.preferences.voiceConversationEnabled)
  const voiceCommandRequest = useUiStore((s) => s.voiceCommandRequest)
```

In the chord `useEffect`, first line of `onKeyDown`: `if (conversationEnabled) return` and add `conversationEnabled` to its dependency array. Add, after the `decide` callback is defined:

```tsx
  // Voice conversation hands Jev requests over here (trigger word or modifier).
  useEffect(() => {
    if (!voiceCommandRequest) return
    setOpen(true)
    setText(voiceCommandRequest.text)
    void decide(voiceCommandRequest.text)
  }, [voiceCommandRequest, decide])
```

- [ ] **Step 5: View test first** — `src/components/VoiceConversation/VoiceConversationView.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { INITIAL_VOICE_CONVERSATION } from '../../stores/voiceConversationStore'
import { VoiceConversationView } from './VoiceConversationView'

vi.mock('../../lib/i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('../VoiceSpectrum', () => ({ VoiceSpectrum: () => null }))

const target = { ptyId: 'pty-1', projectId: 'p', terminalId: 't', label: 'Billing · Claude', cwd: '/w', sessionId: null }

describe('VoiceConversationView', () => {
  it('renders nothing while idle with nothing to say', () => {
    const { container } = render(
      <VoiceConversationView state={INITIAL_VOICE_CONVERSATION} targets={[]} hint="" approvalChannel="both" destructiveNeedsHud onAction={() => undefined} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders transcript and narration as text, never as HTML', () => {
    render(
      <VoiceConversationView
        state={{ ...INITIAL_VOICE_CONVERSATION, turn: 'working', target, narration: '<img src=x onerror=alert(1)>' }}
        targets={[target]}
        hint=""
        approvalChannel="both"
        destructiveNeedsHud
        onAction={() => undefined}
      />,
    )
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
  })

  it('answers the permission card and offers the terminal', () => {
    const onAction = vi.fn()
    render(
      <VoiceConversationView
        state={{
          ...INITIAL_VOICE_CONVERSATION,
          turn: 'awaiting-permission',
          target,
          permission: { requestId: 'r', tool: 'Bash', subject: 'rm -rf dist', destructive: true },
        }}
        targets={[target]}
        hint=""
        approvalChannel="both"
        destructiveNeedsHud
        onAction={onAction}
      />,
    )
    expect(screen.getByText('voice.conv.permissionDestructive')).toBeTruthy()
    fireEvent.click(screen.getByText('voice.conv.allow'))
    fireEvent.click(screen.getByText('voice.conv.answerInTerminal'))
    expect(onAction).toHaveBeenNthCalledWith(1, { kind: 'answer', answer: { kind: 'allow' } })
    expect(onAction).toHaveBeenNthCalledWith(2, { kind: 'answer', answer: { kind: 'defer' } })
  })

  it('hides the panel buttons for a safe request in voice-only mode', () => {
    render(
      <VoiceConversationView
        state={{
          ...INITIAL_VOICE_CONVERSATION,
          turn: 'awaiting-permission',
          target,
          permission: { requestId: 'r', tool: 'Bash', subject: 'npm test', destructive: false },
        }}
        targets={[target]}
        hint=""
        approvalChannel="voice"
        destructiveNeedsHud
        onAction={() => undefined}
      />,
    )
    expect(screen.queryByText('voice.conv.allow')).toBeNull()
    expect(screen.getByText('voice.conv.answerInTerminal')).toBeTruthy()
  })
})
```



Run: `npx vitest run src/components/VoiceConversation` — Expected: FAIL (component missing).

- [ ] **Step 6: Implement the view** — `src/components/VoiceConversation/VoiceConversationView.tsx`:

```tsx
import { Mic, VolumeX, X } from 'lucide-react'
import { useState } from 'react'

import { useT } from '../../lib/i18n'
import type { MessageKey } from '../../lib/i18n/messages/en'
import type { VoiceApprovalChannel } from '../../lib/types'
import type { PermissionAnswer } from '../../lib/voice/permissions'
import { displayPhase, type VoicePhase } from '../../lib/voice/stateMachine'
import type { VoiceTarget } from '../../lib/voice/target'
import type { useVoiceConversationStore } from '../../stores/voiceConversationStore'
import { Dropdown } from '../ui/Dropdown'
import { VoiceSpectrum } from '../VoiceSpectrum'
import styles from './VoiceConversation.module.css'

export type VoiceConversationViewState = Omit<
  ReturnType<typeof useVoiceConversationStore.getState>,
  'patch'
>

export type VoiceConversationAction =
  | { kind: 'answer'; answer: PermissionAnswer }
  | { kind: 'pin'; ptyId: string | null }
  | { kind: 'stop-speaking' }
  | { kind: 'dismiss' }

const PHASE_LABEL: Record<VoicePhase, MessageKey> = {
  idle: 'voice.conv.phase.idle',
  listening: 'voice.conv.phase.listening',
  transcribing: 'voice.conv.phase.transcribing',
  sending: 'voice.conv.phase.sending',
  working: 'voice.conv.phase.working',
  'awaiting-permission': 'voice.conv.phase.awaitingPermission',
}

/** Pure view: everything comes in as props, so phase 2 can mount it in the HUD window. */
export function VoiceConversationView({
  state,
  targets,
  hint,
  approvalChannel,
  destructiveNeedsHud,
  onAction,
}: {
  state: VoiceConversationViewState
  targets: VoiceTarget[]
  hint: string
  approvalChannel: VoiceApprovalChannel
  destructiveNeedsHud: boolean
  onAction: (action: VoiceConversationAction) => void
}) {
  const t = useT()
  const [micSilent, setMicSilent] = useState(false)
  const phase = displayPhase(state.capture, state.turn)
  const visible = phase !== 'idle' || state.notice || state.transcript || state.permission
  if (!visible) return null

  const card = state.permission
  const guarded = Boolean(card?.destructive && destructiveNeedsHud)
  const showButtons = approvalChannel !== 'voice' || guarded

  return (
    <section className={styles.dock} aria-live="polite" aria-label={t('voice.conv.title')}>
      <header className={styles.header}>
        <Mic size={14} aria-hidden className={styles.icon} data-phase={phase} />
        <span className={styles.phase}>{t(PHASE_LABEL[phase])}</span>
        {targets.length > 1 ? (
          <Dropdown
            rootClassName={styles.target}
            value={state.target?.ptyId ?? state.pinnedPtyId ?? ''}
            ariaLabel={t('voice.conv.target')}
            options={targets.map((item) => ({ value: item.ptyId, label: item.label }))}
            onChange={(value) => onAction({ kind: 'pin', ptyId: value || null })}
          />
        ) : state.target ? (
          <span className={styles.targetLabel}>{state.target.label}</span>
        ) : null}
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => onAction({ kind: 'stop-speaking' })}
          aria-label={t('voice.conv.stopSpeaking')}
          title={t('voice.conv.stopSpeaking')}
        >
          <VolumeX size={14} aria-hidden />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => onAction({ kind: 'dismiss' })}
          aria-label={t('voice.conv.close')}
          title={t('voice.conv.close')}
        >
          <X size={14} aria-hidden />
        </button>
      </header>

      <VoiceSpectrum live={state.capture === 'listening'} onSilent={setMicSilent} />
      {state.capture === 'listening' && micSilent ? (
        <p className={styles.notice}>{t('voice.bar.micSilent')}</p>
      ) : null}

      {state.transcript ? <p className={styles.transcript}>{state.transcript}</p> : null}
      {state.narration ? <p className={styles.narration}>{state.narration}</p> : null}

      {card ? (
        <div className={styles.card} data-destructive={card.destructive}>
          <p className={styles.cardTool}>{card.tool}</p>
          <p className={styles.cardSubject}>{card.subject}</p>
          {guarded ? <p className={styles.cardWarning}>{t('voice.conv.permissionDestructive')}</p> : null}
          <div className={styles.cardActions}>
            {showButtons ? (
              <>
                <button
                  type="button"
                  className={styles.allow}
                  onClick={() => onAction({ kind: 'answer', answer: { kind: 'allow' } })}
                >
                  {t('voice.conv.allow')}
                </button>
                <button
                  type="button"
                  className={styles.deny}
                  onClick={() => onAction({ kind: 'answer', answer: { kind: 'deny' } })}
                >
                  {t('voice.conv.deny')}
                </button>
              </>
            ) : null}
            <button
              type="button"
              className={styles.defer}
              onClick={() => onAction({ kind: 'answer', answer: { kind: 'defer' } })}
            >
              {t('voice.conv.answerInTerminal')}
            </button>
          </div>
        </div>
      ) : null}

      {state.notice ? (
        <p className={styles.notice}>{t(state.notice.key, state.notice.params)}</p>
      ) : null}
      {hint ? <p className={styles.hint}>{hint}</p> : null}
    </section>
  )
}
```

`src/components/VoiceConversation/VoiceConversation.module.css` (tokens only):

```css
.dock {
  position: fixed;
  left: 50%;
  bottom: 24px;
  z-index: 110;
  width: min(560px, calc(100vw - 32px));
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  color: var(--fg);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}

.header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.icon {
  color: var(--fg-muted);
}

.icon[data-phase='listening'] {
  color: var(--status-offline);
}

.icon[data-phase='working'] {
  color: var(--status-working);
}

.icon[data-phase='awaiting-permission'] {
  color: var(--status-waiting);
}

.phase {
  font-size: 12px;
  font-weight: 600;
}

.target {
  margin-left: auto;
  width: min(220px, 40vw);
}

.targetLabel {
  margin-left: auto;
  overflow: hidden;
  color: var(--fg-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.iconButton {
  display: inline-flex;
  padding: 4px;
  color: var(--fg-muted);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.iconButton:hover {
  color: var(--fg);
  background: var(--panel-hover);
}

.transcript {
  margin: 0;
  font-size: 14px;
}

.narration {
  margin: 0;
  color: var(--fg-muted);
  font-size: 13px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.card[data-destructive='true'] {
  border-color: var(--status-stopped);
}

.cardTool {
  margin: 0;
  color: var(--fg-muted);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.cardSubject {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  word-break: break-all;
}

.cardWarning {
  margin: 0;
  color: var(--status-stopped);
  font-size: 12px;
}

.cardActions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.allow,
.deny,
.defer {
  padding: 5px 12px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.allow {
  color: var(--accent-on);
  background: var(--accent);
  border-color: var(--accent);
}

.deny {
  color: var(--fg);
  background: var(--panel);
}

.defer {
  margin-left: auto;
  color: var(--fg-muted);
  background: transparent;
}

.notice {
  margin: 0;
  color: var(--status-waiting);
  font-size: 12px;
}

.hint {
  margin: 0;
  color: var(--fg-faint);
  font-size: 11px;
}
```

Run: `npx vitest run src/components/VoiceConversation` — Expected: PASS.

- [ ] **Step 7: Connected component** — `src/components/VoiceConversation/index.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useRef } from 'react'

import { useT } from '../../lib/i18n'
import { formatShortcut, isMacOS } from '../../lib/platform'
import { VoiceConversationController } from '../../lib/voice/controller'
import { isAcceleratorRelease, matchesAccelerator, parseAccelerator } from '../../lib/voice/shortcut'
import { listClaudeTargets } from '../../lib/voice/target'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useVoiceConversationStore } from '../../stores/voiceConversationStore'
import { type VoiceConversationAction, VoiceConversationView } from './VoiceConversationView'

/** Mounted once in the main window while voice conversation is on. */
export function VoiceConversation() {
  const enabled = useProjectsStore((s) => s.preferences.voiceConversationEnabled)
  return enabled ? <VoiceConversationSession /> : null
}

function VoiceConversationSession() {
  const t = useT()
  const shortcut = useProjectsStore((s) => s.preferences.voiceShortcut)
  const captureMode = useProjectsStore((s) => s.preferences.voiceCaptureMode)
  const approvalChannel = useProjectsStore((s) => s.preferences.voiceApprovalChannel)
  const destructiveNeedsHud = useProjectsStore((s) => s.preferences.voiceDestructiveNeedsHud)
  const projects = useProjectsStore((s) => s.projects)
  const runtime = useTerminalsStore((s) => s.byPtyId)
  const capture = useVoiceConversationStore((s) => s.capture)
  const turn = useVoiceConversationStore((s) => s.turn)
  const target = useVoiceConversationStore((s) => s.target)
  const pinnedPtyId = useVoiceConversationStore((s) => s.pinnedPtyId)
  const transcript = useVoiceConversationStore((s) => s.transcript)
  const narration = useVoiceConversationStore((s) => s.narration)
  const permission = useVoiceConversationStore((s) => s.permission)
  const notice = useVoiceConversationStore((s) => s.notice)
  const controllerRef = useRef<VoiceConversationController | null>(null)

  useEffect(() => {
    const controller = new VoiceConversationController()
    controllerRef.current = controller
    void controller.start()
    return () => {
      controller.dispose()
      controllerRef.current = null
    }
  }, [])

  const accelerator = useMemo(() => parseAccelerator(shortcut), [shortcut])

  useEffect(() => {
    if (!accelerator) return
    const mac = isMacOS()
    const onKeyDown = (event: KeyboardEvent) => {
      const { matched, jev } = matchesAccelerator(event, accelerator, mac)
      if (!matched || event.repeat) return
      event.preventDefault()
      event.stopPropagation()
      void controllerRef.current?.press({ jev })
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (captureMode !== 'push-to-talk' || !isAcceleratorRelease(event, accelerator, mac)) return
      void controllerRef.current?.release()
    }
    // Losing focus mid-hold would leave the mic open: treat it as a release.
    const onBlur = () => {
      if (captureMode === 'push-to-talk') void controllerRef.current?.release()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [accelerator, captureMode])

  const targets = useMemo(
    () => listClaudeTargets(projects, (id) => Boolean(runtime[id]?.alive)),
    [projects, runtime],
  )

  const onAction = useCallback((action: VoiceConversationAction) => {
    const controller = controllerRef.current
    if (!controller) return
    if (action.kind === 'answer') void controller.answer(action.answer)
    else if (action.kind === 'pin') controller.pinTarget(action.ptyId)
    else if (action.kind === 'stop-speaking') controller.stopSpeaking()
    else controller.dismiss()
  }, [])

  const label = formatShortcut(shortcut.replace(/CmdOrCtrl|CommandOrControl/i, 'Ctrl'))
  const hint =
    captureMode === 'push-to-talk'
      ? t('voice.conv.hintPushToTalk', { shortcut: label })
      : t('voice.conv.hintToggle', { shortcut: label })

  return (
    <VoiceConversationView
      state={{ capture, turn, target, pinnedPtyId, transcript, narration, permission, notice }}
      targets={targets}
      hint={hint}
      approvalChannel={approvalChannel}
      destructiveNeedsHud={destructiveNeedsHud}
      onAction={onAction}
    />
  )
}
```

`formatShortcut('Ctrl+…')` already renders Ctrl as ⌘ on macOS (it is how the dictation section shows `Ctrl+E`); check `src/lib/platform.ts:27` and adjust the replace if it expects another spelling. In `src/App.tsx`, import `{ VoiceConversation } from './components/VoiceConversation'` and render `<VoiceConversation />` right after `<VoiceCommand />` (`:675`).

- [ ] **Step 8: i18n keys.** Add to `src/lib/i18n/messages/en.ts` (next to the other `voice.*` keys), then the same keys to `pt-BR.ts` and `zh-CN.ts`:

| Key | en | pt-BR | zh-CN |
|---|---|---|---|
| `voice.conv.title` | Voice conversation | Conversa por voz | 语音对话 |
| `voice.conv.phase.idle` | Ready | Pronto | 就绪 |
| `voice.conv.phase.listening` | Listening… | Ouvindo… | 正在聆听… |
| `voice.conv.phase.transcribing` | Transcribing… | Transcrevendo… | 正在转写… |
| `voice.conv.phase.sending` | Sending… | Enviando… | 正在发送… |
| `voice.conv.phase.working` | Claude is working | Claude está trabalhando | Claude 正在工作 |
| `voice.conv.phase.awaitingPermission` | Claude needs permission | Claude precisa de permissão | Claude 需要权限 |
| `voice.conv.target` | Talking to | Falando com | 对话对象 |
| `voice.conv.noTarget` | No Claude pane is open. Open one, or say "{trigger}, open Claude in …". | Nenhum painel do Claude aberto. Abra um, ou diga "{trigger}, abre o Claude em …". | 没有打开的 Claude 面板。请打开一个，或说"{trigger}，在…中打开 Claude"。 |
| `voice.conv.targetGone` | That Claude pane closed. Your message is kept below. | Esse painel do Claude fechou. Sua mensagem ficou guardada abaixo. | 该 Claude 面板已关闭。你的消息保留在下方。 |
| `voice.conv.modelMissing` | Download the speech model in Preferences → Integrations → Voice dictation first. | Baixe antes o modelo de fala em Preferências → Integrações → Ditado por voz. | 请先在 偏好设置 → 集成 → 语音输入 中下载语音模型。 |
| `voice.conv.heardNothing` | Heard nothing. | Não ouvi nada. | 没有听到声音。 |
| `voice.conv.jevNotConfigured` | Jev needs an API key. Open the voice command bar to add one. | O Jev precisa de uma chave de API. Abra a barra de comandos de voz para adicionar. | Jev 需要 API 密钥。请打开语音命令栏添加。 |
| `voice.conv.ttsUnavailable` | Speech output is not available on this system; narration is shown as text. | A saída de voz não está disponível neste sistema; a narração aparece como texto. | 此系统不支持语音输出；旁白将以文字显示。 |
| `voice.conv.permissionAsk` | Claude wants to use {tool}: {subject}. Allow? | O Claude quer usar {tool}: {subject}. Permitir? | Claude 想使用 {tool}：{subject}。允许吗？ |
| `voice.conv.permissionDestructive` | This one needs a click to approve. | Este precisa de um clique para aprovar. | 此操作需要点击确认。 |
| `voice.conv.allow` | Allow | Permitir | 允许 |
| `voice.conv.deny` | Deny | Negar | 拒绝 |
| `voice.conv.answerInTerminal` | Answer in the terminal | Responder no terminal | 在终端中回答 |
| `voice.conv.answerUnclear` | Did not catch that — say yes or no. | Não entendi — diga sim ou não. | 没听清——请说"是"或"否"。 |
| `voice.conv.voiceApprovalBlocked` | Approve this one on the panel. | Aprove este no painel. | 请在面板上批准此操作。 |
| `voice.conv.permissionReleased` | The request went back to the terminal. | O pedido voltou para o terminal. | 该请求已交回终端。 |
| `voice.conv.failed` | Voice conversation failed: {reason} | A conversa por voz falhou: {reason} | 语音对话失败：{reason} |
| `voice.conv.close` | Close | Fechar | 关闭 |
| `voice.conv.stopSpeaking` | Stop speaking | Parar de falar | 停止朗读 |
| `voice.conv.hintPushToTalk` | Hold {shortcut} and speak | Segure {shortcut} e fale | 按住 {shortcut} 说话 |
| `voice.conv.hintToggle` | Press {shortcut} to speak, again to send | Pressione {shortcut} para falar e de novo para enviar | 按 {shortcut} 开始说话，再按一次发送 |
| `voice.narration.codeBlock` | a code block | um bloco de código | 一段代码 |
| `voice.narration.table` | a table | uma tabela | 一个表格 |
| `voice.narration.moreItems` | and {count} more | e mais {count} | 还有 {count} 项 |
| `voice.narration.link` | a link | um link | 一个链接 |
| `voice.narration.runningTests` | Running the tests. | Rodando os testes. | 正在运行测试。 |
| `voice.narration.runningCommand` | Running {what}. | Executando {what}. | 正在执行 {what}。 |
| `voice.narration.runningShell` | Running a command. | Executando um comando. | 正在执行命令。 |
| `voice.narration.editing` | Editing {file}. | Editando {file}. | 正在编辑 {file}。 |
| `voice.narration.reading` | Reading {file}. | Lendo {file}. | 正在读取 {file}。 |
| `voice.narration.searching` | Searching the code. | Procurando no código. | 正在搜索代码。 |
| `voice.narration.browsing` | Looking it up on the web. | Pesquisando na web. | 正在网上查找。 |
| `voice.narration.delegating` | Handing part of it to a subagent. | Passando uma parte para um subagente. | 正在把部分工作交给子代理。 |
| `voice.narration.working` | Working with {tool}. | Trabalhando com {tool}. | 正在使用 {tool}。 |

Placeholders use `{name}`, which `interpolate` in `src/lib/i18n/index.ts` fills.

- [ ] **Step 9: Build and test**

Run: `npm run build`
Expected: succeeds (i18n complete in all three locales).
Run: `npx vitest run src/lib/voice src/components/VoiceConversation src/lib/voiceCommand.test.ts`
Expected: PASS

- [ ] **Step 10: Checkpoint** — working tree only, no commit. The running app picks the dock up through HMR; do not restart it.

---

### Task 13: Voice conversation preferences section

**Files:**
- Create: `src/components/modals/preferences/VoiceConversationSection.tsx`
- Modify: `src/components/modals/preferences/IntegrationsPage.tsx:176` (render after `<VoiceDictationSection />`)
- Modify: `src/components/modals/PreferencesModal.tsx` (`searchItems`, after the `dictation` entry at `:365`)
- Modify: `src/lib/i18n/messages/en.ts`, `pt-BR.ts`, `zh-CN.ts`

**Interfaces:**
- Consumes: Task 1 preferences, `ttsVoices` (Task 5), `parseAccelerator` (Task 12), `SettingsSection` (`./primitives`), `Dropdown`, styles from `../PreferencesModal.module.css` (`segmented`, `segmentActive`, `dictationMicSelect`) and `../controls.module.css` (`input`).
- Produces: `export function VoiceConversationSection(): JSX.Element` with section ids `voice-conversation`, `voice-conversation-mode`, `voice-conversation-shortcut`, `voice-conversation-narration`, `voice-conversation-voice`, `voice-conversation-approval`, `voice-conversation-words`.

- [ ] **Step 1: i18n keys** — add to all three locale files:

| Key | en | pt-BR | zh-CN |
|---|---|---|---|
| `prefs.voiceConv` | Voice conversation | Conversa por voz | 语音对话 |
| `prefs.voiceConvDesc` | Talk to the active Claude pane with {shortcut} and hear what it does. Uses the dictation model and microphone, and applies to Claude panes opened after you turn it on. | Converse com o painel ativo do Claude usando {shortcut} e ouça o que ele faz. Usa o modelo e o microfone do ditado, e vale para painéis do Claude abertos depois de ligar. | 使用 {shortcut} 与当前 Claude 面板对话并收听它的进展。使用语音输入的模型和麦克风，开启后新打开的 Claude 面板生效。 |
| `prefs.voiceConvOn` | On | Ligado | 开启 |
| `prefs.voiceConvOff` | Off | Desligado | 关闭 |
| `prefs.voiceConvMode` | Capture | Captura | 采集方式 |
| `prefs.voiceConvModeDesc` | Hold the shortcut while you speak, or press it once to start and again to send. | Segure o atalho enquanto fala, ou pressione uma vez para começar e outra para enviar. | 说话时按住快捷键，或按一次开始、再按一次发送。 |
| `prefs.voiceConvModeHold` | Hold to talk | Segurar para falar | 按住说话 |
| `prefs.voiceConvModeToggle` | Press to start and stop | Pressionar para começar e parar | 按下开始/停止 |
| `prefs.voiceConvShortcut` | Shortcut | Atalho | 快捷键 |
| `prefs.voiceConvShortcutDesc` | A key combination such as CmdOrCtrl+Shift+Space. Hold Alt with it to send to Jev. | Uma combinação como CmdOrCtrl+Shift+Space. Segure Alt junto para enviar ao Jev. | 例如 CmdOrCtrl+Shift+Space。同时按住 Alt 则发送给 Jev。 |
| `prefs.voiceConvShortcutInvalid` | Not a shortcut Alethe can bind. | Não é um atalho que o Alethe consiga usar. | Alethe 无法绑定此快捷键。 |
| `prefs.voiceConvNarration` | Narration | Narração | 旁白 |
| `prefs.voiceConvNarrationDesc` | How much Alethe says while Claude works. | Quanto o Alethe fala enquanto o Claude trabalha. | Claude 工作时 Alethe 播报的详细程度。 |
| `prefs.voiceConvNarrationSilent` | Silent | Silencioso | 静音 |
| `prefs.voiceConvNarrationFinal` | Final answer only | Só a resposta final | 仅最终回答 |
| `prefs.voiceConvNarrationNormal` | Normal | Normal | 标准 |
| `prefs.voiceConvNarrationDetailed` | Detailed | Detalhado | 详细 |
| `prefs.voiceConvFill` | Status after silence | Status após silêncio | 静默后播报状态 |
| `prefs.voiceConvFillDesc` | Seconds without speech before a short status is spoken. | Segundos sem fala antes de dizer um status curto. | 无语音多少秒后播报简短状态。 |
| `prefs.voiceConvVoice` | Voice | Voz | 声音 |
| `prefs.voiceConvVoiceDesc` | The system voice used for narration. | A voz do sistema usada na narração. | 用于旁白的系统声音。 |
| `prefs.voiceConvVoiceSystem` | System default | Padrão do sistema | 系统默认 |
| `prefs.voiceConvRate` | Speed | Velocidade | 语速 |
| `prefs.voiceConvApproval` | Permission answers | Respostas de permissão | 权限应答 |
| `prefs.voiceConvApprovalDesc` | How you answer when Claude asks for permission. | Como você responde quando o Claude pede permissão. | Claude 请求权限时的应答方式。 |
| `prefs.voiceConvApprovalBoth` | Voice and panel | Voz e painel | 语音和面板 |
| `prefs.voiceConvApprovalVoice` | Voice only | Só voz | 仅语音 |
| `prefs.voiceConvApprovalHud` | Panel only | Só painel | 仅面板 |
| `prefs.voiceConvDestructive` | Destructive commands | Comandos destrutivos | 破坏性命令 |
| `prefs.voiceConvDestructiveDesc` | Commands such as rm -rf or git push --force need a click on the panel, even after a spoken yes. | Comandos como rm -rf ou git push --force exigem um clique no painel, mesmo depois de um sim falado. | rm -rf、git push --force 等命令即使口头同意也需在面板上点击确认。 |
| `prefs.voiceConvDestructiveHud` | Require a click | Exigir clique | 需要点击 |
| `prefs.voiceConvDestructiveVoice` | Voice is enough | Voz basta | 语音即可 |
| `prefs.voiceConvMidTask` | Speaking while Claude works | Falar enquanto o Claude trabalha | Claude 工作时说话 |
| `prefs.voiceConvMidTaskDesc` | Queue your message for Claude's next turn, or interrupt it first. | Enfileirar a mensagem para o próximo turno do Claude, ou interromper antes. | 将消息排入 Claude 的下一轮，或先打断它。 |
| `prefs.voiceConvMidTaskQueue` | Queue | Enfileirar | 排队 |
| `prefs.voiceConvMidTaskInterrupt` | Interrupt | Interromper | 打断 |
| `prefs.voiceConvWords` | Interrupt words | Palavras de interrupção | 打断词 |
| `prefs.voiceConvWordsDesc` | Comma-separated. Starting with one of these, on its own, interrupts Claude first. | Separadas por vírgula. Começar com uma delas, sozinha, interrompe o Claude antes. | 用逗号分隔。以其中一个词单独开头时会先打断 Claude。 |
| `prefs.voiceConvTrigger` | Jev trigger word | Palavra de acionamento do Jev | Jev 唤起词 |
| `prefs.voiceConvTriggerDesc` | Starting with this word sends the rest to Jev instead of Claude. | Começar com esta palavra envia o resto ao Jev em vez do Claude. | 以此词开头时，其余内容发送给 Jev 而不是 Claude。 |

- [ ] **Step 2: Implement the section** — `src/components/modals/preferences/VoiceConversationSection.tsx`:

```tsx
import { useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { formatShortcut } from '../../../lib/platform'
import { ttsVoices, type TtsVoice } from '../../../lib/tauri'
import type { VoiceApprovalChannel, VoiceVerbosity } from '../../../lib/types'
import { parseAccelerator } from '../../../lib/voice/shortcut'
import { useProjectsStore } from '../../../stores/projectsStore'
import { Dropdown } from '../../ui/Dropdown'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'

const RATES = [0.8, 1, 1.2, 1.5]
const FILL_SECONDS = [5, 8, 12, 20, 30]

export function VoiceConversationSection() {
  const t = useT()
  const preferences = useProjectsStore((s) => s.preferences)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const [voices, setVoices] = useState<TtsVoice[]>([])
  const [shortcutDraft, setShortcutDraft] = useState(preferences.voiceShortcut)
  const [wordsDraft, setWordsDraft] = useState(preferences.voiceInterruptWords.join(', '))
  const [triggerDraft, setTriggerDraft] = useState(preferences.voiceJevTrigger)
  const enabled = preferences.voiceConversationEnabled
  const shortcutValid = parseAccelerator(shortcutDraft) !== null

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void ttsVoices()
      .then((list) => {
        if (!cancelled) setVoices(list)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [enabled])

  const segment = <T extends string>(value: T, current: T, label: string, apply: (next: T) => void) => (
    <button
      key={value}
      type="button"
      className={current === value ? styles.segmentActive : undefined}
      disabled={!enabled}
      onClick={() => apply(value)}
    >
      {label}
    </button>
  )

  return (
    <>
      <SettingsSection
        id="voice-conversation"
        title={t('prefs.voiceConv')}
        description={t('prefs.voiceConvDesc', {
          shortcut: formatShortcut(preferences.voiceShortcut.replace(/CmdOrCtrl|CommandOrControl/i, 'Ctrl')),
        })}
      >
        <div className={styles.segmented}>
          <button
            type="button"
            className={enabled ? styles.segmentActive : undefined}
            onClick={() => setPreferences({ voiceConversationEnabled: true })}
          >
            {t('prefs.voiceConvOn')}
          </button>
          <button
            type="button"
            className={!enabled ? styles.segmentActive : undefined}
            onClick={() => setPreferences({ voiceConversationEnabled: false })}
          >
            {t('prefs.voiceConvOff')}
          </button>
        </div>
      </SettingsSection>

      <SettingsSection id="voice-conversation-mode" title={t('prefs.voiceConvMode')} description={t('prefs.voiceConvModeDesc')}>
        <div className={styles.segmented}>
          {segment('push-to-talk', preferences.voiceCaptureMode, t('prefs.voiceConvModeHold'), (v) => setPreferences({ voiceCaptureMode: v }))}
          {segment('toggle', preferences.voiceCaptureMode, t('prefs.voiceConvModeToggle'), (v) => setPreferences({ voiceCaptureMode: v }))}
        </div>
      </SettingsSection>

      <SettingsSection
        id="voice-conversation-shortcut"
        title={t('prefs.voiceConvShortcut')}
        description={shortcutValid ? t('prefs.voiceConvShortcutDesc') : t('prefs.voiceConvShortcutInvalid')}
      >
        <input
          className={controls.input}
          value={shortcutDraft}
          disabled={!enabled}
          spellCheck={false}
          aria-label={t('prefs.voiceConvShortcut')}
          onChange={(event) => setShortcutDraft(event.target.value)}
          onBlur={() => {
            if (parseAccelerator(shortcutDraft)) setPreferences({ voiceShortcut: shortcutDraft.trim() })
          }}
        />
      </SettingsSection>

      <SettingsSection id="voice-conversation-narration" title={t('prefs.voiceConvNarration')} description={t('prefs.voiceConvNarrationDesc')}>
        <Dropdown
          rootClassName={styles.dictationMicSelect}
          disabled={!enabled}
          value={preferences.voiceVerbosity}
          ariaLabel={t('prefs.voiceConvNarration')}
          options={(
            [
              ['silent', 'prefs.voiceConvNarrationSilent'],
              ['final', 'prefs.voiceConvNarrationFinal'],
              ['normal', 'prefs.voiceConvNarrationNormal'],
              ['detailed', 'prefs.voiceConvNarrationDetailed'],
            ] as const
          ).map(([value, key]) => ({ value, label: t(key) }))}
          onChange={(value) => setPreferences({ voiceVerbosity: value as VoiceVerbosity })}
        />
        <p>{t('prefs.voiceConvFill')}</p>
        <Dropdown
          rootClassName={styles.dictationMicSelect}
          disabled={!enabled}
          value={String(Math.round(preferences.voiceFillAfterMs / 1000))}
          ariaLabel={t('prefs.voiceConvFill')}
          options={FILL_SECONDS.map((seconds) => ({ value: String(seconds), label: `${seconds} s` }))}
          onChange={(value) => setPreferences({ voiceFillAfterMs: Number(value) * 1000 })}
        />
      </SettingsSection>

      <SettingsSection id="voice-conversation-voice" title={t('prefs.voiceConvVoice')} description={t('prefs.voiceConvVoiceDesc')}>
        <Dropdown
          rootClassName={styles.dictationMicSelect}
          disabled={!enabled}
          value={preferences.voiceTtsVoice ?? ''}
          ariaLabel={t('prefs.voiceConvVoice')}
          options={[
            { value: '', label: t('prefs.voiceConvVoiceSystem') },
            ...voices.map((voice) => ({ value: voice.id, label: `${voice.name} (${voice.language})` })),
          ]}
          onChange={(value) => setPreferences({ voiceTtsVoice: value || null })}
        />
        <p>{t('prefs.voiceConvRate')}</p>
        <div className={styles.segmented}>
          {RATES.map((rate) => (
            <button
              key={rate}
              type="button"
              disabled={!enabled}
              className={preferences.voiceTtsRate === rate ? styles.segmentActive : undefined}
              onClick={() => setPreferences({ voiceTtsRate: rate })}
            >
              {`${rate}×`}
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection id="voice-conversation-approval" title={t('prefs.voiceConvApproval')} description={t('prefs.voiceConvApprovalDesc')}>
        <div className={styles.segmented}>
          {(
            [
              ['both', 'prefs.voiceConvApprovalBoth'],
              ['voice', 'prefs.voiceConvApprovalVoice'],
              ['hud', 'prefs.voiceConvApprovalHud'],
            ] as const
          ).map(([value, key]) =>
            segment<VoiceApprovalChannel>(value, preferences.voiceApprovalChannel, t(key), (v) =>
              setPreferences({ voiceApprovalChannel: v }),
            ),
          )}
        </div>
        <p>{t('prefs.voiceConvDestructiveDesc')}</p>
        <div className={styles.segmented}>
          {segment('hud', preferences.voiceDestructiveNeedsHud ? 'hud' : 'voice', t('prefs.voiceConvDestructiveHud'), () => setPreferences({ voiceDestructiveNeedsHud: true }))}
          {segment('voice', preferences.voiceDestructiveNeedsHud ? 'hud' : 'voice', t('prefs.voiceConvDestructiveVoice'), () => setPreferences({ voiceDestructiveNeedsHud: false }))}
        </div>
        <p>{t('prefs.voiceConvMidTaskDesc')}</p>
        <div className={styles.segmented}>
          {segment('queue', preferences.voiceMidTaskDefault, t('prefs.voiceConvMidTaskQueue'), (v) => setPreferences({ voiceMidTaskDefault: v }))}
          {segment('interrupt', preferences.voiceMidTaskDefault, t('prefs.voiceConvMidTaskInterrupt'), (v) => setPreferences({ voiceMidTaskDefault: v }))}
        </div>
      </SettingsSection>

      <SettingsSection id="voice-conversation-words" title={t('prefs.voiceConvWords')} description={t('prefs.voiceConvWordsDesc')}>
        <input
          className={controls.input}
          value={wordsDraft}
          disabled={!enabled}
          spellCheck={false}
          aria-label={t('prefs.voiceConvWords')}
          onChange={(event) => setWordsDraft(event.target.value)}
          onBlur={() =>
            setPreferences({
              voiceInterruptWords: wordsDraft.split(',').map((word) => word.trim().toLowerCase()).filter(Boolean),
            })
          }
        />
        <p>{t('prefs.voiceConvTriggerDesc')}</p>
        <input
          className={controls.input}
          value={triggerDraft}
          disabled={!enabled}
          spellCheck={false}
          aria-label={t('prefs.voiceConvTrigger')}
          onChange={(event) => setTriggerDraft(event.target.value)}
          onBlur={() => {
            if (triggerDraft.trim()) setPreferences({ voiceJevTrigger: triggerDraft.trim().toLowerCase() })
          }}
        />
      </SettingsSection>
    </>
  )
}
```

Text inputs use `controls.input` from `../controls.module.css`, the same class the Spotify fields on the Integrations page use. Do not add new colors.

- [ ] **Step 3: Mount and index it.** In `IntegrationsPage.tsx`, import `VoiceConversationSection` and render `<VoiceConversationSection />` after `<VoiceDictationSection />`. In `PreferencesModal.tsx` `searchItems`, after the `dictation` entry:

```ts
      {
        category: 'integrations',
        target: 'voice-conversation',
        label: t('prefs.voiceConv'),
        description: t('prefs.voiceConvDesc', { shortcut: '' }),
        keywords:
          'voice conversation talk speak narration tts permission approve conversa voz falar narração permissão 语音 对话',
      },
```

- [ ] **Step 4: Build and test**

Run: `npm run build`
Expected: succeeds.
Run: `npm test`
Expected: PASS (whole suite).

- [ ] **Step 5: Checkpoint** — working tree only, no commit.

---

### Task 14: Docs, full verification, manual checks

**Files:**
- Modify: `docs/CHANGELOG.md` (`## [Unreleased]` → `### Added`)
- Modify: `docs/FEATURES.md` (voice section — `grep -n -i "dictation\|voice" docs/FEATURES.md`)
- Modify: `docs/superpowers/specs/2026-10-14-voice-conversation-design.md` (status line: "Phase 1 implemented")

- [ ] **Step 1: Changelog** — add under `## [Unreleased]` → `### Added`:

```markdown
- **Talk to Claude and hear it work.** Turn on *Voice conversation* in Preferences → Integrations,
  hold Ctrl+Shift+Space (⌘⇧Space on macOS) in Alethe and speak: what you say goes straight to the
  active Claude pane, transcribed on your machine. While Claude works, Alethe reads out what it
  writes and, after a silence, says what it is doing ("Running the tests."). When Claude asks for
  permission, a panel shows the request and you can answer by voice — "no, use pnpm" sends the
  reason back to Claude — or with a click; destructive commands such as `rm -rf` or
  `git push --force` always need the click. Start with "stop" to interrupt Claude first, or with
  "Alethe" to send the request to Jev instead. It applies to Claude panes opened after you turn it on.
```

- [ ] **Step 2: FEATURES.md** — add a "Voice conversation" subsection next to dictation describing: shortcut and capture modes, target selection (active pane, picker on the panel), narration verbosity levels, permission answers and the destructive guard, interrupt words, Jev trigger, and that it uses the dictation model and microphone.

- [ ] **Step 3: Full verification**

Run: `npm run build` — Expected: succeeds.
Run: `npm test` — Expected: PASS.
Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib` — Expected: PASS.
Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` only if CI runs clippy (`grep -n clippy .github/workflows/ci.yml`); otherwise `cargo check`.

Record the exact output of any failure in the hand-off; do not mark the task done with a failing command.

- [ ] **Step 4: Manual checks** (the owner runs the app; never restart it yourself). Hand this checklist over:
  1. Preferences → Integrations: turn on Voice conversation; open a **new** Claude pane.
  2. Hold the shortcut, say "list the files in src", release → text appears in the Claude TUI and is submitted once; the pane status shows working; narration speaks.
  3. While Claude runs a long command, stay silent 8 s → a status line is spoken.
  4. Ask for something that needs a Bash permission → the card appears and the request is spoken; say "yes" → it runs.
  5. Ask for `rm -rf` of a scratch folder → say "yes" → refused with "Approve this one on the panel"; click Deny.
  6. With a permission card up, check whether the TUI shows its own prompt meanwhile (spec §13 open question) and record the answer.
  7. Click "Answer in the terminal" → the TUI shows its normal prompt.
  8. Say "stop, use pnpm" mid-task → Claude is interrupted and gets "use pnpm".
  9. Close the Claude pane while a card is up → the card disappears.
  10. macOS bundled build only: first capture shows the microphone prompt with the Info.plist text.

- [ ] **Step 5: Checkpoint** — everything stays in the working tree. Report to the owner: files changed, commands run with results, the manual checklist, and the answer to manual check 6 if they ran it. Do not commit.
