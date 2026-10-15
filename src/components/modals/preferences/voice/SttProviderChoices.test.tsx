import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../../../lib/types'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { SttProviderChoices } from './SttProviderChoices'

const tauri = vi.hoisted(() => ({
  speechListModels: vi.fn(),
  speechModelStates: vi.fn(),
  speechNativeLocales: vi.fn(),
  onSpeechDownloadProgress: vi.fn(),
  voiceProviderCatalog: vi.fn(),
  voiceOpenrouterModels: vi.fn(),
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
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
    tauri.voiceOpenrouterModels.mockReset().mockResolvedValue([])
    tauri.speechNativeLocales.mockResolvedValue([
      { id: 'pt-BR', name: 'Português', installed: true },
    ])
    tauri.onSpeechDownloadProgress.mockResolvedValue(() => undefined)
    tauri.speechListModels.mockResolvedValue([
      {
        id: 'parakeet-tdt-0.6b-v3-int8',
        label: 'Parakeet',
        kind: 'download',
        capability: 'stt',
        sizeBytes: 1,
      },
      { id: 'piper-pt', label: 'Piper', kind: 'download', capability: 'tts', sizeBytes: 1 },
    ])
    tauri.speechModelStates.mockResolvedValue([
      { id: 'parakeet-tdt-0.6b-v3-int8', status: 'ready' },
    ])
    tauri.voiceProviderCatalog.mockResolvedValue([
      {
        provider: 'openai',
        keyUrl: 'https://x',
        voices: [],
        models: [{ id: 'whisper-1', label: 'Whisper', capability: 'stt' }],
      },
      {
        provider: 'gemini',
        keyUrl: 'https://x',
        voices: [],
        models: [{ id: 'gemini-2.5-flash', label: 'Flash', capability: 'stt' }],
      },
    ])
    useProjectsStore
      .getState()
      .setPreferences({ voiceProviders: { openai: { configured: true, invalid: false } } })
  })

  const openModels = async (provider: string) => {
    fireEvent.click(
      await screen.findByRole('button', {
        name: `prefs.voicePickModelFor:{"provider":"${provider}"}`,
      }),
    )
  }

  it('selects a cloud provider for one use only', async () => {
    render(<SttProviderChoices use="conversation" onOpenProvider={() => undefined} />)
    fireEvent.click(await screen.findByRole('radio', { name: 'voice.provider.openai' }))
    expect(prefs().voiceStt.conversation).toEqual({
      provider: 'openai',
      model: 'whisper-1',
      locale: null,
    })
    expect(prefs().voiceStt.dictation.provider).toBe('local')
  })

  it('marks the provider in use', async () => {
    render(<SttProviderChoices use="dictation" onOpenProvider={() => undefined} />)
    const local = await screen.findByRole('radio', { name: 'voice.provider.local' })
    expect(local.getAttribute('aria-checked')).toBe('true')
    expect(screen.getAllByText('prefs.voiceStatusInUse')).toHaveLength(1)
    expect(screen.getByText('prefs.voiceGroupLocal')).toBeTruthy()
    expect(screen.getByText('prefs.voiceGroupCloud')).toBeTruthy()
  })

  it('shows the privacy note on the selected cloud card only', async () => {
    useProjectsStore.getState().setPreferences({
      voiceStt: {
        dictation: { provider: 'openai', model: 'whisper-1', locale: null },
        conversation: { provider: 'local', model: 'parakeet-tdt-0.6b-v3-int8', locale: null },
      },
    })
    render(<SttProviderChoices use="dictation" onOpenProvider={() => undefined} />)
    expect(
      await screen.findByText('prefs.voiceCloudSendsAudio:{"provider":"voice.provider.openai"}'),
    ).toBeTruthy()
  })

  it('warns about an invalid key on the provider in use', async () => {
    useProjectsStore.getState().setPreferences({
      voiceProviders: { openai: { configured: true, invalid: true } },
      voiceStt: {
        dictation: { provider: 'openai', model: 'whisper-1', locale: null },
        conversation: { provider: 'local', model: 'parakeet-tdt-0.6b-v3-int8', locale: null },
      },
    })
    render(<SttProviderChoices use="dictation" onOpenProvider={() => undefined} />)
    const openai = await screen.findByRole('radio', { name: 'voice.provider.openai' })
    expect(openai.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('prefs.voiceStatusInvalid')).toBeTruthy()
  })

  it('locks a provider without a key but still lists its models', async () => {
    const onOpen = vi.fn()
    render(<SttProviderChoices use="dictation" onOpenProvider={onOpen} />)
    const gemini = await screen.findByRole('radio', { name: 'voice.provider.gemini' })
    expect((gemini as HTMLButtonElement).disabled).toBe(true)
    await openModels('voice.provider.gemini')
    const flash = await screen.findByRole('option', { name: 'Flash' })
    expect((flash as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(
      screen.getByRole('button', { name: 'prefs.voiceActionSetUpKey voice.provider.gemini' }),
    )
    expect(onOpen).toHaveBeenCalledWith('gemini')
  })

  // Moved from the former ProviderChoiceCard tests: long lists get a search box.
  it("lists OpenRouter's live models before a key exists, with search", async () => {
    tauri.voiceOpenrouterModels.mockImplementation(async (kind: string) =>
      kind === 'stt'
        ? Array.from({ length: 12 }, (_, index) => ({
            id: `vendor/stt-${index}`,
            label: `Live STT ${index}`,
            capability: 'stt',
          }))
        : [],
    )
    tauri.voiceProviderCatalog.mockResolvedValue([
      {
        provider: 'openrouter',
        keyUrl: 'https://x',
        voices: [],
        models: [{ id: 'curated-stt', label: 'Curated', capability: 'stt' }],
      },
    ])
    render(<SttProviderChoices use="dictation" onOpenProvider={() => undefined} />)
    expect(await screen.findByText('Live STT 0')).toBeTruthy()
    expect(
      (screen.getByRole('radio', { name: 'voice.provider.openrouter' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await openModels('voice.provider.openrouter')
    expect(await screen.findByRole('textbox', { name: 'prefs.voiceSearchModels' })).toBeTruthy()
    expect(screen.getAllByRole('option')).toHaveLength(12)
  })

  it('keeps short model lists without a search box', async () => {
    render(<SttProviderChoices use="dictation" onOpenProvider={() => undefined} />)
    await openModels('voice.provider.openai')
    expect(await screen.findByRole('option', { name: 'Whisper' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'prefs.voiceSearchModels' })).toBeNull()
  })

  it('picks a cloud model from its list', async () => {
    tauri.voiceProviderCatalog.mockResolvedValue([
      {
        provider: 'openai',
        keyUrl: 'https://x',
        voices: [],
        models: [
          { id: 'whisper-1', label: 'Whisper', capability: 'stt' },
          { id: 'gpt-4o-transcribe', label: 'Transcribe', capability: 'stt' },
        ],
      },
    ])
    render(<SttProviderChoices use="dictation" onOpenProvider={() => undefined} />)
    await openModels('voice.provider.openai')
    const option = await screen.findByRole('option', { name: 'Transcribe' })
    fireEvent.pointerDown(option)
    fireEvent.click(option)
    expect(prefs().voiceStt.dictation).toEqual({
      provider: 'openai',
      model: 'gpt-4o-transcribe',
      locale: null,
    })
  })

  it('lists only downloaded speech-to-text local models', async () => {
    render(<SttProviderChoices use="dictation" onOpenProvider={() => undefined} />)
    await openModels('voice.provider.local')
    expect(await screen.findByRole('option', { name: 'Parakeet' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /Piper/ })).toBeNull()
  })

  it('offers to manage models when none is downloaded', async () => {
    tauri.speechModelStates.mockResolvedValue([])
    const onOpen = vi.fn()
    render(<SttProviderChoices use="dictation" onOpenProvider={onOpen} />)
    fireEvent.click(await screen.findByRole('button', { name: 'prefs.voiceActionManageModels' }))
    expect(onOpen).toHaveBeenCalledWith('local')
  })

  const withApple = (status: string) => {
    tauri.speechListModels.mockResolvedValue([
      { id: 'apple-speech', label: 'Apple', kind: 'native', capability: 'stt', sizeBytes: 0 },
    ])
    tauri.speechModelStates.mockResolvedValue([{ id: 'apple-speech', status }])
  }

  it('explains a denied Apple permission', async () => {
    withApple('denied')
    render(<SttProviderChoices use="dictation" onOpenProvider={() => undefined} />)
    expect(await screen.findByText('prefs.dictationNativeDenied')).toBeTruthy()
  })

  it('explains an empty locale list and hides the dropdown', async () => {
    withApple('needs-locale')
    tauri.speechNativeLocales.mockResolvedValue([])
    useProjectsStore.getState().setPreferences({
      voiceStt: {
        dictation: { provider: 'apple', model: 'apple-speech', locale: null },
        conversation: { provider: 'local', model: 'parakeet-tdt-0.6b-v3-int8', locale: null },
      },
    })
    render(<SttProviderChoices use="dictation" onOpenProvider={() => undefined} />)
    expect(await screen.findByText('prefs.dictationNativeNoLocales')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'prefs.dictationNativeLocale' })).toBeNull()
  })

  it('picks an Apple locale for one use only', async () => {
    withApple('needs-locale')
    const before = prefs().voiceStt.conversation
    render(<SttProviderChoices use="dictation" onOpenProvider={() => undefined} />)
    fireEvent.click(await screen.findByRole('radio', { name: 'voice.provider.apple' }))
    fireEvent.click(await screen.findByRole('button', { name: 'prefs.dictationNativeLocale' }))
    const option = await screen.findByRole('option', {
      name: 'prefs.dictationNativeLocaleInstalled:{"name":"Português"}',
    })
    fireEvent.pointerDown(option)
    fireEvent.click(option)
    expect(prefs().voiceStt.dictation).toEqual({
      provider: 'apple',
      model: 'apple-speech',
      locale: 'pt-BR',
    })
    expect(prefs().voiceStt.conversation).toEqual(before)
  })
})
