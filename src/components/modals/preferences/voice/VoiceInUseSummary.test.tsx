import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpeechModelManifest } from '../../../../lib/tauri'
import { EMPTY_PROJECTS_FILE, type Preferences } from '../../../../lib/types'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { type RowStatus, useModelDownloads } from './useModelDownloads'
import { VoiceInUseSummary } from './VoiceInUseSummary'

vi.mock('./useModelDownloads')
const tauri = vi.hoisted(() => ({ voiceProviderCatalog: vi.fn(), speechModelStates: vi.fn() }))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/i18n')>()),
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  getLocale: () => 'en',
  intlLocale: () => 'en',
}))

const PARAKEET = 'parakeet-tdt-0.6b-v3-int8'
const WHISPER = 'whisper-base-int8'

const manifest = (id: string, label: string, capability: 'stt' | 'tts'): SpeechModelManifest => ({
  id,
  label,
  description: '',
  language: 'multilingual',
  sampleRate: 16000,
  sizeBytes: 100_000_000,
  recommended: false,
  kind: 'download',
  capability,
})

type Downloads = ReturnType<typeof useModelDownloads>

const statusOf = vi.fn<Downloads['statusOf']>()

function mockDownloads(models: SpeechModelManifest[], statuses: Record<string, RowStatus>) {
  statusOf.mockImplementation((id) => statuses[id] ?? { kind: 'not-downloaded' })
  vi.mocked(useModelDownloads).mockReturnValue({
    models,
    activeId: null,
    statusOf,
    refresh: vi.fn<Downloads['refresh']>(),
    download: vi.fn<Downloads['download']>(),
    pause: vi.fn<Downloads['pause']>(),
    cancel: vi.fn<Downloads['cancel']>(),
    remove: vi.fn<Downloads['remove']>(),
  } satisfies Downloads)
}

const setPrefs = (patch: Partial<Preferences>) => useProjectsStore.getState().setPreferences(patch)

const rowFor = (use: 'Dictation' | 'Conversation' | 'Narration') =>
  screen.getByRole('button', { name: new RegExp(`prefs\\.voiceTab${use}`) })

afterEach(cleanup)

describe('VoiceInUseSummary', () => {
  beforeEach(() => {
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
    vi.mocked(useModelDownloads).mockReset()
    statusOf.mockReset()
    tauri.speechModelStates.mockReset().mockResolvedValue([])
    tauri.voiceProviderCatalog.mockReset().mockResolvedValue([
      {
        provider: 'openai',
        keyUrl: 'https://x',
        voices: [],
        models: [
          { id: 'whisper-1', label: 'Whisper', capability: 'stt' },
          { id: 'gpt-4o-mini-tts', label: 'Mini TTS', capability: 'tts' },
        ],
      },
    ])
  })

  it('lists the provider and model for each use and opens its tab', async () => {
    mockDownloads([manifest(PARAKEET, 'Parakeet TDT v3', 'stt')], { [PARAKEET]: { kind: 'ready' } })
    setPrefs({
      voiceStt: {
        dictation: { provider: 'local', model: PARAKEET, locale: null },
        conversation: { provider: 'apple', model: 'apple-speech', locale: 'pt-BR' },
      },
      voiceTts: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova', rate: 1 },
      voiceProviders: { openai: { configured: true, invalid: false } },
    })
    const onOpenTab = vi.fn()
    render(<VoiceInUseSummary onOpenTab={onOpenTab} />)
    // One downloads hook for the whole summary, not one per row.
    expect(useModelDownloads).toHaveBeenCalledTimes(1)

    expect(screen.getByRole('heading', { name: 'prefs.voiceInUseTitle' })).toBeTruthy()
    const section = screen.getByRole('heading', { name: 'prefs.voiceInUseTitle' })
      .parentElement as HTMLElement
    expect(within(section).getAllByRole('button')).toHaveLength(3)

    const dictation = rowFor('Dictation')
    expect(within(dictation).getByText('voice.provider.local · Parakeet TDT v3')).toBeTruthy()
    expect(within(dictation).getByText('prefs.voiceBadgeDevice')).toBeTruthy()

    const conversation = rowFor('Conversation')
    expect(
      within(conversation).getByText('voice.provider.apple · Portuguese (Brazil)'),
    ).toBeTruthy()
    expect(within(conversation).getByText('prefs.voiceBadgeDevice')).toBeTruthy()

    const narration = rowFor('Narration')
    expect(await within(narration).findByText('voice.provider.openai · Mini TTS')).toBeTruthy()
    expect(within(narration).getByText('prefs.voiceBadgeCloud')).toBeTruthy()

    for (const row of [dictation, conversation, narration]) {
      expect(within(row).queryByText(/^prefs\.voiceWarn|prefs\.voiceStatusInvalid/)).toBeNull()
    }

    fireEvent.click(narration)
    expect(onOpenTab).toHaveBeenLastCalledWith('narration')
    fireEvent.click(dictation)
    expect(onOpenTab).toHaveBeenLastCalledWith('dictation')
    fireEvent.click(conversation)
    expect(onOpenTab).toHaveBeenLastCalledWith('conversation')
    expect(onOpenTab).toHaveBeenCalledTimes(3)
  })

  it('shows the model id until the cloud catalog names it', () => {
    tauri.voiceProviderCatalog.mockReset().mockReturnValue(new Promise(() => undefined))
    mockDownloads([], {})
    setPrefs({
      voiceStt: {
        dictation: { provider: 'openai', model: 'whisper-1', locale: null },
        conversation: { provider: 'openai', model: 'whisper-1', locale: null },
      },
      voiceProviders: { openai: { configured: true, invalid: false } },
    })
    render(<VoiceInUseSummary onOpenTab={() => undefined} />)
    expect(within(rowFor('Dictation')).getByText('voice.provider.openai · whisper-1')).toBeTruthy()
    // The system voice has no model to name.
    expect(within(rowFor('Narration')).getByText('voice.provider.system')).toBeTruthy()
    expect(within(rowFor('Narration')).getByText('prefs.voiceBadgeDevice')).toBeTruthy()
  })

  it('says a chosen local model is still downloading or paused', () => {
    const models = [
      manifest(PARAKEET, 'Parakeet TDT v3', 'stt'),
      manifest(WHISPER, 'Whisper base', 'stt'),
    ]
    setPrefs({
      voiceStt: {
        dictation: { provider: 'local', model: WHISPER, locale: null },
        conversation: { provider: 'local', model: PARAKEET, locale: null },
      },
    })
    const cases: [RowStatus, string][] = [
      [{ kind: 'downloading', progress: null, bytesPerSecond: null }, 'prefs.voiceWarnDownloading'],
      [{ kind: 'verifying' }, 'prefs.voiceWarnDownloading'],
      [{ kind: 'unpacking' }, 'prefs.voiceWarnDownloading'],
      [{ kind: 'paused', downloaded: 40, total: 150 }, 'prefs.voiceWarnPaused'],
    ]
    for (const [status, key] of cases) {
      mockDownloads(models, { [PARAKEET]: { kind: 'ready' }, [WHISPER]: status })
      render(<VoiceInUseSummary onOpenTab={() => undefined} />)
      const dictation = rowFor('Dictation')
      expect(within(dictation).getByText(key)).toBeTruthy()
      expect(within(dictation).queryByText('prefs.voiceWarnNotDownloaded')).toBeNull()
      expect(within(rowFor('Conversation')).queryByText(/^prefs\.voiceWarn/)).toBeNull()
      cleanup()
    }
  })

  it('warns when the chosen local model is not downloaded', () => {
    mockDownloads(
      [manifest(PARAKEET, 'Parakeet TDT v3', 'stt'), manifest(WHISPER, 'Whisper base', 'stt')],
      {
        [PARAKEET]: { kind: 'ready' },
        [WHISPER]: { kind: 'error', message: 'boom', action: 'download' },
      },
    )
    setPrefs({
      voiceStt: {
        dictation: { provider: 'local', model: WHISPER, locale: null },
        conversation: { provider: 'local', model: PARAKEET, locale: null },
      },
    })
    render(<VoiceInUseSummary onOpenTab={() => undefined} />)
    expect(statusOf).toHaveBeenCalledWith(WHISPER)
    const dictation = rowFor('Dictation')
    expect(within(dictation).getByText('voice.provider.local · Whisper base')).toBeTruthy()
    expect(within(dictation).getByText('prefs.voiceWarnNotDownloaded')).toBeTruthy()
    expect(within(rowFor('Conversation')).queryByText('prefs.voiceWarnNotDownloaded')).toBeNull()
    expect(within(rowFor('Narration')).queryByText('prefs.voiceWarnNotDownloaded')).toBeNull()
  })

  it('does not warn about local models before the model list loads', () => {
    mockDownloads([], {})
    setPrefs({
      voiceStt: {
        dictation: { provider: 'local', model: WHISPER, locale: null },
        conversation: { provider: 'local', model: PARAKEET, locale: null },
      },
    })
    render(<VoiceInUseSummary onOpenTab={() => undefined} />)
    expect(screen.queryByText('prefs.voiceWarnNotDownloaded')).toBeNull()
    expect(within(rowFor('Dictation')).getByText(`voice.provider.local · ${WHISPER}`)).toBeTruthy()
  })

  it('warns when a local narration voice is not downloaded', () => {
    mockDownloads([manifest('piper-en-us-amy-low', 'Piper · Amy', 'tts')], {})
    setPrefs({
      voiceTts: { provider: 'local', model: 'piper-en-us-amy-low', voice: null, rate: 1 },
    })
    render(<VoiceInUseSummary onOpenTab={() => undefined} />)
    const narration = rowFor('Narration')
    expect(within(narration).getByText('voice.provider.local · Piper · Amy')).toBeTruthy()
    expect(within(narration).getByText('prefs.voiceWarnNotDownloaded')).toBeTruthy()
  })

  it('warns when a cloud key is invalid or missing', async () => {
    mockDownloads([], {})
    setPrefs({
      voiceStt: {
        dictation: { provider: 'openai', model: 'whisper-1', locale: null },
        conversation: { provider: 'elevenlabs', model: 'scribe_v1', locale: null },
      },
      voiceTts: { provider: 'gemini', model: 'gemini-tts', voice: 'Kore', rate: 1 },
      voiceProviders: {
        openai: { configured: true, invalid: true },
        gemini: { configured: true, invalid: false },
      },
    })
    render(<VoiceInUseSummary onOpenTab={() => undefined} />)
    const dictation = rowFor('Dictation')
    expect(await within(dictation).findByText('voice.provider.openai · Whisper')).toBeTruthy()
    expect(within(dictation).getByText('prefs.voiceStatusInvalid')).toBeTruthy()
    expect(within(dictation).getByText('prefs.voiceBadgeCloud')).toBeTruthy()

    const conversation = rowFor('Conversation')
    expect(within(conversation).getByText('prefs.voiceWarnNoKey')).toBeTruthy()
    expect(within(conversation).queryByText('prefs.voiceStatusInvalid')).toBeNull()

    const narration = rowFor('Narration')
    expect(within(narration).getByText('voice.provider.gemini · gemini-tts')).toBeTruthy()
    expect(within(narration).queryByText('prefs.voiceWarnNoKey')).toBeNull()
    expect(within(narration).queryByText('prefs.voiceStatusInvalid')).toBeNull()
  })

  it('warns when Apple has no language', () => {
    mockDownloads([], {})
    setPrefs({
      voiceStt: {
        dictation: { provider: 'apple', model: 'apple-speech', locale: null },
        conversation: { provider: 'apple', model: 'apple-speech', locale: 'en-US' },
      },
    })
    render(<VoiceInUseSummary onOpenTab={() => undefined} />)
    const dictation = rowFor('Dictation')
    expect(within(dictation).getByText('voice.provider.apple')).toBeTruthy()
    expect(within(dictation).getByText('prefs.dictationNativeNeedsLocale')).toBeTruthy()
    const conversation = rowFor('Conversation')
    expect(
      within(conversation).getByText('voice.provider.apple · English (United States)'),
    ).toBeTruthy()
    expect(within(conversation).queryByText('prefs.dictationNativeNeedsLocale')).toBeNull()
  })

  it('warns when the chosen Apple language is not installed', async () => {
    mockDownloads([], {})
    tauri.speechModelStates.mockImplementation(async (locale?: string | null) => [
      { id: 'apple-speech', status: locale === 'fr-FR' ? 'not-installed' : 'ready' },
    ])
    setPrefs({
      voiceStt: {
        dictation: { provider: 'apple', model: 'apple-speech', locale: 'fr-FR' },
        conversation: { provider: 'apple', model: 'apple-speech', locale: 'en-US' },
      },
    })
    render(<VoiceInUseSummary onOpenTab={() => undefined} />)
    expect(
      await within(rowFor('Dictation')).findByText('prefs.voiceWarnAppleNotInstalled'),
    ).toBeTruthy()
    expect(tauri.speechModelStates).toHaveBeenCalledWith('fr-FR')
    expect(tauri.speechModelStates).toHaveBeenCalledWith('en-US')
    expect(
      within(rowFor('Conversation')).queryByText('prefs.voiceWarnAppleNotInstalled'),
    ).toBeNull()
  })

  it('marks no row with a data attribute; the warning text carries it', () => {
    mockDownloads([manifest(WHISPER, 'Whisper base', 'stt')], {})
    setPrefs({
      voiceStt: {
        dictation: { provider: 'local', model: WHISPER, locale: null },
        conversation: { provider: 'local', model: WHISPER, locale: null },
      },
    })
    render(<VoiceInUseSummary onOpenTab={() => undefined} />)
    expect(rowFor('Dictation').hasAttribute('data-warning')).toBe(false)
  })
})
