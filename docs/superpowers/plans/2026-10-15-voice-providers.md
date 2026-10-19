# Voice Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each voice use (dictation, conversation, narration) run on a provider the person picks — local models, Apple Speech, the system voice, or a cloud API (OpenAI, ElevenLabs, Gemini, OpenRouter) with the person's own key — from a new Voice page in Preferences.

**Architecture:** Preferences gain `voiceStt` (per use), `voiceTts` and `voiceProviders` (flags only). All cloud traffic goes through Rust: keys live in the OS keychain (`secure_store.rs`), a new `voice_providers` module builds provider requests as pure, testable data and sends them with `reqwest`. Cloud STT plugs into the existing `Transcriber` dispatch in `speech.rs`; TTS gets a `cpal` PCM player used by cloud and local (sherpa-onnx Piper) voices. A cloud failure falls back to a local engine and emits `voice://fallback` for a toast.

**Tech Stack:** Tauri 2, Rust (`reqwest` 0.12, `cpal` 0.15, `sherpa-onnx` 1.13.6, `keyring` 3, `tar`, new `bzip2`), React 19 + TypeScript, Zustand, CSS Modules, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-15-voice-providers-design.md`

## Global Constraints

- Never stop or restart the running app or dev server; rely on HMR (`CLAUDE.md` §3.1).
- Never commit, push or tag without the owner's explicit permission at that moment. Commit steps below are **checkpoints**: show `git status --short`, ask, and commit only on a yes. Never add `Co-Authored-By` or any tool signature.
- Every visible string goes through `t()`; each new key goes into `src/lib/i18n/messages/en.ts`, `pt-BR.ts` and `zh-CN.ts` (build fails otherwise).
- One `.module.css` per component; colors, radii and shadows only through `src/styles/theme.css` tokens. No gradients, no literal colors, no vendor logos.
- English for code, comments, docs and changelog.
- Keys are never written to `projects.json`, never logged, never returned to the frontend. Logs and errors carry only provider id, error class and HTTP status.
- Local providers stay the default for every use; a new or migrated profile never lands on a cloud provider.
- A cloud failure may fall back to local; a local failure never falls back to the cloud.
- `tauri.conf.json` CSP is not changed.
- `docs/CHANGELOG.md` `[Unreleased]` and `docs/FEATURES.md` are updated (Task 16).

## Deviations from the spec (decided while planning)

- **No `projects.json` version bump.** Preference shape changes in this repo are backfilled in `normalizePreferences` (see `showGitControl`); the v9 file format is unchanged. Legacy fields are read there and dropped.
- **Kokoro is deferred.** Its sherpa-onnx archive is 350 MB and its Portuguese support goes through espeak with unverified quality. First version ships Piper `pt_BR-faber-medium` and `en_US-amy-low` (assets and hashes verified on 2026-10-15).
- **Fallback locale comes from the frontend.** Rust has no access to preferences, so STT commands receive `fallbackLocale` (the first Apple locale set on any use). Order stays as in spec §5.4: Apple (ready + locale) → first downloaded sherpa STT model.
- **Local model downloads come from Hugging Face (STT, per file, pinned revision) and the sherpa-onnx GitHub `tts-models` release (Piper, one `.tar.bz2` each).** Piper needs the `espeak-ng-data` folder, which only ships as an archive.

## Review Focus

1. **Cloud key saved, network down at transcribe time** → the transcript still arrives from the local fallback and a toast names the reason. Pinned by `fallback_order_*` tests (Task 8) and `useVoiceFallbackToasts` test (Task 8).
2. **Barge-in while cloud or Piper audio plays** → `tts_stop` silences output at once, and no `tts://end` arrives for the interrupted utterance. Pinned by `player_stop_drops_queued_audio` (Task 10).
3. **Profile switch** → keys are per profile; provider flags refresh on `activeProfileId` change, so profile B never shows profile A as connected. Pinned by `useVoiceProviderStatus` test (Task 5).
4. **Key removed while that provider is selected** (by hand, or gone after a profile switch) → every use on that provider moves back to its local default immediately. Pinned by the `clearProviderUses` and `useVoiceProviderStatus` tests (Task 5) and the CloudKeyForm remove test (Task 6).
5. **Long narration to a cloud TTS** → text is split at sentence boundaries under the provider's character limit; nothing is truncated. Pinned by `split_for_tts_*` tests (Task 11).

---

## File map

Frontend, new:
- `src/lib/voice/providers.ts` — provider ids, defaults, `isCloudProvider`.
- `src/lib/voice/voicePreferences.ts` (+ `.test.ts`) — normalize/migrate voice prefs, choice helpers.
- `src/lib/tauri/voiceProviders.ts` — key/status/test/catalog wrappers.
- `src/hooks/useVoiceProviderStatus.ts` (+ test) — mirror keychain flags into prefs.
- `src/hooks/useVoiceFallbackToasts.ts` (+ test) — toast on `voice://fallback`.
- `src/components/modals/preferences/voice/` — `VoicePage`, `UsageTabs`, `ProviderChoiceCard`, `ProviderGrid`, `ProviderCard`, `ProviderDetail`, `CloudKeyForm`, `LocalModelList`, `NarrationPanel`, each with its `.module.css`; tests next to them.

Frontend, modified: `src/lib/types.ts`, `src/stores/projectsStore.migrations.ts`, `src/lib/speech/engine.ts`, `src/lib/tauri/speech.ts`, `src/lib/tauri/tts.ts`, `src/lib/tauri/index.ts`, `src/lib/voice/controller.ts`, `src/components/DictationButton/index.tsx`, `src/components/VoiceCommand/index.tsx`, `src/components/VoiceConversation/index.tsx`, `src/hooks/useSpeechEngineDefault.ts`, `src/components/modals/PreferencesModal.tsx`, `src/components/modals/preferences/IntegrationsPage.tsx`, `VoiceDictationSection.tsx`, `VoiceConversationSection.tsx`, `src/App.tsx`, the three locale files, and the tests of each.

Rust, new: `src-tauri/src/voice_providers/{mod.rs,catalog.rs,keys.rs,http.rs,stt_cloud.rs,tts_cloud.rs,openrouter.rs}`, `src-tauri/src/audio_out.rs`, `src-tauri/src/tts_local.rs`.

Rust, modified: `src-tauri/src/secure_store.rs`, `src-tauri/src/speech.rs`, `src-tauri/src/tts.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`.

Docs: `docs/CHANGELOG.md`, `docs/FEATURES.md`.

---

## Phase 1 — Data model and page shell

### Task 1: Voice preferences model and migration

**Files:**
- Create: `src/lib/voice/providers.ts`, `src/lib/voice/voicePreferences.ts`, `src/lib/voice/voicePreferences.test.ts`
- Modify: `src/lib/types.ts` (Preferences ~850-885, defaults ~1077-1096), `src/stores/projectsStore.migrations.ts:45,164-260`, `src/lib/speech/engine.ts`, `src/lib/speech/engine.test.ts`, `src/hooks/useSpeechEngineDefault.ts` (+ test), `src/components/DictationButton/index.tsx:47-50` (+ test), `src/components/VoiceCommand/index.tsx:196-199` (+ test), `src/lib/voice/controller.ts:175,229,638-640` (+ test), `src/components/VoiceConversation/index.tsx:29,91`, `src/components/modals/preferences/VoiceDictationSection.tsx` (+ tests), `src/components/modals/preferences/VoiceConversationSection.tsx`, `src/stores/projectsStore.migrations.test.ts`

**Interfaces:**
- Produces (types, `src/lib/types.ts`):
  ```ts
  export type CloudVoiceProviderId = 'openai' | 'elevenlabs' | 'gemini' | 'openrouter'
  export type SttProviderId = 'local' | 'apple' | CloudVoiceProviderId
  export type TtsProviderId = 'system' | 'local' | CloudVoiceProviderId
  export type VoiceUse = 'dictation' | 'conversation'
  export interface SttChoice { provider: SttProviderId; model: string; locale: string | null }
  export interface TtsChoice { provider: TtsProviderId; model: string; voice: string | null; rate: number }
  export type VoiceProviderFlags = Partial<Record<CloudVoiceProviderId, { configured: boolean; invalid: boolean }>>
  // Preferences: voiceStt: Record<VoiceUse, SttChoice>; voiceTts: TtsChoice; voiceProviders: VoiceProviderFlags
  ```
- Produces (`src/lib/voice/providers.ts`): `CLOUD_VOICE_PROVIDERS`, `STT_PROVIDERS`, `TTS_PROVIDERS`, `PARAKEET_MODEL_ID`, `APPLE_MODEL_ID`, `DEFAULT_STT_CHOICE`, `DEFAULT_TTS_CHOICE`, `isCloudProvider(id: string): id is CloudVoiceProviderId`.
- Produces (`src/lib/voice/voicePreferences.ts`): `normalizeVoicePreferences(raw)`, `withSttChoice(prefs, use, choice): Pick<Preferences,'voiceStt'>`, `withTtsChoice(prefs, patch: Partial<TtsChoice>): Pick<Preferences,'voiceTts'>`.
- Produces (`src/lib/speech/engine.ts`): `type SttEngineArgs = { provider: SttProviderId; modelId: string; locale: string | null; needsLocale: boolean; fallbackLocale: string | null }`, `sttChoiceFor(prefs: Pick<Preferences,'voiceStt'>, use: VoiceUse): SttEngineArgs`. `speechEngineArgs` is removed.
- Removed from `Preferences`: `dictationModelId`, `dictationNativeLocale`, `voiceTtsVoice`, `voiceTtsRate`.

- [ ] **Step 1: Write the failing tests**

`src/lib/voice/voicePreferences.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { DEFAULT_STT_CHOICE, DEFAULT_TTS_CHOICE } from './providers'
import { normalizeVoicePreferences, withSttChoice, withTtsChoice } from './voicePreferences'

describe('normalizeVoicePreferences', () => {
  it('gives local defaults to an empty profile', () => {
    expect(normalizeVoicePreferences(undefined)).toEqual({
      voiceStt: { dictation: DEFAULT_STT_CHOICE, conversation: DEFAULT_STT_CHOICE },
      voiceTts: DEFAULT_TTS_CHOICE,
      voiceProviders: {},
    })
  })

  it('moves a legacy Apple choice to both uses', () => {
    const result = normalizeVoicePreferences({
      dictationModelId: 'apple-speech',
      dictationNativeLocale: ' pt-BR ',
    })
    const apple = { provider: 'apple', model: 'apple-speech', locale: 'pt-BR' }
    expect(result.voiceStt).toEqual({ dictation: apple, conversation: apple })
  })

  it('moves a legacy sherpa model to both uses', () => {
    const result = normalizeVoicePreferences({ dictationModelId: 'zipformer-small-en-int8' })
    const local = { provider: 'local', model: 'zipformer-small-en-int8', locale: null }
    expect(result.voiceStt).toEqual({ dictation: local, conversation: local })
  })

  it('keeps the legacy system voice and clamps its rate', () => {
    const result = normalizeVoicePreferences({ voiceTtsVoice: 'com.apple.voice.Luciana', voiceTtsRate: 9 })
    expect(result.voiceTts).toEqual({ provider: 'system', model: '', voice: 'com.apple.voice.Luciana', rate: 2 })
  })

  it('prefers the new shape over legacy fields', () => {
    const result = normalizeVoicePreferences({
      dictationModelId: 'apple-speech',
      voiceProviders: { openai: { configured: true, invalid: false } },
      voiceStt: {
        dictation: { provider: 'openai', model: 'gpt-4o-transcribe', locale: 'x' },
        conversation: { provider: 'local', model: 'parakeet-tdt-0.6b-v3-int8', locale: null },
      },
    })
    expect(result.voiceStt.dictation).toEqual({ provider: 'openai', model: 'gpt-4o-transcribe', locale: null })
    expect(result.voiceStt.conversation.provider).toBe('local')
  })

  it('resets an unknown or unconfigured cloud provider to the local default', () => {
    const result = normalizeVoicePreferences({
      voiceStt: {
        dictation: { provider: 'openai', model: 'gpt-4o-transcribe', locale: null },
        conversation: { provider: 'mystery', model: 'x', locale: null },
      },
      voiceTts: { provider: 'elevenlabs', model: 'eleven_flash_v2_5', voice: 'abc', rate: 1 },
    })
    expect(result.voiceStt.dictation).toEqual(DEFAULT_STT_CHOICE)
    expect(result.voiceStt.conversation).toEqual(DEFAULT_STT_CHOICE)
    expect(result.voiceTts).toEqual(DEFAULT_TTS_CHOICE)
  })

  it('drops malformed provider flags', () => {
    const result = normalizeVoicePreferences({
      voiceProviders: { openai: { configured: true }, gemini: 'yes', bogus: { configured: true } },
    })
    expect(result.voiceProviders).toEqual({ openai: { configured: true, invalid: false } })
  })
})

describe('choice helpers', () => {
  const prefs = normalizeVoicePreferences(undefined)

  it('replaces one use only', () => {
    const next = withSttChoice(prefs, 'conversation', { provider: 'apple', model: 'apple-speech', locale: 'en-US' })
    expect(next.voiceStt.dictation).toEqual(DEFAULT_STT_CHOICE)
    expect(next.voiceStt.conversation.provider).toBe('apple')
  })

  it('patches the narration choice', () => {
    expect(withTtsChoice(prefs, { rate: 1.5 }).voiceTts).toEqual({ ...DEFAULT_TTS_CHOICE, rate: 1.5 })
  })
})
```

Add to `src/lib/speech/engine.test.ts` (replace the existing `speechEngineArgs` cases):

```ts
import { sttChoiceFor } from './engine'

const choice = (provider: string, model: string, locale: string | null = null) =>
  ({ provider, model, locale }) as never

describe('sttChoiceFor', () => {
  it('returns the use own choice', () => {
    const prefs = { voiceStt: { dictation: choice('local', 'zipformer-small-en-int8'), conversation: choice('openai', 'whisper-1') } }
    expect(sttChoiceFor(prefs, 'conversation')).toEqual({
      provider: 'openai', modelId: 'whisper-1', locale: null, needsLocale: false, fallbackLocale: null,
    })
  })

  it('asks for a locale when Apple has none', () => {
    const prefs = { voiceStt: { dictation: choice('apple', 'apple-speech'), conversation: choice('apple', 'apple-speech') } }
    expect(sttChoiceFor(prefs, 'dictation').needsLocale).toBe(true)
  })

  it('offers an Apple locale from either use as the fallback', () => {
    const prefs = { voiceStt: { dictation: choice('openai', 'whisper-1'), conversation: choice('apple', 'apple-speech', 'pt-BR') } }
    expect(sttChoiceFor(prefs, 'dictation').fallbackLocale).toBe('pt-BR')
  })
})
```

Add to `src/stores/projectsStore.migrations.test.ts`:

```ts
it('migrates legacy voice fields and drops them', () => {
  const preferences = normalizePreferences({
    dictationModelId: 'apple-speech',
    dictationNativeLocale: 'pt-BR',
    voiceTtsVoice: 'v1',
    voiceTtsRate: 1.5,
  } as never) as unknown as Record<string, unknown>
  expect(preferences.voiceStt).toEqual({
    dictation: { provider: 'apple', model: 'apple-speech', locale: 'pt-BR' },
    conversation: { provider: 'apple', model: 'apple-speech', locale: 'pt-BR' },
  })
  expect(preferences.voiceTts).toEqual({ provider: 'system', model: '', voice: 'v1', rate: 1.5 })
  for (const legacy of ['dictationModelId', 'dictationNativeLocale', 'voiceTtsVoice', 'voiceTtsRate']) {
    expect(preferences).not.toHaveProperty(legacy)
  }
})
```

Delete the old cases in that file that assert `dictationNativeLocale`, `voiceTtsVoice` or `voiceTtsRate` on the result (lines ~13-22, ~47-80); the new test above covers them.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/voice/voicePreferences.test.ts src/lib/speech/engine.test.ts src/stores/projectsStore.migrations.test.ts`
Expected: FAIL — `Cannot find module './providers'` / `sttChoiceFor is not exported`.

- [ ] **Step 3: Add the types and defaults**

In `src/lib/types.ts`, above `export interface Preferences`, add the type block from **Interfaces**. In `Preferences`, delete `dictationModelId`, `dictationNativeLocale`, `voiceTtsVoice`, `voiceTtsRate` with their comments and add:

```ts
  /** Speech-to-text provider per use. Device-specific; not synced. */
  voiceStt: Record<VoiceUse, SttChoice>
  /** Narration provider, voice and speed. Device-specific; not synced. */
  voiceTts: TtsChoice
  /** Mirror of which cloud keys exist in the keychain. Never holds a key. */
  voiceProviders: VoiceProviderFlags
```

In `DEFAULT_PREFERENCES`, delete the same four fields and add:

```ts
  voiceStt: {
    dictation: { provider: 'local', model: 'parakeet-tdt-0.6b-v3-int8', locale: null },
    conversation: { provider: 'local', model: 'parakeet-tdt-0.6b-v3-int8', locale: null },
  },
  voiceTts: { provider: 'system', model: '', voice: null, rate: 1 },
  voiceProviders: {},
```

- [ ] **Step 4: Write `providers.ts` and `voicePreferences.ts`**

`src/lib/voice/providers.ts`:

```ts
import type { CloudVoiceProviderId, SttChoice, SttProviderId, TtsChoice, TtsProviderId } from '../types'

export const CLOUD_VOICE_PROVIDERS: readonly CloudVoiceProviderId[] = [
  'openai',
  'elevenlabs',
  'gemini',
  'openrouter',
]
export const STT_PROVIDERS: readonly SttProviderId[] = ['local', 'apple', ...CLOUD_VOICE_PROVIDERS]
export const TTS_PROVIDERS: readonly TtsProviderId[] = ['system', 'local', ...CLOUD_VOICE_PROVIDERS]

export const PARAKEET_MODEL_ID = 'parakeet-tdt-0.6b-v3-int8'
export const APPLE_MODEL_ID = 'apple-speech'

export const DEFAULT_STT_CHOICE: SttChoice = { provider: 'local', model: PARAKEET_MODEL_ID, locale: null }
export const DEFAULT_TTS_CHOICE: TtsChoice = { provider: 'system', model: '', voice: null, rate: 1 }

export function isCloudProvider(id: string): id is CloudVoiceProviderId {
  return (CLOUD_VOICE_PROVIDERS as readonly string[]).includes(id)
}
```

`src/lib/voice/voicePreferences.ts`:

```ts
import type {
  Preferences,
  SttChoice,
  SttProviderId,
  TtsChoice,
  TtsProviderId,
  VoiceProviderFlags,
  VoiceUse,
} from '../types'
import {
  APPLE_MODEL_ID,
  CLOUD_VOICE_PROVIDERS,
  DEFAULT_STT_CHOICE,
  DEFAULT_TTS_CHOICE,
  isCloudProvider,
  STT_PROVIDERS,
  TTS_PROVIDERS,
} from './providers'

export type LegacyVoiceFields = {
  dictationModelId?: unknown
  dictationNativeLocale?: unknown
  voiceTtsVoice?: unknown
  voiceTtsRate?: unknown
  voiceStt?: unknown
  voiceTts?: unknown
  voiceProviders?: unknown
}

type VoicePreferences = Pick<Preferences, 'voiceStt' | 'voiceTts' | 'voiceProviders'>

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function clampRate(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(2, Math.max(0.5, value))
}

function normalizeProviderFlags(value: unknown): VoiceProviderFlags {
  const raw = record(value)
  const flags: VoiceProviderFlags = {}
  for (const id of CLOUD_VOICE_PROVIDERS) {
    const entry = raw[id]
    if (!entry || typeof entry !== 'object') continue
    const { configured, invalid } = entry as Record<string, unknown>
    if (typeof configured !== 'boolean') continue
    flags[id] = { configured, invalid: invalid === true }
  }
  return flags
}

function usable(provider: string, flags: VoiceProviderFlags): boolean {
  return !isCloudProvider(provider) || flags[provider]?.configured === true
}

function legacySttChoice(raw: LegacyVoiceFields): SttChoice {
  const model = text(raw.dictationModelId) ?? DEFAULT_STT_CHOICE.model
  if (model === APPLE_MODEL_ID) {
    return { provider: 'apple', model, locale: text(raw.dictationNativeLocale) }
  }
  return { provider: 'local', model, locale: null }
}

function normalizeSttChoice(value: unknown, fallback: SttChoice, flags: VoiceProviderFlags): SttChoice {
  if (!value || typeof value !== 'object') return fallback
  const { provider, model, locale } = value as Record<string, unknown>
  if (typeof provider !== 'string' || !(STT_PROVIDERS as readonly string[]).includes(provider)) {
    return DEFAULT_STT_CHOICE
  }
  if (!usable(provider, flags)) return DEFAULT_STT_CHOICE
  if (provider === 'apple') return { provider, model: APPLE_MODEL_ID, locale: text(locale) }
  const id = text(model)
  return id ? { provider: provider as SttProviderId, model: id, locale: null } : DEFAULT_STT_CHOICE
}

function normalizeTtsChoice(value: unknown, fallback: TtsChoice, flags: VoiceProviderFlags): TtsChoice {
  if (!value || typeof value !== 'object') return fallback
  const { provider, model, voice, rate } = value as Record<string, unknown>
  if (typeof provider !== 'string' || !(TTS_PROVIDERS as readonly string[]).includes(provider)) {
    return DEFAULT_TTS_CHOICE
  }
  if (!usable(provider, flags)) return DEFAULT_TTS_CHOICE
  const id = text(model) ?? ''
  if (provider !== 'system' && !id) return DEFAULT_TTS_CHOICE
  return {
    provider: provider as TtsProviderId,
    model: provider === 'system' ? '' : id,
    voice: text(voice),
    rate: clampRate(rate, DEFAULT_TTS_CHOICE.rate),
  }
}

/** Reads the current shape, or builds it from the pre-provider fields of an older profile. */
export function normalizeVoicePreferences(raw: LegacyVoiceFields | undefined): VoicePreferences {
  const source = raw ?? {}
  const voiceProviders = normalizeProviderFlags(source.voiceProviders)
  const legacyStt = legacySttChoice(source)
  const stt = record(source.voiceStt)
  const legacyTts: TtsChoice = {
    ...DEFAULT_TTS_CHOICE,
    voice: text(source.voiceTtsVoice),
    rate: clampRate(source.voiceTtsRate, DEFAULT_TTS_CHOICE.rate),
  }
  return {
    voiceStt: {
      dictation: normalizeSttChoice(stt.dictation, legacyStt, voiceProviders),
      conversation: normalizeSttChoice(stt.conversation, legacyStt, voiceProviders),
    },
    voiceTts: normalizeTtsChoice(source.voiceTts, legacyTts, voiceProviders),
    voiceProviders,
  }
}

export function withSttChoice(
  prefs: Pick<Preferences, 'voiceStt'>,
  use: VoiceUse,
  choice: SttChoice,
): Pick<Preferences, 'voiceStt'> {
  return { voiceStt: { ...prefs.voiceStt, [use]: choice } }
}

export function withTtsChoice(
  prefs: Pick<Preferences, 'voiceTts'>,
  patch: Partial<TtsChoice>,
): Pick<Preferences, 'voiceTts'> {
  return { voiceTts: { ...prefs.voiceTts, ...patch } }
}
```

- [ ] **Step 5: Wire it into `normalizePreferences`**

In `src/stores/projectsStore.migrations.ts`:

```ts
import { type LegacyVoiceFields, normalizeVoicePreferences } from '../lib/voice/voicePreferences'

type LegacyPreferences = Partial<Preferences> & { showGitControl?: boolean } & LegacyVoiceFields
```

Right after `delete preferences.showGitControl` add:

```ts
  // Pre-provider voice fields; their values move into voiceStt / voiceTts below.
  for (const legacy of ['dictationModelId', 'dictationNativeLocale', 'voiceTtsVoice', 'voiceTtsRate']) {
    delete (preferences as Record<string, unknown>)[legacy]
  }
```

In the returned object, delete the `dictationModelId`, `dictationNativeLocale`, `voiceTtsVoice` and `voiceTtsRate` entries and add `...normalizeVoicePreferences(raw),` after `speechEngineMigrated`.

- [ ] **Step 6: Replace `speechEngineArgs` with `sttChoiceFor`**

`src/lib/speech/engine.ts` becomes:

```ts
import type { Preferences, SttProviderId, VoiceUse } from '../types'
import { APPLE_MODEL_ID, PARAKEET_MODEL_ID } from '../voice/providers'

export { PARAKEET_MODEL_ID }

export type SttEngineArgs = {
  provider: SttProviderId
  modelId: string
  locale: string | null
  needsLocale: boolean
  /** An Apple locale set on any use, so a failed cloud call can fall back to Apple Speech. */
  fallbackLocale: string | null
}

/** What every speech consumer passes to the speech commands for one use. */
export function sttChoiceFor(prefs: Pick<Preferences, 'voiceStt'>, use: VoiceUse): SttEngineArgs {
  const choice = prefs.voiceStt[use]
  const fallbackLocale =
    [choice, prefs.voiceStt.dictation, prefs.voiceStt.conversation].find(
      (candidate) => candidate.provider === 'apple' && candidate.locale,
    )?.locale ?? null
  if (choice.provider !== 'apple') {
    return { provider: choice.provider, modelId: choice.model, locale: null, needsLocale: false, fallbackLocale }
  }
  return {
    provider: 'apple',
    modelId: APPLE_MODEL_ID,
    locale: choice.locale,
    needsLocale: choice.locale === null,
    fallbackLocale,
  }
}

/** Spec §5.3: move an untouched default to the Apple engine once, never a real choice. */
export function shouldSwitchToNative(input: {
  migrated: boolean
  modelId: string
  nativeAvailable: boolean
  parakeetReady: boolean
}): boolean {
  return (
    !input.migrated &&
    input.nativeAvailable &&
    input.modelId === PARAKEET_MODEL_ID &&
    !input.parakeetReady
  )
}
```

- [ ] **Step 7: Update consumers**

`src/hooks/useSpeechEngineDefault.ts` — replace the `modelId:` line and the `setPreferences` call:

```ts
          modelId: current.voiceStt.dictation.model,
```

```ts
        const toNative = (choice: SttChoice): SttChoice =>
          choice.provider === 'local' && choice.model === PARAKEET_MODEL_ID
            ? { provider: 'apple', model: APPLE_SPEECH_MODEL_ID, locale: choice.locale }
            : choice
        useProjectsStore.getState().setPreferences(
          switchToNative
            ? {
                voiceStt: {
                  dictation: toNative(current.voiceStt.dictation),
                  conversation: toNative(current.voiceStt.conversation),
                },
                speechEngineMigrated: true,
              }
            : { speechEngineMigrated: true },
        )
```

(add `import type { SttChoice } from '../lib/types'`).

`src/components/DictationButton/index.tsx:47-50`:

```ts
  const voiceStt = useProjectsStore((s) => s.preferences.voiceStt)
  const engine = useMemo(() => sttChoiceFor({ voiceStt }, 'dictation'), [voiceStt])
```

`src/components/VoiceCommand/index.tsx:196-199` — same, with `'conversation'` (the Jev bar uses the conversation choice).

`src/lib/voice/controller.ts`: lines 175 and 229 → `sttChoiceFor(p, 'conversation')` / `sttChoiceFor(prefs(), 'conversation')`; line 638 → `const rate = prefs().voiceTts.rate`; line 640 → `ttsSpeak(text, prefs().voiceTts.voice, rate)`. Update the import from `speechEngineArgs` to `sttChoiceFor`.

`src/components/VoiceConversation/index.tsx`: line 29 → `useProjectsStore((s) => s.preferences.voiceTts.rate)`; line 91 →

```ts
      const store = useProjectsStore.getState()
      store.setPreferences(withTtsChoice(store.preferences, { rate: action.rate }))
```

`VoiceDictationSection.tsx`: `nativeLocale` reads `preferences.voiceStt.dictation.locale`; `modelId` reads `preferences.voiceStt.dictation.model`. Until Task 9 replaces this dropdown, one pick still sets **both** uses (today's behaviour). Add inside the component:

```ts
  const setBothUses = (choice: SttChoice) =>
    setPreferences({ voiceStt: { dictation: choice, conversation: choice } })
  const choiceFor = (id: string, locale: string | null): SttChoice =>
    id === APPLE_SPEECH_MODEL_ID
      ? { provider: 'apple', model: id, locale }
      : { provider: 'local', model: id, locale: null }
```

and replace `setPreferences({ dictationModelId: X })` with `setBothUses(choiceFor(X, nativeLocale))`, and `setPreferences({ dictationNativeLocale: value || null })` with `setBothUses(choiceFor(APPLE_SPEECH_MODEL_ID, value || null))`. Remove the `DEFAULT_SPEECH_MODEL_ID` import.

`VoiceConversationSection.tsx`: the voice Dropdown reads `preferences.voiceTts.voice ?? ''` and writes `setPreferences(withTtsChoice(preferences, { voice: value || null }))`; the rate buttons read `preferences.voiceTts.rate` and write `withTtsChoice(preferences, { rate })`.

- [ ] **Step 8: Update test fixtures**

In `DictationButton.test.tsx`, `VoiceCommand.test.tsx`, `controller.test.ts`, `useSpeechEngineDefault.test.ts`, `VoiceDictationSection.test.tsx`, `VoiceDictationSection.locale.test.tsx`: replace every preferences fixture of the form

```ts
{ dictationModelId: 'apple-speech', dictationNativeLocale: 'pt-BR' }
```

with

```ts
{
  voiceStt: {
    dictation: { provider: 'apple', model: 'apple-speech', locale: 'pt-BR' },
    conversation: { provider: 'apple', model: 'apple-speech', locale: 'pt-BR' },
  },
}
```

(and `{ provider: 'local', model: '<id>', locale: null }` for sherpa ids), every assertion on `prefs().dictationModelId` with `prefs().voiceStt.dictation.model`, `dictationNativeLocale` with `voiceStt.dictation.locale`, `voiceTtsRate` with `voiceTts.rate`, `voiceTtsVoice` with `voiceTts.voice`. Run `grep -rn "dictationModelId\|dictationNativeLocale\|voiceTtsVoice\|voiceTtsRate\|speechEngineArgs" src` — only `voicePreferences.ts`, its test, the migrations file/test and locale-free comments may remain.

- [ ] **Step 9: Run the checks**

Run: `npx tsc --noEmit -p . && npx vitest run src/lib src/hooks src/stores src/components/DictationButton src/components/VoiceCommand src/components/modals/preferences`
Expected: PASS, no type errors.

- [ ] **Step 10: Checkpoint**

Show `git status --short`. Ask the owner whether to commit. If yes: `git commit -m "refactor(voice): move speech choices to per-use provider preferences"` (no co-author line).

---

### Task 2: Voice page shell

**Files:**
- Create: `src/components/modals/preferences/voice/VoicePage.tsx`, `VoicePage.module.css`, `UsageTabs.tsx`, `UsageTabs.module.css`, `VoicePage.test.tsx`
- Modify: `src/components/modals/PreferencesModal.tsx:2-18,41-52,83-147,357-378,586-601`, `src/components/modals/preferences/IntegrationsPage.tsx:16-17,177-178`, `src/components/modals/preferences/VoiceConversationSection.tsx`, locale files

**Interfaces:**
- Consumes: Task 1 preferences.
- Produces: `export type VoiceTab = 'dictation' | 'conversation' | 'narration'`; `VoicePage({ target }: { target: string | null })`; `UsageTabs({ value, onChange }: { value: VoiceTab; onChange: (tab: VoiceTab) => void })`; `tabForTarget(target: string | null): VoiceTab | null`; `VoiceConversationSection({ part }: { part: 'conversation' | 'narration' })`. Later tasks add children under each tab and a providers section below via `VoicePage`.

- [ ] **Step 1: Write the failing test**

`src/components/modals/preferences/voice/VoicePage.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { tabForTarget, VoicePage } from './VoicePage'

vi.mock('../VoiceDictationSection', () => ({ VoiceDictationSection: () => <div>dictation-body</div> }))
vi.mock('../VoiceConversationSection', () => ({
  VoiceConversationSection: ({ part }: { part: string }) => <div>{`${part}-body`}</div>,
}))
vi.mock('../../../../lib/i18n', () => ({ useT: () => (key: string) => key }))

afterEach(cleanup)

describe('VoicePage', () => {
  it('opens on dictation and switches tabs', () => {
    render(<VoicePage target={null} />)
    expect(screen.getByText('dictation-body')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'prefs.voiceTabNarration' }))
    expect(screen.getByText('narration-body')).toBeTruthy()
    expect(screen.queryByText('dictation-body')).toBeNull()
  })

  it('opens the tab that holds a search target', () => {
    render(<VoicePage target="voice-conversation-voice" />)
    expect(screen.getByText('narration-body')).toBeTruthy()
  })

  it('maps search targets to tabs', () => {
    expect(tabForTarget('dictation-mic')).toBe('dictation')
    expect(tabForTarget('voice-conversation')).toBe('conversation')
    expect(tabForTarget('voice-conversation-voice')).toBe('narration')
    expect(tabForTarget('voice-providers')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/modals/preferences/voice/VoicePage.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Split `VoiceConversationSection` by part**

Change the signature to `export function VoiceConversationSection({ part }: { part: 'conversation' | 'narration' })`. Wrap the `voice-conversation-voice` `SettingsSection` in `{part === 'narration' ? (...) : null}` and every other section in `{part === 'conversation' ? (<>...</>) : null}`. In the narration part, drop `disabled={!enabled}` from the voice dropdown and rate buttons (narration settings are editable before conversation is turned on), and load voices when `part === 'narration'` instead of only when `enabled`:

```ts
  useEffect(() => {
    if (part !== 'narration' && !enabled) return
```

- [ ] **Step 4: Write `UsageTabs` and `VoicePage`**

`UsageTabs.tsx`:

```tsx
import { useT } from '../../../../lib/i18n'
import type { MessageKey } from '../../../../lib/i18n/messages/en'
import styles from './UsageTabs.module.css'

export type VoiceTab = 'dictation' | 'conversation' | 'narration'

const TABS: { id: VoiceTab; label: MessageKey; hint: MessageKey }[] = [
  { id: 'dictation', label: 'prefs.voiceTabDictation', hint: 'prefs.voiceTabDictationHint' },
  { id: 'conversation', label: 'prefs.voiceTabConversation', hint: 'prefs.voiceTabConversationHint' },
  { id: 'narration', label: 'prefs.voiceTabNarration', hint: 'prefs.voiceTabNarrationHint' },
]

export function UsageTabs({ value, onChange }: { value: VoiceTab; onChange: (tab: VoiceTab) => void }) {
  const t = useT()
  return (
    <div className={styles.tabs} role="tablist" aria-label={t('prefs.voiceTabsLabel')}>
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          title={t(tab.hint)}
          className={value === tab.id ? styles.tabActive : styles.tab}
          onClick={() => onChange(tab.id)}
        >
          {t(tab.label)}
        </button>
      ))}
    </div>
  )
}
```

`UsageTabs.module.css`:

```css
.tabs {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-sunken);
}

.tab,
.tabActive {
  padding: 6px 14px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
  background: transparent;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background-color var(--anim-fast) var(--ease-out-fluid),
    color var(--anim-fast) var(--ease-out-fluid);
}

.tab:hover {
  color: var(--fg);
  background: var(--panel-hover);
}

.tabActive {
  border-color: var(--border);
  color: var(--fg);
  background: var(--surface-card-default);
  box-shadow: var(--shadow-sm);
}
```

`VoicePage.tsx`:

```tsx
import { useLayoutEffect, useState } from 'react'

import { useT } from '../../../../lib/i18n'
import { VoiceConversationSection } from '../VoiceConversationSection'
import { VoiceDictationSection } from '../VoiceDictationSection'
import { UsageTabs, type VoiceTab } from './UsageTabs'
import styles from './VoicePage.module.css'

/** The tab a preferences-search target lives in; null for targets outside the tabs. */
export function tabForTarget(target: string | null): VoiceTab | null {
  if (!target) return null
  if (target.startsWith('dictation')) return 'dictation'
  if (target === 'voice-conversation-voice') return 'narration'
  if (target.startsWith('voice-conversation')) return 'conversation'
  return null
}

export function VoicePage({ target }: { target: string | null }) {
  const t = useT()
  const [tab, setTab] = useState<VoiceTab>(() => tabForTarget(target) ?? 'dictation')

  // Layout effect: the modal scrolls to the target on the next frame, after this re-render.
  useLayoutEffect(() => {
    const next = tabForTarget(target)
    if (next) setTab(next)
  }, [target])

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>{t('prefs.categoryVoice')}</h1>
        <p>{t('prefs.categoryVoiceDesc')}</p>
      </header>
      <UsageTabs value={tab} onChange={setTab} />
      <div className={styles.tabBody} role="tabpanel">
        {tab === 'dictation' ? <VoiceDictationSection /> : null}
        {tab === 'conversation' ? <VoiceConversationSection part="conversation" /> : null}
        {tab === 'narration' ? <VoiceConversationSection part="narration" /> : null}
      </div>
    </div>
  )
}
```

`VoicePage.module.css`:

```css
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.header h1 {
  margin: 0;
  color: var(--fg);
  font-size: 18px;
  font-weight: 650;
}

.header p {
  max-width: 560px;
  margin: 4px 0 0;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.5;
}

.tabBody {
  display: flex;
  flex-direction: column;
}
```

- [ ] **Step 5: Register the category and move the sections**

`PreferencesModal.tsx`: add `Mic` to the `lucide-react` import; add `| 'voice'` to `CategoryId`; insert after the `integrations` category:

```ts
      {
        id: 'voice',
        label: t('prefs.categoryVoice'),
        description: t('prefs.categoryVoiceDesc'),
        Icon: Mic,
      },
```

Change the `dictation` and `voice-conversation` search items to `category: 'voice'`, and add:

```ts
      {
        category: 'voice',
        target: 'voice-conversation-voice',
        label: t('prefs.voiceConvVoice'),
        description: t('prefs.voiceConvVoiceDesc'),
        keywords: 'narration tts voice speed rate narração voz velocidade 旁白 语音 语速',
      },
```

Render: `{category === 'voice' ? <VoicePage target={pendingTarget} /> : null}` (import from `./preferences/voice/VoicePage`).

`IntegrationsPage.tsx`: delete the two imports and the `<VoiceDictationSection />` / `<VoiceConversationSection />` lines.

- [ ] **Step 6: Add i18n keys**

Add to `en.ts` (next to `prefs.categoryIntegrations*`) and translate in `pt-BR.ts` / `zh-CN.ts`:

| key | en | pt-BR | zh-CN |
|---|---|---|---|
| `prefs.categoryVoice` | Voice | Voz | 语音 |
| `prefs.categoryVoiceDesc` | Choose who listens and who speaks for each voice feature: models on this device or a cloud API with your own key. | Escolha quem ouve e quem fala em cada recurso de voz: modelos neste dispositivo ou uma API de nuvem com sua própria chave. | 为每个语音功能选择由谁聆听、由谁朗读：本设备上的模型，或使用你自己密钥的云端 API。 |
| `prefs.voiceTabsLabel` | Voice uses | Usos de voz | 语音用途 |
| `prefs.voiceTabDictation` | Dictation | Ditado | 听写 |
| `prefs.voiceTabDictationHint` | Speech to text into the active terminal | Fala para texto no terminal ativo | 语音转文字，输入到当前终端 |
| `prefs.voiceTabConversation` | Conversation | Conversa | 对话 |
| `prefs.voiceTabConversationHint` | Speech to text when talking to an agent | Fala para texto ao conversar com um agente | 与智能体对话时的语音转文字 |
| `prefs.voiceTabNarration` | Narration | Narração | 旁白 |
| `prefs.voiceTabNarrationHint` | Text to speech for agent replies | Texto para fala nas respostas do agente | 将智能体回复转为语音 |

- [ ] **Step 7: Run the checks**

Run: `npx vitest run src/components/modals && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 8: Checkpoint**

Show `git status --short`; ask; on yes: `git commit -m "feat(preferences): add a Voice page with dictation, conversation and narration tabs"`.


## Phase 2 — Providers, keys and the provider grid

### Task 3: Cloud provider ids, keychain keys and curated catalog (Rust)

**Files:**
- Create: `src-tauri/src/voice_providers/mod.rs`, `src-tauri/src/voice_providers/keys.rs`, `src-tauri/src/voice_providers/catalog.rs`
- Modify: `src-tauri/src/secure_store.rs:6-21` (+ tests), `src-tauri/src/lib.rs` (mod list ~73-86, `invoke_handler` ~555-569)

**Interfaces:**
- Produces (`voice_providers/mod.rs`):
  ```rust
  #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
  #[serde(rename_all = "lowercase")]
  pub enum CloudProvider { Openai, Elevenlabs, Gemini, Openrouter }
  impl CloudProvider { pub const ALL: [CloudProvider; 4]; pub fn id(self) -> &'static str }
  ```
- Produces (`keys.rs`): `pub(crate) fn read_key(app: &AppHandle, provider: CloudProvider) -> Result<Option<String>, String>`; commands `voice_provider_set_key(provider, key)`, `voice_provider_delete_key(provider)`, `voice_providers_status() -> Vec<ProviderStatus { provider, configured }>`.
- Produces (`catalog.rs`): `pub fn provider_catalog(provider) -> &'static ProviderCatalog`; `pub fn default_model(provider, capability: &str) -> Option<&'static str>`; command `voice_provider_catalog() -> Vec<&'static ProviderCatalog>`. `ProviderCatalog { provider, key_url, models: &[CatalogModel { id, label, capability: "stt" | "tts" }], voices: &[CatalogVoice { id, label }] }` serialized camelCase.
- `SecretKind::VoiceProviderKey(CloudProvider)` with suffix `voice-key-<id>`.

- [ ] **Step 1: Write the failing tests**

Append to `secure_store.rs` tests:

```rust
    #[test]
    fn voice_provider_keys_have_distinct_stable_accounts() {
        use crate::voice_providers::CloudProvider;
        let accounts: Vec<String> = CloudProvider::ALL
            .iter()
            .map(|provider| account("p", SecretKind::VoiceProviderKey(*provider)))
            .collect();
        assert_eq!(accounts[0], "profile:p:voice-key-openai");
        assert_eq!(accounts[3], "profile:p:voice-key-openrouter");
        let unique: std::collections::HashSet<_> = accounts.iter().collect();
        assert_eq!(unique.len(), 4);
    }
```

`keys.rs` tests (at the bottom of the new file):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_store::SecureStoreError;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryStore(RefCell<HashMap<(String, SecretKind), String>>);

    impl SecretStore for MemoryStore {
        fn get(&self, profile: &str, kind: SecretKind) -> Result<Option<String>, SecureStoreError> {
            Ok(self.0.borrow().get(&(profile.to_string(), kind)).cloned())
        }
        fn set(&self, profile: &str, kind: SecretKind, value: &str) -> Result<(), SecureStoreError> {
            self.0.borrow_mut().insert((profile.to_string(), kind), value.to_string());
            Ok(())
        }
        fn delete(&self, profile: &str, kind: SecretKind) -> Result<(), SecureStoreError> {
            self.0.borrow_mut().remove(&(profile.to_string(), kind));
            Ok(())
        }
    }

    #[test]
    fn keys_are_trimmed_and_rejected_when_malformed() {
        assert_eq!(validate_key("  sk-abc  ").unwrap(), "sk-abc");
        assert!(validate_key("   ").is_err());
        assert!(validate_key("sk abc").is_err());
        assert!(validate_key(&"x".repeat(513)).is_err());
    }

    #[test]
    fn status_reports_only_the_profile_own_keys() {
        let store = MemoryStore::default();
        store.set("a", SecretKind::VoiceProviderKey(CloudProvider::Gemini), "k").unwrap();
        let a = statuses(&store, "a").unwrap();
        let b = statuses(&store, "b").unwrap();
        assert!(a.iter().any(|s| s.provider == CloudProvider::Gemini && s.configured));
        assert!(b.iter().all(|s| !s.configured));
        assert_eq!(a.len(), 4);
    }

    #[test]
    fn errors_never_echo_the_key() {
        let error = validate_key("bad key with spaces").unwrap_err();
        assert!(!error.contains("bad key"));
    }
}
```

`catalog.rs` tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_has_a_default_stt_and_tts_model() {
        for provider in CloudProvider::ALL {
            assert!(default_model(provider, "stt").is_some(), "{provider:?} stt");
            assert!(default_model(provider, "tts").is_some(), "{provider:?} tts");
            assert!(provider_catalog(provider).key_url.starts_with("https://"));
        }
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib voice_provider secure_store`
Expected: compile error — `voice_providers` not found.

- [ ] **Step 3: Implement**

`voice_providers/mod.rs`:

```rust
//! Cloud speech providers. Keys stay in the OS keychain and every request is built here, in
//! Rust, so the webview never sees a key and the CSP needs no new `connect-src` entries.

pub mod catalog;
pub mod keys;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudProvider {
    Openai,
    Elevenlabs,
    Gemini,
    Openrouter,
}

impl CloudProvider {
    pub const ALL: [CloudProvider; 4] = [
        CloudProvider::Openai,
        CloudProvider::Elevenlabs,
        CloudProvider::Gemini,
        CloudProvider::Openrouter,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Elevenlabs => "elevenlabs",
            Self::Gemini => "gemini",
            Self::Openrouter => "openrouter",
        }
    }
}
```

`secure_store.rs` — add the variant and suffixes:

```rust
    VoiceProviderKey(crate::voice_providers::CloudProvider),
```

```rust
            Self::VoiceProviderKey(provider) => match provider {
                crate::voice_providers::CloudProvider::Openai => "voice-key-openai",
                crate::voice_providers::CloudProvider::Elevenlabs => "voice-key-elevenlabs",
                crate::voice_providers::CloudProvider::Gemini => "voice-key-gemini",
                crate::voice_providers::CloudProvider::Openrouter => "voice-key-openrouter",
            },
```

`keys.rs`:

```rust
use serde::Serialize;
use tauri::AppHandle;

use super::CloudProvider;
use crate::secure_store::{OsSecretStore, SecretKind, SecretStore};

const MAX_KEY_LEN: usize = 512;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: CloudProvider,
    pub configured: bool,
}

fn active_profile_id(app: &AppHandle) -> Result<String, String> {
    Ok(crate::profiles::ensure_profiles_index(app)?.active_profile_id)
}

/// Trimmed key, or a fixed error code; the message never repeats the input.
pub(crate) fn validate_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    if key.is_empty()
        || key.len() > MAX_KEY_LEN
        || key.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("voice_key_invalid_format".into());
    }
    Ok(key.to_string())
}

pub(crate) fn statuses(store: &impl SecretStore, profile: &str) -> Result<Vec<ProviderStatus>, String> {
    CloudProvider::ALL
        .iter()
        .map(|provider| {
            let configured = store
                .get(profile, SecretKind::VoiceProviderKey(*provider))
                .map_err(|e| e.to_string())?
                .is_some();
            Ok(ProviderStatus { provider: *provider, configured })
        })
        .collect()
}

pub(crate) fn read_key(app: &AppHandle, provider: CloudProvider) -> Result<Option<String>, String> {
    let profile = active_profile_id(app)?;
    OsSecretStore
        .get(&profile, SecretKind::VoiceProviderKey(provider))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn voice_provider_set_key(app: AppHandle, provider: CloudProvider, key: String) -> Result<(), String> {
    let key = validate_key(&key)?;
    let profile = active_profile_id(&app)?;
    OsSecretStore
        .set(&profile, SecretKind::VoiceProviderKey(provider), &key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn voice_provider_delete_key(app: AppHandle, provider: CloudProvider) -> Result<(), String> {
    let profile = active_profile_id(&app)?;
    OsSecretStore
        .delete(&profile, SecretKind::VoiceProviderKey(provider))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn voice_providers_status(app: AppHandle) -> Result<Vec<ProviderStatus>, String> {
    statuses(&OsSecretStore, &active_profile_id(&app)?)
}
```

`catalog.rs`:

```rust
use serde::Serialize;

use super::CloudProvider;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: &'static str,
    pub label: &'static str,
    /// `stt` or `tts`.
    pub capability: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogVoice {
    pub id: &'static str,
    pub label: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalog {
    pub provider: CloudProvider,
    pub key_url: &'static str,
    pub models: &'static [CatalogModel],
    /// Empty when the voices come from the account (ElevenLabs).
    pub voices: &'static [CatalogVoice],
}

const fn m(id: &'static str, label: &'static str, capability: &'static str) -> CatalogModel {
    CatalogModel { id, label, capability }
}

const fn v(id: &'static str, label: &'static str) -> CatalogVoice {
    CatalogVoice { id, label }
}

const OPENAI_VOICES: &[CatalogVoice] = &[
    v("alloy", "Alloy"), v("ash", "Ash"), v("ballad", "Ballad"), v("coral", "Coral"),
    v("echo", "Echo"), v("fable", "Fable"), v("nova", "Nova"), v("onyx", "Onyx"),
    v("sage", "Sage"), v("shimmer", "Shimmer"), v("verse", "Verse"),
];

const GEMINI_VOICES: &[CatalogVoice] = &[
    v("Kore", "Kore"), v("Puck", "Puck"), v("Charon", "Charon"), v("Fenrir", "Fenrir"),
    v("Aoede", "Aoede"), v("Leda", "Leda"), v("Orus", "Orus"), v("Zephyr", "Zephyr"),
];

static CATALOG: [ProviderCatalog; 4] = [
    ProviderCatalog {
        provider: CloudProvider::Openai,
        key_url: "https://platform.openai.com/api-keys",
        models: &[
            m("gpt-4o-transcribe", "GPT-4o Transcribe", "stt"),
            m("gpt-4o-mini-transcribe", "GPT-4o mini Transcribe", "stt"),
            m("whisper-1", "Whisper", "stt"),
            m("gpt-4o-mini-tts", "GPT-4o mini TTS", "tts"),
            m("tts-1", "TTS-1", "tts"),
        ],
        voices: OPENAI_VOICES,
    },
    ProviderCatalog {
        provider: CloudProvider::Elevenlabs,
        key_url: "https://elevenlabs.io/app/settings/api-keys",
        models: &[
            m("scribe_v2", "Scribe v2", "stt"),
            m("eleven_multilingual_v2", "Multilingual v2", "tts"),
            m("eleven_flash_v2_5", "Flash v2.5", "tts"),
        ],
        voices: &[],
    },
    ProviderCatalog {
        provider: CloudProvider::Gemini,
        key_url: "https://aistudio.google.com/apikey",
        models: &[
            m("gemini-2.5-flash", "Gemini 2.5 Flash", "stt"),
            m("gemini-2.5-flash-preview-tts", "Gemini 2.5 Flash TTS", "tts"),
            m("gemini-3.1-flash-tts-preview", "Gemini 3.1 Flash TTS", "tts"),
        ],
        voices: GEMINI_VOICES,
    },
    ProviderCatalog {
        provider: CloudProvider::Openrouter,
        key_url: "https://openrouter.ai/settings/keys",
        models: &[
            m("openai/gpt-4o-mini-transcribe", "OpenAI GPT-4o mini Transcribe", "stt"),
            m("openai/whisper-1", "OpenAI Whisper", "stt"),
            m("openai/gpt-4o-mini-tts-2025-12-15", "OpenAI GPT-4o mini TTS", "tts"),
        ],
        voices: OPENAI_VOICES,
    },
];

pub fn provider_catalog(provider: CloudProvider) -> &'static ProviderCatalog {
    CATALOG
        .iter()
        .find(|entry| entry.provider == provider)
        .expect("every provider has a catalog entry")
}

pub fn default_model(provider: CloudProvider, capability: &str) -> Option<&'static str> {
    provider_catalog(provider)
        .models
        .iter()
        .find(|model| model.capability == capability)
        .map(|model| model.id)
}

#[tauri::command]
pub fn voice_provider_catalog() -> Vec<&'static ProviderCatalog> {
    CATALOG.iter().collect()
}
```

`lib.rs`: add `mod voice_providers;` beside `mod tts;`, and in `invoke_handler` after `tts::tts_voices,`:

```rust
            voice_providers::keys::voice_provider_set_key,
            voice_providers::keys::voice_provider_delete_key,
            voice_providers::keys::voice_providers_status,
            voice_providers::catalog::voice_provider_catalog,
```

- [ ] **Step 4: Verify the curated model ids**

Open https://platform.openai.com/docs/guides/speech-to-text, https://elevenlabs.io/docs/api-reference/speech-to-text/convert, https://ai.google.dev/gemini-api/docs/speech-generation and https://openrouter.ai/models?output_modalities=speech. Remove from `CATALOG` any id the page no longer lists (do not invent replacements; keep at least one `stt` and one `tts` per provider — if a provider loses all of one capability, stop and ask the owner).

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && cargo test --lib voice_provider secure_store && cargo clippy --lib -- -D warnings`
Expected: PASS, no warnings.

- [ ] **Step 6: Checkpoint**

Show `git status --short`; ask; on yes: `git commit -m "feat(voice): store cloud voice provider keys in the OS keychain"`.

---

### Task 4: HTTP layer, error classes and "Test connection" (Rust)

**Files:**
- Create: `src-tauri/src/voice_providers/http.rs`
- Modify: `src-tauri/src/voice_providers/mod.rs`, `src-tauri/src/voice_providers/keys.rs`, `src-tauri/Cargo.toml:54`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `CloudProvider`, `read_key` (Task 3).
- Produces (`http.rs`):
  ```rust
  #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)] #[serde(rename_all = "camelCase")]
  pub enum CloudErrorKind { Network, Auth, Quota, BadAudio, Timeout, Other }
  #[derive(Clone, Debug, PartialEq, Eq)] pub struct CloudError { pub kind: CloudErrorKind, pub status: Option<u16> }
  pub fn classify_status(status: u16, audio_request: bool) -> CloudErrorKind
  pub enum HttpMethod { Get, Post }
  pub enum FormPart { Text { name: &'static str, value: String }, File { name: &'static str, filename: &'static str, mime: &'static str, bytes: Vec<u8> } }
  pub enum HttpBody { Empty, Json(serde_json::Value), Multipart(Vec<FormPart>) }
  pub struct HttpRequest { pub method: HttpMethod, pub url: String, pub headers: Vec<(&'static str, String)>, pub body: HttpBody, pub audio: bool }
  pub async fn send(request: HttpRequest, timeout: Duration) -> Result<Vec<u8>, CloudError>
  pub fn auth_headers(provider: CloudProvider, key: &str) -> Vec<(&'static str, String)>
  pub fn test_request(provider: CloudProvider, key: &str) -> HttpRequest
  ```
- `CloudError` displays as `voice_cloud_<kind>` plus ` (HTTP <status>)` when known — no body, no key.
- Command `voice_provider_test(provider) -> VoiceTestResult { ok: bool, reason: Option<CloudErrorKind> }`.

- [ ] **Step 1: Write the failing tests** (bottom of `http.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_to_error_classes() {
        assert_eq!(classify_status(401, false), CloudErrorKind::Auth);
        assert_eq!(classify_status(403, true), CloudErrorKind::Auth);
        assert_eq!(classify_status(429, false), CloudErrorKind::Quota);
        assert_eq!(classify_status(402, false), CloudErrorKind::Quota);
        assert_eq!(classify_status(400, true), CloudErrorKind::BadAudio);
        assert_eq!(classify_status(400, false), CloudErrorKind::Other);
        assert_eq!(classify_status(504, false), CloudErrorKind::Timeout);
        assert_eq!(classify_status(500, true), CloudErrorKind::Other);
    }

    #[test]
    fn error_text_carries_class_and_status_only() {
        let error = CloudError { kind: CloudErrorKind::Auth, status: Some(401) };
        assert_eq!(error.to_string(), "voice_cloud_auth (HTTP 401)");
        let network = CloudError { kind: CloudErrorKind::Network, status: None };
        assert_eq!(network.to_string(), "voice_cloud_network");
    }

    #[test]
    fn each_provider_authenticates_its_own_way() {
        assert_eq!(auth_headers(CloudProvider::Openai, "k")[0], ("Authorization", "Bearer k".into()));
        assert_eq!(auth_headers(CloudProvider::Elevenlabs, "k")[0], ("xi-api-key", "k".into()));
        assert_eq!(auth_headers(CloudProvider::Gemini, "k")[0], ("x-goog-api-key", "k".into()));
        assert_eq!(auth_headers(CloudProvider::Openrouter, "k")[0], ("Authorization", "Bearer k".into()));
    }

    #[test]
    fn test_requests_hit_a_cheap_authenticated_endpoint() {
        let urls: Vec<String> = CloudProvider::ALL.iter().map(|p| test_request(*p, "k").url).collect();
        assert_eq!(urls, vec![
            "https://api.openai.com/v1/models",
            "https://api.elevenlabs.io/v1/models",
            "https://generativelanguage.googleapis.com/v1beta/models",
            "https://openrouter.ai/api/v1/key",
        ]);
        assert!(CloudProvider::ALL.iter().all(|p| matches!(test_request(*p, "k").method, HttpMethod::Get)));
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib voice_providers::http`
Expected: compile error — module `http` not found.

- [ ] **Step 3: Implement**

`Cargo.toml:54`: `reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls", "stream", "multipart"] }`.

`mod.rs`: add `pub mod http;`.

`http.rs`:

```rust
use std::fmt;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;

use super::CloudProvider;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CloudErrorKind {
    Network,
    Auth,
    Quota,
    BadAudio,
    Timeout,
    Other,
}

impl CloudErrorKind {
    fn code(self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::Auth => "auth",
            Self::Quota => "quota",
            Self::BadAudio => "badAudio",
            Self::Timeout => "timeout",
            Self::Other => "other",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudError {
    pub kind: CloudErrorKind,
    pub status: Option<u16>,
}

impl CloudError {
    pub fn of(kind: CloudErrorKind) -> Self {
        Self { kind, status: None }
    }
}

impl fmt::Display for CloudError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.status {
            Some(status) => write!(f, "voice_cloud_{} (HTTP {status})", self.kind.code()),
            None => write!(f, "voice_cloud_{}", self.kind.code()),
        }
    }
}

pub fn classify_status(status: u16, audio_request: bool) -> CloudErrorKind {
    match status {
        401 | 403 => CloudErrorKind::Auth,
        402 | 429 => CloudErrorKind::Quota,
        408 | 504 => CloudErrorKind::Timeout,
        400 | 413 | 415 | 422 if audio_request => CloudErrorKind::BadAudio,
        _ => CloudErrorKind::Other,
    }
}

pub enum HttpMethod {
    Get,
    Post,
}

pub enum FormPart {
    Text { name: &'static str, value: String },
    File { name: &'static str, filename: &'static str, mime: &'static str, bytes: Vec<u8> },
}

pub enum HttpBody {
    Empty,
    Json(serde_json::Value),
    Multipart(Vec<FormPart>),
}

pub struct HttpRequest {
    pub method: HttpMethod,
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: HttpBody,
    /// The body carries audio, so a 4xx on it reads as bad audio rather than "other".
    pub audio: bool,
}

pub fn auth_headers(provider: CloudProvider, key: &str) -> Vec<(&'static str, String)> {
    match provider {
        CloudProvider::Openai => vec![("Authorization", format!("Bearer {key}"))],
        CloudProvider::Elevenlabs => vec![("xi-api-key", key.to_string())],
        CloudProvider::Gemini => vec![("x-goog-api-key", key.to_string())],
        CloudProvider::Openrouter => vec![
            ("Authorization", format!("Bearer {key}")),
            ("X-Title", "Alethe".to_string()),
        ],
    }
}

pub fn test_request(provider: CloudProvider, key: &str) -> HttpRequest {
    let url = match provider {
        CloudProvider::Openai => "https://api.openai.com/v1/models",
        CloudProvider::Elevenlabs => "https://api.elevenlabs.io/v1/models",
        CloudProvider::Gemini => "https://generativelanguage.googleapis.com/v1beta/models",
        CloudProvider::Openrouter => "https://openrouter.ai/api/v1/key",
    };
    HttpRequest {
        method: HttpMethod::Get,
        url: url.to_string(),
        headers: auth_headers(provider, key),
        body: HttpBody::Empty,
        audio: false,
    }
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("reqwest client")
    })
}

/// Sends the request and returns the body of a 2xx reply. Errors carry no body text: provider
/// error bodies can echo request content.
pub async fn send(request: HttpRequest, timeout: Duration) -> Result<Vec<u8>, CloudError> {
    let mut builder = match request.method {
        HttpMethod::Get => client().get(&request.url),
        HttpMethod::Post => client().post(&request.url),
    }
    .timeout(timeout);
    for (name, value) in request.headers {
        builder = builder.header(name, value);
    }
    builder = match request.body {
        HttpBody::Empty => builder,
        HttpBody::Json(value) => builder.json(&value),
        HttpBody::Multipart(parts) => {
            let mut form = reqwest::multipart::Form::new();
            for part in parts {
                form = match part {
                    FormPart::Text { name, value } => form.text(name, value),
                    FormPart::File { name, filename, mime, bytes } => form.part(
                        name,
                        reqwest::multipart::Part::bytes(bytes)
                            .file_name(filename)
                            .mime_str(mime)
                            .map_err(|_| CloudError::of(CloudErrorKind::Other))?,
                    ),
                };
            }
            builder.multipart(form)
        }
    };
    let response = builder.send().await.map_err(|error| {
        CloudError::of(if error.is_timeout() { CloudErrorKind::Timeout } else { CloudErrorKind::Network })
    })?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Err(CloudError { kind: classify_status(status, request.audio), status: Some(status) });
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|_| CloudError::of(CloudErrorKind::Network))
}
```

Append to `keys.rs`:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTestResult {
    pub ok: bool,
    pub reason: Option<super::http::CloudErrorKind>,
}

#[tauri::command]
pub async fn voice_provider_test(app: AppHandle, provider: CloudProvider) -> Result<VoiceTestResult, String> {
    use super::http::{send, test_request, CloudErrorKind};
    let Some(key) = read_key(&app, provider)? else {
        return Ok(VoiceTestResult { ok: false, reason: Some(CloudErrorKind::Auth) });
    };
    Ok(match send(test_request(provider, &key), std::time::Duration::from_secs(15)).await {
        Ok(_) => VoiceTestResult { ok: true, reason: None },
        Err(error) => VoiceTestResult { ok: false, reason: Some(error.kind) },
    })
}
```

Register `voice_providers::keys::voice_provider_test,` in `lib.rs`.

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test --lib voice_providers && cargo clippy --lib -- -D warnings`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Show `git status --short`; ask; on yes: `git commit -m "feat(voice): classify cloud errors and test provider keys"`.

---

### Task 5: Provider status sync and provider grid (frontend)

**Files:**
- Create: `src/lib/tauri/voiceProviders.ts`, `src/hooks/useVoiceProviderStatus.ts`, `src/hooks/useVoiceProviderStatus.test.ts`, `src/components/modals/preferences/voice/useSpeechInventory.ts`, `ProviderCard.tsx`, `ProviderCard.module.css`, `ProviderGrid.tsx`, `ProviderGrid.module.css`, `ProviderGrid.test.tsx`, `providerMeta.ts`
- Modify: `src/lib/tauri/index.ts`, `src/lib/voice/voicePreferences.ts` (+ test), `src/App.tsx:217`, `VoicePage.tsx`, locale files

**Interfaces:**
- Consumes: Tasks 1–4 (`voice_providers_status`, `voice_provider_*` commands; `Preferences.voiceProviders`).
- Produces (`src/lib/tauri/voiceProviders.ts`):
  ```ts
  export type CloudErrorKind = 'network' | 'auth' | 'quota' | 'badAudio' | 'timeout' | 'other'
  export type VoiceProviderStatus = { provider: CloudVoiceProviderId; configured: boolean }
  export type VoiceCatalogModel = { id: string; label: string; capability: 'stt' | 'tts' }
  export type VoiceCatalogVoice = { id: string; label: string }
  export type VoiceProviderCatalog = { provider: CloudVoiceProviderId; keyUrl: string; models: VoiceCatalogModel[]; voices: VoiceCatalogVoice[] }
  export type VoiceTestResult = { ok: boolean; reason: CloudErrorKind | null }
  voiceProvidersStatus(): Promise<VoiceProviderStatus[]>
  voiceProviderSetKey(provider, key): Promise<void>
  voiceProviderDeleteKey(provider): Promise<void>
  voiceProviderTest(provider): Promise<VoiceTestResult>
  voiceProviderCatalog(): Promise<VoiceProviderCatalog[]>
  ```
- Produces (`voicePreferences.ts`): `flagsFromStatus(statuses, previous: VoiceProviderFlags): VoiceProviderFlags`; `clearProviderUses(prefs: Pick<Preferences,'voiceStt'|'voiceTts'>, provider: CloudVoiceProviderId): Pick<Preferences,'voiceStt'|'voiceTts'>`.
- Produces (`useSpeechInventory.ts`): `useSpeechInventory(): { models: SpeechModelManifest[]; states: Record<string, SpeechModelState>; refresh: () => Promise<void> }`.
- Produces (`providerMeta.ts`): `type VoiceProviderId = 'local' | 'apple' | 'system' | CloudVoiceProviderId`; `PROVIDER_META: Record<VoiceProviderId, { icon: LucideIcon; name: MessageKey; description: MessageKey; group: 'local' | 'cloud' }>`.
- Produces: `ProviderGrid({ onOpen }: { onOpen: (id: VoiceProviderId) => void })`; `ProviderCard({ icon, title, description, status, actionLabel, onAction })` with `status: 'connected' | 'disconnected' | 'invalid'`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/voice/voicePreferences.test.ts`:

```ts
import { clearProviderUses, flagsFromStatus } from './voicePreferences'

describe('provider flags', () => {
  it('keeps the invalid mark only while the key still exists', () => {
    const next = flagsFromStatus(
      [
        { provider: 'openai', configured: true },
        { provider: 'gemini', configured: false },
      ],
      { openai: { configured: true, invalid: true }, gemini: { configured: true, invalid: true } },
    )
    expect(next).toEqual({
      openai: { configured: true, invalid: true },
      gemini: { configured: false, invalid: false },
    })
  })

  it('moves every use off a provider whose key is gone', () => {
    const prefs = {
      voiceStt: {
        dictation: { provider: 'openai' as const, model: 'whisper-1', locale: null },
        conversation: { provider: 'apple' as const, model: 'apple-speech', locale: 'pt-BR' },
      },
      voiceTts: { provider: 'openai' as const, model: 'gpt-4o-mini-tts', voice: 'nova', rate: 1.5 },
    }
    const next = clearProviderUses(prefs, 'openai')
    expect(next.voiceStt.dictation).toEqual(DEFAULT_STT_CHOICE)
    expect(next.voiceStt.conversation).toEqual(prefs.voiceStt.conversation)
    expect(next.voiceTts).toEqual({ ...DEFAULT_TTS_CHOICE, rate: 1.5 })
  })
})
```

`src/hooks/useVoiceProviderStatus.test.ts`:

```ts
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'
import { useVoiceProviderStatus } from './useVoiceProviderStatus'

const tauri = vi.hoisted(() => ({ voiceProvidersStatus: vi.fn() }))
vi.mock('../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tauri')>()),
  ...tauri,
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))

const prefs = () => useProjectsStore.getState().preferences

describe('useVoiceProviderStatus', () => {
  beforeEach(() => {
    useProjectsStore.getState().hydrate(EMPTY_PROJECTS_FILE)
  })

  it('mirrors keychain flags and refreshes on profile switch', async () => {
    tauri.voiceProvidersStatus.mockResolvedValueOnce([{ provider: 'openai', configured: true }])
    const { rerender } = renderHook(({ profile }) => useVoiceProviderStatus(true, profile), {
      initialProps: { profile: 'a' },
    })
    await waitFor(() => expect(prefs().voiceProviders.openai?.configured).toBe(true))

    tauri.voiceProvidersStatus.mockResolvedValueOnce([{ provider: 'openai', configured: false }])
    rerender({ profile: 'b' })
    await waitFor(() => expect(prefs().voiceProviders.openai?.configured).toBe(false))
  })

  it('moves a use off a provider that lost its key', async () => {
    useProjectsStore.getState().setPreferences({
      voiceProviders: { gemini: { configured: true, invalid: false } },
      voiceStt: {
        dictation: { provider: 'gemini', model: 'gemini-2.5-flash', locale: null },
        conversation: { provider: 'local', model: 'parakeet-tdt-0.6b-v3-int8', locale: null },
      },
    })
    tauri.voiceProvidersStatus.mockResolvedValueOnce([{ provider: 'gemini', configured: false }])
    renderHook(() => useVoiceProviderStatus(true, 'a'))
    await waitFor(() => expect(prefs().voiceStt.dictation.provider).toBe('local'))
  })
})
```

(If `hydrate` is named differently in `projectsStore`, use the same reset the other store tests use — check `src/components/modals/preferences/VoiceDictationSection.test.tsx`'s `beforeEach`.)

`ProviderGrid.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../../../lib/types'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { ProviderGrid } from './ProviderGrid'

const tauri = vi.hoisted(() => ({
  speechListModels: vi.fn(),
  speechModelStates: vi.fn(),
  onSpeechDownloadProgress: vi.fn().mockResolvedValue(() => undefined),
}))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/i18n', () => ({ useT: () => (key: string) => key }))

afterEach(cleanup)

describe('ProviderGrid', () => {
  beforeEach(() => {
    useProjectsStore.getState().hydrate(EMPTY_PROJECTS_FILE)
    tauri.speechListModels.mockResolvedValue([
      { id: 'parakeet-tdt-0.6b-v3-int8', kind: 'download', capability: 'stt' },
    ])
    tauri.speechModelStates.mockResolvedValue([{ id: 'parakeet-tdt-0.6b-v3-int8', status: 'ready' }])
    useProjectsStore.getState().setPreferences({
      voiceProviders: { openai: { configured: true, invalid: false }, gemini: { configured: true, invalid: true } },
    })
  })

  it('shows connection status per provider', async () => {
    render(<ProviderGrid onOpen={() => undefined} />)
    const openai = await screen.findByRole('article', { name: 'voice.provider.openai' })
    expect(openai.textContent).toContain('prefs.voiceStatusConnected')
    const gemini = screen.getByRole('article', { name: 'voice.provider.gemini' })
    expect(gemini.textContent).toContain('prefs.voiceStatusInvalid')
    const eleven = screen.getByRole('article', { name: 'voice.provider.elevenlabs' })
    expect(eleven.textContent).toContain('prefs.voiceStatusDisconnected')
    await waitFor(() =>
      expect(screen.getByRole('article', { name: 'voice.provider.local' }).textContent).toContain(
        'prefs.voiceStatusConnected',
      ),
    )
  })

  it('filters by group and opens a provider', async () => {
    const onOpen = vi.fn()
    render(<ProviderGrid onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('radio', { name: 'prefs.voiceFilterCloud' }))
    expect(screen.queryByRole('article', { name: 'voice.provider.local' })).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: 'prefs.voiceActionSetUpKey voice.provider.elevenlabs' }),
    )
    expect(onOpen).toHaveBeenCalledWith('elevenlabs')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/voice src/hooks/useVoiceProviderStatus.test.ts src/components/modals/preferences/voice`
Expected: FAIL — missing exports / modules.

- [ ] **Step 3: Wrappers and preference helpers**

`src/lib/tauri/voiceProviders.ts`:

```ts
import { invoke } from '@tauri-apps/api/core'

import type { CloudVoiceProviderId } from '../types'

export type CloudErrorKind = 'network' | 'auth' | 'quota' | 'badAudio' | 'timeout' | 'other'
export type VoiceProviderStatus = { provider: CloudVoiceProviderId; configured: boolean }
export type VoiceCatalogModel = { id: string; label: string; capability: 'stt' | 'tts' }
export type VoiceCatalogVoice = { id: string; label: string }
export type VoiceProviderCatalog = {
  provider: CloudVoiceProviderId
  keyUrl: string
  models: VoiceCatalogModel[]
  voices: VoiceCatalogVoice[]
}
export type VoiceTestResult = { ok: boolean; reason: CloudErrorKind | null }

export function voiceProvidersStatus(): Promise<VoiceProviderStatus[]> {
  return invoke('voice_providers_status')
}

export async function voiceProviderSetKey(provider: CloudVoiceProviderId, key: string): Promise<void> {
  await invoke('voice_provider_set_key', { provider, key })
}

export async function voiceProviderDeleteKey(provider: CloudVoiceProviderId): Promise<void> {
  await invoke('voice_provider_delete_key', { provider })
}

export function voiceProviderTest(provider: CloudVoiceProviderId): Promise<VoiceTestResult> {
  return invoke('voice_provider_test', { provider })
}

export function voiceProviderCatalog(): Promise<VoiceProviderCatalog[]> {
  return invoke('voice_provider_catalog')
}
```

`src/lib/tauri/index.ts`: add `export * from './voiceProviders'`.

Append to `voicePreferences.ts` (import `CloudVoiceProviderId` from `../types`):

```ts
export function flagsFromStatus(
  statuses: { provider: CloudVoiceProviderId; configured: boolean }[],
  previous: VoiceProviderFlags,
): VoiceProviderFlags {
  const next: VoiceProviderFlags = {}
  for (const { provider, configured } of statuses) {
    next[provider] = { configured, invalid: configured && previous[provider]?.invalid === true }
  }
  return next
}

export function clearProviderUses(
  prefs: Pick<Preferences, 'voiceStt' | 'voiceTts'>,
  provider: CloudVoiceProviderId,
): Pick<Preferences, 'voiceStt' | 'voiceTts'> {
  const stt = (choice: SttChoice) => (choice.provider === provider ? DEFAULT_STT_CHOICE : choice)
  return {
    voiceStt: { dictation: stt(prefs.voiceStt.dictation), conversation: stt(prefs.voiceStt.conversation) },
    voiceTts:
      prefs.voiceTts.provider === provider
        ? { ...DEFAULT_TTS_CHOICE, rate: prefs.voiceTts.rate }
        : prefs.voiceTts,
  }
}
```

- [ ] **Step 4: Status hook**

`src/hooks/useVoiceProviderStatus.ts`:

```ts
import { useEffect } from 'react'

import { voiceProvidersStatus } from '../lib/tauri'
import { CLOUD_VOICE_PROVIDERS } from '../lib/voice/providers'
import { clearProviderUses, flagsFromStatus } from '../lib/voice/voicePreferences'
import { useProjectsStore } from '../stores/projectsStore'

/** Keys live in the keychain per profile; mirror which exist so the UI and sanitizer can see it. */
export function useVoiceProviderStatus(hydrated: boolean, activeProfileId: string): void {
  useEffect(() => {
    if (!hydrated) return
    let cancelled = false
    void voiceProvidersStatus()
      .then((statuses) => {
        if (cancelled) return
        const store = useProjectsStore.getState()
        const flags = flagsFromStatus(statuses, store.preferences.voiceProviders)
        let uses: ReturnType<typeof clearProviderUses> = store.preferences
        for (const provider of CLOUD_VOICE_PROVIDERS) {
          if (!flags[provider]?.configured) uses = clearProviderUses(uses, provider)
        }
        store.setPreferences({ voiceProviders: flags, voiceStt: uses.voiceStt, voiceTts: uses.voiceTts })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [hydrated, activeProfileId])
}
```

`src/App.tsx`: below `useSpeechEngineDefault(hydrated, activeProfileId)` add `useVoiceProviderStatus(hydrated, activeProfileId)` (import from `./hooks/useVoiceProviderStatus`).

- [ ] **Step 5: Inventory hook, provider metadata, card and grid**

`useSpeechInventory.ts`:

```ts
import { useCallback, useEffect, useState } from 'react'

import {
  speechListModels,
  type SpeechModelManifest,
  type SpeechModelState,
  speechModelStates,
} from '../../../../lib/tauri'

/** Speech model catalog and readiness, shared by the voice cards and the local model list. */
export function useSpeechInventory(locale: string | null = null) {
  const [models, setModels] = useState<SpeechModelManifest[]>([])
  const [states, setStates] = useState<Record<string, SpeechModelState>>({})

  const refresh = useCallback(async () => {
    const [catalog, list] = await Promise.all([speechListModels(), speechModelStates(locale)])
    setModels(catalog)
    setStates(Object.fromEntries(list.map((state) => [state.id, state])))
  }, [locale])

  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])

  return { models, states, refresh }
}
```

`providerMeta.ts`:

```ts
import {
  AudioWaveform,
  Gem,
  HardDrive,
  Laptop,
  type LucideIcon,
  Route,
  Sparkle,
  Volume2,
} from 'lucide-react'

import type { MessageKey } from '../../../../lib/i18n/messages/en'
import type { CloudVoiceProviderId } from '../../../../lib/types'

export type VoiceProviderId = 'local' | 'apple' | 'system' | CloudVoiceProviderId

type Meta = { icon: LucideIcon; name: MessageKey; description: MessageKey; group: 'local' | 'cloud' }

export const PROVIDER_META: Record<VoiceProviderId, Meta> = {
  local: { icon: HardDrive, name: 'voice.provider.local', description: 'prefs.voiceProviderLocalDesc', group: 'local' },
  apple: { icon: Laptop, name: 'voice.provider.apple', description: 'prefs.voiceProviderAppleDesc', group: 'local' },
  system: { icon: Volume2, name: 'voice.provider.system', description: 'prefs.voiceProviderSystemDesc', group: 'local' },
  openai: { icon: Sparkle, name: 'voice.provider.openai', description: 'prefs.voiceProviderOpenaiDesc', group: 'cloud' },
  elevenlabs: { icon: AudioWaveform, name: 'voice.provider.elevenlabs', description: 'prefs.voiceProviderElevenlabsDesc', group: 'cloud' },
  gemini: { icon: Gem, name: 'voice.provider.gemini', description: 'prefs.voiceProviderGeminiDesc', group: 'cloud' },
  openrouter: { icon: Route, name: 'voice.provider.openrouter', description: 'prefs.voiceProviderOpenrouterDesc', group: 'cloud' },
}
```

`ProviderCard.tsx`:

```tsx
import type { LucideIcon } from 'lucide-react'
import { ChevronRight } from 'lucide-react'
import { useId } from 'react'

import { useT } from '../../../../lib/i18n'
import styles from './ProviderCard.module.css'

export type ProviderStatus = 'connected' | 'disconnected' | 'invalid'

const STATUS_KEY = {
  connected: 'prefs.voiceStatusConnected',
  disconnected: 'prefs.voiceStatusDisconnected',
  invalid: 'prefs.voiceStatusInvalid',
} as const

export function ProviderCard({
  icon: Icon,
  title,
  description,
  status,
  actionLabel,
  onAction,
}: {
  icon: LucideIcon
  title: string
  description: string
  status: ProviderStatus
  actionLabel: string
  onAction: () => void
}) {
  const t = useT()
  const titleId = useId()
  return (
    <article className={styles.card} aria-labelledby={titleId}>
      <div className={styles.top}>
        <span className={styles.icon} aria-hidden="true">
          <Icon size={18} />
        </span>
        <span className={styles.badge} data-status={status}>
          <span className={styles.dot} aria-hidden="true" />
          {t(STATUS_KEY[status])}
        </span>
      </div>
      <h3 id={titleId} className={styles.title}>
        {title}
      </h3>
      <p className={styles.description}>{description}</p>
      <button
        type="button"
        className={styles.action}
        aria-label={`${actionLabel} ${title}`}
        onClick={onAction}
      >
        <span>{actionLabel}</span>
        <ChevronRight size={14} aria-hidden="true" />
      </button>
    </article>
  )
}
```

`ProviderCard.module.css`:

```css
.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-card-default);
}

.top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--fg);
  background: var(--bg-sunken);
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--fg-muted);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.badge[data-status='connected'] {
  border-color: color-mix(in srgb, var(--status-working) 40%, transparent);
  color: var(--status-working);
  background: var(--status-working-soft);
}

.badge[data-status='invalid'] {
  border-color: color-mix(in srgb, var(--status-waiting) 40%, transparent);
  color: var(--status-waiting);
  background: var(--status-waiting-soft);
}

.title {
  margin: 0;
  color: var(--fg);
  font-size: 14px;
  font-weight: 650;
}

.description {
  flex: 1;
  margin: 0;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.5;
}

.action {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--fg);
  background: var(--bg-sunken);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--anim-fast) var(--ease-out-fluid);
}

.action:hover {
  background: var(--panel-hover);
}
```

`ProviderGrid.tsx`:

```tsx
import { useState } from 'react'

import { useT } from '../../../../lib/i18n'
import { APPLE_SPEECH_MODEL_ID } from '../../../../lib/tauri'
import { CLOUD_VOICE_PROVIDERS } from '../../../../lib/voice/providers'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { ProviderCard, type ProviderStatus } from './ProviderCard'
import styles from './ProviderGrid.module.css'
import { PROVIDER_META, type VoiceProviderId } from './providerMeta'
import { useSpeechInventory } from './useSpeechInventory'

type Filter = 'all' | 'local' | 'cloud'

export function ProviderGrid({ onOpen }: { onOpen: (id: VoiceProviderId) => void }) {
  const t = useT()
  const flags = useProjectsStore((s) => s.preferences.voiceProviders)
  const { models, states } = useSpeechInventory()
  const [filter, setFilter] = useState<Filter>('all')

  const appleAvailable = models.some((model) => model.id === APPLE_SPEECH_MODEL_ID)
  const localReady = models.some((model) => model.kind === 'download' && states[model.id]?.status === 'ready')

  const statusOf = (id: VoiceProviderId): ProviderStatus => {
    if (id === 'system') return 'connected'
    if (id === 'local') return localReady ? 'connected' : 'disconnected'
    if (id === 'apple') return states[APPLE_SPEECH_MODEL_ID]?.status === 'ready' ? 'connected' : 'disconnected'
    const flag = flags[id]
    if (!flag?.configured) return 'disconnected'
    return flag.invalid ? 'invalid' : 'connected'
  }

  const actionOf = (id: VoiceProviderId): string => {
    if (id === 'local') return t('prefs.voiceActionManageModels')
    if (PROVIDER_META[id].group === 'local') return t('prefs.voiceActionManage')
    return flags[id as (typeof CLOUD_VOICE_PROVIDERS)[number]]?.configured
      ? t('prefs.voiceActionManage')
      : t('prefs.voiceActionSetUpKey')
  }

  const localIds: VoiceProviderId[] = appleAvailable ? ['local', 'apple', 'system'] : ['local', 'system']
  const groups: { id: 'local' | 'cloud'; title: string; ids: VoiceProviderId[] }[] = [
    { id: 'local', title: t('prefs.voiceGroupLocal'), ids: localIds },
    { id: 'cloud', title: t('prefs.voiceGroupCloud'), ids: [...CLOUD_VOICE_PROVIDERS] },
  ]

  return (
    <section className={styles.root} data-setting-id="voice-providers" tabIndex={-1}>
      <div className={styles.header}>
        <div>
          <h2>{t('prefs.voiceProvidersTitle')}</h2>
          <p>{t('prefs.voiceProvidersDesc')}</p>
        </div>
        <div className={styles.filter} role="radiogroup" aria-label={t('prefs.voiceFilterLabel')}>
          {(['all', 'local', 'cloud'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={filter === id}
              className={filter === id ? styles.filterActive : styles.filterOption}
              onClick={() => setFilter(id)}
            >
              {t(id === 'all' ? 'prefs.voiceFilterAll' : id === 'local' ? 'prefs.voiceFilterLocal' : 'prefs.voiceFilterCloud')}
            </button>
          ))}
        </div>
      </div>
      {groups
        .filter((group) => filter === 'all' || filter === group.id)
        .map((group) => (
          <div key={group.id} className={styles.group}>
            <h3 className={styles.groupTitle}>{group.title}</h3>
            <div className={styles.grid}>
              {group.ids.map((id) => (
                <ProviderCard
                  key={id}
                  icon={PROVIDER_META[id].icon}
                  title={t(PROVIDER_META[id].name)}
                  description={t(PROVIDER_META[id].description)}
                  status={statusOf(id)}
                  actionLabel={actionOf(id)}
                  onAction={() => onOpen(id)}
                />
              ))}
            </div>
          </div>
        ))}
    </section>
  )
}
```

`ProviderGrid.module.css`:

```css
.root {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 8px;
  outline: none;
}

.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.header h2 {
  margin: 0;
  color: var(--fg);
  font-size: 15px;
  font-weight: 650;
}

.header p {
  max-width: 520px;
  margin: 4px 0 0;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.5;
}

.filter {
  display: inline-flex;
  flex: none;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-sunken);
}

.filterOption,
.filterActive {
  padding: 5px 12px;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
  background: transparent;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.filterActive {
  color: var(--fg);
  background: var(--surface-card-default);
  box-shadow: var(--shadow-sm);
}

.group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.groupTitle {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  color: var(--fg-muted);
  font-size: 12px;
  font-weight: 600;
}

.groupTitle::before {
  width: 24px;
  height: 1px;
  background: var(--border);
  content: '';
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}
```

In `VoicePage.tsx`, render `<ProviderGrid onOpen={() => undefined} />` after the tab panel (Task 6 wires `onOpen`).

- [ ] **Step 6: i18n keys**

| key | en | pt-BR | zh-CN |
|---|---|---|---|
| `voice.provider.local` | Local models | Modelos locais | 本地模型 |
| `voice.provider.apple` | Apple Speech | Apple Speech | Apple Speech |
| `voice.provider.system` | System voice | Voz do sistema | 系统语音 |
| `voice.provider.openai` | OpenAI | OpenAI | OpenAI |
| `voice.provider.elevenlabs` | ElevenLabs | ElevenLabs | ElevenLabs |
| `voice.provider.gemini` | Google Gemini | Google Gemini | Google Gemini |
| `voice.provider.openrouter` | OpenRouter | OpenRouter | OpenRouter |
| `prefs.voiceProviderLocalDesc` | Download models and run them on this device. Private and offline, no API key. | Baixe modelos e execute neste dispositivo. Privado e offline, sem chave de API. | 下载模型并在本设备运行。私密、离线，无需 API 密钥。 |
| `prefs.voiceProviderAppleDesc` | macOS on-device speech recognition. Nothing to download. | Reconhecimento de fala do macOS no dispositivo. Nada para baixar. | macOS 设备端语音识别，无需下载。 |
| `prefs.voiceProviderSystemDesc` | The operating system voice. Always available, offline. | A voz do sistema operacional. Sempre disponível, offline. | 操作系统自带语音，始终可用，离线。 |
| `prefs.voiceProviderOpenaiDesc` | Transcription and natural voices from OpenAI with your API key. | Transcrição e vozes naturais da OpenAI com sua chave de API. | 使用你的 API 密钥调用 OpenAI 的转写和自然语音。 |
| `prefs.voiceProviderElevenlabsDesc` | Lifelike voices and Scribe transcription with your API key. | Vozes realistas e transcrição Scribe com sua chave de API. | 使用你的 API 密钥获取逼真语音和 Scribe 转写。 |
| `prefs.voiceProviderGeminiDesc` | Gemini audio understanding and speech with your API key. | Compreensão de áudio e fala do Gemini com sua chave de API. | 使用你的 API 密钥调用 Gemini 音频理解与语音。 |
| `prefs.voiceProviderOpenrouterDesc` | Many speech models through one OpenRouter key. | Vários modelos de fala com uma única chave do OpenRouter. | 通过一个 OpenRouter 密钥使用多种语音模型。 |
| `prefs.voiceStatusConnected` | Connected | Conectado | 已连接 |
| `prefs.voiceStatusDisconnected` | Not connected | Não conectado | 未连接 |
| `prefs.voiceStatusInvalid` | Invalid key | Chave inválida | 密钥无效 |
| `prefs.voiceActionManageModels` | Manage models | Gerenciar modelos | 管理模型 |
| `prefs.voiceActionManage` | Manage | Gerenciar | 管理 |
| `prefs.voiceActionSetUpKey` | Set up key | Configurar chave | 设置密钥 |
| `prefs.voiceProvidersTitle` | Providers | Provedores | 提供方 |
| `prefs.voiceProvidersDesc` | Connect a cloud API with your own key, or run models privately on this device. | Conecte uma API de nuvem com sua chave ou execute modelos de forma privada neste dispositivo. | 用你自己的密钥连接云端 API，或在本设备私密运行模型。 |
| `prefs.voiceFilterLabel` | Filter providers | Filtrar provedores | 筛选提供方 |
| `prefs.voiceFilterAll` | All | Todos | 全部 |
| `prefs.voiceFilterLocal` | Local | Local | 本地 |
| `prefs.voiceFilterCloud` | Cloud | Nuvem | 云端 |
| `prefs.voiceGroupLocal` | Local and on device | Local e no dispositivo | 本地与设备端 |
| `prefs.voiceGroupCloud` | Cloud APIs | APIs de nuvem | 云端 API |

Add a search item in `PreferencesModal.tsx`:

```ts
      {
        category: 'voice',
        target: 'voice-providers',
        label: t('prefs.voiceProvidersTitle'),
        description: t('prefs.voiceProvidersDesc'),
        keywords: 'provider api key openai elevenlabs gemini openrouter cloud local whisper piper provedor chave nuvem 提供方 密钥 云端',
      },
```

- [ ] **Step 7: Run the checks**

Run: `npx vitest run src/lib/voice src/hooks src/components/modals && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 8: Checkpoint**

Show `git status --short`; ask; on yes: `git commit -m "feat(voice): show voice providers with their connection status"`.

---

### Task 6: Provider detail — keys, test, local models

**Files:**
- Create: `voice/ProviderDetail.tsx`, `ProviderDetail.module.css`, `CloudKeyForm.tsx`, `CloudKeyForm.module.css`, `CloudKeyForm.test.tsx`, `LocalModelList.tsx`, `LocalModelList.module.css`, `LocalModelList.test.tsx`, `src/lib/format.ts` (only if no `formatBytes` exists — run `grep -rn "export function formatBytes" src/lib` first and reuse it when found)
- Modify: `VoicePage.tsx`, `VoicePage.test.tsx`, locale files

**Interfaces:**
- Consumes: Task 5 wrappers, `clearProviderUses`, `PROVIDER_META`, `useSpeechInventory`; existing `speechDownloadModel`, `speechDeleteModel`, `onSpeechDownloadProgress`, `ModelDownloadProgress`, `nextRate`, `openInBrowser`.
- Produces: `ProviderDetail({ id, onBack })`; `CloudKeyForm({ provider, keyUrl })`; `LocalModelList({ capability }: { capability: 'stt' | 'tts' | 'all' })`. `VoicePage` holds `detail: VoiceProviderId | null`.

- [ ] **Step 1: Write the failing tests**

`CloudKeyForm.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../../../lib/types'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { CloudKeyForm } from './CloudKeyForm'

const tauri = vi.hoisted(() => ({
  voiceProviderSetKey: vi.fn().mockResolvedValue(undefined),
  voiceProviderDeleteKey: vi.fn().mockResolvedValue(undefined),
  voiceProviderTest: vi.fn(),
  openInBrowser: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/i18n', () => ({
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const prefs = () => useProjectsStore.getState().preferences

afterEach(cleanup)

describe('CloudKeyForm', () => {
  beforeEach(() => useProjectsStore.getState().hydrate(EMPTY_PROJECTS_FILE))

  it('saves, tests and marks the provider connected without keeping the key', async () => {
    tauri.voiceProviderTest.mockResolvedValue({ ok: true, reason: null })
    render(<CloudKeyForm provider="openai" keyUrl="https://platform.openai.com/api-keys" />)
    fireEvent.change(screen.getByLabelText('prefs.voiceKeyLabel'), { target: { value: ' sk-1 ' } })
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceKeySave' }))
    await waitFor(() => expect(prefs().voiceProviders.openai).toEqual({ configured: true, invalid: false }))
    expect(tauri.voiceProviderSetKey).toHaveBeenCalledWith('openai', 'sk-1')
    expect((screen.getByLabelText('prefs.voiceKeyLabel') as HTMLInputElement).value).toBe('')
    expect(JSON.stringify(prefs())).not.toContain('sk-1')
  })

  it('marks a rejected key invalid', async () => {
    tauri.voiceProviderTest.mockResolvedValue({ ok: false, reason: 'auth' })
    render(<CloudKeyForm provider="gemini" keyUrl="https://aistudio.google.com/apikey" />)
    fireEvent.change(screen.getByLabelText('prefs.voiceKeyLabel'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceKeySave' }))
    await waitFor(() => expect(prefs().voiceProviders.gemini).toEqual({ configured: true, invalid: true }))
    expect(screen.getByRole('status').textContent).toContain('prefs.voiceTestFailed.auth')
  })

  it('removing the key moves its uses back to local', async () => {
    useProjectsStore.getState().setPreferences({
      voiceProviders: { openai: { configured: true, invalid: false } },
      voiceTts: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova', rate: 1 },
    })
    render(<CloudKeyForm provider="openai" keyUrl="https://platform.openai.com/api-keys" />)
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceKeyRemove' }))
    await waitFor(() => expect(prefs().voiceTts.provider).toBe('system'))
    expect(prefs().voiceProviders.openai?.configured).toBe(false)
  })
})
```

`LocalModelList.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LocalModelList } from './LocalModelList'

const tauri = vi.hoisted(() => ({
  speechListModels: vi.fn(),
  speechModelStates: vi.fn(),
  speechDownloadModel: vi.fn().mockResolvedValue({ id: 'whisper-base-int8', status: 'ready' }),
  speechDeleteModel: vi.fn().mockResolvedValue(undefined),
  onSpeechDownloadProgress: vi.fn().mockResolvedValue(() => undefined),
}))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
}))
vi.mock('../../../../lib/i18n', () => ({
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

afterEach(cleanup)

const model = (id: string, capability: 'stt' | 'tts') => ({
  id, label: id, description: '', language: 'multilingual', sampleRate: 16000,
  sizeBytes: 1024 * 1024, recommended: false, kind: 'download', capability,
})

describe('LocalModelList', () => {
  it('lists downloadable models of the capability and downloads one', async () => {
    tauri.speechListModels.mockResolvedValue([model('whisper-base-int8', 'stt'), model('piper-pt-br', 'tts')])
    tauri.speechModelStates.mockResolvedValue([{ id: 'whisper-base-int8', status: 'not-downloaded' }])
    render(<LocalModelList capability="stt" />)
    const row = await screen.findByRole('listitem', { name: 'whisper-base-int8' })
    expect(screen.queryByRole('listitem', { name: 'piper-pt-br' })).toBeNull()
    fireEvent.click(row.querySelector('button')!)
    await waitFor(() => expect(tauri.speechDownloadModel).toHaveBeenCalledWith('whisper-base-int8', null))
  })
})
```

Add to `VoicePage.test.tsx` (also mock `./ProviderGrid` as `({ onOpen }) => <button onClick={() => onOpen('openai')}>open-openai</button>` and `./ProviderDetail` as `({ id, onBack }) => <button onClick={onBack}>{`detail-${id}`}</button>`):

```tsx
  it('opens a provider detail and goes back', () => {
    render(<VoicePage target={null} />)
    fireEvent.click(screen.getByText('open-openai'))
    expect(screen.queryByText('dictation-body')).toBeNull()
    fireEvent.click(screen.getByText('detail-openai'))
    expect(screen.getByText('dictation-body')).toBeTruthy()
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/modals/preferences/voice`
Expected: FAIL — modules not found.

- [ ] **Step 3: `CloudKeyForm`**

```tsx
import { ExternalLink } from 'lucide-react'
import { useId, useState } from 'react'

import { useT } from '../../../../lib/i18n'
import {
  type CloudErrorKind,
  openInBrowser,
  voiceProviderDeleteKey,
  voiceProviderSetKey,
  voiceProviderTest,
} from '../../../../lib/tauri'
import type { CloudVoiceProviderId } from '../../../../lib/types'
import { clearProviderUses } from '../../../../lib/voice/voicePreferences'
import { useProjectsStore } from '../../../../stores/projectsStore'
import controls from '../../controls.module.css'
import styles from './CloudKeyForm.module.css'
import { PROVIDER_META } from './providerMeta'

type Feedback = { tone: 'ok' | 'error'; text: string } | null

export function CloudKeyForm({ provider, keyUrl }: { provider: CloudVoiceProviderId; keyUrl: string }) {
  const t = useT()
  const inputId = useId()
  const flag = useProjectsStore((s) => s.preferences.voiceProviders[provider])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const name = t(PROVIDER_META[provider].name)

  const setFlag = (configured: boolean, invalid: boolean) => {
    const store = useProjectsStore.getState()
    store.setPreferences({
      voiceProviders: { ...store.preferences.voiceProviders, [provider]: { configured, invalid } },
    })
  }

  const failure = (reason: CloudErrorKind | null) =>
    t(`prefs.voiceTestFailed.${reason ?? 'other'}` as 'prefs.voiceTestFailed.other')

  const test = async () => {
    setBusy(true)
    try {
      const result = await voiceProviderTest(provider)
      setFlag(true, !result.ok && result.reason === 'auth')
      setFeedback(result.ok ? { tone: 'ok', text: t('prefs.voiceTestOk') } : { tone: 'error', text: failure(result.reason) })
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    setFeedback(null)
    try {
      await voiceProviderSetKey(provider, draft)
      setDraft('')
      setFlag(true, false)
    } catch {
      setFeedback({ tone: 'error', text: t('prefs.voiceKeyRejected') })
      setBusy(false)
      return
    }
    await test()
  }

  const remove = async () => {
    setBusy(true)
    try {
      await voiceProviderDeleteKey(provider)
      const store = useProjectsStore.getState()
      store.setPreferences({
        ...clearProviderUses(store.preferences, provider),
        voiceProviders: { ...store.preferences.voiceProviders, [provider]: { configured: false, invalid: false } },
      })
      setFeedback(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.form}>
      <label htmlFor={inputId} className={styles.label}>
        {t('prefs.voiceKeyLabel')}
      </label>
      <div className={styles.row}>
        <input
          id={inputId}
          className={controls.input}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          placeholder={flag?.configured ? '••••••••••••••••' : t('prefs.voiceKeyPlaceholder', { provider: name })}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="button" className={controls.btn} onClick={() => void openInBrowser(keyUrl)}>
          <ExternalLink size={14} aria-hidden="true" />
          {t('prefs.voiceKeyGet')}
        </button>
      </div>
      <p className={styles.hint}>{t('prefs.voiceKeyHint')}</p>
      <div className={styles.actions}>
        <button
          type="button"
          className={controls.btnPrimary}
          disabled={busy || !draft.trim()}
          onClick={() => void save()}
        >
          {t('prefs.voiceKeySave')}
        </button>
        <button type="button" className={controls.btn} disabled={busy || !flag?.configured} onClick={() => void test()}>
          {t('prefs.voiceKeyTest')}
        </button>
        <button type="button" className={controls.btnDanger} disabled={busy || !flag?.configured} onClick={() => void remove()}>
          {t('prefs.voiceKeyRemove')}
        </button>
      </div>
      {feedback ? (
        <p role="status" className={styles.feedback} data-tone={feedback.tone}>
          {feedback.text}
        </p>
      ) : null}
      <p className={styles.privacy}>{t('prefs.voiceCloudPrivacy', { provider: name })}</p>
    </div>
  )
}
```

`CloudKeyForm.module.css`:

```css
.form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.label {
  color: var(--fg);
  font-size: 13px;
  font-weight: 600;
}

.row {
  display: flex;
  gap: 8px;
}

.row input {
  flex: 1;
  min-width: 0;
}

.hint,
.privacy {
  margin: 0;
  color: var(--fg-muted);
  font-size: 11px;
  line-height: 1.5;
}

.privacy {
  padding: 8px 10px;
  border: 1px solid var(--accent-border);
  border-radius: var(--radius-md);
  color: var(--fg);
  background: var(--accent-faint);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.feedback {
  margin: 0;
  font-size: 12px;
}

.feedback[data-tone='ok'] {
  color: var(--status-working);
}

.feedback[data-tone='error'] {
  color: var(--status-waiting);
}
```

- [ ] **Step 4: `LocalModelList`**

```tsx
import { useEffect, useRef, useState } from 'react'

import { useT } from '../../../../lib/i18n'
import { type DownloadRate, nextRate } from '../../../../lib/speech/downloadStats'
import {
  onSpeechDownloadProgress,
  speechDeleteModel,
  speechDownloadModel,
  type SpeechDownloadProgress,
} from '../../../../lib/tauri'
import controls from '../../controls.module.css'
import { ModelDownloadProgress } from '../ModelDownloadProgress'
import styles from './LocalModelList.module.css'
import { useSpeechInventory } from './useSpeechInventory'

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function LocalModelList({ capability }: { capability: 'stt' | 'tts' | 'all' }) {
  const t = useT()
  const { models, states, refresh } = useSpeechInventory()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [download, setDownload] = useState<SpeechDownloadProgress | null>(null)
  const [bytesPerSecond, setBytesPerSecond] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rateRef = useRef<DownloadRate | null>(null)

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void onSpeechDownloadProgress((progress) => {
      setDownload(progress)
      if (progress.phase === 'downloading') {
        rateRef.current = nextRate(rateRef.current, { bytes: progress.downloaded, at: performance.now() })
        setBytesPerSecond(rateRef.current.bytesPerSecond)
      }
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id)
    setError(null)
    rateRef.current = null
    setBytesPerSecond(null)
    try {
      await action()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyId(null)
      setDownload(null)
    }
  }

  const rows = models.filter(
    (model) => model.kind === 'download' && (capability === 'all' || model.capability === capability),
  )

  return (
    <div className={styles.root}>
      <ul className={styles.list}>
        {rows.map((model) => {
          const ready = states[model.id]?.status === 'ready'
          return (
            <li key={model.id} className={styles.row} aria-label={model.label}>
              <div className={styles.info}>
                <strong>{model.label}</strong>
                <small>
                  {t(model.capability === 'tts' ? 'prefs.voiceModelKindTts' : 'prefs.voiceModelKindStt')}
                  {' · '}
                  {formatBytes(model.sizeBytes)}
                  {' · '}
                  {t(ready ? 'prefs.voiceModelReady' : 'prefs.voiceModelNotDownloaded')}
                </small>
                {download?.modelId === model.id ? (
                  <ModelDownloadProgress progress={download} bytesPerSecond={bytesPerSecond} />
                ) : null}
              </div>
              {ready ? (
                <button
                  type="button"
                  className={controls.btnDanger}
                  disabled={busyId !== null}
                  onClick={() => void run(model.id, () => speechDeleteModel(model.id))}
                >
                  {t('prefs.dictationModelDelete')}
                </button>
              ) : (
                <button
                  type="button"
                  className={controls.btn}
                  disabled={busyId !== null}
                  onClick={() => void run(model.id, () => speechDownloadModel(model.id, null))}
                >
                  {t('prefs.dictationModelDownload')}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {error ? <p className={styles.error}>{error}</p> : null}
    </div>
  )
}
```

`LocalModelList.module.css`:

```css
.root {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  list-style: none;
  overflow: hidden;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  background: var(--surface-card-default);
}

.row + .row {
  border-top: 1px solid var(--border-subtle);
}

.info {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.info strong {
  color: var(--fg);
  font-size: 13px;
}

.info small {
  color: var(--fg-muted);
  font-size: 11px;
}

.error {
  margin: 0;
  color: var(--status-waiting);
  font-size: 12px;
}
```

`SpeechModelManifest` in `src/lib/tauri/speech.ts` gains `capability: 'stt' | 'tts'` here; Task 13 makes Rust send it. Until then, treat a missing value as `'stt'` in the filter: `(model.capability ?? 'stt') === capability`.

- [ ] **Step 5: `ProviderDetail` and navigation**

`ProviderDetail.tsx`:

```tsx
import { ArrowLeft } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../../../lib/i18n'
import { voiceProviderCatalog, type VoiceProviderCatalog } from '../../../../lib/tauri'
import { isCloudProvider } from '../../../../lib/voice/providers'
import { CloudKeyForm } from './CloudKeyForm'
import { LocalModelList } from './LocalModelList'
import styles from './ProviderDetail.module.css'
import { PROVIDER_META, type VoiceProviderId } from './providerMeta'

export function ProviderDetail({ id, onBack }: { id: VoiceProviderId; onBack: () => void }) {
  const t = useT()
  const [catalog, setCatalog] = useState<VoiceProviderCatalog | null>(null)
  const meta = PROVIDER_META[id]

  useEffect(() => {
    if (!isCloudProvider(id)) return
    let cancelled = false
    void voiceProviderCatalog()
      .then((list) => {
        if (!cancelled) setCatalog(list.find((entry) => entry.provider === id) ?? null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [id])

  return (
    <div className={styles.root}>
      <nav className={styles.breadcrumb}>
        <button type="button" className={styles.back} onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" />
          {t('prefs.voiceProvidersTitle')}
        </button>
        <span aria-hidden="true">/</span>
        <strong>{t(meta.name)}</strong>
      </nav>
      <p className={styles.description}>{t(meta.description)}</p>
      {isCloudProvider(id) && catalog ? (
        <>
          <CloudKeyForm provider={id} keyUrl={catalog.keyUrl} />
          <h3 className={styles.subTitle}>{t('prefs.voiceDetailModels')}</h3>
          <ul className={styles.modelList}>
            {catalog.models.map((model) => (
              <li key={`${model.capability}-${model.id}`}>
                <span>{model.label}</span>
                <small>{t(model.capability === 'tts' ? 'prefs.voiceModelKindTts' : 'prefs.voiceModelKindStt')}</small>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {id === 'local' ? <LocalModelList capability="all" /> : null}
      {id === 'apple' || id === 'system' ? <p className={styles.description}>{t('prefs.voiceDetailBuiltIn')}</p> : null}
    </div>
  )
}
```

`ProviderDetail.module.css`:

```css
.root {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--fg-muted);
  font-size: 13px;
}

.breadcrumb strong {
  color: var(--fg);
}

.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--fg);
  background: var(--bg-sunken);
  font-size: 12px;
  cursor: pointer;
}

.description {
  margin: 0;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.5;
}

.subTitle {
  margin: 8px 0 0;
  color: var(--fg);
  font-size: 13px;
  font-weight: 600;
}

.modelList {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  list-style: none;
}

.modelList li {
  display: flex;
  justify-content: space-between;
  padding: 10px 14px;
  color: var(--fg);
  font-size: 12px;
}

.modelList li + li {
  border-top: 1px solid var(--border-subtle);
}

.modelList small {
  color: var(--fg-muted);
}
```

`VoicePage.tsx`: add `const [detail, setDetail] = useState<VoiceProviderId | null>(null)`; when `detail` is set, render only `<ProviderDetail id={detail} onBack={() => setDetail(null)} />` inside `.page`; otherwise render header, tabs, panel and `<ProviderGrid onOpen={setDetail} />`. In the `useLayoutEffect`, also `setDetail(null)` when a target arrives.

- [ ] **Step 6: i18n keys**

| key | en | pt-BR | zh-CN |
|---|---|---|---|
| `prefs.voiceKeyLabel` | API key | Chave de API | API 密钥 |
| `prefs.voiceKeyPlaceholder` | Paste your {{provider}} key | Cole sua chave do {{provider}} | 粘贴你的 {{provider}} 密钥 |
| `prefs.voiceKeyGet` | Get a key | Obter chave | 获取密钥 |
| `prefs.voiceKeyHint` | Stored in the system keychain for this profile. Alethe never shows it again. | Guardada no chaveiro do sistema para este perfil. O Alethe nunca a mostra de novo. | 保存在本配置文件的系统钥匙串中，Alethe 不会再次显示。 |
| `prefs.voiceKeySave` | Save | Salvar | 保存 |
| `prefs.voiceKeyTest` | Test connection | Testar conexão | 测试连接 |
| `prefs.voiceKeyRemove` | Remove key | Remover chave | 移除密钥 |
| `prefs.voiceKeyRejected` | That key has an invalid format. | A chave tem formato inválido. | 密钥格式无效。 |
| `prefs.voiceTestOk` | Connected. | Conectado. | 已连接。 |
| `prefs.voiceTestFailed.auth` | The provider rejected this key. | O provedor recusou esta chave. | 提供方拒绝了此密钥。 |
| `prefs.voiceTestFailed.quota` | The account is out of credit or rate limited. | A conta está sem crédito ou com limite atingido. | 账户额度不足或受到速率限制。 |
| `prefs.voiceTestFailed.network` | Could not reach the provider. Check your connection. | Não foi possível alcançar o provedor. Verifique sua conexão. | 无法连接提供方，请检查网络。 |
| `prefs.voiceTestFailed.timeout` | The provider took too long to answer. | O provedor demorou demais para responder. | 提供方响应超时。 |
| `prefs.voiceTestFailed.badAudio` | The provider could not read the audio. | O provedor não conseguiu ler o áudio. | 提供方无法读取音频。 |
| `prefs.voiceTestFailed.other` | The provider returned an error. | O provedor retornou um erro. | 提供方返回了错误。 |
| `prefs.voiceCloudPrivacy` | When you pick {{provider}} for a voice use, that audio or text is sent to {{provider}}. Local options never leave this device. | Ao escolher {{provider}} para um uso de voz, o áudio ou texto é enviado ao {{provider}}. Opções locais nunca saem deste dispositivo. | 为某项语音用途选择 {{provider}} 后，相关音频或文本会发送给 {{provider}}。本地选项不会离开本设备。 |
| `prefs.voiceDetailModels` | Models | Modelos | 模型 |
| `prefs.voiceDetailBuiltIn` | Built into the system. Nothing to set up here. | Já vem no sistema. Nada para configurar aqui. | 系统内置，无需设置。 |
| `prefs.voiceModelKindStt` | Speech to text | Fala para texto | 语音转文字 |
| `prefs.voiceModelKindTts` | Text to speech | Texto para fala | 文字转语音 |
| `prefs.voiceModelReady` | Downloaded | Baixado | 已下载 |
| `prefs.voiceModelNotDownloaded` | Not downloaded | Não baixado | 未下载 |

(Check the interpolation syntax used by `t()` in `en.ts` — e.g. `prefs.dictationDesc` — and use the same braces.)

- [ ] **Step 7: Run the checks**

Run: `npx vitest run src/components/modals && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 8: Checkpoint**

Show `git status --short`; ask; on yes: `git commit -m "feat(voice): manage provider keys and local models from the provider page"`.


---

## Phase 3 — Cloud speech-to-text

### Task 7: Cloud transcription requests and replies (Rust)

**Files:**
- Create: `src-tauri/src/voice_providers/stt_cloud.rs`
- Modify: `src-tauri/src/voice_providers/mod.rs`

**Interfaces:**
- Consumes: `CloudProvider`, `http::{HttpRequest, HttpBody, FormPart, HttpMethod, CloudError, CloudErrorKind, auth_headers}` (Tasks 3–4).
- Produces:
  ```rust
  pub fn wav_bytes(samples: &[f32], sample_rate: u32) -> Vec<u8>
  pub fn transcription_request(provider: CloudProvider, model: &str, key: &str, wav: Vec<u8>) -> HttpRequest
  pub fn parse_transcription(provider: CloudProvider, body: &[u8]) -> Result<String, CloudError>
  pub async fn transcribe(provider: CloudProvider, model: &str, key: &str, samples: &[f32], sample_rate: u32) -> Result<String, CloudError>
  ```

- [ ] **Step 1: Write the failing tests** (bottom of `stt_cloud.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice_providers::http::{FormPart, HttpBody};

    #[test]
    fn wav_has_a_pcm16_mono_header() {
        let wav = wav_bytes(&[0.0, 1.0, -1.0], 16_000);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1, "mono");
        assert_eq!(u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]), 16_000);
        assert_eq!(u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]), 6, "3 samples x 2 bytes");
        assert_eq!(i16::from_le_bytes([wav[46], wav[47]]), i16::MAX);
        assert_eq!(i16::from_le_bytes([wav[48], wav[49]]), -i16::MAX);
    }

    #[test]
    fn openai_and_elevenlabs_upload_multipart() {
        let openai = transcription_request(CloudProvider::Openai, "whisper-1", "k", vec![1, 2]);
        assert_eq!(openai.url, "https://api.openai.com/v1/audio/transcriptions");
        let HttpBody::Multipart(parts) = openai.body else { panic!("multipart") };
        assert!(parts.iter().any(|p| matches!(p, FormPart::Text { name: "model", value } if value == "whisper-1")));
        assert!(parts.iter().any(|p| matches!(p, FormPart::File { name: "file", .. })));
        assert!(openai.audio);

        let eleven = transcription_request(CloudProvider::Elevenlabs, "scribe_v2", "k", vec![1]);
        assert_eq!(eleven.url, "https://api.elevenlabs.io/v1/speech-to-text");
        let HttpBody::Multipart(parts) = eleven.body else { panic!("multipart") };
        assert!(parts.iter().any(|p| matches!(p, FormPart::Text { name: "model_id", value } if value == "scribe_v2")));
    }

    #[test]
    fn gemini_and_openrouter_send_base64_json() {
        let gemini = transcription_request(CloudProvider::Gemini, "gemini-2.5-flash", "k", vec![1, 2, 3]);
        assert_eq!(
            gemini.url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
        );
        let HttpBody::Json(body) = gemini.body else { panic!("json") };
        assert_eq!(body["contents"][0]["parts"][1]["inline_data"]["mime_type"], "audio/wav");
        assert_eq!(body["contents"][0]["parts"][1]["inline_data"]["data"], "AQID");

        let router = transcription_request(CloudProvider::Openrouter, "openai/whisper-1", "k", vec![1, 2, 3]);
        assert_eq!(router.url, "https://openrouter.ai/api/v1/audio/transcriptions");
        let HttpBody::Json(body) = router.body else { panic!("json") };
        assert_eq!(body["model"], "openai/whisper-1");
        assert_eq!(body["input_audio"]["format"], "wav");
        assert_eq!(body["input_audio"]["data"], "AQID");
    }

    #[test]
    fn replies_are_parsed_per_provider() {
        assert_eq!(parse_transcription(CloudProvider::Openai, br#"{"text":" oi "}"#).unwrap(), "oi");
        assert_eq!(parse_transcription(CloudProvider::Elevenlabs, br#"{"text":"hello"}"#).unwrap(), "hello");
        assert_eq!(parse_transcription(CloudProvider::Openrouter, br#"{"text":"x","usage":{}}"#).unwrap(), "x");
        let gemini = br#"{"candidates":[{"content":{"parts":[{"text":"bom "},{"text":"dia"}]}}]}"#;
        assert_eq!(parse_transcription(CloudProvider::Gemini, gemini).unwrap(), "bom dia");
        assert_eq!(
            parse_transcription(CloudProvider::Openai, b"not json").unwrap_err().kind,
            CloudErrorKind::Other
        );
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib stt_cloud`
Expected: compile error — module not found.

- [ ] **Step 3: Implement**

`mod.rs`: add `pub mod stt_cloud;`.

`stt_cloud.rs`:

```rust
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};

use super::http::{auth_headers, send, CloudError, CloudErrorKind, FormPart, HttpBody, HttpMethod, HttpRequest};
use super::CloudProvider;

const TIMEOUT: Duration = Duration::from_secs(30);
const GEMINI_PROMPT: &str =
    "Transcribe this audio verbatim in its original language. Reply with the transcript only.";

/// 16-bit PCM mono WAV, the one container every provider accepts.
pub fn wav_bytes(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

fn wav_part(wav: Vec<u8>) -> FormPart {
    FormPart::File { name: "file", filename: "audio.wav", mime: "audio/wav", bytes: wav }
}

pub fn transcription_request(provider: CloudProvider, model: &str, key: &str, wav: Vec<u8>) -> HttpRequest {
    let b64 = || base64::engine::general_purpose::STANDARD.encode(&wav);
    let (url, body) = match provider {
        CloudProvider::Openai => (
            "https://api.openai.com/v1/audio/transcriptions".to_string(),
            HttpBody::Multipart(vec![
                FormPart::Text { name: "model", value: model.to_string() },
                FormPart::Text { name: "response_format", value: "json".to_string() },
                wav_part(wav.clone()),
            ]),
        ),
        CloudProvider::Elevenlabs => (
            "https://api.elevenlabs.io/v1/speech-to-text".to_string(),
            HttpBody::Multipart(vec![
                FormPart::Text { name: "model_id", value: model.to_string() },
                wav_part(wav.clone()),
            ]),
        ),
        CloudProvider::Gemini => (
            format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"),
            HttpBody::Json(json!({
                "contents": [{ "parts": [
                    { "text": GEMINI_PROMPT },
                    { "inline_data": { "mime_type": "audio/wav", "data": b64() } }
                ]}]
            })),
        ),
        CloudProvider::Openrouter => (
            "https://openrouter.ai/api/v1/audio/transcriptions".to_string(),
            HttpBody::Json(json!({
                "model": model,
                "input_audio": { "data": b64(), "format": "wav" }
            })),
        ),
    };
    HttpRequest { method: HttpMethod::Post, url, headers: auth_headers(provider, key), body, audio: true }
}

pub fn parse_transcription(provider: CloudProvider, body: &[u8]) -> Result<String, CloudError> {
    let value: Value = serde_json::from_slice(body).map_err(|_| CloudError::of(CloudErrorKind::Other))?;
    let text = match provider {
        CloudProvider::Gemini => value["candidates"][0]["content"]["parts"]
            .as_array()
            .map(|parts| parts.iter().filter_map(|part| part["text"].as_str()).collect::<String>()),
        _ => value["text"].as_str().map(str::to_string),
    };
    text.map(|text| text.trim().to_string())
        .ok_or_else(|| CloudError::of(CloudErrorKind::Other))
}

pub async fn transcribe(
    provider: CloudProvider,
    model: &str,
    key: &str,
    samples: &[f32],
    sample_rate: u32,
) -> Result<String, CloudError> {
    let request = transcription_request(provider, model, key, wav_bytes(samples, sample_rate));
    let body = send(request, TIMEOUT).await?;
    parse_transcription(provider, &body)
}
```

(`wav.clone()` in the multipart arms keeps the borrow for `b64` simple; the buffer is at most 60 s of 16 kHz audio, ~2 MB.)

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test --lib stt_cloud && cargo clippy --lib -- -D warnings`
Expected: PASS. If clippy flags `redundant_clone` on the multipart arms, restructure to compute `b64` only in the JSON arms (`let encoded = base64::...encode(&wav);` inside each).

- [ ] **Step 5: Checkpoint**

Show `git status --short`; ask; on yes: `git commit -m "feat(voice): build cloud transcription requests"`.

---

### Task 8: Cloud STT dispatch with local fallback

**Files:**
- Modify: `src-tauri/src/speech.rs:756-920` (+ tests), `src/lib/tauri/speech.ts:94-104`, `src/components/DictationButton/index.tsx`, `src/components/VoiceCommand/index.tsx`, `src/lib/voice/controller.ts` (+ tests of each), `src/App.tsx`, locale files
- Create: `src/hooks/useVoiceFallbackToasts.ts`, `src/hooks/useVoiceFallbackToasts.test.ts`

**Interfaces:**
- Consumes: `stt_cloud::transcribe`, `keys::read_key`, `CloudError` (Tasks 3–7); `sttChoiceFor` (Task 1).
- Produces (Rust):
  ```rust
  #[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)] #[serde(rename_all = "lowercase")]
  pub enum SttProvider { Local, Apple, Openai, Elevenlabs, Gemini, Openrouter }
  // speech_prepare(provider: Option<SttProvider>, model_id, locale)
  // speech_stop_and_transcribe(provider: Option<SttProvider>, model_id, locale, fallback_locale: Option<String>, usage: Option<String>)
  // event "voice://fallback" { usage: String, provider: String, reason: CloudErrorKind, fallback: String }
  enum FallbackStt { Apple(String), Sherpa(&'static str) }
  fn pick_fallback(apple_locale_ready: Option<String>, ready_sherpa: &[&'static str]) -> Option<FallbackStt>
  ```
- Produces (TS): `speechPrepare(modelId, locale?, provider?)`, `speechStopAndTranscribe(modelId, locale?, options?: { provider: SttProviderId; fallbackLocale: string | null; usage: string })`; `type VoiceFallbackEvent = { usage: string; provider: CloudVoiceProviderId | 'system'; reason: CloudErrorKind; fallback: string }`; `onVoiceFallback(handler)`; `useVoiceFallbackToasts()`.

- [ ] **Step 1: Write the failing tests**

Rust, in `speech.rs` tests:

```rust
    #[test]
    fn fallback_order_prefers_apple_with_a_ready_locale() {
        let picked = pick_fallback(Some("pt-BR".into()), &["parakeet-tdt-0.6b-v3-int8"]);
        assert!(matches!(picked, Some(FallbackStt::Apple(locale)) if locale == "pt-BR"));
    }

    #[test]
    fn fallback_order_uses_the_first_ready_sherpa_model() {
        let picked = pick_fallback(None, &["zipformer-small-en-int8", "parakeet-tdt-0.6b-v3-int8"]);
        assert!(matches!(picked, Some(FallbackStt::Sherpa("zipformer-small-en-int8"))));
    }

    #[test]
    fn fallback_order_is_empty_without_local_engines() {
        assert!(pick_fallback(None, &[]).is_none());
    }

    #[test]
    fn provider_defaults_from_the_model_id_for_old_callers() {
        assert_eq!(SttProvider::infer(None, "apple-speech"), SttProvider::Apple);
        assert_eq!(SttProvider::infer(None, "parakeet-tdt-0.6b-v3-int8"), SttProvider::Local);
        assert_eq!(SttProvider::infer(Some(SttProvider::Gemini), "x"), SttProvider::Gemini);
    }
```

TS, `src/hooks/useVoiceFallbackToasts.test.ts`:

```ts
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { useVoiceFallbackToasts } from './useVoiceFallbackToasts'

const captured = vi.hoisted(() => ({ handler: null as null | ((event: unknown) => void) }))
vi.mock('../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tauri')>()),
  onVoiceFallback: vi.fn(async (handler: (event: unknown) => void) => {
    captured.handler = handler
    return () => undefined
  }),
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/i18n', () => ({
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

describe('useVoiceFallbackToasts', () => {
  beforeEach(() => {
    useProjectsStore.getState().hydrate(EMPTY_PROJECTS_FILE)
    useProjectsStore.getState().setPreferences({ voiceProviders: { openai: { configured: true, invalid: false } } })
  })

  it('toasts the reason and marks a rejected key invalid', async () => {
    const pushToast = vi.spyOn(useUiStore.getState(), 'pushToast')
    renderHook(() => useVoiceFallbackToasts())
    await vi.waitFor(() => expect(captured.handler).not.toBeNull())
    captured.handler!({ usage: 'dictation', provider: 'openai', reason: 'auth', fallback: 'apple-speech' })
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('voice.fallback.title') }),
    )
    expect(useProjectsStore.getState().preferences.voiceProviders.openai?.invalid).toBe(true)
  })
})
```

(If `pushToast` is not spy-able on the store object, read `useUiStore.getState().notifications[0]` instead — the store prepends notifications in `pushToast`, `uiStore.ts:356`.)

In `DictationButton.test.tsx`, update the transcribe expectation to:

```ts
expect(tauri.speechStopAndTranscribe).toHaveBeenCalledWith('apple-speech', 'pt-BR', {
  provider: 'apple',
  fallbackLocale: 'pt-BR',
  usage: 'dictation',
})
```

and in `controller.test.ts` the same with `usage: 'conversation'`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib speech::tests` then `npx vitest run src/hooks/useVoiceFallbackToasts.test.ts src/components/DictationButton src/lib/voice`
Expected: FAIL — `pick_fallback`/`SttProvider` undefined; `onVoiceFallback` missing; call args differ.

- [ ] **Step 3: Rust dispatch**

In `speech.rs`, near `enum Engine`:

```rust
use crate::voice_providers::http::{CloudError, CloudErrorKind};
use crate::voice_providers::CloudProvider;

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SttProvider {
    Local,
    Apple,
    Openai,
    Elevenlabs,
    Gemini,
    Openrouter,
}

impl SttProvider {
    /// Callers that predate providers pass only a model id.
    fn infer(provider: Option<SttProvider>, model_id: &str) -> SttProvider {
        provider.unwrap_or(if model_id == APPLE_MODEL_ID { Self::Apple } else { Self::Local })
    }

    fn cloud(self) -> Option<CloudProvider> {
        match self {
            Self::Openai => Some(CloudProvider::Openai),
            Self::Elevenlabs => Some(CloudProvider::Elevenlabs),
            Self::Gemini => Some(CloudProvider::Gemini),
            Self::Openrouter => Some(CloudProvider::Openrouter),
            Self::Local | Self::Apple => None,
        }
    }
}

#[derive(Debug)]
enum FallbackStt {
    Apple(String),
    Sherpa(&'static str),
}

/// Spec §5.4: Apple Speech when ready for a locale, else the first downloaded sherpa model.
fn pick_fallback(apple_locale_ready: Option<String>, ready_sherpa: &[&'static str]) -> Option<FallbackStt> {
    if let Some(locale) = apple_locale_ready {
        return Some(FallbackStt::Apple(locale));
    }
    ready_sherpa.first().map(|id| FallbackStt::Sherpa(id))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FallbackEvent {
    usage: String,
    provider: &'static str,
    reason: CloudErrorKind,
    fallback: String,
}

async fn fallback_transcriber(
    app: &AppHandle,
    state: &SpeechState,
    fallback_locale: Option<String>,
) -> Option<(Box<dyn Transcriber>, String)> {
    let apple_ready = match (crate::speech_apple::bridge(), fallback_locale) {
        (Some(bridge), Some(locale)) => {
            let check = locale.clone();
            let ready = tokio::task::spawn_blocking(move || {
                crate::speech_apple::native_status(bridge.authorization(), &bridge.locales(), Some(&check)) == "ready"
            })
            .await
            .unwrap_or(false);
            ready.then_some(locale)
        }
        _ => None,
    };
    let root = models_root(app).ok()?;
    let ready: Vec<&'static str> = CATALOG
        .iter()
        .filter(|entry| model_ready(&root.join(entry.id), entry))
        .map(|entry| entry.id)
        .collect();
    match pick_fallback(apple_ready, &ready)? {
        FallbackStt::Apple(locale) => transcriber_for(app, state, APPLE_MODEL_ID, Some(&locale))
            .ok()
            .map(|t| (t, APPLE_MODEL_ID.to_string())),
        FallbackStt::Sherpa(id) => transcriber_for(app, state, id, None).ok().map(|t| (t, id.to_string())),
    }
}
```

`fallback_transcriber` reuses `transcriber_for` (unchanged). `CATALOG` must still hold only STT entries here; Task 14 keeps TTS entries in a separate list.

Replace `speech_prepare` signature and add the cloud branch at the top:

```rust
#[tauri::command]
pub async fn speech_prepare(
    app: AppHandle,
    state: State<'_, SpeechState>,
    provider: Option<SttProvider>,
    model_id: String,
    locale: Option<String>,
) -> Result<bool, String> {
    if let Some(cloud) = SttProvider::infer(provider, &model_id).cloud() {
        return Ok(crate::voice_providers::keys::read_key(&app, cloud)?.is_some());
    }
    // ... existing body unchanged ...
}
```

Replace `speech_stop_and_transcribe`:

```rust
#[tauri::command]
pub async fn speech_stop_and_transcribe(
    app: AppHandle,
    state: State<'_, SpeechState>,
    provider: Option<SttProvider>,
    model_id: String,
    locale: Option<String>,
    fallback_locale: Option<String>,
    usage: Option<String>,
) -> Result<String, String> {
    let audio = stop_capture(&state)?;
    if audio.samples.len() < (SAMPLE_RATE as usize) / 6 {
        return Err("Recording was too short — hold a bit longer, then release.".into());
    }
    if audio.peak < 0.005 {
        return Err(
            "No audio captured. Check the microphone and that PipeWire/PulseAudio can see it."
                .into(),
        );
    }
    let Some(cloud) = SttProvider::infer(provider, &model_id).cloud() else {
        let transcriber = transcriber_for(&app, &state, &model_id, locale.as_deref())?;
        return transcribe_on_worker(transcriber, audio.samples, audio.sample_rate).await;
    };
    let trimmed = trim_silence(&audio.samples).to_vec();
    let error = match crate::voice_providers::keys::read_key(&app, cloud)? {
        Some(key) => match crate::voice_providers::stt_cloud::transcribe(
            cloud, &model_id, &key, &trimmed, audio.sample_rate,
        )
        .await
        {
            Ok(text) => return Ok(text),
            Err(error) => error,
        },
        None => CloudError::of(CloudErrorKind::Auth),
    };
    let _ = crate::diagnostics::append_spawn_log(&app, &format!("voice stt: {} failed: {error}", cloud.id()));
    let Some((transcriber, fallback)) = fallback_transcriber(&app, &state, fallback_locale).await else {
        return Err(error.to_string());
    };
    let _ = app.emit(
        "voice://fallback",
        FallbackEvent {
            usage: usage.unwrap_or_else(|| "dictation".into()),
            provider: cloud.id(),
            reason: error.kind,
            fallback,
        },
    );
    transcribe_on_worker(transcriber, audio.samples, audio.sample_rate).await
}
```

The log line goes to `spawn.log` and contains only the provider id and the error's `Display` (class + HTTP status) — never the key or a body.

Update the Apple native-locale error message in `engine_for` from `Preferences → Integrations → Voice dictation` to `Preferences → Voice`, and the not-downloaded message in `transcriber_for` from `Preferences → Integrations → Voice` to `Preferences → Voice`.

- [ ] **Step 4: TS wrappers and consumers**

`src/lib/tauri/speech.ts`:

```ts
import type { CloudVoiceProviderId, SttProviderId } from '../types'
import type { CloudErrorKind } from './voiceProviders'

export type SttCallOptions = { provider: SttProviderId; fallbackLocale: string | null; usage: string }

/** Loads the model, requests Apple permission, or checks a cloud key; true when ready. */
export async function speechPrepare(
  modelId: string,
  locale?: string | null,
  provider?: SttProviderId,
): Promise<boolean> {
  return invoke('speech_prepare', { provider: provider ?? null, modelId, locale: locale ?? null })
}

/** Stop capture and transcribe with the chosen provider; a cloud failure falls back to local. */
export async function speechStopAndTranscribe(
  modelId: string,
  locale?: string | null,
  options?: SttCallOptions,
): Promise<string> {
  return invoke('speech_stop_and_transcribe', {
    provider: options?.provider ?? null,
    modelId,
    locale: locale ?? null,
    fallbackLocale: options?.fallbackLocale ?? null,
    usage: options?.usage ?? null,
  })
}

export type VoiceFallbackEvent = {
  usage: string
  provider: CloudVoiceProviderId
  reason: CloudErrorKind
  fallback: string
}

export async function onVoiceFallback(handler: (event: VoiceFallbackEvent) => void): Promise<UnlistenFn> {
  return listen<VoiceFallbackEvent>('voice://fallback', (event) => handler(event.payload))
}
```

Callers:
- `DictationButton/index.tsx:88` → `speechStopAndTranscribe(engine.modelId, engine.locale, { provider: engine.provider, fallbackLocale: engine.fallbackLocale, usage: 'dictation' })`; line 121 → `speechPrepare(engine.modelId, engine.locale, engine.provider)`.
- `VoiceCommand/index.tsx:356,394,456` → same, `usage: 'conversation'`.
- `controller.ts:183,230` → same, `usage: 'conversation'`. In `controller.ts` the not-ready notice becomes:

```ts
        store().patch({
          notice: {
            key:
              engine.provider === 'apple'
                ? 'speech.nativeNotReady'
                : isCloudProvider(engine.provider)
                  ? 'voice.cloud.noKey'
                  : 'voice.conv.modelMissing',
          },
        })
```

and the same three-way choice in `DictationButton` and `VoiceCommand` where they pick their not-ready message.

- [ ] **Step 5: Fallback toast hook**

`src/hooks/useVoiceFallbackToasts.ts`:

```ts
import { useEffect } from 'react'

import { useT } from '../lib/i18n'
import type { MessageKey } from '../lib/i18n/messages/en'
import { onVoiceFallback } from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

const ENGINE_NAME: Record<string, MessageKey> = {
  'apple-speech': 'voice.provider.apple',
  system: 'voice.provider.system',
}

/** Tells the person when a cloud voice provider failed and which local engine took over. */
export function useVoiceFallbackToasts(): void {
  const t = useT()
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void onVoiceFallback((event) => {
      const provider = t(`voice.provider.${event.provider}` as MessageKey)
      const engine = ENGINE_NAME[event.fallback] ? t(ENGINE_NAME[event.fallback]) : t('voice.provider.local')
      useUiStore.getState().pushToast({
        title: t('voice.fallback.title', { provider }),
        body: `${t(`prefs.voiceTestFailed.${event.reason}` as MessageKey)} ${t('voice.fallback.used', { engine })}`,
      })
      if (event.reason === 'auth') {
        const store = useProjectsStore.getState()
        const flags = store.preferences.voiceProviders
        store.setPreferences({
          voiceProviders: { ...flags, [event.provider]: { configured: true, invalid: true } },
        })
      }
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [t])
}
```

`src/App.tsx`: call `useVoiceFallbackToasts()` next to `useVoiceProviderStatus(...)`.

- [ ] **Step 6: i18n keys**

| key | en | pt-BR | zh-CN |
|---|---|---|---|
| `voice.fallback.title` | {{provider}} unavailable | {{provider}} indisponível | {{provider}} 不可用 |
| `voice.fallback.used` | Used {{engine}} instead. | Usado {{engine}} no lugar. | 已改用 {{engine}}。 |
| `voice.cloud.noKey` | This voice provider has no API key. Add one in Preferences → Voice. | Este provedor de voz não tem chave de API. Adicione em Preferências → Voz. | 此语音提供方没有 API 密钥。请在 偏好设置 → 语音 中添加。 |

- [ ] **Step 7: Run the checks**

Run: `cd src-tauri && cargo test --lib && cargo clippy --lib -- -D warnings`, then `npx vitest run && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 8: Checkpoint**

Show `git status --short`; ask; on yes: `git commit -m "feat(voice): transcribe with cloud providers and fall back to local engines"`.

---

### Task 9: Speech-to-text provider cards in the Dictation and Conversation tabs

**Files:**
- Create: `voice/ProviderChoiceCard.tsx`, `ProviderChoiceCard.module.css`, `voice/SttProviderChoices.tsx`, `SttProviderChoices.module.css`, `SttProviderChoices.test.tsx`, `voice/useVoiceCatalog.ts`
- Modify: `VoiceDictationSection.tsx` (remove the `dictation-model` section and its state), `VoiceDictationSection.test.tsx`, `VoiceDictationSection.locale.test.tsx`, `VoicePage.tsx`, locale files

**Interfaces:**
- Consumes: `useSpeechInventory`, `PROVIDER_META`, `withSttChoice`, `voiceProviderCatalog`, `speechNativeLocales`.
- Produces:
  ```ts
  type ChoiceRow = { id: string; label: string; detail?: string; selected: boolean; disabled?: boolean }
  ProviderChoiceCard(props: {
    icon: LucideIcon; title: string; badge: 'device' | 'cloud'; subtitle: string
    rows: ChoiceRow[]; onSelect: (id: string) => void
    locked?: { label: string; onClick: () => void }   // cloud without key
    note?: string; children?: ReactNode
  })
  SttProviderChoices({ use, onOpenProvider }: { use: VoiceUse; onOpenProvider: (id: VoiceProviderId) => void })
  useVoiceCatalog(): VoiceProviderCatalog[]
  ```

- [ ] **Step 1: Write the failing test**

`SttProviderChoices.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../../../lib/types'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { SttProviderChoices } from './SttProviderChoices'

const tauri = vi.hoisted(() => ({
  speechListModels: vi.fn(),
  speechModelStates: vi.fn(),
  speechNativeLocales: vi.fn().mockResolvedValue([{ id: 'pt-BR', name: 'Português', installed: true }]),
  voiceProviderCatalog: vi.fn(),
}))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/i18n', () => ({
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const prefs = () => useProjectsStore.getState().preferences

afterEach(cleanup)

describe('SttProviderChoices', () => {
  beforeEach(() => {
    useProjectsStore.getState().hydrate(EMPTY_PROJECTS_FILE)
    tauri.speechListModels.mockResolvedValue([
      { id: 'parakeet-tdt-0.6b-v3-int8', label: 'Parakeet', kind: 'download', capability: 'stt', sizeBytes: 1 },
      { id: 'piper-pt', label: 'Piper', kind: 'download', capability: 'tts', sizeBytes: 1 },
    ])
    tauri.speechModelStates.mockResolvedValue([{ id: 'parakeet-tdt-0.6b-v3-int8', status: 'ready' }])
    tauri.voiceProviderCatalog.mockResolvedValue([
      { provider: 'openai', keyUrl: 'https://x', voices: [], models: [{ id: 'whisper-1', label: 'Whisper', capability: 'stt' }] },
      { provider: 'gemini', keyUrl: 'https://x', voices: [], models: [{ id: 'gemini-2.5-flash', label: 'Flash', capability: 'stt' }] },
    ])
    useProjectsStore.getState().setPreferences({ voiceProviders: { openai: { configured: true, invalid: false } } })
  })

  it('selects a cloud model for one use only', async () => {
    render(<SttProviderChoices use="conversation" onOpenProvider={() => undefined} />)
    fireEvent.click(await screen.findByRole('radio', { name: /Whisper/ }))
    expect(prefs().voiceStt.conversation).toEqual({ provider: 'openai', model: 'whisper-1', locale: null })
    expect(prefs().voiceStt.dictation.provider).toBe('local')
  })

  it('locks a provider without a key and links to its setup', async () => {
    const onOpen = vi.fn()
    render(<SttProviderChoices use="dictation" onOpenProvider={onOpen} />)
    const flash = await screen.findByRole('radio', { name: /Flash/ })
    expect((flash as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceActionSetUpKey voice.provider.gemini' }))
    expect(onOpen).toHaveBeenCalledWith('gemini')
  })

  it('lists only speech-to-text local models', async () => {
    render(<SttProviderChoices use="dictation" onOpenProvider={() => undefined} />)
    expect(await screen.findByRole('radio', { name: /Parakeet/ })).toBeTruthy()
    expect(screen.queryByRole('radio', { name: /Piper/ })).toBeNull()
  })
})
```

In `VoiceDictationSection.test.tsx` / `.locale.test.tsx`, delete the cases that exercise the model dropdown, download/delete buttons and native locale (they move to `SttProviderChoices` and `LocalModelList`); keep on/off, mode and microphone cases.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/modals/preferences/voice/SttProviderChoices.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: `useVoiceCatalog` and `ProviderChoiceCard`**

`useVoiceCatalog.ts`:

```ts
import { useEffect, useState } from 'react'

import { voiceProviderCatalog, type VoiceProviderCatalog } from '../../../../lib/tauri'

export function useVoiceCatalog(): VoiceProviderCatalog[] {
  const [catalog, setCatalog] = useState<VoiceProviderCatalog[]>([])
  useEffect(() => {
    let cancelled = false
    void voiceProviderCatalog()
      .then((list) => {
        if (!cancelled) setCatalog(list)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  return catalog
}
```

`ProviderChoiceCard.tsx`:

```tsx
import { Check, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { useT } from '../../../../lib/i18n'
import styles from './ProviderChoiceCard.module.css'

export type ChoiceRow = { id: string; label: string; detail?: string; selected: boolean; disabled?: boolean }

export function ProviderChoiceCard({
  icon: Icon,
  title,
  badge,
  subtitle,
  rows,
  onSelect,
  locked,
  note,
  children,
}: {
  icon: LucideIcon
  title: string
  badge: 'device' | 'cloud'
  subtitle: string
  rows: ChoiceRow[]
  onSelect: (id: string) => void
  locked?: { label: string; onClick: () => void }
  note?: string
  children?: ReactNode
}) {
  const t = useT()
  const active = rows.some((row) => row.selected)
  return (
    <section className={styles.card} data-active={active ? '' : undefined} data-locked={locked ? '' : undefined}>
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          <Icon size={16} />
        </span>
        <div className={styles.heading}>
          <div className={styles.titleRow}>
            <h3>{title}</h3>
            <span className={styles.badge}>{t(badge === 'device' ? 'prefs.voiceBadgeDevice' : 'prefs.voiceBadgeCloud')}</span>
          </div>
          <p>{subtitle}</p>
        </div>
      </header>
      <div className={styles.rows} role="radiogroup" aria-label={title}>
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            role="radio"
            aria-checked={row.selected}
            disabled={row.disabled || Boolean(locked)}
            className={row.selected ? styles.rowSelected : styles.row}
            onClick={() => onSelect(row.id)}
          >
            <span className={styles.rowText}>
              <strong>{row.label}</strong>
              {row.detail ? <small>{row.detail}</small> : null}
            </span>
            {row.selected ? <Check size={14} className={styles.check} aria-hidden="true" /> : null}
          </button>
        ))}
      </div>
      {children}
      {locked ? (
        <button type="button" className={styles.locked} aria-label={`${locked.label} ${title}`} onClick={locked.onClick}>
          {locked.label}
        </button>
      ) : null}
      {note ? <p className={styles.note}>{note}</p> : null}
    </section>
  )
}
```

`ProviderChoiceCard.module.css`:

```css
.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-card-default);
}

.card[data-active] {
  border-color: var(--border-strong);
}

.card[data-locked] .rows {
  opacity: 0.55;
}

.header {
  display: flex;
  gap: 10px;
}

.icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--fg);
  background: var(--bg-sunken);
}

.heading {
  min-width: 0;
}

.titleRow {
  display: flex;
  align-items: center;
  gap: 8px;
}

.titleRow h3 {
  margin: 0;
  color: var(--fg);
  font-size: 13px;
  font-weight: 650;
}

.heading p {
  margin: 2px 0 0;
  color: var(--fg-muted);
  font-size: 11px;
}

.badge {
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--fg-muted);
  font-size: 10px;
  font-weight: 600;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.row,
.rowSelected {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  color: var(--fg);
  background: var(--bg-sunken);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--anim-fast) var(--ease-out-fluid),
    background-color var(--anim-fast) var(--ease-out-fluid);
}

.row:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--panel-hover);
}

.row:disabled {
  cursor: not-allowed;
}

.rowSelected {
  border-color: var(--accent-border);
  background: var(--surface-card-selected);
}

.rowText {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.rowText strong {
  font-size: 12px;
  font-weight: 600;
}

.rowText small {
  color: var(--fg-muted);
  font-size: 11px;
}

.check {
  flex: none;
  color: var(--accent);
}

.locked {
  align-self: flex-start;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--fg);
  background: transparent;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.note {
  margin: 0;
  color: var(--fg-muted);
  font-size: 11px;
  line-height: 1.5;
}
```

- [ ] **Step 4: `SttProviderChoices`**

```tsx
import { useEffect, useState } from 'react'

import { useT } from '../../../../lib/i18n'
import {
  APPLE_SPEECH_MODEL_ID,
  type NativeLocale,
  speechDownloadModel,
  speechNativeLocales,
} from '../../../../lib/tauri'
import type { SttChoice, VoiceUse } from '../../../../lib/types'
import { CLOUD_VOICE_PROVIDERS } from '../../../../lib/voice/providers'
import { withSttChoice } from '../../../../lib/voice/voicePreferences'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { Dropdown } from '../../../ui/Dropdown'
import controls from '../../controls.module.css'
import { ProviderChoiceCard } from './ProviderChoiceCard'
import { PROVIDER_META, type VoiceProviderId } from './providerMeta'
import styles from './SttProviderChoices.module.css'
import { useSpeechInventory } from './useSpeechInventory'
import { useVoiceCatalog } from './useVoiceCatalog'

export function SttProviderChoices({
  use,
  onOpenProvider,
}: {
  use: VoiceUse
  onOpenProvider: (id: VoiceProviderId) => void
}) {
  const t = useT()
  const voiceStt = useProjectsStore((s) => s.preferences.voiceStt)
  const flags = useProjectsStore((s) => s.preferences.voiceProviders)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const current = voiceStt[use]
  const { models, states, refresh } = useSpeechInventory(current.provider === 'apple' ? current.locale : null)
  const catalog = useVoiceCatalog()
  const [locales, setLocales] = useState<NativeLocale[] | null>(null)
  const appleAvailable = models.some((model) => model.id === APPLE_SPEECH_MODEL_ID)

  useEffect(() => {
    if (!appleAvailable) return
    let cancelled = false
    void speechNativeLocales()
      .then((list) => {
        if (!cancelled) setLocales(list)
      })
      .catch(() => {
        if (!cancelled) setLocales([])
      })
    return () => {
      cancelled = true
    }
  }, [appleAvailable])

  const choose = (choice: SttChoice) => setPreferences(withSttChoice({ voiceStt }, use, choice))
  const selected = (provider: string, model: string) =>
    current.provider === provider && current.model === model

  const localRows = models
    .filter((model) => model.kind === 'download' && (model.capability ?? 'stt') === 'stt')
    .map((model) => {
      const ready = states[model.id]?.status === 'ready'
      return {
        id: model.id,
        label: model.label,
        detail: t(ready ? 'prefs.voiceModelReady' : 'prefs.voiceModelNotDownloaded'),
        selected: selected('local', model.id),
        disabled: !ready,
      }
    })

  return (
    <div className={styles.grid}>
      {appleAvailable ? (
        <ProviderChoiceCard
          icon={PROVIDER_META.apple.icon}
          title={t('voice.provider.apple')}
          badge="device"
          subtitle={t('prefs.voiceProviderAppleDesc')}
          rows={[{ id: APPLE_SPEECH_MODEL_ID, label: t('voice.provider.apple'), selected: current.provider === 'apple' }]}
          onSelect={() =>
            choose({
              provider: 'apple',
              model: APPLE_SPEECH_MODEL_ID,
              locale: current.provider === 'apple' ? current.locale : null,
            })
          }
        >
          {current.provider === 'apple' ? (
            <Dropdown
              value={current.locale ?? ''}
              ariaLabel={t('prefs.dictationNativeLocale')}
              onChange={(value) => choose({ provider: 'apple', model: APPLE_SPEECH_MODEL_ID, locale: value || null })}
              options={[
                { value: '', label: t('prefs.dictationNativeLocaleChoose') },
                ...(locales ?? []).map((locale) => ({
                  value: locale.id,
                  label: t(
                    locale.installed ? 'prefs.dictationNativeLocaleInstalled' : 'prefs.dictationNativeLocaleNeedsInstall',
                    { name: locale.name },
                  ),
                })),
              ]}
            />
          ) : null}
          {current.provider === 'apple' && current.locale && states[APPLE_SPEECH_MODEL_ID]?.status === 'not-installed' ? (
            <button
              type="button"
              className={controls.btn}
              onClick={() => void speechDownloadModel(APPLE_SPEECH_MODEL_ID, current.locale).then(refresh)}
            >
              {t('prefs.dictationNativeInstall')}
            </button>
          ) : null}
        </ProviderChoiceCard>
      ) : null}
      <ProviderChoiceCard
        icon={PROVIDER_META.local.icon}
        title={t('voice.provider.local')}
        badge="device"
        subtitle={t('prefs.voiceProviderLocalDesc')}
        rows={localRows}
        onSelect={(id) => choose({ provider: 'local', model: id, locale: null })}
        note={localRows.some((row) => row.disabled) ? t('prefs.voiceDownloadHint') : undefined}
      />
      {CLOUD_VOICE_PROVIDERS.map((provider) => {
        const entry = catalog.find((item) => item.provider === provider)
        if (!entry) return null
        const configured = flags[provider]?.configured === true
        const name = t(PROVIDER_META[provider].name)
        return (
          <ProviderChoiceCard
            key={provider}
            icon={PROVIDER_META[provider].icon}
            title={name}
            badge="cloud"
            subtitle={t(PROVIDER_META[provider].description)}
            rows={entry.models
              .filter((model) => model.capability === 'stt')
              .map((model) => ({ id: model.id, label: model.label, selected: selected(provider, model.id) }))}
            onSelect={(id) => choose({ provider, model: id, locale: null })}
            locked={configured ? undefined : { label: t('prefs.voiceActionSetUpKey'), onClick: () => onOpenProvider(provider) }}
            note={configured ? t('prefs.voiceCloudSendsAudio', { provider: name }) : undefined}
          />
        )
      })}
    </div>
  )
}
```

`SttProviderChoices.module.css`:

```css
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}
```

- [ ] **Step 5: Wire into the page and trim the dictation section**

`VoicePage.tsx`: in the dictation tab render `<SttProviderChoices use="dictation" onOpenProvider={setDetail} />` above `<VoiceDictationSection />`; in the conversation tab render `<SttProviderChoices use="conversation" onOpenProvider={setDetail} />` above `<VoiceConversationSection part="conversation" />`.

`VoiceDictationSection.tsx`: delete the `dictation-model` `SettingsSection`, and with it `models`, `states`, `download`, `bytesPerSecond`, `rateRef`, `locales`, `busy`, `refreshStates`, the three effects that feed them, `downloadModel`, `deleteModel`, `engineLabel`, `engineDescription`, `engineSubtitle`, `nativeStatus`, `setBothUses`, `choiceFor` and `formatBytes`, plus the imports they used. Keep `mics` loading (only `speechListInputDevices`), `enableDictation`, `error`, and the on/off, mode and microphone sections. Delete i18n keys that are now unused only if `grep -rn "<key>" src` finds no other user (`prefs.dictationModel*`, `prefs.dictationEngine*`, `prefs.dictationNative*` are still used by `SttProviderChoices` for locale labels — keep those).

- [ ] **Step 6: i18n keys**

| key | en | pt-BR | zh-CN |
|---|---|---|---|
| `prefs.voiceBadgeDevice` | On device | No dispositivo | 设备端 |
| `prefs.voiceBadgeCloud` | Cloud | Nuvem | 云端 |
| `prefs.voiceCloudSendsAudio` | Audio is sent to {{provider}}. | O áudio é enviado ao {{provider}}. | 音频将发送至 {{provider}}。 |
| `prefs.voiceDownloadHint` | Download models in Providers → Local models. | Baixe modelos em Provedores → Modelos locais. | 在 提供方 → 本地模型 中下载模型。 |

- [ ] **Step 7: Run the checks**

Run: `npx vitest run src/components/modals && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 8: Checkpoint**

Show `git status --short`; ask; on yes: `git commit -m "feat(voice): pick the speech-to-text provider per use"`.

---

## Phase 4 — Text-to-speech providers

### Task 10: PCM output player (Rust)

**Files:**
- Create: `src-tauri/src/audio_out.rs`
- Modify: `src-tauri/src/lib.rs` (mod list)

**Interfaces:**
- Produces:
  ```rust
  pub struct PcmQueue { .. }
  impl PcmQueue { pub fn new() -> Self; pub fn begin(&mut self, id: u64); pub fn push(&mut self, id: u64, samples: &[f32]);
                  pub fn close(&mut self, id: u64); pub fn clear(&mut self); pub fn pull(&mut self, out: &mut [f32]) -> Option<u64> }
  pub fn pcm16le_to_f32(bytes: &[u8]) -> Vec<f32>
  pub fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32>
  pub struct AudioOut;  impl AudioOut { pub fn begin(&self, id: u64); pub fn push(&self, id: u64, samples: &[f32], rate: u32); pub fn close(&self, id: u64); pub fn stop(&self) }
  pub fn get(on_finished: impl Fn(u64) + Send + 'static) -> Result<&'static AudioOut, String>
  pub fn stop_if_running()
  ```
- Semantics: one utterance at a time. `begin(id)` drops whatever was queued. Chunks for the current id are appended; chunks for any other id are ignored. `pull` reports the id **once**, after `close(id)` and when its samples have drained. `clear`/`stop` drop everything without reporting.

- [ ] **Step 1: Write the failing tests** (bottom of `audio_out.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_stop_drops_queued_audio() {
        let mut queue = PcmQueue::new();
        queue.begin(1);
        queue.push(1, &[0.5; 10]);
        queue.close(1);
        queue.clear();
        let mut out = [9.0; 4];
        assert_eq!(queue.pull(&mut out), None);
        assert_eq!(out, [0.0; 4]);
    }

    #[test]
    fn finish_is_reported_once_after_close_and_drain() {
        let mut queue = PcmQueue::new();
        queue.begin(7);
        queue.push(7, &[0.1, 0.2, 0.3]);
        let mut out = [0.0; 2];
        assert_eq!(queue.pull(&mut out), None);
        queue.close(7);
        assert_eq!(queue.pull(&mut out), Some(7));
        assert_eq!(queue.pull(&mut out), None);
    }

    #[test]
    fn an_open_utterance_waits_for_more_chunks() {
        let mut queue = PcmQueue::new();
        queue.begin(3);
        queue.push(3, &[0.1]);
        let mut out = [0.0; 4];
        assert_eq!(queue.pull(&mut out), None, "drained but not closed");
        queue.push(3, &[0.2]);
        queue.close(3);
        assert_eq!(queue.pull(&mut out), Some(3));
        assert_eq!(out[0], 0.2);
    }

    #[test]
    fn chunks_of_an_interrupted_utterance_are_ignored() {
        let mut queue = PcmQueue::new();
        queue.begin(1);
        queue.begin(2);
        queue.push(1, &[0.9; 4]);
        queue.close(1);
        let mut out = [0.0; 4];
        assert_eq!(queue.pull(&mut out), None);
        assert_eq!(out, [0.0; 4]);
    }

    #[test]
    fn pcm16_decodes_to_unit_floats() {
        let bytes = [0x00, 0x00, 0xff, 0x7f, 0x01, 0x80];
        let samples = pcm16le_to_f32(&bytes);
        assert_eq!(samples[0], 0.0);
        assert!((samples[1] - 1.0).abs() < 1e-4);
        assert!((samples[2] + 1.0).abs() < 1e-4);
    }

    #[test]
    fn resampling_scales_the_length() {
        assert_eq!(resample_linear(&[0.0; 240], 24_000, 48_000).len(), 480);
        assert_eq!(resample_linear(&[0.0; 480], 48_000, 24_000).len(), 240);
        assert_eq!(resample_linear(&[0.25; 3], 16_000, 16_000), vec![0.25; 3]);
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib audio_out`
Expected: compile error — module not found.

- [ ] **Step 3: Implement**

`lib.rs`: add `mod audio_out;`.

`audio_out.rs`:

```rust
//! One output stream for synthesized speech (cloud and local voices). `cpal::Stream` is `!Send`,
//! so the stream lives on its own thread; callers only touch the shared queue.

use std::collections::VecDeque;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;

pub struct PcmQueue {
    samples: VecDeque<f32>,
    current: Option<u64>,
    closed: bool,
}

impl PcmQueue {
    pub fn new() -> Self {
        Self { samples: VecDeque::new(), current: None, closed: false }
    }

    pub fn begin(&mut self, id: u64) {
        self.samples.clear();
        self.current = Some(id);
        self.closed = false;
    }

    pub fn push(&mut self, id: u64, samples: &[f32]) {
        if self.current == Some(id) {
            self.samples.extend(samples.iter().copied());
        }
    }

    pub fn close(&mut self, id: u64) {
        if self.current == Some(id) {
            self.closed = true;
        }
    }

    pub fn clear(&mut self) {
        self.samples.clear();
        self.current = None;
        self.closed = false;
    }

    /// Fills `out` (silence past the end) and returns the id that just finished, if any.
    pub fn pull(&mut self, out: &mut [f32]) -> Option<u64> {
        for sample in out.iter_mut() {
            *sample = self.samples.pop_front().unwrap_or(0.0);
        }
        if self.closed && self.samples.is_empty() {
            self.closed = false;
            return self.current.take();
        }
        None
    }
}

pub fn pcm16le_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / i16::MAX as f32)
        .collect()
}

pub fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() || from == 0 {
        return input.to_vec();
    }
    let len = ((input.len() as u64 * to as u64) / from as u64) as usize;
    let step = from as f64 / to as f64;
    (0..len)
        .map(|index| {
            let position = index as f64 * step;
            let base = position.floor() as usize;
            let next = (base + 1).min(input.len() - 1);
            let fraction = (position - base as f64) as f32;
            input[base.min(input.len() - 1)] * (1.0 - fraction) + input[next] * fraction
        })
        .collect()
}

pub struct AudioOut {
    queue: Arc<Mutex<PcmQueue>>,
    device_rate: u32,
}

impl AudioOut {
    fn with_queue(&self, work: impl FnOnce(&mut PcmQueue)) {
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        work(&mut queue);
    }

    pub fn begin(&self, id: u64) {
        self.with_queue(|queue| queue.begin(id));
    }

    pub fn push(&self, id: u64, samples: &[f32], rate: u32) {
        let resampled = resample_linear(samples, rate, self.device_rate);
        self.with_queue(|queue| queue.push(id, &resampled));
    }

    pub fn close(&self, id: u64) {
        self.with_queue(|queue| queue.close(id));
    }

    pub fn stop(&self) {
        self.with_queue(PcmQueue::clear);
    }
}

static OUT: OnceLock<Result<AudioOut, String>> = OnceLock::new();

/// The shared player, opened on first use. `on_finished` runs on a worker thread, never on the
/// audio callback.
pub fn get(on_finished: impl Fn(u64) + Send + 'static) -> Result<&'static AudioOut, String> {
    OUT.get_or_init(|| open(on_finished)).as_ref().map_err(Clone::clone)
}

pub fn stop_if_running() {
    if let Some(Ok(out)) = OUT.get() {
        out.stop();
    }
}

fn open(on_finished: impl Fn(u64) + Send + 'static) -> Result<AudioOut, String> {
    let queue = Arc::new(Mutex::new(PcmQueue::new()));
    let (finished_tx, finished_rx) = mpsc::channel::<u64>();
    std::thread::spawn(move || {
        while let Ok(id) = finished_rx.recv() {
            on_finished(id);
        }
    });

    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
    let stream_queue = Arc::clone(&queue);
    std::thread::spawn(move || {
        let built = (|| -> Result<(cpal::Stream, u32), String> {
            let device = cpal::default_host()
                .default_output_device()
                .ok_or_else(|| "no audio output device".to_string())?;
            let supported = device.default_output_config().map_err(|e| e.to_string())?;
            let channels = supported.channels() as usize;
            let rate = supported.sample_rate().0;
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            let mut mono: Vec<f32> = Vec::new();
            let mut fill = move |frames: usize| -> Vec<f32> {
                mono.resize(frames, 0.0);
                let finished = stream_queue.lock().unwrap_or_else(|e| e.into_inner()).pull(&mut mono);
                if let Some(id) = finished {
                    let _ = finished_tx.send(id);
                }
                mono.clone()
            };
            let on_error = |error| eprintln!("audio_out: stream error: {error}");
            let stream = match format {
                SampleFormat::F32 => device.build_output_stream(
                    &config,
                    move |data: &mut [f32], _| {
                        let mono = fill(data.len() / channels);
                        for (frame, value) in data.chunks_mut(channels).zip(mono) {
                            frame.fill(value);
                        }
                    },
                    on_error,
                    None,
                ),
                SampleFormat::I16 => device.build_output_stream(
                    &config,
                    move |data: &mut [i16], _| {
                        let mono = fill(data.len() / channels);
                        for (frame, value) in data.chunks_mut(channels).zip(mono) {
                            frame.fill((value * i16::MAX as f32) as i16);
                        }
                    },
                    on_error,
                    None,
                ),
                other => return Err(format!("unsupported output sample format: {other:?}")),
            }
            .map_err(|e| e.to_string())?;
            stream.play().map_err(|e| e.to_string())?;
            Ok((stream, rate))
        })();
        match built {
            Ok((stream, rate)) => {
                let _ = ready_tx.send(Ok(rate));
                // The stream must outlive every caller; this thread owns it for the app's life.
                let _keep = stream;
                loop {
                    std::thread::park();
                }
            }
            Err(error) => {
                let _ = ready_tx.send(Err(error));
            }
        }
    });

    let device_rate = ready_rx
        .recv()
        .map_err(|_| "audio output thread exited".to_string())??;
    Ok(AudioOut { queue, device_rate })
}
```

(Stream errors go to stderr with `eprintln!`, matching `speech_capture.rs`; there is no `AppHandle` on the audio thread.)

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test --lib audio_out && cargo clippy --lib -- -D warnings`
Expected: PASS (`dead_code` warnings for `get`/`AudioOut` are fine to silence with `#[allow(dead_code)]` only until Task 11 uses them — remove the attribute in Task 11).

- [ ] **Step 5: Checkpoint**

Show `git status --short`; ask; on yes: `git commit -m "feat(voice): add a PCM output player for synthesized speech"`.

---

### Task 11: Cloud text-to-speech and provider dispatch (Rust)

**Files:**
- Create: `src-tauri/src/voice_providers/tts_cloud.rs`
- Modify: `src-tauri/src/voice_providers/mod.rs`, `src-tauri/src/tts.rs` (+ tests)

**Interfaces:**
- Consumes: Task 4 `http`, Task 3 `keys::read_key`, `catalog::provider_catalog`, Task 10 `audio_out`.
- Produces (`tts_cloud.rs`):
  ```rust
  pub const MAX_TTS_CHARS: usize = 4000;
  pub const CLOUD_PCM_RATE: u32 = 24_000;
  pub fn split_for_tts(text: &str, max_chars: usize) -> Vec<String>
  pub fn speech_request(provider, model: &str, voice: Option<&str>, key: &str, text: &str, rate: f32) -> Result<HttpRequest, CloudError>
  pub fn parse_speech(provider, body: &[u8]) -> Result<Vec<f32>, CloudError>
  pub fn playback_rate(provider, rate: f32) -> u32
  pub fn voices_request(key: &str) -> HttpRequest            // ElevenLabs account voices
  pub fn parse_voices(body: &[u8]) -> Result<Vec<(String, String)>, CloudError>
  pub async fn synthesize(provider, model, voice: Option<&str>, key, text, rate) -> Result<Vec<f32>, CloudError>
  ```
- Produces (`tts.rs`): `#[serde(rename_all = "lowercase")] pub enum TtsProvider { System, Local, Openai, Elevenlabs, Gemini, Openrouter }`; `tts_speak(text, voice, rate, provider: Option<TtsProvider>, model: Option<String>) -> u64`; `tts_voices(provider: Option<TtsProvider>) -> Vec<TtsVoice>`. Every provider reports `tts://end { id }` for the latest utterance only. A cloud failure before any audio plays falls back to the system voice under the **same id** and emits `voice://fallback { usage: "narration", provider, reason, fallback: "system" }`.

- [ ] **Step 1: Write the failing tests** (bottom of `tts_cloud.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice_providers::http::HttpBody;
    use base64::Engine as _;

    #[test]
    fn split_for_tts_keeps_short_text_whole() {
        assert_eq!(split_for_tts("Olá. Tudo bem?", 100), vec!["Olá. Tudo bem?"]);
        assert!(split_for_tts("   ", 100).is_empty());
    }

    #[test]
    fn split_for_tts_groups_sentences_under_the_limit() {
        let chunks = split_for_tts("One two. Three four. Five six.", 18);
        assert_eq!(chunks, vec!["One two.", "Three four.", "Five six."]);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 18));
        assert_eq!(chunks.join(" "), "One two. Three four. Five six.");
        assert_eq!(split_for_tts("One two. Three four.", 40), vec!["One two. Three four."]);
    }

    #[test]
    fn split_for_tts_cuts_a_long_sentence_at_spaces_without_losing_words() {
        let text = "palavra ".repeat(50);
        let chunks = split_for_tts(&text, 40);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 40));
        let words: Vec<&str> = chunks.iter().flat_map(|c| c.split_whitespace()).collect();
        assert_eq!(words.len(), 50);
    }

    #[test]
    fn speech_requests_ask_for_pcm() {
        let openai = speech_request(CloudProvider::Openai, "gpt-4o-mini-tts", Some("nova"), "k", "hi", 1.5).unwrap();
        assert_eq!(openai.url, "https://api.openai.com/v1/audio/speech");
        let HttpBody::Json(body) = openai.body else { panic!("json") };
        assert_eq!(body["response_format"], "pcm");
        assert_eq!(body["voice"], "nova");
        assert_eq!(body["speed"], 1.5);

        let eleven = speech_request(CloudProvider::Elevenlabs, "eleven_flash_v2_5", Some("v1"), "k", "hi", 1.0).unwrap();
        assert_eq!(eleven.url, "https://api.elevenlabs.io/v1/text-to-speech/v1?output_format=pcm_24000");
        assert!(speech_request(CloudProvider::Elevenlabs, "m", None, "k", "hi", 1.0).is_err());

        let gemini = speech_request(CloudProvider::Gemini, "gemini-2.5-flash-preview-tts", None, "k", "hi", 1.0).unwrap();
        let HttpBody::Json(body) = gemini.body else { panic!("json") };
        assert_eq!(body["generationConfig"]["responseModalities"][0], "AUDIO");
        assert_eq!(body["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"], "Kore");

        let router = speech_request(CloudProvider::Openrouter, "openai/gpt-4o-mini-tts-2025-12-15", Some("alloy"), "k", "hi", 1.0).unwrap();
        assert_eq!(router.url, "https://openrouter.ai/api/v1/audio/speech");
        let HttpBody::Json(body) = router.body else { panic!("json") };
        assert_eq!(body["response_format"], "pcm");
        assert_eq!(body["input"], "hi");
    }

    #[test]
    fn replies_decode_to_samples() {
        let raw = [0x00, 0x00, 0xff, 0x7f];
        assert_eq!(parse_speech(CloudProvider::Openai, &raw).unwrap().len(), 2);
        let encoded = base64::engine::general_purpose::STANDARD.encode(raw);
        let gemini = format!(r#"{{"candidates":[{{"content":{{"parts":[{{"inlineData":{{"mimeType":"audio/L16;rate=24000","data":"{encoded}"}}}}]}}}}]}}"#);
        assert_eq!(parse_speech(CloudProvider::Gemini, gemini.as_bytes()).unwrap().len(), 2);
        assert!(parse_speech(CloudProvider::Gemini, b"{}").is_err());
    }

    #[test]
    fn speed_is_native_where_supported_and_resampled_elsewhere() {
        assert_eq!(playback_rate(CloudProvider::Openai, 1.5), 24_000);
        assert_eq!(playback_rate(CloudProvider::Gemini, 1.5), 36_000);
        assert_eq!(playback_rate(CloudProvider::Elevenlabs, 1.0), 24_000);
        assert_eq!(playback_rate(CloudProvider::Elevenlabs, 1.5), 30_000, "1.2 native x 1.25 resample");
    }

    #[test]
    fn elevenlabs_voices_are_read_from_the_account() {
        let body = br#"{"voices":[{"voice_id":"a1","name":"Ana"},{"voice_id":"b2","name":"Bruno"}]}"#;
        assert_eq!(parse_voices(body).unwrap(), vec![("a1".into(), "Ana".into()), ("b2".into(), "Bruno".into())]);
        assert_eq!(voices_request("k").url, "https://api.elevenlabs.io/v1/voices");
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib tts_cloud`
Expected: compile error — module not found.

- [ ] **Step 3: Implement `tts_cloud.rs`**

`mod.rs`: add `pub mod tts_cloud;`.

```rust
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};

use super::http::{auth_headers, send, CloudError, CloudErrorKind, HttpBody, HttpMethod, HttpRequest};
use super::CloudProvider;
use crate::audio_out::pcm16le_to_f32;

/// Under every provider's single-request limit (OpenAI 4096, ElevenLabs 5000).
pub const MAX_TTS_CHARS: usize = 4000;
/// All four providers return 16-bit mono PCM at 24 kHz when asked for PCM.
pub const CLOUD_PCM_RATE: u32 = 24_000;
const TIMEOUT: Duration = Duration::from_secs(30);
const ELEVENLABS_SPEED: (f32, f32) = (0.7, 1.2);

fn sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    for (index, ch) in text.char_indices() {
        if matches!(ch, '.' | '!' | '?' | '\n') {
            let end = index + ch.len_utf8();
            out.push(&text[start..end]);
            start = end;
        }
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

fn hard_split(sentence: &str, max: usize) -> Vec<String> {
    if sentence.chars().count() <= max {
        return vec![sentence.to_string()];
    }
    let mut pieces = Vec::new();
    let mut current = String::new();
    for word in sentence.split_whitespace() {
        let mut word = word.to_string();
        while word.chars().count() > max {
            let head: String = word.chars().take(max).collect();
            word = word.chars().skip(max).collect();
            if !current.is_empty() {
                pieces.push(std::mem::take(&mut current));
            }
            pieces.push(head);
        }
        let extra = if current.is_empty() { 0 } else { 1 };
        if current.chars().count() + extra + word.chars().count() > max {
            pieces.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(&word);
    }
    if !current.is_empty() {
        pieces.push(current);
    }
    pieces
}

/// Splits at sentence ends, packing sentences up to `max_chars`; never drops a word.
pub fn split_for_tts(text: &str, max_chars: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for sentence in sentences(text) {
        for piece in hard_split(sentence.trim(), max_chars) {
            if piece.is_empty() {
                continue;
            }
            let extra = if current.is_empty() { 0 } else { 1 };
            if !current.is_empty() && current.chars().count() + extra + piece.chars().count() > max_chars {
                chunks.push(std::mem::take(&mut current));
            }
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(&piece);
        }
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    chunks
}

pub fn speech_request(
    provider: CloudProvider,
    model: &str,
    voice: Option<&str>,
    key: &str,
    text: &str,
    rate: f32,
) -> Result<HttpRequest, CloudError> {
    let (url, body) = match provider {
        CloudProvider::Openai | CloudProvider::Openrouter => (
            if provider == CloudProvider::Openai {
                "https://api.openai.com/v1/audio/speech".to_string()
            } else {
                "https://openrouter.ai/api/v1/audio/speech".to_string()
            },
            json!({
                "model": model,
                "input": text,
                "voice": voice.unwrap_or("alloy"),
                "response_format": "pcm",
                "speed": rate.clamp(0.25, 4.0),
            }),
        ),
        CloudProvider::Elevenlabs => {
            let voice = voice.ok_or_else(|| CloudError::of(CloudErrorKind::Other))?;
            (
                format!("https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=pcm_24000"),
                json!({
                    "text": text,
                    "model_id": model,
                    "voice_settings": { "speed": rate.clamp(ELEVENLABS_SPEED.0, ELEVENLABS_SPEED.1) },
                }),
            )
        }
        CloudProvider::Gemini => (
            format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"),
            json!({
                "contents": [{ "parts": [{ "text": text }] }],
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                    "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": voice.unwrap_or("Kore") } } }
                }
            }),
        ),
    };
    Ok(HttpRequest {
        method: HttpMethod::Post,
        url,
        headers: auth_headers(provider, key),
        body: HttpBody::Json(body),
        audio: false,
    })
}

pub fn parse_speech(provider: CloudProvider, body: &[u8]) -> Result<Vec<f32>, CloudError> {
    if provider != CloudProvider::Gemini {
        return Ok(pcm16le_to_f32(body));
    }
    let value: Value = serde_json::from_slice(body).map_err(|_| CloudError::of(CloudErrorKind::Other))?;
    let data = value["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
        .as_str()
        .ok_or_else(|| CloudError::of(CloudErrorKind::Other))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| CloudError::of(CloudErrorKind::Other))?;
    Ok(pcm16le_to_f32(&bytes))
}

/// The rate to declare to the player. Native speed when the provider has one; the remainder is
/// applied by playing the 24 kHz audio faster or slower.
pub fn playback_rate(provider: CloudProvider, rate: f32) -> u32 {
    let residual = match provider {
        CloudProvider::Openai | CloudProvider::Openrouter => 1.0,
        CloudProvider::Elevenlabs => rate / rate.clamp(ELEVENLABS_SPEED.0, ELEVENLABS_SPEED.1),
        CloudProvider::Gemini => rate,
    };
    (CLOUD_PCM_RATE as f32 * residual).round() as u32
}

pub fn voices_request(key: &str) -> HttpRequest {
    HttpRequest {
        method: HttpMethod::Get,
        url: "https://api.elevenlabs.io/v1/voices".to_string(),
        headers: auth_headers(CloudProvider::Elevenlabs, key),
        body: HttpBody::Empty,
        audio: false,
    }
}

pub fn parse_voices(body: &[u8]) -> Result<Vec<(String, String)>, CloudError> {
    let value: Value = serde_json::from_slice(body).map_err(|_| CloudError::of(CloudErrorKind::Other))?;
    let voices = value["voices"].as_array().ok_or_else(|| CloudError::of(CloudErrorKind::Other))?;
    Ok(voices
        .iter()
        .filter_map(|voice| Some((voice["voice_id"].as_str()?.to_string(), voice["name"].as_str()?.to_string())))
        .collect())
}

pub async fn fetch_voices(key: &str) -> Result<Vec<(String, String)>, CloudError> {
    parse_voices(&send(voices_request(key), TIMEOUT).await?)
}

pub async fn synthesize(
    provider: CloudProvider,
    model: &str,
    voice: Option<&str>,
    key: &str,
    text: &str,
    rate: f32,
) -> Result<Vec<f32>, CloudError> {
    let request = speech_request(provider, model, voice, key, text, rate)?;
    parse_speech(provider, &send(request, TIMEOUT).await?)
}
```

The `playback_rate` test for ElevenLabs at 1.5: native 1.2, residual 1.25 → 30 000. OpenRouter's PCM rate is assumed 24 kHz (OpenAI-compatible models); its docs only state it for some models — this is a Review Focus item for the reviewer to try by ear.

- [ ] **Step 4: Dispatch in `tts.rs`**

Add:

```rust
use serde::Deserialize;

use crate::voice_providers::http::CloudErrorKind;
use crate::voice_providers::{catalog, keys, tts_cloud, CloudProvider};

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TtsProvider {
    System,
    Local,
    Openai,
    Elevenlabs,
    Gemini,
    Openrouter,
}

impl TtsProvider {
    fn cloud(self) -> Option<CloudProvider> {
        match self {
            Self::Openai => Some(CloudProvider::Openai),
            Self::Elevenlabs => Some(CloudProvider::Elevenlabs),
            Self::Gemini => Some(CloudProvider::Gemini),
            Self::Openrouter => Some(CloudProvider::Openrouter),
            Self::System | Self::Local => None,
        }
    }
}

fn is_current(id: u64) -> bool {
    CURRENT_ID.load(Ordering::SeqCst) == id
}

fn player(app: &AppHandle) -> Result<&'static crate::audio_out::AudioOut, String> {
    let handle = app.clone();
    crate::audio_out::get(move |id| {
        if is_current(id) {
            let _ = handle.emit("tts://end", serde_json::json!({ "id": id }));
        }
    })
}
```

Rename today's `tts_speak` body into:

```rust
/// The OS voice. `id` is supplied when this speaks for a failed cloud utterance.
async fn speak_system(
    app: AppHandle,
    text: String,
    voice: Option<String>,
    rate: Option<f32>,
    id: Option<u64>,
) -> Result<u64, String> {
    with_engine(app, move |engine| {
        // ... unchanged voice/rate setup ...
        let id = id.unwrap_or_else(|| NEXT_ID.fetch_add(1, Ordering::SeqCst));
        CURRENT_ID.store(id, Ordering::SeqCst);
        // ... unchanged speak + LATEST ...
        Ok(id)
    })
    .await
}
```

New command and cloud path:

```rust
#[tauri::command]
pub async fn tts_speak(
    app: AppHandle,
    text: String,
    voice: Option<String>,
    rate: Option<f32>,
    provider: Option<TtsProvider>,
    model: Option<String>,
) -> Result<u64, String> {
    let provider = provider.unwrap_or(TtsProvider::System);
    let Some(cloud) = provider.cloud() else {
        // `Local` is wired in Task 14; until then it behaves like the system voice.
        return speak_system(app, text, voice, rate, None).await;
    };
    stop_all(&app).await;
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    CURRENT_ID.store(id, Ordering::SeqCst);
    let model = model
        .filter(|m| !m.trim().is_empty())
        .or_else(|| catalog::default_model(cloud, "tts").map(str::to_string))
        .unwrap_or_default();
    tauri::async_runtime::spawn(speak_cloud(app, id, cloud, model, voice, rate.unwrap_or(1.0), text));
    Ok(id)
}

async fn speak_cloud(
    app: AppHandle,
    id: u64,
    cloud: CloudProvider,
    model: String,
    voice: Option<String>,
    rate: f32,
    text: String,
) {
    let fail = |app: AppHandle, kind: CloudErrorKind, text: String| async move {
        let _ = crate::diagnostics::append_spawn_log(&app, &format!("voice tts: {} failed: {kind:?}", cloud.id()));
        let _ = app.emit(
            "voice://fallback",
            serde_json::json!({ "usage": "narration", "provider": cloud.id(), "reason": kind, "fallback": "system" }),
        );
        if is_current(id) {
            let _ = speak_system(app, text, None, Some(rate), Some(id)).await;
        }
    };
    let key = match keys::read_key(&app, cloud) {
        Ok(Some(key)) => key,
        _ => return fail(app, CloudErrorKind::Auth, text).await,
    };
    let voice = match (cloud, voice) {
        (CloudProvider::Elevenlabs, None) => match tts_cloud::fetch_voices(&key).await {
            Ok(list) => list.into_iter().next().map(|(voice_id, _)| voice_id),
            Err(error) => return fail(app, error.kind, text).await,
        },
        (_, voice) => voice,
    };
    let out = match player(&app) {
        Ok(out) => out,
        Err(_) => return fail(app, CloudErrorKind::Other, text).await,
    };
    out.begin(id);
    let playback = tts_cloud::playback_rate(cloud, rate);
    for (index, chunk) in tts_cloud::split_for_tts(&text, tts_cloud::MAX_TTS_CHARS).into_iter().enumerate() {
        if !is_current(id) {
            return;
        }
        match tts_cloud::synthesize(cloud, &model, voice.as_deref(), &key, &chunk, rate).await {
            Ok(samples) => out.push(id, &samples, playback),
            // Nothing played yet: hand the whole text to the system voice under the same id.
            Err(error) if index == 0 => return fail(app, error.kind, text).await,
            // Mid-utterance: stop where we are rather than restart from the top.
            Err(_) => break,
        }
    }
    out.close(id);
}

async fn stop_all(app: &AppHandle) {
    crate::audio_out::stop_if_running();
    let _ = with_engine(app.clone(), |engine| {
        if engine.supported_features().stop {
            engine.stop().map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await;
}

#[tauri::command]
pub async fn tts_stop(app: AppHandle) -> Result<(), String> {
    CURRENT_ID.store(0, Ordering::SeqCst);
    stop_all(&app).await;
    Ok(())
}
```

`tts_voices` gains a provider:

```rust
#[tauri::command]
pub async fn tts_voices(app: AppHandle, provider: Option<TtsProvider>) -> Result<Vec<TtsVoice>, String> {
    match provider.and_then(TtsProvider::cloud) {
        None if provider == Some(TtsProvider::Local) => Ok(Vec::new()),
        None => system_voices(app).await,
        Some(CloudProvider::Elevenlabs) => {
            let Some(key) = keys::read_key(&app, CloudProvider::Elevenlabs)? else {
                return Ok(Vec::new());
            };
            let list = tts_cloud::fetch_voices(&key).await.map_err(|e| e.to_string())?;
            Ok(list.into_iter().map(|(id, name)| TtsVoice { id, name, language: String::new() }).collect())
        }
        Some(cloud) => Ok(catalog::provider_catalog(cloud)
            .voices
            .iter()
            .map(|voice| TtsVoice { id: voice.id.into(), name: voice.label.into(), language: String::new() })
            .collect()),
    }
}
```

where `system_voices` is today's `tts_voices` body, renamed. Remove any `#[allow(dead_code)]` added in Task 10.

Add to `tts.rs` tests:

```rust
    #[test]
    fn only_cloud_providers_map_to_a_cloud_id() {
        use super::TtsProvider;
        assert!(TtsProvider::System.cloud().is_none());
        assert!(TtsProvider::Local.cloud().is_none());
        assert_eq!(TtsProvider::Gemini.cloud(), Some(crate::voice_providers::CloudProvider::Gemini));
    }
```

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && cargo test --lib tts && cargo clippy --lib -- -D warnings`
Expected: PASS.

- [ ] **Step 6: Checkpoint**

Show `git status --short`; ask; on yes: `git commit -m "feat(voice): narrate with cloud voices and fall back to the system voice"`.

---

### Task 12: Narration panel and TTS wiring (frontend)

**Files:**
- Create: `voice/NarrationPanel.tsx`, `NarrationPanel.module.css`, `NarrationPanel.test.tsx`
- Modify: `src/lib/tauri/tts.ts`, `src/lib/voice/controller.ts:636-641` (+ test), `VoiceConversationSection.tsx` (drop the narration part), `VoicePage.tsx`, `VoicePage.test.tsx`, locale files

**Interfaces:**
- Consumes: Task 11 commands; `ProviderChoiceCard`, `useVoiceCatalog`, `useSpeechInventory`, `withTtsChoice`.
- Produces: `ttsSpeak(text: string, choice: TtsChoice): Promise<number>`; `ttsVoices(provider?: TtsProviderId): Promise<TtsVoice[]>`; `NarrationPanel({ onOpenProvider })`; `NARRATION_RATES = [1, 1.25, 1.5, 2]` (same chips as the voice HUD).

- [ ] **Step 1: Write the failing test**

`NarrationPanel.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../../../lib/types'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { NarrationPanel } from './NarrationPanel'

const tauri = vi.hoisted(() => ({
  speechListModels: vi.fn().mockResolvedValue([]),
  speechModelStates: vi.fn().mockResolvedValue([]),
  voiceProviderCatalog: vi.fn().mockResolvedValue([
    {
      provider: 'openai',
      keyUrl: 'https://x',
      voices: [],
      models: [{ id: 'gpt-4o-mini-tts', label: 'Mini TTS', capability: 'tts' }],
    },
  ]),
  ttsVoices: vi.fn(async (provider?: string) =>
    provider === 'openai' ? [{ id: 'nova', name: 'Nova', language: '' }] : [{ id: 'sys', name: 'Luciana', language: 'pt-BR' }],
  ),
  ttsSpeak: vi.fn().mockResolvedValue(1),
}))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/i18n', () => ({
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const prefs = () => useProjectsStore.getState().preferences

afterEach(cleanup)

describe('NarrationPanel', () => {
  beforeEach(() => {
    useProjectsStore.getState().hydrate(EMPTY_PROJECTS_FILE)
    useProjectsStore.getState().setPreferences({ voiceProviders: { openai: { configured: true, invalid: false } } })
  })

  it('switches to a cloud voice and resets the voice id', async () => {
    useProjectsStore.getState().setPreferences({ voiceTts: { provider: 'system', model: '', voice: 'sys', rate: 1.5 } })
    render(<NarrationPanel onOpenProvider={() => undefined} />)
    fireEvent.click(await screen.findByRole('radio', { name: /Mini TTS/ }))
    expect(prefs().voiceTts).toEqual({ provider: 'openai', model: 'gpt-4o-mini-tts', voice: null, rate: 1.5 })
    await waitFor(() => expect(tauri.ttsVoices).toHaveBeenCalledWith('openai'))
  })

  it('tests the selected voice with the current settings', async () => {
    render(<NarrationPanel onOpenProvider={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceTest' }))
    await waitFor(() =>
      expect(tauri.ttsSpeak).toHaveBeenCalledWith('prefs.voiceTestSentence', prefs().voiceTts),
    )
  })

  it('sets the narration speed', () => {
    render(<NarrationPanel onOpenProvider={() => undefined} />)
    fireEvent.click(screen.getByRole('radio', { name: 'prefs.voiceConvRateValue:{"rate":1.25}' }))
    expect(prefs().voiceTts.rate).toBe(1.25)
  })
})
```

In `controller.test.ts`, update the speak expectation to `expect(tauri.ttsSpeak).toHaveBeenCalledWith('<text>', expect.objectContaining({ provider: 'system' }))`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/modals/preferences/voice/NarrationPanel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Wrappers and controller**

`src/lib/tauri/tts.ts`:

```ts
import type { TtsChoice, TtsProviderId } from '../types'

/** Speaks `text` with the chosen provider, interrupting anything already playing. */
export function ttsSpeak(text: string, choice: TtsChoice): Promise<number> {
  return invoke<number>('tts_speak', {
    text,
    voice: choice.voice,
    rate: choice.rate,
    provider: choice.provider,
    model: choice.model || null,
  })
}

export function ttsVoices(provider?: TtsProviderId): Promise<TtsVoice[]> {
  return invoke<TtsVoice[]>('tts_voices', { provider: provider ?? null })
}
```

`controller.ts` `speak`:

```ts
    const choice = prefs().voiceTts
    const rate = choice.rate
    try {
      const id = await ttsSpeak(text, choice)
```

- [ ] **Step 4: `NarrationPanel`**

```tsx
import { useEffect, useState } from 'react'

import { useT } from '../../../../lib/i18n'
import { type TtsVoice, ttsSpeak, ttsVoices } from '../../../../lib/tauri'
import type { TtsChoice } from '../../../../lib/types'
import { CLOUD_VOICE_PROVIDERS, DEFAULT_TTS_CHOICE } from '../../../../lib/voice/providers'
import { withTtsChoice } from '../../../../lib/voice/voicePreferences'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { Dropdown } from '../../../ui/Dropdown'
import controls from '../../controls.module.css'
import styles from './NarrationPanel.module.css'
import { ProviderChoiceCard } from './ProviderChoiceCard'
import { PROVIDER_META, type VoiceProviderId } from './providerMeta'
import { useSpeechInventory } from './useSpeechInventory'
import { useVoiceCatalog } from './useVoiceCatalog'

export const NARRATION_RATES = [1, 1.25, 1.5, 2]

export function NarrationPanel({ onOpenProvider }: { onOpenProvider: (id: VoiceProviderId) => void }) {
  const t = useT()
  const choice = useProjectsStore((s) => s.preferences.voiceTts)
  const flags = useProjectsStore((s) => s.preferences.voiceProviders)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const { models, states } = useSpeechInventory()
  const catalog = useVoiceCatalog()
  const [voices, setVoices] = useState<TtsVoice[]>([])

  useEffect(() => {
    let cancelled = false
    void ttsVoices(choice.provider)
      .then((list) => {
        if (!cancelled) setVoices(list)
      })
      .catch(() => {
        if (!cancelled) setVoices([])
      })
    return () => {
      cancelled = true
    }
  }, [choice.provider])

  const patch = (next: Partial<TtsChoice>) => setPreferences(withTtsChoice({ voiceTts: choice }, next))
  const pick = (provider: TtsChoice['provider'], model: string) =>
    patch({ provider, model, voice: provider === choice.provider ? choice.voice : null })
  const selected = (provider: string, model: string) => choice.provider === provider && choice.model === model

  const localRows = models
    .filter((model) => model.kind === 'download' && model.capability === 'tts')
    .map((model) => {
      const ready = states[model.id]?.status === 'ready'
      return {
        id: model.id,
        label: model.label,
        detail: t(ready ? 'prefs.voiceModelReady' : 'prefs.voiceModelNotDownloaded'),
        selected: selected('local', model.id),
        disabled: !ready,
      }
    })

  return (
    <div className={styles.root} data-setting-id="voice-conversation-voice" tabIndex={-1}>
      <div className={styles.grid}>
        <ProviderChoiceCard
          icon={PROVIDER_META.system.icon}
          title={t('voice.provider.system')}
          badge="device"
          subtitle={t('prefs.voiceProviderSystemDesc')}
          rows={[{ id: 'system', label: t('voice.provider.system'), selected: choice.provider === 'system' }]}
          onSelect={() => patch({ ...DEFAULT_TTS_CHOICE, rate: choice.rate, voice: choice.provider === 'system' ? choice.voice : null })}
        />
        {localRows.length > 0 ? (
          <ProviderChoiceCard
            icon={PROVIDER_META.local.icon}
            title={t('voice.provider.local')}
            badge="device"
            subtitle={t('prefs.voiceProviderLocalDesc')}
            rows={localRows}
            onSelect={(id) => pick('local', id)}
            note={localRows.some((row) => row.disabled) ? t('prefs.voiceDownloadHint') : undefined}
          />
        ) : null}
        {CLOUD_VOICE_PROVIDERS.map((provider) => {
          const entry = catalog.find((item) => item.provider === provider)
          if (!entry) return null
          const configured = flags[provider]?.configured === true
          const name = t(PROVIDER_META[provider].name)
          return (
            <ProviderChoiceCard
              key={provider}
              icon={PROVIDER_META[provider].icon}
              title={name}
              badge="cloud"
              subtitle={t(PROVIDER_META[provider].description)}
              rows={entry.models
                .filter((model) => model.capability === 'tts')
                .map((model) => ({ id: model.id, label: model.label, selected: selected(provider, model.id) }))}
              onSelect={(id) => pick(provider, id)}
              locked={configured ? undefined : { label: t('prefs.voiceActionSetUpKey'), onClick: () => onOpenProvider(provider) }}
              note={configured ? t('prefs.voiceCloudSendsText', { provider: name }) : undefined}
            />
          )
        })}
      </div>

      <div className={styles.controls}>
        <label className={styles.field}>
          <span>{t('prefs.voiceConvVoice')}</span>
          <Dropdown
            value={choice.voice ?? ''}
            ariaLabel={t('prefs.voiceConvVoice')}
            searchable={voices.length > 8}
            options={[
              { value: '', label: t('prefs.voiceDefaultVoice') },
              ...voices.map((voice) => ({
                value: voice.id,
                label: voice.language ? `${voice.name} (${voice.language})` : voice.name,
              })),
            ]}
            onChange={(value) => patch({ voice: value || null })}
          />
        </label>
        <div className={styles.field}>
          <span>{t('prefs.voiceConvRate')}</span>
          <div className={styles.rates} role="radiogroup" aria-label={t('prefs.voiceConvRate')}>
            {NARRATION_RATES.map((rate) => (
              <button
                key={rate}
                type="button"
                role="radio"
                aria-checked={choice.rate === rate}
                className={choice.rate === rate ? styles.rateActive : styles.rate}
                onClick={() => patch({ rate })}
              >
                {t('prefs.voiceConvRateValue', { rate })}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className={controls.btn} onClick={() => void ttsSpeak(t('prefs.voiceTestSentence'), choice)}>
          {t('prefs.voiceTest')}
        </button>
      </div>
    </div>
  )
}
```

`NarrationPanel.module.css`:

```css
.root {
  display: flex;
  flex-direction: column;
  gap: 16px;
  outline: none;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 16px;
  padding: 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-card-default);
}

.field {
  display: flex;
  min-width: 220px;
  flex-direction: column;
  gap: 6px;
  color: var(--fg-muted);
  font-size: 12px;
}

.rates {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-sunken);
}

.rate,
.rateActive {
  padding: 5px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
  background: transparent;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.rateActive {
  color: var(--fg);
  background: var(--surface-card-default);
  box-shadow: var(--shadow-sm);
}
```

- [ ] **Step 5: Page wiring**

`VoiceConversationSection.tsx`: delete the `voice-conversation-voice` section, the voice list state/effect, `RATES`, and the `part` prop (render the conversation sections unconditionally). `VoicePage.tsx`: narration tab renders `<NarrationPanel onOpenProvider={setDetail} />`; conversation tab renders `<VoiceConversationSection />`. Update the `VoicePage.test.tsx` mocks: `VoiceConversationSection: () => <div>conversation-body</div>` and `vi.mock('./NarrationPanel', () => ({ NarrationPanel: () => <div>narration-body</div> }))`.

- [ ] **Step 6: i18n keys**

| key | en | pt-BR | zh-CN |
|---|---|---|---|
| `prefs.voiceCloudSendsText` | Narration text is sent to {{provider}}. | O texto da narração é enviado ao {{provider}}. | 旁白文本将发送至 {{provider}}。 |
| `prefs.voiceDefaultVoice` | Provider default | Padrão do provedor | 提供方默认 |
| `prefs.voiceTest` | Test voice | Testar voz | 试听 |
| `prefs.voiceTestSentence` | Hello! This is how Alethe will narrate your agents. | Olá! É assim que o Alethe vai narrar seus agentes. | 你好！Alethe 将用这个声音为你的智能体朗读。 |

`prefs.voiceConvVoiceSystem` becomes unused — delete it from all three locales if `grep -rn "voiceConvVoiceSystem" src` finds nothing else.

- [ ] **Step 7: Run the checks**

Run: `npx vitest run && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 8: Checkpoint**

Show `git status --short`; ask; on yes: `git commit -m "feat(voice): pick the narration provider, voice and speed"`.

---

## Phase 5 — Local Hugging Face models

### Task 13: Whisper and Moonshine speech-to-text models (Rust)

**Files:**
- Modify: `src-tauri/src/speech.rs` (`SpeechModelManifest` :28-40, `CatalogEntry` :103-112, entries :114-221, `SpeechState::recognizer_for` :242-261, `build_recognizer` :684-721, `catalog_manifests` :303-333, `transcriber_for` / `speech_prepare` callers of `recognizer_for`), tests

**Interfaces:**
- Produces: `SpeechModelManifest.capability: String` (`"stt"` here; `"tts"` in Task 14). `CatalogEntry.layout: Layout` replaces `model_type`:
  ```rust
  #[derive(Clone, Copy, Debug)]
  enum Layout {
      Transducer { model_type: &'static str },
      Whisper { encoder: &'static str, decoder: &'static str, tokens: &'static str },
      Moonshine,
  }
  ```
  New catalog ids: `whisper-base-int8`, `whisper-small-int8`, `moonshine-base-en-int8`.

- [ ] **Step 1: Write the failing tests** (in `speech.rs` tests)

```rust
    #[test]
    fn every_download_is_pinned_and_hashed() {
        for entry in CATALOG {
            for file in entry.files {
                assert!(file.url.starts_with("https://huggingface.co/"), "{}", file.url);
                assert!(!file.url.contains("/resolve/main/"), "unpinned revision: {}", file.url);
                assert_eq!(file.sha256.len(), 64, "{}", file.name);
                assert!(file.size_bytes > 0);
            }
        }
    }

    #[test]
    fn whisper_and_moonshine_entries_ship_the_files_their_layout_reads() {
        let whisper = find_entry("whisper-small-int8").unwrap();
        let Layout::Whisper { encoder, decoder, tokens } = whisper.layout else { panic!("whisper layout") };
        let names: Vec<&str> = whisper.files.iter().map(|f| f.name).collect();
        for needed in [encoder, decoder, tokens] {
            assert!(names.contains(&needed), "{needed}");
        }
        let moonshine = find_entry("moonshine-base-en-int8").unwrap();
        assert!(matches!(moonshine.layout, Layout::Moonshine));
        let names: Vec<&str> = moonshine.files.iter().map(|f| f.name).collect();
        for needed in MOONSHINE_FILES {
            assert!(names.contains(needed), "{needed}");
        }
    }

    #[test]
    fn manifests_say_they_are_speech_to_text() {
        assert!(catalog_manifests(false).iter().all(|m| m.capability == "stt"));
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib speech::tests`
Expected: compile errors — `Layout`, `MOONSHINE_FILES`, `capability` unknown.

- [ ] **Step 3: Implement**

Add `pub capability: String,` to `SpeechModelManifest` (doc: `` /// `stt` or `tts`. ``) and set `capability: "stt".to_string()` in both manifest builders of `catalog_manifests`.

Add `Layout` (from **Interfaces**) and replace `model_type: &'static str` in `CatalogEntry` with `layout: Layout`. Existing entries: `PARAKEET_V3` → `layout: Layout::Transducer { model_type: "nemo_transducer" }`; the two Zipformer entries → `Layout::Transducer { model_type: "<their current model_type value>" }`.

New entries (sizes and SHA-256 verified on 2026-10-15 from the Hugging Face API, revisions pinned):

```rust
const MOONSHINE_FILES: &[&str] = &[
    "preprocess.onnx",
    "encode.int8.onnx",
    "uncached_decode.int8.onnx",
    "cached_decode.int8.onnx",
    "tokens.txt",
];

/// Whisper base, multilingual with language detection. Smaller and less accurate than Parakeet.
const WHISPER_BASE: CatalogEntry = CatalogEntry {
    id: "whisper-base-int8",
    label: "Whisper base",
    description: "Multilingual with automatic language detection, including Portuguese. Fast; less accurate than Parakeet.",
    language: "multilingual",
    layout: Layout::Whisper { encoder: "base-encoder.int8.onnx", decoder: "base-decoder.int8.onnx", tokens: "base-tokens.txt" },
    recommended: false,
    files: &[
        ModelFile {
            name: "base-encoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/bb53ee204431c90d314c1cc08d28d23e5b7927cc/base-encoder.int8.onnx?download=true",
            size_bytes: 29_120_534,
            sha256: "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11",
        },
        ModelFile {
            name: "base-decoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/bb53ee204431c90d314c1cc08d28d23e5b7927cc/base-decoder.int8.onnx?download=true",
            size_bytes: 130_672_026,
            sha256: "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d",
        },
        ModelFile {
            name: "base-tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/bb53ee204431c90d314c1cc08d28d23e5b7927cc/base-tokens.txt?download=true",
            size_bytes: 816_730,
            sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
        },
    ],
};

const WHISPER_SMALL: CatalogEntry = CatalogEntry {
    id: "whisper-small-int8",
    label: "Whisper small",
    description: "Multilingual with automatic language detection. More accurate than Whisper base, slower.",
    language: "multilingual",
    layout: Layout::Whisper { encoder: "small-encoder.int8.onnx", decoder: "small-decoder.int8.onnx", tokens: "small-tokens.txt" },
    recommended: false,
    files: &[
        ModelFile {
            name: "small-encoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/8f3c18b358db4d1f2fc1eae49d75cd20989e4309/small-encoder.int8.onnx?download=true",
            size_bytes: 112_442_483,
            sha256: "4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9",
        },
        ModelFile {
            name: "small-decoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/8f3c18b358db4d1f2fc1eae49d75cd20989e4309/small-decoder.int8.onnx?download=true",
            size_bytes: 262_226_114,
            sha256: "acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee",
        },
        ModelFile {
            name: "small-tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/8f3c18b358db4d1f2fc1eae49d75cd20989e4309/small-tokens.txt?download=true",
            size_bytes: 816_730,
            sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
        },
    ],
};

const MOONSHINE_BASE_EN: CatalogEntry = CatalogEntry {
    id: "moonshine-base-en-int8",
    label: "Moonshine base",
    description: "English only. Very fast on short commands.",
    language: "en",
    layout: Layout::Moonshine,
    recommended: false,
    files: &[
        ModelFile {
            name: "preprocess.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-base-en-int8/resolve/052b0798ad1bf046a140fdd4efcd9426530fa3f5/preprocess.onnx?download=true",
            size_bytes: 14_077_290,
            sha256: "ffa630d395c5ccf76f5d4954be5b882df76aaf6491519ec01fd82ea7a3819fb2",
        },
        ModelFile {
            name: "encode.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-base-en-int8/resolve/052b0798ad1bf046a140fdd4efcd9426530fa3f5/encode.int8.onnx?download=true",
            size_bytes: 50_311_494,
            sha256: "7e38770f776f2e5583a53b052936005df2ba5c833d7e09c2a5fd796b94bf73e2",
        },
        ModelFile {
            name: "uncached_decode.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-base-en-int8/resolve/052b0798ad1bf046a140fdd4efcd9426530fa3f5/uncached_decode.int8.onnx?download=true",
            size_bytes: 122_120_451,
            sha256: "c01f4b35093bcac20d352d23a75a539e772964579f9d024a90e5e6f09cae9987",
        },
        ModelFile {
            name: "cached_decode.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-base-en-int8/resolve/052b0798ad1bf046a140fdd4efcd9426530fa3f5/cached_decode.int8.onnx?download=true",
            size_bytes: 99_983_837,
            sha256: "2db74e51cedf64a8b1be3c8192e0bb5e4923af0e90bd9e87f8e8771873f8ea03",
        },
        ModelFile {
            name: "tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-base-en-int8/resolve/052b0798ad1bf046a140fdd4efcd9426530fa3f5/tokens.txt?download=true",
            size_bytes: 436_688,
            sha256: "1165c2aeb9f72f457a83be2d459a09054f27490acd9b41bd43794dfd25e296ea",
        },
    ],
};

const CATALOG: &[CatalogEntry] = &[
    ZIPFORMER_GIGASPEECH,
    ZIPFORMER_SMALL_EN,
    PARAKEET_V3,
    WHISPER_BASE,
    WHISPER_SMALL,
    MOONSHINE_BASE_EN,
];
```

`recognizer_for(&self, dir: &Path, layout: Layout)` and `build_recognizer(dir: &Path, layout: Layout)`; callers pass `entry.layout`. `build_recognizer` becomes:

```rust
fn build_recognizer(dir: &Path, layout: Layout) -> Result<OfflineRecognizer, String> {
    let path = |name: &str| -> Result<String, String> {
        let full = dir.join(name);
        if !full.is_file() {
            return Err(format!("missing model file: {}", full.display()));
        }
        Ok(full.to_string_lossy().into_owned())
    };
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.num_threads = decode_threads();
    config.feat_config.sample_rate = SAMPLE_RATE;
    match layout {
        Layout::Transducer { model_type } => {
            config.model_config.transducer = OfflineTransducerModelConfig {
                encoder: Some(path("encoder.int8.onnx")?),
                decoder: Some(path("decoder.int8.onnx")?),
                joiner: Some(path("joiner.int8.onnx")?),
            };
            config.model_config.tokens = Some(path("tokens.txt")?);
            config.model_config.model_type = Some(model_type.to_string());
            // ... the existing hotwords block, unchanged, guarded by `model_type == "transducer"` ...
        }
        Layout::Whisper { encoder, decoder, tokens } => {
            config.model_config.whisper = OfflineWhisperModelConfig {
                encoder: Some(path(encoder)?),
                decoder: Some(path(decoder)?),
                // Empty language = detect it per utterance.
                language: Some(String::new()),
                task: Some("transcribe".into()),
                tail_paddings: -1,
                ..Default::default()
            };
            config.model_config.tokens = Some(path(tokens)?);
        }
        Layout::Moonshine => {
            config.model_config.moonshine = OfflineMoonshineModelConfig {
                preprocessor: Some(path("preprocess.onnx")?),
                encoder: Some(path("encode.int8.onnx")?),
                uncached_decoder: Some(path("uncached_decode.int8.onnx")?),
                cached_decoder: Some(path("cached_decode.int8.onnx")?),
                merged_decoder: None,
            };
            config.model_config.tokens = Some(path("tokens.txt")?);
        }
    }
    OfflineRecognizer::create(&config).ok_or_else(|| "failed to create OfflineRecognizer".into())
}
```

Import `OfflineWhisperModelConfig` and `OfflineMoonshineModelConfig` from `sherpa_onnx` next to the existing `OfflineTransducerModelConfig` import.

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test --lib speech && cargo clippy --lib -- -D warnings`
Expected: PASS.

- [ ] **Step 5: Manual smoke check**

With the app already running (`npm run app` rebuilds the Rust side on save — do not start or restart it yourself), open Preferences → Voice → Providers → Local models, download **Whisper base**, select it in the Dictation tab, dictate a Portuguese sentence. Expected: text appears in the terminal. If the app is not running, note it in the checkpoint and leave this for the owner.

- [ ] **Step 6: Checkpoint**

Show `git status --short`; ask; on yes: `git commit -m "feat(voice): add Whisper and Moonshine local speech models"`.

---

### Task 14: Piper local voices (Rust + frontend)

**Files:**
- Create: `src-tauri/src/tts_local.rs`
- Modify: `src-tauri/Cargo.toml` (add `bzip2 = "0.4"` after `tar`), `src-tauri/src/speech.rs` (download loop :462-582, states :355-399, delete :584-595, manifests), `src-tauri/src/tts.rs` (`tts_speak` local branch), `src-tauri/src/lib.rs` (mod list)

**Interfaces:**
- Consumes: Task 10 player, Task 11 `split_for_tts`, `speak_system`, `is_current`, `player`.
- Produces (`speech.rs`):
  ```rust
  struct TtsCatalogEntry { id, label, description, language: &'static str, archive: ModelFile, root: &'static str, model_file: &'static str }
  const TTS_CATALOG: &[TtsCatalogEntry]
  pub(crate) fn local_tts_model(app: &AppHandle, id: &str) -> Result<(PathBuf, &'static str), String>  // ready dir + model file, or why not
  fn extract_tar_bz2(archive: &Path, dest: &Path, root: &str) -> Result<(), String>
  ```
  TTS ids: `piper-pt-br-faber-medium`, `piper-en-us-amy-low`; manifests with `capability: "tts"`, `kind: "download"`.
- Produces (`tts_local.rs`): `pub fn synthesize(dir: &Path, model_file: &str, text: &str, rate: f32) -> Result<(Vec<f32>, u32), String>` (cached `OfflineTts` per directory).

- [ ] **Step 1: Write the failing tests**

`speech.rs` tests:

```rust
    #[test]
    fn piper_archives_are_pinned_releases() {
        for entry in TTS_CATALOG {
            assert!(entry.archive.url.starts_with("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"));
            assert_eq!(entry.archive.sha256.len(), 64);
            assert!(entry.model_file.ends_with(".onnx"));
        }
    }

    #[test]
    fn archives_unpack_without_their_top_folder() {
        use std::io::Write as _;
        let root = std::env::temp_dir().join(format!("alethe-tar-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("voice.tar.bz2");
        {
            let file = File::create(&archive_path).unwrap();
            let encoder = bzip2::write::BzEncoder::new(file, bzip2::Compression::fast());
            let mut builder = tar::Builder::new(encoder);
            for (name, body) in [("voice/model.onnx", b"m".as_slice()), ("voice/espeak-ng-data/pt_dict", b"d".as_slice())] {
                let mut header = tar::Header::new_gnu();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, name, body).unwrap();
            }
            builder.into_inner().unwrap().finish().unwrap().flush().unwrap();
        }
        let dest = root.join("out");
        fs::create_dir_all(&dest).unwrap();
        extract_tar_bz2(&archive_path, &dest, "voice").unwrap();
        assert!(dest.join("model.onnx").is_file());
        assert!(dest.join("espeak-ng-data/pt_dict").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn tts_manifests_are_listed_as_text_to_speech() {
        let list = speech_list_models();
        let tts: Vec<_> = list.iter().filter(|m| m.capability == "tts").collect();
        assert_eq!(tts.len(), TTS_CATALOG.len());
        assert!(tts.iter().all(|m| m.kind == "download" && m.size_bytes > 0));
    }
```

Update `catalog_recommends_exactly_one_downloadable_model` to filter `model.capability == "stt"` before counting recommended entries.

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib speech::tests`
Expected: compile errors — `TTS_CATALOG`, `extract_tar_bz2`, `bzip2` unknown.

- [ ] **Step 3: Catalog, download and extraction**

`Cargo.toml`: `bzip2 = "0.4"` under `tar = "0.4"`.

`speech.rs`:

```rust
struct TtsCatalogEntry {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    language: &'static str,
    archive: ModelFile,
    /// Top folder inside the archive; stripped on unpack.
    root: &'static str,
    model_file: &'static str,
}

/// Piper voices from the sherpa-onnx `tts-models` release; each ships with its espeak-ng data.
const TTS_CATALOG: &[TtsCatalogEntry] = &[
    TtsCatalogEntry {
        id: "piper-pt-br-faber-medium",
        label: "Piper · Faber (pt-BR)",
        description: "Brazilian Portuguese male voice. Runs offline.",
        language: "pt-BR",
        archive: ModelFile {
            name: "vits-piper-pt_BR-faber-medium.tar.bz2",
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-pt_BR-faber-medium.tar.bz2",
            size_bytes: 67_183_065,
            sha256: "7add3f923ad6bc25ca8a192805fd1a64d1b3893e4611c4a9719545a825039a83",
        },
        root: "vits-piper-pt_BR-faber-medium",
        model_file: "pt_BR-faber-medium.onnx",
    },
    TtsCatalogEntry {
        id: "piper-en-us-amy-low",
        label: "Piper · Amy (en-US)",
        description: "American English female voice. Runs offline.",
        language: "en-US",
        archive: ModelFile {
            name: "vits-piper-en_US-amy-low.tar.bz2",
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-amy-low.tar.bz2",
            size_bytes: 67_095_344,
            sha256: "c70f5284a09a7fd4ed203b39b2ff51cac1432b422b852eb647b481dade3cf639",
        },
        root: "vits-piper-en_US-amy-low",
        model_file: "en_US-amy-low.onnx",
    },
];

fn find_tts_entry(id: &str) -> Option<&'static TtsCatalogEntry> {
    TTS_CATALOG.iter().find(|entry| entry.id == id)
}

fn tts_ready(dir: &Path, entry: &TtsCatalogEntry) -> bool {
    dir.join(entry.model_file).is_file() && dir.join("tokens.txt").is_file() && dir.join("espeak-ng-data").is_dir()
}

pub(crate) fn local_tts_model(app: &AppHandle, id: &str) -> Result<(PathBuf, &'static str), String> {
    let entry = find_tts_entry(id).ok_or_else(|| format!("Unknown voice model: {id}"))?;
    let dir = model_dir(app, id)?;
    if !tts_ready(&dir, entry) {
        return Err(format!("Voice model '{id}' is not downloaded. Open Preferences → Voice."));
    }
    Ok((dir, entry.model_file))
}

fn extract_tar_bz2(archive: &Path, dest: &Path, root: &str) -> Result<(), String> {
    use std::path::Component;
    let file = File::open(archive).map_err(|e| format!("open archive: {e}"))?;
    let mut tar = tar::Archive::new(bzip2::read::BzDecoder::new(file));
    for entry in tar.entries().map_err(|e| format!("read archive: {e}"))? {
        let mut entry = entry.map_err(|e| format!("read archive: {e}"))?;
        let path = entry.path().map_err(|e| format!("archive path: {e}"))?.into_owned();
        let Ok(relative) = path.strip_prefix(root) else { continue };
        if relative.as_os_str().is_empty() {
            continue;
        }
        if relative.components().any(|part| !matches!(part, Component::Normal(_))) {
            return Err("archive contains an unsafe path".into());
        }
        let target = dest.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        entry.unpack(&target).map_err(|e| format!("unpack {}: {e}", relative.display()))?;
    }
    Ok(())
}
```

Download refactor — move the body of the `for (index, file) in entry.files.iter().enumerate()` loop, plus the `client`, `total`, `throttle` and `emit` set-up, into:

```rust
async fn download_files(app: &AppHandle, model_id: &str, dir: &Path, files: &[ModelFile]) -> Result<(), String> {
    // ... the existing set-up and loop, unchanged, with `entry.files` → `files`,
    //     `entry_size_bytes(entry)` → `files.iter().map(|f| f.size_bytes).sum()`,
    //     and `model_id.clone()` → `model_id.to_string()` inside `emit` ...
    Ok(())
}
```

`speech_download_model` then reads:

```rust
    if model_id == APPLE_MODEL_ID {
        return install_native_locale(&app, model_id, locale).await;
    }
    let _guard = state.download_lock.lock().await;
    let dir = model_dir(&app, &model_id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create model dir: {e}"))?;
    if let Some(entry) = find_tts_entry(&model_id) {
        if !tts_ready(&dir, entry) {
            download_files(&app, &model_id, &dir, std::slice::from_ref(&entry.archive)).await?;
            let archive = dir.join(entry.archive.name);
            extract_tar_bz2(&archive, &dir, entry.root)?;
            let _ = fs::remove_file(&archive);
        }
    } else {
        let entry = find_entry(&model_id)?;
        download_files(&app, &model_id, &dir, entry.files).await?;
    }
    Ok(SpeechModelState { id: model_id, status: "ready".into(), progress: Some(1.0), error: None })
```

`speech_model_states`: after building the STT states, append one state per `TTS_CATALOG` entry with `ready`/`not-downloaded` from `tts_ready`. `speech_delete_model`: accept `find_tts_entry(&model_id).is_some() || find_entry(&model_id).is_ok()`. `catalog_manifests`: append one manifest per TTS entry with `capability: "tts"`, `kind: "download"`, `sample_rate: 22_050`, `size_bytes: entry.archive.size_bytes`, `recommended: false`.

- [ ] **Step 4: Local synthesis and dispatch**

`lib.rs`: `mod tts_local;`.

`tts_local.rs`:

```rust
//! Piper voices through sherpa-onnx. Loading a voice reads ~60 MB, so the last one stays cached.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use sherpa_onnx::{GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsModelConfig, OfflineTtsVitsModelConfig};

static CACHE: Mutex<Option<(PathBuf, Arc<OfflineTts>)>> = Mutex::new(None);

fn engine(dir: &Path, model_file: &str) -> Result<Arc<OfflineTts>, String> {
    let mut slot = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((cached, tts)) = slot.as_ref() {
        if cached == dir {
            return Ok(Arc::clone(tts));
        }
    }
    let path = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
    let config = OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            vits: OfflineTtsVitsModelConfig {
                model: path(model_file),
                tokens: path("tokens.txt"),
                data_dir: path("espeak-ng-data"),
                ..Default::default()
            },
            num_threads: 2,
            ..Default::default()
        },
        max_num_sentences: 1,
        ..Default::default()
    };
    let tts = Arc::new(OfflineTts::create(&config).ok_or_else(|| "failed to load the voice model".to_string())?);
    *slot = Some((dir.to_path_buf(), Arc::clone(&tts)));
    Ok(tts)
}

/// Samples and their rate. Blocks for the length of the synthesis; call on a worker thread.
pub fn synthesize(dir: &Path, model_file: &str, text: &str, rate: f32) -> Result<(Vec<f32>, u32), String> {
    let tts = engine(dir, model_file)?;
    let config = GenerationConfig { speed: rate.clamp(0.5, 2.0), ..Default::default() };
    let audio = tts
        .generate_with_config(text, &config, None::<fn(&[f32], f32) -> bool>)
        .ok_or_else(|| "voice synthesis failed".to_string())?;
    Ok((audio.samples().to_vec(), audio.sample_rate() as u32))
}
```

(`OfflineTtsVitsModelConfig` implements `Default` with Piper-friendly noise/length scales — check its `impl Default` at `sherpa-onnx-1.13.6/src/tts.rs:83` and keep those values.)

`tts.rs` — in `tts_speak`, before the cloud branch:

```rust
    if provider == TtsProvider::Local {
        let (dir, model_file) = match model.as_deref().map(|id| crate::speech::local_tts_model(&app, id)) {
            Some(Ok(found)) => found,
            // A missing local voice falls back to the system voice, never to the cloud.
            _ => return speak_system(app, text, voice, rate, None).await,
        };
        stop_all(&app).await;
        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        CURRENT_ID.store(id, Ordering::SeqCst);
        tauri::async_runtime::spawn(speak_local(app, id, dir, model_file, rate.unwrap_or(1.0), text));
        return Ok(id);
    }
```

```rust
async fn speak_local(app: AppHandle, id: u64, dir: std::path::PathBuf, model_file: &'static str, rate: f32, text: String) {
    let Ok(out) = player(&app) else {
        let _ = speak_system(app, text, None, Some(rate), Some(id)).await;
        return;
    };
    out.begin(id);
    // Short chunks so the first sentence plays while the rest is synthesized.
    for (index, chunk) in tts_cloud::split_for_tts(&text, 400).into_iter().enumerate() {
        if !is_current(id) {
            return;
        }
        let dir = dir.clone();
        let result = tokio::task::spawn_blocking(move || crate::tts_local::synthesize(&dir, model_file, &chunk, rate)).await;
        match result {
            Ok(Ok((samples, sample_rate))) => out.push(id, &samples, sample_rate),
            _ if index == 0 => {
                let _ = speak_system(app, text, None, Some(rate), Some(id)).await;
                return;
            }
            _ => break,
        }
    }
    out.close(id);
}
```

The frontend needs no change: `NarrationPanel` and `LocalModelList` already list `capability === 'tts'` manifests.

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && cargo test --lib && cargo clippy --lib -- -D warnings`, then `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Manual smoke check**

In the running app: Providers → Local models → download **Piper · Faber (pt-BR)**; Narration tab → pick it → **Test voice**. Expected: the Portuguese sentence plays; pressing the conversation shortcut mid-sentence stops it. Skip and note if the app is not running.

- [ ] **Step 7: Checkpoint**

Show `git status --short`; ask; on yes: `git commit -m "feat(voice): add offline Piper voices for narration"`.

---

## Phase 6 — OpenRouter catalog and docs

### Task 15: OpenRouter live model list

**Files:**
- Create: `src-tauri/src/voice_providers/openrouter.rs`, `voice/ProviderChoiceCard.test.tsx`
- Modify: `src-tauri/src/voice_providers/mod.rs`, `src-tauri/src/lib.rs`, `src/lib/tauri/voiceProviders.ts`, `voice/useVoiceCatalog.ts`, `voice/ProviderChoiceCard.tsx`, `voice/ProviderDetail.tsx`, `ProviderDetail.module.css`, locale files

**Interfaces:**
- Produces (Rust): `pub fn modality(kind: &str) -> Option<&'static str>` (`stt` → `transcription`, `tts` → `speech`); `pub fn parse_models(body: &[u8], capability: &'static str) -> Result<Vec<LiveModel>, CloudError>`; `LiveModel { id: String, label: String, capability: &'static str }` (camelCase); command `voice_openrouter_models(kind: String) -> Result<Vec<LiveModel>, String>` cached one hour per kind.
- Produces (TS): `voiceOpenrouterModels(kind: 'stt' | 'tts'): Promise<VoiceCatalogModel[]>`; `useVoiceCatalog` replaces OpenRouter's curated models with the live list when OpenRouter has a key (curated list stays on error); `ProviderChoiceCard` renders a searchable `Dropdown` instead of row buttons when it has more than 6 rows.

- [ ] **Step 1: Write the failing tests**

`openrouter.rs` tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_map_to_openrouter_modalities() {
        assert_eq!(modality("stt"), Some("transcription"));
        assert_eq!(modality("tts"), Some("speech"));
        assert_eq!(modality("../models"), None);
    }

    #[test]
    fn model_lists_are_parsed() {
        let body = br#"{"data":[{"id":"openai/whisper-1","name":"OpenAI: Whisper"},{"id":"x/y"}]}"#;
        let models = parse_models(body, "stt").unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].label, "OpenAI: Whisper");
        assert_eq!(models[1].label, "x/y", "falls back to the id");
        assert!(parse_models(b"{}", "stt").is_err());
    }
}
```

`ProviderChoiceCard.test.tsx`:

```tsx
import { cleanup, render, screen } from '@testing-library/react'
import { Sparkle } from 'lucide-react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderChoiceCard } from './ProviderChoiceCard'

vi.mock('../../../../lib/i18n', () => ({ useT: () => (key: string) => key }))
afterEach(cleanup)

const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `m${index}`, label: `Model ${index}`, selected: index === 2 }))

describe('ProviderChoiceCard', () => {
  it('shows buttons for a short list', () => {
    render(<ProviderChoiceCard icon={Sparkle} title="P" badge="cloud" subtitle="" rows={rows(3)} onSelect={() => undefined} />)
    expect(screen.getAllByRole('radio')).toHaveLength(3)
  })

  it('collapses a long list into a searchable picker', () => {
    render(<ProviderChoiceCard icon={Sparkle} title="P" badge="cloud" subtitle="" rows={rows(40)} onSelect={() => undefined} />)
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(screen.getByText('Model 2')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib openrouter` and `npx vitest run src/components/modals/preferences/voice/ProviderChoiceCard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Rust**

`mod.rs`: `pub mod openrouter;`. `openrouter.rs`:

```rust
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use super::http::{send, CloudError, CloudErrorKind, HttpBody, HttpMethod, HttpRequest};
use super::{keys, CloudProvider};

const TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveModel {
    pub id: String,
    pub label: String,
    pub capability: &'static str,
}

static CACHE: Mutex<Vec<(&'static str, Instant, Vec<LiveModel>)>> = Mutex::new(Vec::new());

pub fn modality(kind: &str) -> Option<&'static str> {
    match kind {
        "stt" => Some("transcription"),
        "tts" => Some("speech"),
        _ => None,
    }
}

pub fn parse_models(body: &[u8], capability: &'static str) -> Result<Vec<LiveModel>, CloudError> {
    let value: Value = serde_json::from_slice(body).map_err(|_| CloudError::of(CloudErrorKind::Other))?;
    let data = value["data"].as_array().ok_or_else(|| CloudError::of(CloudErrorKind::Other))?;
    Ok(data
        .iter()
        .filter_map(|model| {
            let id = model["id"].as_str()?.to_string();
            let label = model["name"].as_str().map(str::to_string).unwrap_or_else(|| id.clone());
            Some(LiveModel { id, label, capability })
        })
        .collect())
}

#[tauri::command]
pub async fn voice_openrouter_models(app: AppHandle, kind: String) -> Result<Vec<LiveModel>, String> {
    let capability: &'static str = if kind == "tts" { "tts" } else { "stt" };
    let modality = modality(&kind).ok_or_else(|| "voice_openrouter_bad_kind".to_string())?;
    {
        let cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, _, models)) = cache.iter().find(|(k, at, _)| *k == capability && at.elapsed() < TTL) {
            return Ok(models.clone());
        }
    }
    let mut headers = vec![("X-Title", "Alethe".to_string())];
    if let Some(key) = keys::read_key(&app, CloudProvider::Openrouter)? {
        headers.push(("Authorization", format!("Bearer {key}")));
    }
    let request = HttpRequest {
        method: HttpMethod::Get,
        url: format!("https://openrouter.ai/api/v1/models?output_modalities={modality}"),
        headers,
        body: HttpBody::Empty,
        audio: false,
    };
    let body = send(request, Duration::from_secs(15)).await.map_err(|e| e.to_string())?;
    let models = parse_models(&body, capability).map_err(|e| e.to_string())?;
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    cache.retain(|(k, _, _)| *k != capability);
    cache.push((capability, Instant::now(), models.clone()));
    Ok(models)
}
```

Register `voice_providers::openrouter::voice_openrouter_models,` in `lib.rs`.

- [ ] **Step 4: Frontend**

`voiceProviders.ts`:

```ts
export function voiceOpenrouterModels(kind: 'stt' | 'tts'): Promise<VoiceCatalogModel[]> {
  return invoke('voice_openrouter_models', { kind })
}
```

`useVoiceCatalog.ts` — after the curated list loads, when `useProjectsStore.getState().preferences.voiceProviders.openrouter?.configured`:

```ts
export function useVoiceCatalog(): VoiceProviderCatalog[] {
  const [catalog, setCatalog] = useState<VoiceProviderCatalog[]>([])
  const openrouterReady = useProjectsStore((s) => s.preferences.voiceProviders.openrouter?.configured === true)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await voiceProviderCatalog().catch(() => [] as VoiceProviderCatalog[])
      if (cancelled) return
      setCatalog(list)
      if (!openrouterReady) return
      const live = await Promise.all([voiceOpenrouterModels('stt'), voiceOpenrouterModels('tts')]).catch(() => null)
      if (cancelled || !live) return
      setCatalog(
        list.map((entry) => (entry.provider === 'openrouter' ? { ...entry, models: live.flat() } : entry)),
      )
    })()
    return () => {
      cancelled = true
    }
  }, [openrouterReady])
  return catalog
}
```

`ProviderChoiceCard.tsx` — replace the `.rows` block with:

```tsx
      {rows.length > 6 ? (
        <Dropdown
          value={rows.find((row) => row.selected)?.id ?? ''}
          ariaLabel={title}
          searchable
          disabled={Boolean(locked)}
          placeholder={t('prefs.voicePickModel')}
          searchPlaceholder={t('prefs.voiceSearchModels')}
          options={rows.map((row) => ({ value: row.id, label: row.label, disabled: row.disabled, searchText: row.label }))}
          onChange={onSelect}
        />
      ) : (
        <div className={styles.rows} role="radiogroup" aria-label={title}>
          {/* ... existing row buttons ... */}
        </div>
      )}
```

`ProviderDetail.tsx` — swap the curated list for `useVoiceCatalog()` (so OpenRouter shows the live list) and add a filter input above the model list when it has more than 6 entries:

```tsx
  const [query, setQuery] = useState('')
  const catalog = useVoiceCatalog().find((entry) => entry.provider === id) ?? null
  const shown = (catalog?.models ?? []).filter((model) =>
    `${model.label} ${model.id}`.toLowerCase().includes(query.trim().toLowerCase()),
  )
```

```tsx
          {catalog.models.length > 6 ? (
            <input
              className={`${controls.input} ${styles.search}`}
              type="search"
              value={query}
              placeholder={t('prefs.voiceSearchModels')}
              aria-label={t('prefs.voiceSearchModels')}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
```

and render `shown` instead of `catalog.models`. Remove the component's own `voiceProviderCatalog` effect. CSS: `.search { width: 100%; }`.

- [ ] **Step 5: i18n keys**

| key | en | pt-BR | zh-CN |
|---|---|---|---|
| `prefs.voicePickModel` | Pick a model | Escolha um modelo | 选择模型 |
| `prefs.voiceSearchModels` | Search models… | Pesquisar modelos… | 搜索模型… |

- [ ] **Step 6: Run the checks**

Run: `cd src-tauri && cargo test --lib && cargo clippy --lib -- -D warnings`; `npx vitest run && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 7: Checkpoint**

Show `git status --short`; ask; on yes: `git commit -m "feat(voice): list OpenRouter speech models live"`.

---

### Task 16: Changelog, features doc and full verification

**Files:**
- Modify: `docs/CHANGELOG.md` (`[Unreleased]` → `### Added` / `### Changed`), `docs/FEATURES.md` (`## Voice Conversation`, line ~164)

- [ ] **Step 1: Changelog**

Under `## [Unreleased]` → `### Added`, add:

```markdown
- **Voice providers.** Preferences has a new **Voice** page. Dictation, voice conversation and
  narration each pick their own provider: models on this device (Parakeet, Zipformer, Whisper,
  Moonshine, Piper voices, Apple Speech, the system voice) or a cloud API with your own key
  (OpenAI, ElevenLabs, Google Gemini, OpenRouter). Keys are kept in the system keychain per
  profile. A provider grid shows what is connected, a provider page saves, tests and removes keys
  and manages downloaded models, and **Test voice** previews narration. If a cloud provider fails,
  Alethe uses a local engine for that turn and says why. Local stays the default; audio or text
  only leaves the device for a use you set to a cloud provider.
```

Under `### Changed` (create it if absent):

```markdown
- Voice dictation and voice conversation settings moved from Preferences → Integrations to
  Preferences → Voice. Existing model, language, voice and speed choices carry over.
```

Edit the earlier Apple-speech entry in `[Unreleased]` that says *Preferences → Integrations → Voice dictation* to say *Preferences → Voice*.

- [ ] **Step 2: Features doc**

In `docs/FEATURES.md`, add a `### Voice providers` subsection under `## Voice Conversation` covering: the three uses and their per-use choice; the provider list (local and cloud); keychain storage per profile and the "never shown again" behaviour; the cloud-to-local fallback order (Apple Speech with a set language → first downloaded local model; narration → system voice) and the toast; downloaded model locations (`<app data>/speech-models/<id>`); OpenRouter's live model list. Replace any "Integrations → Voice" path in that section with "Voice".

- [ ] **Step 3: Full verification**

Run, in order, and read every output:

```bash
npm test
npm run build
cd src-tauri && cargo test && cargo clippy -- -D warnings
grep -rn "dictationModelId\|dictationNativeLocale\|voiceTtsVoice\|voiceTtsRate" src --include='*.ts' --include='*.tsx' | grep -v "voicePreferences\|migrations"
grep -rn "Integrations → Voice\|Integrações → Voz" src src-tauri/src docs
```

Expected: tests and build pass; clippy clean; both greps print nothing.

- [ ] **Step 4: Manual pass in the running app** (do not start or restart it; skip and report if it is not running)

1. Preferences → Voice opens on Dictation; the search "openai" jumps to Providers.
2. Save a real OpenAI key → card shows *Connected*; Dictation tab → pick *GPT-4o mini Transcribe* → dictate → text arrives.
3. Turn off the network → dictate again → toast "OpenAI unavailable … Used Apple Speech / Local models", text still arrives.
4. Save a wrong key → *Invalid key* badge; Test connection explains the rejection.
5. Narration → pick an OpenAI voice → Test voice plays; start conversation and talk over narration → audio stops at once.
6. Remove the OpenAI key → every use on OpenAI shows the local default again.
7. Switch profile → the other profile shows OpenAI as *Not connected*.
8. Check `spawn.log` (`%APPDATA%/Alethe/…` or the macOS app-data folder) contains no key text.

- [ ] **Step 5: Checkpoint**

Show `git status --short`; ask; on yes: `git commit -m "docs: document voice providers"`.
