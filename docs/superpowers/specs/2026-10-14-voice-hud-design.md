# Voice conversation — floating HUD and system-wide shortcut — Design

Date: 2026-10-14
Status: implemented. Note: `tauri-nspanel` requires `app.macOSPrivateApi: true` (see §8).
Related: phase 2 of `docs/superpowers/specs/2026-10-14-voice-conversation-design.md` (§6 `voice_hud.rs`,
§12 phase 2). Phase 1 is implemented in the working tree.

## 1. What this is

Today the voice-conversation shortcut is a `keydown` listener inside the Alethe window, and the voice
panel lives inside that window. This change makes the shortcut work from any app, adds a floating HUD
that shows the conversation while another app is in front, and adds a narration-speed control to both.

## 2. Decisions (made in conversation)

1. **System-wide shortcut.** `voiceShortcut` is registered with the OS; it works with any app focused.
2. **A floating HUD (approach A).** On macOS the HUD is a non-activating `NSPanel` (`tauri-nspanel`), so
   clicking Allow / Deny on it does not take focus away from the app in front; on Windows and Linux it is
   a `focusable(false)` window.
3. **Both surfaces.** When Alethe is focused, the existing in-window panel is used; when Alethe is not
   focused, the HUD is used.
4. **HUD visibility.** It appears when the shortcut is pressed, stays while listening, while Claude
   works and while a permission is pending, and hides 4 s after the turn ends; it has a close button.
5. **Default position is a preference**: bottom center (default), bottom left, bottom right, top center,
   top left, top right — on the screen under the mouse pointer.
6. **The HUD can be dragged anywhere.** A dragged position is remembered as "Custom" and wins over the
   preset until reset.
7. **The shortcut is chosen by recording it.** Preferences get a shortcut recorder: click it, press the
   combination, and it is saved and registered system-wide (§4.6).
8. **Narration speed in the panel and the HUD**: 1x · 1.25x · 1.5x · 2x, bound to `voiceTtsRate`. The
   Preferences rate options gain 2x.

## 3. Non-goals

- Changing the conversation controller, routing, narration or permission logic (phase 1).
- Toggle-mode end-of-speech detection (phase 3) and macOS extras (phase 4).
- A wake word.
- Resizing the HUD.

## 4. Behaviour

### 4.1 Shortcut

- The accelerator in `voiceShortcut` (default `CmdOrCtrl+Shift+Space`) and the same accelerator plus
  `Alt` are registered system-wide while voice conversation is on. Press and release of the plain one
  drive push-to-talk / toggle exactly as the in-window shortcut does today; the `Alt` one does the same
  with `jev: true`.
- While the global registration is active, the in-window `keydown` listener is disabled, so a press is
  never handled twice.
- If registration fails (the combination is taken by another app or the OS), a toast says so and points
  to the shortcut preference; the in-window listener stays active as a fallback.
- Changing the preference re-registers; turning voice conversation off unregisters.

### 4.2 Which surface shows

A pure function decides, given whether the main window is focused, the conversation phase, and how long
the turn has been idle:

| Main window focused | Conversation active (listening, transcribing, sending, working, permission, or a notice) | Shows |
|---|---|---|
| yes | any | the in-window panel (today's rules) |
| no | yes | the HUD |
| no | no, idle < 4 s | the HUD |
| no | no, idle ≥ 4 s | nothing |

Closing the HUD with its button hides it until the next press. When Alethe gains focus while the HUD is
visible, the HUD hides and the panel takes over; when Alethe loses focus mid-conversation, the HUD shows.

### 4.3 HUD content

The same `VoiceConversationView` the panel uses: waveform, phase, transcript, narration text, permission
card (Allow / Deny / Answer in the terminal, with the destructive guard), Claude-pane picker, notices,
close and stop-speaking buttons, and the speed control (§4.5). A slim header strip is the drag handle.

### 4.4 Position

- Preference `voiceHudPosition`: `bottom-center` (default) · `bottom-left` · `bottom-right` ·
  `top-center` · `top-left` · `top-right` · `custom`.
- Presets are computed on the monitor under the mouse pointer at show time, inside that monitor's work
  area (excluding Dock / taskbar when the platform reports it), with a 48 px margin.
- Dragging the header moves the HUD. When a drag ends, the position is saved as
  `voiceHudCustomPosition = { monitor, x, y }`, where `monitor` is the monitor name and `x`, `y` are the
  HUD's top-left as fractions (0–1) of that monitor's work area; `voiceHudPosition` becomes `custom`.
- `custom` places the HUD on the saved monitor at the saved fractions, clamped so the whole HUD stays
  visible; if that monitor is not connected, the HUD falls back to `bottom-center` on the monitor under
  the pointer (the saved position is kept for when the monitor returns).
- Preferences show the preset choice and a **Reset to default position** button that clears
  `voiceHudCustomPosition` and sets `bottom-center`.
- Both fields are device-specific and are **not** added to `cloudSync.ts`.

### 4.5 Narration speed

A segmented control **1x · 1.25x · 1.5x · 2x** in the panel and the HUD, showing the current
`voiceTtsRate` (a stored value off these steps highlights none). Choosing one saves `voiceTtsRate`; the
next spoken sentence uses it. The Preferences speed options become 0.8 · 1 · 1.2 · 1.5 · 2.

### 4.6 Choosing the shortcut

- Preferences → Integrations → Voice conversation replaces the free-text shortcut field with a
  **recorder**: it shows the current shortcut as key caps (⌘ ⇧ Space on macOS, Ctrl Shift Space
  elsewhere) and a **Change** button.
- **Change** enters recording: the field says "Press the new shortcut…"; the next key press with at least
  one modifier (Cmd/Ctrl, Alt/Option or Shift) and a supported key (A–Z, 0–9, F1–F24, Space) becomes the
  candidate, shown live while modifiers are held. **Esc** cancels; a key without a modifier (other than
  F1–F24) is refused with "Add a modifier key (⌘, Ctrl, ⌥ or ⇧)".
- **Alt is reserved** for the Jev variant, so a candidate that includes Alt/Option is refused with
  "Alt is used to send to Jev; pick a shortcut without it".
- On a valid candidate, Alethe tries to register it system-wide **before** saving:
  - success → saved in `voiceShortcut` (as an accelerator such as `CmdOrCtrl+Shift+Space`; Cmd on macOS
    and Ctrl elsewhere are stored as `CmdOrCtrl`), the old one is unregistered;
  - failure (taken by another app or the OS) → the old shortcut stays registered and saved, and the
    field says "That shortcut is taken by another app or by the system".
- While recording, the global and in-window voice shortcuts are paused so pressing the current
  combination records it instead of starting a capture.
- **Reset to default** restores `CmdOrCtrl+Shift+Space` (same registration check).
- A pure `acceleratorFromKeyEvent(event, mac) -> { accelerator } | { error }` builds the candidate and is
  unit-tested; `parseAccelerator` (phase 1) keeps validating stored values.

### 4.7 Running in the background

The main window keeps timers and polling running when hidden or behind other windows
(`backgroundThrottling: "disabled"` on the main window), otherwise narration and permission handling
would stall while the HUD is the only thing visible.

## 5. Architecture

### 5.1 Rust — `src-tauri/src/voice_hud.rs` (new)

- **Window.** Label `voice-hud`, created once at startup (async, like `open_orchestration_window`, to
  avoid the Windows build deadlock), hidden, loading `index.html`. Builder flags: `decorations(false)`,
  `always_on_top(true)`, `skip_taskbar(true)`, `focusable(false)`, `visible_on_all_workspaces(true)`,
  `resizable(false)`, `visible(false)`, fixed size 560 × 240 logical px.
  - The window is exactly the card, so no window transparency is needed; on
    macOS its corners are rounded with the same objc2 calls `window_style.rs` uses for the main window.
  - **macOS:** converted to an `NSPanel` with `tauri-nspanel`: non-activating style mask, floating level,
    collection behaviour `canJoinAllSpaces | fullScreenAuxiliary`, `movableByWindowBackground = false`
    (drag is from the header only).
- **Pure helpers (tested):**
  - `preset_origin(work_area, hud_size, preset, margin) -> (x, y)`;
  - `custom_origin(work_area, hud_size, fractions) -> (x, y)` clamped to stay visible;
  - `fractions_for(work_area, hud_size, origin) -> (fx, fy)`;
  - `jev_accelerator(accelerator) -> Option<String>` (adds `Alt+`; `None` when the shortcut already holds Alt).
- **Commands** (the label checks follow phase 1's `require_main_window` pattern):

| Command | Allowed caller | Behaviour |
|---|---|---|
| `voice_hud_show(position)` | `main` | Computes the origin from `position` (preset or custom data) on the right monitor, moves the HUD there and orders it front without activating Alethe. |
| `voice_hud_hide()` | `main` | Hides the HUD, and cancels a `voice_hud_show` still in flight (a generation counter it checks before the native show). |
| `voice_hud_publish(state)` | `main` | Stores the latest view-state JSON and emits `voice-hud://state` to the `voice-hud` window. |
| `voice_hud_snapshot()` | `voice-hud` | Returns the stored state, for a HUD that (re)loads. |
| `voice_hud_action(action)` | `voice-hud` | Emits `voice-hud://action` to the `main` window. |
| `voice_hud_moved()` | `voice-hud` | After a drag, computes the fractions on the HUD's current monitor and emits `voice-hud://moved {monitor, x, y, bounds}` to `main` (`bounds`: the monitor's physical position and size, which tells identical monitors apart). A move to the origin `voice_hud_show` last placed is ignored. |
| `voice_shortcut_set(accelerator)` | `main` | `None` unregisters; otherwise registers `accelerator` and its `Alt` variant (none when `accelerator` already holds Alt; replacing earlier ones) and returns an error if either cannot be registered. Each press / release emits `voice://shortcut {state: "pressed" \| "released", jev}` to `main`. |

- **Plugin.** `tauri-plugin-global-shortcut` 2.x, initialised in `lib.rs` with the handler that emits
  `voice://shortcut`.
- **Capability** `src-tauri/capabilities/voice-hud.json`, webviews `["voice-hud"]`:
  `core:event:allow-listen`, `core:event:allow-unlisten`, `core:window:allow-start-dragging`.
  These gate only core and plugin permissions. There is no app-command manifest, so the HUD webview
  can invoke every app command; only the label-checked commands (the table above and phase 1's
  permission commands) refuse it.
- **Config.** `backgroundThrottling: "disabled"` on the main window and `app.macOSPrivateApi: true`
  (required by `tauri-nspanel`, §8) in `tauri.conf.json`; the CSP is not touched.

### 5.2 Frontend

- **Routing.** `main.tsx` renders `VoiceHud` for the `voice-hud` label, the same way it routes the
  orchestration window, without starting the plugin host or the app shell.
- **`VoiceHud`** (new): loads `voice_hud_snapshot()`, listens to `voice-hud://state`, renders
  `VoiceConversationView` from that state, and sends every view action through `voice_hud_action`. Its
  header strip calls `startDragging()` on mouse down and `voice_hud_moved()` when the drag ends (window
  `onMoved` debounced 300 ms).
- **Main window** (`VoiceConversation`):
  - registers the shortcut through `voice_shortcut_set` while enabled, and turns the in-window `keydown`
    listener off while that succeeds (toast + listener kept on failure);
  - tracks focus with `getCurrentWindow().onFocusChanged` and applies the §4.2 function to show / hide the
    HUD and the panel;
  - publishes the view state to the HUD at most every 100 ms while the HUD is visible;
  - handles `voice-hud://action` with the same `onAction` the panel uses, and `voice-hud://moved` by saving
    `voiceHudCustomPosition` and `voiceHudPosition: 'custom'`.
- **View.** `VoiceConversationView` gains the speed control and a `{ kind: 'rate', rate }` action; the
  connected components save `voiceTtsRate`.
- **Preferences.** In the Voice conversation section: the shortcut recorder (§4.6) in place of the
  free-text field, the position preset dropdown, the Reset button (shown when custom), the speed options
  with 2x.
- **Shortcut recorder** (`ShortcutRecorder` component, own CSS module): records with a capture-phase
  `keydown` listener while active, calls `voice_shortcut_set` with the candidate, and saves only on
  success; it sets a `voiceShortcutRecording` flag in the voice store that pauses both shortcut paths.

### 5.3 Preferences

| Field | Default | Notes |
|---|---|---|
| `voiceHudPosition` | `'bottom-center'` | one of the §4.4 values |
| `voiceHudCustomPosition` | `null` | `{ monitor: string; x: number; y: number }`, fractions clamped to 0–1 |

Sanitised in `projectsStore.migrations.ts`; not cloud-synced.

## 6. Error handling

- **Shortcut taken** → toast, in-window shortcut stays; the preference description says the shortcut is
  only active inside Alethe.
- **HUD creation fails** → log it, keep using the panel only; never block the conversation.
- **Saved monitor disconnected** → `bottom-center` on the pointer's monitor; saved custom data kept.
- **Full-screen app in front** (macOS) → `fullScreenAuxiliary` keeps the HUD above it.
- **HUD webview reloads** → it pulls `voice_hud_snapshot()` and continues.
- **Security** → the HUD never writes to a PTY and never answers permissions itself: its actions go to
  the main-window controller, which applies the phase 1 rules (`answerAllowed`, the destructive guard,
  card-bound answers). The HUD and permission commands check the calling window's label; other app
  commands are not restricted per window (see §5.1, Capability).

## 7. Testing

- **Rust:** preset and custom origin maths (each preset, clamping, fractions round-trip),
  `jev_accelerator`, the label checks on every command.
- **Frontend (vitest):** `acceleratorFromKeyEvent` (modifiers per platform, Alt refused, no-modifier
  refused, F-keys allowed alone, Esc cancels); the recorder saves only after a successful registration
  and keeps the old shortcut on failure; recording pauses the voice shortcuts; the §4.2 surface function with fake timers; publish throttling; the HUD renders a
  snapshot and forwards actions; drag end → moved → preferences saved as custom; the speed control saves
  `voiceTtsRate` and highlights the current step; the in-window listener is off while the global shortcut
  is registered and back on after a registration error; migrations for the new fields.
- **Manual (macOS and Windows):** record a new shortcut and use it from another app; try to record one
  that the OS already uses (e.g. ⌘Space on macOS) and see it refused; shortcut from another app (push-to-talk and toggle, plain and Alt);
  clicking Allow on the HUD keeps the other app focused; HUD above a full-screen app; every preset on
  two monitors; drag, restart, the HUD returns to the dragged spot; reset; speed 2x audible.

## 8. Risks

- **`tauri-nspanel` needs `macOSPrivateApi: true`.** The crate enables Tauri's `macos-private-api`
  feature, and `tauri-build` requires the matching config flag. That is acceptable for Alethe (it is not
  distributed through the Mac App Store, where private APIs are rejected); the CSP is unaffected.
- **`tauri-nspanel` 2.1 with Tauri 2.11.** Validate first. Fallback: approach B (`focusable(false)`
  window with objc2 tweaks), accepting that clicks on the HUD activate Alethe on macOS.
- **Work-area API.** If the Tauri version does not expose a monitor work area, use the monitor size minus
  a platform margin (macOS menu bar / Dock, Windows taskbar).
- **Accelerator collisions.** `Cmd+Shift+Space` may be taken by input-source switching on some macOS
  setups; the toast and the preference cover it.
- **Dragging a non-focusable window.** `startDragging` on a `focusable(false)` window / NSPanel must be
  confirmed on each platform; if it fails, the panel's `movableByWindowBackground` (macOS) or a native
  drag handle is the fallback.

## 9. Changelog

The implementation adds a user-facing entry under `[Unreleased]` in `docs/CHANGELOG.md`.
