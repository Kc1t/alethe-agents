# Native macOS speech-to-text — Design

Date: 2026-10-14
Status: approved in conversation (sections 1–3); implemented (working tree, 2026-10-14).
Related: phase 4 of `docs/superpowers/specs/2026-10-14-voice-conversation-design.md` (§4.5, §12).

## 1. What this is

On a Mac, Alethe can transcribe speech with Apple's own on-device recognizer instead of the
sherpa-onnx models (Parakeet TDT v3, Zipformer). The person picks the speech engine/model in
Preferences, and the choice applies to dictation (Cmd/Ctrl+E), the Jev voice bar and voice
conversation. Windows and Linux are unchanged.

Why: on a Mac the native engine needs no 670 MB download from Alethe, is maintained by the system,
and runs on Apple's neural hardware. The sherpa models stay available on the Mac for anyone who
prefers automatic multilingual recognition.

## 2. Decisions

Made in conversation:

1. **Both Apple APIs.** macOS 26+ uses `SpeechAnalyzer` + `SpeechTranscriber`; macOS 12–25 use
   `SFSpeechRecognizer`. Alethe picks one at runtime; the person sees one "Apple (native)" engine.
   The native engine needs macOS 12+: the bridge runs on Swift concurrency, whose runtime ships with
   macOS 12, so on macOS 10.15/11 (still supported by the app) no native engine is offered.
2. **Native is the default on the Mac.** A profile that never chose a model gets the native engine;
   a saved choice is never changed (§5.3).
3. **The language is always chosen by hand.** Apple's recognizers handle one locale at a time.
   There is no automatic default: until a language is picked, the native engine asks for one.
4. **Never Apple's servers.** Only on-device recognition is used. A language without local support
   is not offered; nothing falls back to the cloud silently or otherwise. This keeps the current
   promise that audio never leaves the machine.
5. **One Swift bridge for both APIs** (approach A), built with `swift-rs`, rather than splitting
   `SFSpeechRecognizer` into Rust (`objc2-speech`) and `SpeechAnalyzer` into Swift, or shipping a
   Swift sidecar executable.
6. **A model picker.** The Preferences section gets a real engine/model selector; today it only
   shows the current model.

## 3. Non-goals

- Streaming / partial results while speaking. Capture stays batch: record, then transcribe.
- Apple's server recognition, in any form.
- Native engines on Windows (Windows.Media.SpeechRecognition) or Linux.
- Choosing between `SpeechAnalyzer` and `SFSpeechRecognizer` by hand.

## 4. Engine catalog and preferences

### 4.1 Catalog

`speech_list_models()` returns, on macOS, one extra entry:

| Field | Value |
|---|---|
| `id` | `apple-speech` |
| `label` | `Apple (native)` |
| `kind` (new field) | `native` (the sherpa entries are `download`) |
| `language` | `single` — one chosen language at a time |
| `sizeBytes` | `0` — nothing for Alethe to download |

The sherpa entries keep their ids; their `language` stays `multilingual` / `en`. The field `kind` is
added to `SpeechModelManifest` (and its TS type) so the UI can show "no download" vs a size.

### 4.2 Preferences

| Field | Default | Notes |
|---|---|---|
| `dictationModelId` | `parakeet-tdt-0.6b-v3-int8` (unchanged) | existing field; on a Mac the one-time switch of §5.3 moves it to `apple-speech` |
| `dictationNativeLocale` | `null` | new; BCP-47 id such as `pt-BR`, `en-US` |
| `speechEngineMigrated` | `false` | new; set once the §5.3 switch has run |

`dictationNativeLocale` is sanitised in `projectsStore.migrations.ts` (trimmed string or `null`) and
is device-specific, so it is **not** added to `cloudSync.ts`'s allowlist (another machine may not
have that language locally). `dictationModelId` is not synced today and stays that way.

### 4.3 Preferences UI (Preferences → Integrations → Voice dictation → Model)

- A dropdown lists every catalog entry. Each option shows its label and, beneath it:
  "No download · one language at a time" for `apple-speech`; size and languages for the others.
- When `apple-speech` is selected:
  - a **Language** dropdown lists only the locales returned by `speech_native_locales()` (local
    support only), each marked installed or not;
  - with no language chosen, the section says the native engine needs a language first;
  - a chosen language that is not installed (macOS 26) shows **Install language**, which runs the
    install and reuses the download progress bar (`ModelDownloadProgress`, `install` variant: bar,
    percent and language only, since Apple reports no byte counts); on earlier macOS there is no
    install step (§6.2);
  - if no locale has local support, the section says so and suggests Parakeet.
- When a sherpa model is selected: today's Download / Delete controls and progress bar.

## 5. Architecture

### 5.1 Swift bridge (`src-tauri/swift/AletheSpeech/`)

A Swift package compiled only on macOS by `build.rs` through `swift-rs` (the build dependency Tauri
uses for its own macOS plugins). Minimum deployment target: macOS 10.15, but the native engine needs
macOS 12+ (`alethe_speech_supported()` is false on 10.15/11, and Rust then exposes no bridge). It
exports C functions;
each is synchronous to the caller (it runs Swift async work and waits on it), and Rust calls them from
`tokio::task::spawn_blocking`.

| Function | Result | Behaviour |
|---|---|---|
| `alethe_speech_supported()` | `bool` | `true` on macOS 12+, where the Swift concurrency runtime exists. Uses no concurrency itself, so it is safe to call first on any macOS. |
| `alethe_speech_authorize()` | status: `authorized` / `denied` / `restricted` / `notDetermined` | Requests speech-recognition authorization on first call. |
| `alethe_speech_locales()` | JSON `[{ id, name, installed }]` | macOS 26: `SpeechTranscriber.supportedLocales` with `installedLocales`. Earlier: `SFSpeechRecognizer.supportedLocales()` filtered to `supportsOnDeviceRecognition == true` (always `installed: true`). `name` is the locale's localized name. |
| `alethe_speech_install(locale)` | `ok` / error | macOS 26 only: `AssetInventory.assetInstallationRequest(supporting:)` then `downloadAndInstall()`. Earlier macOS: returns an error (`install_unsupported`). |
| `alethe_speech_install_progress(locale)` | fraction `0…1` or `-1` | Reads the running request's `Progress.fractionCompleted`. |
| `alethe_speech_transcribe(samples, count, sampleRate, locale)` | JSON `{ text }` or `{ error }` | macOS 26: `SpeechAnalyzer(modules: [SpeechTranscriber(locale:…)])`, audio converted with `AVAudioConverter` to `SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith:)` (no format → `{ error: "assets_missing" }`), fed as one input sequence, then `finalizeAndFinishThroughEndOfInput()`; the final results are joined. Earlier: `SFSpeechRecognizer(locale:)` + `SFSpeechAudioBufferRecognitionRequest` with `requiresOnDeviceRecognition = true`, one `AVAudioPCMBuffer`, `endAudio()`, wait for the final result. A timeout of max(30 s, 2 × the audio's duration) returns `{ error: "timeout" }`. |

`SpeechAnalyzer` code is wrapped in `#if compiler(>=6.2)` and `if #available(macOS 26, *)`, so the
package also builds with an older SDK (then only the `SFSpeechRecognizer` path exists). The exact
`SpeechAnalyzer` / `AssetInventory` calls are confirmed against the macOS 26 SDK when implementing.

### 5.2 Rust

- `speech.rs` gains
  `trait Transcriber { fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String, String>; }`.
  - `SherpaTranscriber` wraps the current `recognizer_for` + `transcribe_samples` path with no
    behaviour change.
  - `AppleTranscriber { locale }` lives in a new `speech_apple.rs`, compiled only with
    `cfg(target_os = "macos")`, and calls the bridge.
- A pure `fn engine_for(model_id, locale) -> Result<Engine, String>` decides which transcriber runs;
  `apple-speech` without a locale is an error (`native_locale_required`).
- Commands, all keeping their current names:
  - `speech_prepare(model_id, locale?)`: for `apple-speech`, authorization granted and locale
    installed → `true`; otherwise `false` (and the reason through `speech_model_states`).
  - `speech_stop_and_transcribe(model_id, locale?)` and `speech_transcribe(…, locale?)` dispatch
    through `engine_for`.
  - `speech_model_states(locale?)`: `apple-speech` is `ready` when authorized and the locale is
    installed, `needs-locale` without a locale, `not-installed` when the locale must be installed,
    `denied` without authorization.
  - `speech_download_model('apple-speech', locale)` runs `alethe_speech_install` and polls
    `alethe_speech_install_progress` every 200 ms, emitting the existing `speech://download-progress`
    event (`phase: "downloading"`, `file`: the locale id, `fileIndex: 1`, `fileCount: 1`).
  - New `speech_native_locales() -> Vec<NativeLocale>`; empty on other platforms.
- `build.rs`: on macOS, link the Swift package with `swift-rs`. If no Swift toolchain is found, the
  build still succeeds without the bridge and the catalog omits `apple-speech` (a `cfg` set by
  `build.rs`, like the existing `ghostty_linked`). Release builds on macOS require Swift and fail
  loudly without it.
- `src-tauri/Info.plist` gains `NSSpeechRecognitionUsageDescription`.

### 5.3 Frontend

- `src/lib/tauri/speech.ts`: optional `locale` on `speechPrepare`, `speechStopAndTranscribe`,
  `speechTranscribe`, `speechModelStates`, `speechDownloadModel`; new `speechNativeLocales()`; `kind`
  on `SpeechModelManifest`.
- One helper, `speechEngineArgs(preferences) → { modelId, locale }`, is used by the three consumers:
  `DictationButton`, `VoiceCommand` and the voice controller. `locale` is
  `dictationNativeLocale` when `modelId` is `apple-speech`, otherwise `undefined`.
- Before capturing with `apple-speech` and no locale, the three consumers show
  "Choose the native recognition language in Preferences" and do not open the microphone.
- Default switch (one mechanism for new and existing profiles): at startup on a Mac, when
  `speechEngineMigrated` is false, `apple-speech` is in the catalog, `dictationModelId` is still
  `parakeet-tdt-0.6b-v3-int8` **and** that model is not downloaded, set `dictationModelId` to
  `apple-speech`; then set `speechEngineMigrated` to true either way. A downloaded Parakeet, or any
  other saved id, is left alone. `DEFAULT_PREFERENCES` itself stays platform-independent.
- The Preferences section of §4.3, and its search entry keywords gain "apple native siri".

## 6. Error handling

1. **Authorization denied / restricted** → message with a pointer to System Settings → Privacy &
   Security → Speech Recognition; no capture.
2. **No language chosen** → "Choose the native recognition language in Preferences"; no capture.
3. **Language not installed** (macOS 26) → the Preferences section offers Install language; the
   consumers say the language is still installing / not installed.
4. **No local support for any language** → the native engine shows as unavailable and the section
   suggests Parakeet.
5. **Bridge error or timeout** (max(30 s, 2 × the audio's duration)) → the error reaches the person (dictation toast, voice panel
   notice); the capture is discarded; the app does not hang (the call runs on a blocking thread).
6. **Built without Swift, or macOS 10.15/11** → `apple-speech` is not in the catalog; everything else
   works.
7. **macOS update from < 26 to 26** → the same `apple-speech` id keeps working; the bridge picks
   `SpeechAnalyzer` at runtime; the chosen locale may need installing.

## 7. Testing

- **Rust:** `engine_for` dispatch (sherpa ids, `apple-speech` with and without locale); the catalog
  includes `apple-speech` only on macOS with the bridge; `speech_model_states` status mapping from
  bridge answers (bridge behind a small trait so it can be faked); existing sherpa tests unchanged.
- **Swift (`swift test`):** PCM → `AVAudioPCMBuffer` conversion; locale JSON encoding.
- **Frontend (vitest):** `speechEngineArgs`; model picker shows every entry with its subtitle;
  language dropdown lists only native locales; no-locale message blocks capture in dictation, the
  Jev bar and the voice controller; the one-time default migration (switches only when the old default
  is not downloaded; respects the marker).
- **Manual:** on macOS 26 and on macOS 14/15 — dictation and voice conversation in pt-BR and
  en-US; Install language with the progress bar; deny authorization; a language without local
  support; switch between Apple and Parakeet without restarting.

## 8. Risks

- **`SpeechAnalyzer` API details** (`AssetInventory`, audio format, result finalization) are new;
  verify them against the macOS 26 SDK before writing the bridge.
- **Authorization under `npm run app`**: in development the permission prompt may be attributed to
  the terminal app; the bundled app shows Alethe's own description.
- **Mixed Portuguese and English** (code terms) is weaker with a single-locale recognizer than with
  Parakeet; the picker's subtitle says "one language at a time" so the trade-off is visible.
- **CI**: the macOS release job must run with Xcode 26 to include the `SpeechAnalyzer` path;
  without it the build silently ships only `SFSpeechRecognizer` — the release job checks for it.

## 9. Changelog

The implementation adds a user-facing entry under `[Unreleased]` in `docs/CHANGELOG.md`.
