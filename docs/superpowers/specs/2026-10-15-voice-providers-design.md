# Voice providers (local and cloud speech) — Design

Date: 2026-10-15
Status: approved (2026-10-15). Plan: `docs/superpowers/plans/2026-10-15-voice-providers.md`.
Related: `2026-10-14-voice-conversation-design.md`, `2026-10-14-macos-native-stt-design.md`,
`2026-10-14-voice-hud-design.md`.

## 1. What this is

Alethe's voice features (dictation, voice conversation, narration) can run on a provider the person
picks per use: local models on the device, or a cloud API authenticated with the person's own key.
Preferences gets a dedicated **Voice** page that shows every provider, its connection status, and
which provider each use is set to.

Today speech-to-text (STT) is local only (sherpa-onnx Parakeet/Zipformer, Apple Speech on the Mac),
text-to-speech (TTS) is the operating system voice only, and both are chosen from plain dropdowns
buried in the Integrations page.

Why: cloud models give better accuracy and more natural voices on demand, and small local models
from Hugging Face give choice without a cloud hop. The person decides the trade-off per use.

## 2. Decisions

Made in conversation:

1. **Providers in the first version.**
   - Local: downloadable sherpa-onnx models from Hugging Face (STT and TTS), Apple Speech (macOS STT),
     the system voice (existing `tts` crate).
   - Cloud: OpenAI, ElevenLabs, Google Gemini, OpenRouter. Each one key covers STT and TTS.
2. **Provider per use.** Dictation and voice conversation pick their STT provider independently;
   narration picks the TTS provider. Initial values reproduce today's behaviour.
3. **Cloud failure falls back to local, with a notice.** Voice never goes silent because of a
   network, key or quota error while a local option exists. The reverse never happens: a local
   failure never falls back to the cloud.
4. **Layout: one Voice page, two levels** (§6). Usage tabs with selectable provider cards on top;
   a provider grid with status and a Local/Cloud filter below; a provider detail page for keys and
   models.
5. **All cloud traffic goes through Rust** (approach A). Keys live in the OS keychain and never
   return to the webview after they are saved. The CSP is not changed.
6. **No new audio playback dependency.** Every cloud TTS is asked for raw PCM, local TTS yields PCM
   samples, and both play through `cpal` (already a dependency).

Rejected approaches:

- **Cloud calls from the frontend** (fetch + WebAudio): needs `connect-src` opened in the CSP
  (asserted literally by `src/securityPolicy.test.ts`) and puts keys in a webview with full IPC.
- **OpenRouter as the only cloud gateway**: one key, but loses ElevenLabs voices and per-provider
  control.

## 3. Non-goals

- Streaming (real-time partial) STT. Transcription stays batch, after capture ends.
- Voice cloning, custom voice upload, SSML.
- Syncing keys, provider choices, or downloaded models through cloud sync.
- Usage or billing dashboards.
- Changing Jev (`voiceCommandApiKey`) or Router9; they keep their own settings.

## 4. Privacy

The earlier promise "audio never leaves the machine" becomes "audio never leaves the machine unless
the person picks a cloud provider for that use". Concretely:

- Local providers stay the default for every use. A new or migrated profile never ends up on a
  cloud provider.
- A cloud provider card shows "Audio is sent to {provider}" (STT) or "Text is sent to {provider}"
  (TTS) wherever it can be selected.
- A cloud provider without a saved key cannot be selected.
- Keys, request bodies and audio are never logged. `spawn.log` and errors carry only provider id,
  error class and HTTP status.

## 5. Data model

### 5.1 Preferences

New fields on `Preferences` (`src/lib/types.ts`):

```ts
type VoiceProviderId = 'local' | 'apple' | 'system' | 'openai' | 'elevenlabs' | 'gemini' | 'openrouter'
type CloudVoiceProviderId = 'openai' | 'elevenlabs' | 'gemini' | 'openrouter'

interface SttChoice {
  provider: Exclude<VoiceProviderId, 'system'>
  model: string          // sherpa model id, 'apple-speech', or cloud model id
  locale: string | null  // Apple Speech only; null elsewhere
}

interface TtsChoice {
  provider: Exclude<VoiceProviderId, 'apple'>
  model: string          // '' for system; sherpa TTS model id; cloud model id
  voice: string | null   // provider voice id; null = provider default
  rate: number           // 0.5–2, as voiceTtsRate today
}

voiceStt: { dictation: SttChoice; conversation: SttChoice }
voiceTts: TtsChoice
voiceProviders: Partial<Record<CloudVoiceProviderId, { configured: boolean; invalid: boolean }>>
```

`voiceProviders` holds flags only, mirrored from the keychain at startup (§7.2); keys are never in
`projects.json`.

### 5.2 Migration

In `normalizePreferences` (`src/stores/projectsStore.migrations.ts`); the `projects.json` file
version stays 9, as with earlier preference backfills:

- `voiceStt.dictation` and `voiceStt.conversation` are both built from `dictationModelId` and
  `dictationNativeLocale`: `apple-speech` → `{ provider: 'apple', model: 'apple-speech', locale }`;
  any other id → `{ provider: 'local', model: id, locale: null }`.
- `voiceTts` = `{ provider: 'system', model: '', voice: voiceTtsVoice, rate: voiceTtsRate }`.
- `voiceProviders` = `{}`.
- The old fields (`dictationModelId`, `dictationNativeLocale`, `voiceTtsVoice`, `voiceTtsRate`) are
  removed after backfill.
- `useSpeechEngineDefault` (Mac switch to Apple Speech) keeps working, now on `voiceStt.dictation`
  and `voiceStt.conversation`, under the same rule: only an untouched default is switched.
- The voice HUD rate chips bind to `voiceTts.rate`.

Sanitizing on load: an unknown provider or a cloud provider whose `configured` flag is false resets
that use to its local default (Apple Speech on a Mac with a locale set, else Parakeet; system voice
for TTS). Rate is clamped to 0.5–2.

### 5.3 Cloud sync

Unchanged include-list in `src/lib/cloudSync.ts`: none of `voiceStt`, `voiceTts`, `voiceProviders`
syncs. Keys and downloaded models are per machine.

### 5.4 Fixed fallback order

- STT: Apple Speech when on macOS, ready and a locale is set → the first downloaded sherpa STT model
  (the use's own model if it is local) → error.
- TTS: system voice (always available).

## 6. User interface

### 6.1 Placement

New Preferences category **Voice** (microphone icon) in `PreferencesModal.tsx`, between Integrations
and Orchestration. `VoiceDictationSection` and `VoiceConversationSection` leave the Integrations
page; their behavioural settings move into the Voice page (§6.2). The search index entries
`prefs.dictation` and `prefs.voiceConv` point to the new page, and new entries cover providers and
keys.

### 6.2 Voice page

Top to bottom:

1. **Usage tabs** (existing segmented control): Dictation · Conversation · Narration.
   - Dictation and Conversation list STT providers; Narration lists TTS providers.
   - Each tab shows a grid of **provider choice cards**: icon, name, a badge ("On device" or
     "Cloud"), a one-line subtitle, and inside the card the provider's models (or voices) as
     selectable rows. The selected row shows a check, `--accent-border` and
     `--surface-card-selected`.
   - A cloud provider without a key is shown disabled with a "Set up key" action that opens its
     detail page.
   - A local model not yet downloaded shows Download inline with the existing
     `ModelDownloadProgress`.
   - Apple Speech keeps its locale dropdown and install button.
   - Narration adds the voice selector, the rate chips (1x / 1.25x / 1.5x / 2x) and a **Test voice**
     button that speaks a short localized sentence through the selected provider.
   - Below the cards, the tab's existing behavioural settings: Dictation → on/off, toggle/hold,
     microphone; Conversation → on/off, capture mode, shortcut, verbosity, fill delay, approval
     channels, interrupt words, Jev trigger; Narration → nothing extra.
2. **Providers** section, styled after the reference grid:
   - Header with a `All | Local | Cloud` filter.
   - Group "Local and on device": Local models, Apple Speech (macOS only), System voice.
   - Group "Cloud APIs": OpenAI, ElevenLabs, Google Gemini, OpenRouter.
   - Each card: icon, status badge (`Connected` on `--status-working`, `Not connected` neutral,
     `Invalid key` on the waiting/warning status token), short description, one action button
     ("Manage models", "Set up key", "Manage").
3. **Provider detail**, replacing the page content with a breadcrumb `← Providers / OpenAI`:
   - Cloud: password key field (shows `••••` when a key is saved), "Get a key" external link,
     Save / Test connection / Remove buttons, the privacy note (§4), and the provider's STT and TTS
     models with a search box. OpenRouter's list is its live catalog filtered to audio models
     (§7.5); the others use the curated catalog (§7.1).
   - Local models: STT and TTS model lists with size, language, status, Download/Delete.
   - Apple Speech and System voice: status and locale/voice info.

### 6.3 Components and styling

New folder `src/components/modals/preferences/voice/`: `VoicePage.tsx`, `UsageTabs.tsx`,
`ProviderChoiceCard.tsx`, `ProviderGrid.tsx`, `ProviderCard.tsx`, `ProviderDetail.tsx`,
`CloudKeyForm.tsx`, `LocalModelList.tsx`, and one `.module.css` per component.

- Colors, radii, shadows only through `src/styles/theme.css` tokens (`--surface-card-default`,
  `--surface-card-selected`, `--border-subtle`, `--accent-border`, `--radius-lg`, `--status-*`).
  No gradients, no literal colors.
- Reuse `Dropdown`, `SettingsSection`, `ModelDownloadProgress`, `controls.module.css` buttons and
  inputs. The selectable card follows `.modeChoice` in `controls.module.css`.
- Provider icons are generic glyphs from the app's current icon set, not vendor logos.
- Every string goes through `t()` with keys in `en.ts`, `pt-BR.ts` and `zh-CN.ts`.

## 7. Backend

### 7.1 Provider registry

New module `src-tauri/src/voice_providers/`:

- `mod.rs`: `ProviderId` enum and a static catalog per provider listing supported STT models and TTS
  models with their voices. Initial cloud catalog (verified against provider docs while planning):
  - OpenAI: STT `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper-1`; TTS `gpt-4o-mini-tts`
    with its built-in voices.
  - ElevenLabs: STT `scribe_v1`; TTS `eleven_multilingual_v2`, `eleven_flash_v2_5`; voices from
    the account's voice list.
  - Gemini: STT via `generateContent` with audio input on a Flash model; TTS Gemini Flash TTS with
    its prebuilt voices.
  - OpenRouter: dynamic (§7.5).
- Command `voice_providers_status` → per cloud provider `{ configured, invalid }`.

### 7.2 Keys

- `SecretKind` in `src-tauri/src/secure_store.rs` gains `VoiceProviderKey(CloudProvider)` with
  suffixes `voice-key-openai`, `voice-key-elevenlabs`, `voice-key-gemini`, `voice-key-openrouter`,
  per profile, following the Spotify pattern.
- Commands: `voice_provider_set_key(provider, key)`, `voice_provider_delete_key(provider)`,
  `voice_provider_test(provider)` (cheapest authenticated call, e.g. list models/voices). No command
  returns a key.
- At startup the frontend reads `voice_providers_status` and refreshes `voiceProviders`.

### 7.3 Cloud STT

`stt_cloud.rs`: `CloudTranscriber` implements the existing `Transcriber` trait in `speech.rs`.

- Input: the captured 16 kHz mono buffer from `speech_capture.rs`, encoded as WAV in memory.
- OpenAI and ElevenLabs: multipart upload (`reqwest` gains the `multipart` feature).
- Gemini: inline base64 audio in `generateContent` with a transcription instruction.
- OpenRouter: `POST /api/v1/audio/transcriptions` with base64 audio in JSON.
- Timeout 30 s. `engine_for` dispatches on `SttChoice.provider`.

### 7.4 TTS engines

`tts_engine.rs`: trait `Speaker { speak(text, choice), stop(), voices(choice) }`.

- `SystemSpeaker`: wraps the current `tts.rs` implementation unchanged.
- `SherpaSpeaker`: sherpa-onnx offline TTS (Piper/VITS), outputs f32 samples.
- `CloudSpeaker`: requests PCM (OpenAI `response_format: "pcm"`, ElevenLabs `pcm_24000`, Gemini
  native PCM, OpenRouter `/api/v1/audio/speech` with PCM format), long text split by sentence.
- `audio_out.rs`: one `cpal` output stream playing a PCM queue; `stop()` clears the queue at once so
  barge-in keeps working. Rate: provider `speed` parameter where supported, otherwise resampling.
- `tts_speak`, `tts_stop`, `tts_voices` keep their names and take a `TtsChoice`.

### 7.5 OpenRouter catalog

Command `voice_openrouter_models(kind: 'stt' | 'tts')` fetches the model list, keeps audio-capable
models of that kind, and caches the result in memory for one hour.

### 7.6 Local model catalog

`speech.rs` catalog gains, with pinned Hugging Face URLs and SHA-256 like today:

- STT: Whisper base and small (multilingual), Moonshine base (English).
- TTS: Piper `pt_BR-faber-medium` and `en_US-amy-low` (sherpa-onnx `tts-models` release archives,
  which carry the `espeak-ng-data` folder Piper needs).

Assets and SHA-256 were verified on 2026-10-15. Kokoro is deferred: a 350 MB archive with unverified
Portuguese quality. TTS downloads reuse the existing
download pipeline and the `speech://download-progress` event, with a `kind` field added.

### 7.7 Frontend wrappers

- `src/lib/tauri/speech.ts` and `src/lib/tauri/tts.ts` take `SttChoice` / `TtsChoice`.
- New `src/lib/tauri/voiceProviders.ts` for key, status, test and catalog commands.
- `src/lib/speech/engine.ts`: `speechEngineArgs` becomes `sttChoiceFor(prefs, 'dictation' |
  'conversation')`; dictation, the Jev voice bar and voice conversation call it with their use.
  The Jev bar uses the conversation choice.

## 8. Errors and fallback

- Cloud errors are classified: `Network`, `Auth` (401/403), `Quota` (402/429), `BadAudio` (400 on
  audio), `Timeout`, `Other(status)`.
- On a cloud error the Rust side retries once on the fallback order (§5.4) and emits
  `voice://fallback { use, provider, reason }`. The frontend shows a localized toast ("OpenAI
  unavailable (invalid key) — used Apple Speech").
- If no local fallback is ready, the error surfaces as today (HUD/toast) and nothing is spoken or
  inserted.
- `Auth` sets `voiceProviders[p].invalid = true`; the card shows "Invalid key" until a successful
  test or a new key.
- Local failures never fall back to the cloud.

## 9. Testing

Rust:

- Error classification from HTTP status and transport errors.
- Request building per provider (URL, headers, body shape) through an injectable HTTP transport.
- Fallback chain selection given provider readiness.
- `SecretKind` suffixes unique and stable.
- PCM queue stop clears pending audio.

TypeScript (vitest):

- Legacy-field migration in `projectsStore.migrations.test.ts`: Apple and sherpa ids map to both uses;
  TTS voice/rate preserved; old fields removed.
- Sanitizing: unknown provider and unconfigured cloud provider reset to local defaults.
- `sttChoiceFor` per use.
- `ProviderGrid` filter and status badges; disabled cloud choice without a key; fallback toast on
  `voice://fallback`.

Build: `npm run build` (typecheck + i18n completeness across en, pt-BR, zh-CN), `npm test`,
`cargo test`.

Docs: `docs/CHANGELOG.md` `[Unreleased]` entry and `docs/FEATURES.md` voice section.

## 10. Phasing

One spec, implemented in order so each phase leaves the app working:

1. Data model, migration, Voice page shell with the moved sections (no behaviour change).
2. Provider registry, keychain keys, provider grid and detail pages.
3. Cloud STT with fallback.
4. TTS engine trait, `cpal` output, cloud TTS, Test voice.
5. Local Hugging Face models (Whisper/Moonshine STT, Piper TTS).
6. OpenRouter live catalog, changelog and docs.
