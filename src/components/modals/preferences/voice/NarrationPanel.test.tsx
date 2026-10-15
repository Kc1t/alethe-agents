import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../../../lib/types'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { NarrationPanel } from './NarrationPanel'

const tauri = vi.hoisted(() => ({
  speechListModels: vi.fn(),
  speechModelStates: vi.fn(),
  voiceProviderCatalog: vi.fn(),
  voiceOpenrouterModels: vi.fn(),
  ttsVoices: vi.fn(),
  ttsSpeak: vi.fn(),
}))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/i18n')>()),
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const prefs = () => useProjectsStore.getState().preferences
const routerVoices = ['Kore', 'af_bella', 'pf_dora']
/** Lets pending mocked replies and the effects they trigger settle. */
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

afterEach(cleanup)

describe('NarrationPanel', () => {
  beforeEach(() => {
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
    tauri.speechListModels
      .mockReset()
      .mockResolvedValue([
        { id: 'piper-pt', label: 'Piper', kind: 'download', capability: 'tts', sizeBytes: 1 },
      ])
    tauri.speechModelStates.mockReset().mockResolvedValue([])
    tauri.voiceProviderCatalog.mockReset().mockResolvedValue([
      {
        provider: 'openai',
        keyUrl: 'https://x',
        voices: [],
        models: [{ id: 'gpt-4o-mini-tts', label: 'Mini TTS', capability: 'tts' }],
      },
      {
        provider: 'openrouter',
        keyUrl: 'https://x',
        voices: [],
        models: [{ id: 'curated-tts', label: 'Curated', capability: 'tts' }],
      },
    ])
    tauri.voiceOpenrouterModels
      .mockReset()
      .mockImplementation(async (kind: string) =>
        kind === 'tts'
          ? [{ id: 'hexgrad/kokoro-82m', label: 'Kokoro', capability: 'tts', voices: routerVoices }]
          : [],
      )
    tauri.ttsVoices
      .mockReset()
      .mockImplementation(async (provider?: string) =>
        provider === 'openai'
          ? [{ id: 'nova', name: 'Nova', language: '' }]
          : [{ id: 'sys', name: 'Luciana', language: 'pt-BR' }],
      )
    tauri.ttsSpeak.mockReset().mockResolvedValue(1)
    useProjectsStore.getState().setPreferences({
      voiceProviders: {
        openai: { configured: true, invalid: false },
        openrouter: { configured: true, invalid: false },
      },
    })
  })

  it('switches to a cloud provider and picks a voice it speaks', async () => {
    useProjectsStore
      .getState()
      .setPreferences({ voiceTts: { provider: 'system', model: '', voice: 'sys', rate: 1.5 } })
    render(<NarrationPanel onOpenProvider={() => undefined} />)
    fireEvent.click(await screen.findByRole('radio', { name: 'voice.provider.openai' }))
    expect(prefs().voiceTts).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      rate: 1.5,
    })
    await waitFor(() => expect(tauri.ttsVoices).toHaveBeenCalledWith('openai', 'gpt-4o-mini-tts'))
    await waitFor(() => expect(prefs().voiceTts.voice).toBe('nova'))
  })

  it("defaults an OpenRouter model to a voice in the app's language", async () => {
    useProjectsStore.getState().setPreferences({ language: 'pt-BR' })
    render(<NarrationPanel onOpenProvider={() => undefined} />)
    await screen.findByText('Kokoro')
    fireEvent.click(screen.getByRole('radio', { name: 'voice.provider.openrouter' }))
    await waitFor(() =>
      expect(prefs().voiceTts).toMatchObject({
        provider: 'openrouter',
        model: 'hexgrad/kokoro-82m',
        voice: 'pf_dora',
      }),
    )
    expect(tauri.ttsVoices).not.toHaveBeenCalledWith('openrouter', expect.anything())
  })

  it('lists app-language voices first in the picker', async () => {
    useProjectsStore.getState().setPreferences({
      language: 'pt-BR',
      voiceTts: { provider: 'openrouter', model: 'hexgrad/kokoro-82m', voice: 'Kore', rate: 1 },
    })
    render(<NarrationPanel onOpenProvider={() => undefined} />)
    await screen.findByText('Kokoro')
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceConvVoice' }))
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4))
    const labels = screen.getAllByRole('option').map((option) => option.textContent)
    expect(labels[0]).toBe('prefs.voiceDefaultVoice')
    expect(labels[1]).toBe('Dora (prefs.voiceGenderFemale) · português (Brasil)')
    expect(labels[2]).toBe('Kore · prefs.voiceLangMulti')
  })

  it('keeps an explicit provider default after the automatic pick', async () => {
    render(<NarrationPanel onOpenProvider={() => undefined} />)
    fireEvent.click(await screen.findByRole('radio', { name: 'voice.provider.openai' }))
    await waitFor(() => expect(prefs().voiceTts.voice).toBe('nova'))
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceConvVoice' }))
    const option = await screen.findByRole('option', { name: 'prefs.voiceDefaultVoice' })
    fireEvent.pointerDown(option)
    fireEvent.click(option)
    expect(prefs().voiceTts.voice).toBeNull()
    await flush()
    expect(prefs().voiceTts.voice).toBeNull()
  })

  it('leaves the system voice on the system default', async () => {
    useProjectsStore.getState().setPreferences({
      voiceTts: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova', rate: 1 },
    })
    render(<NarrationPanel onOpenProvider={() => undefined} />)
    fireEvent.click(await screen.findByRole('radio', { name: 'voice.provider.system' }))
    await waitFor(() => expect(tauri.ttsVoices).toHaveBeenCalledWith('system', undefined))
    await flush()
    expect(prefs().voiceTts).toMatchObject({ provider: 'system', voice: null })
  })

  it('explains multilingual voices under the picker', async () => {
    useProjectsStore.getState().setPreferences({
      voiceTts: { provider: 'openrouter', model: 'hexgrad/kokoro-82m', voice: 'Kore', rate: 1 },
    })
    render(<NarrationPanel onOpenProvider={() => undefined} />)
    expect(await screen.findByText('prefs.voiceLangMultiHint')).toBeTruthy()
    act(() =>
      useProjectsStore.getState().setPreferences({
        voiceTts: {
          provider: 'openrouter',
          model: 'hexgrad/kokoro-82m',
          voice: 'pf_dora',
          rate: 1,
        },
      }),
    )
    expect(screen.queryByText('prefs.voiceLangMultiHint')).toBeNull()
  })

  it('replaces a saved voice the loaded list lacks', async () => {
    useProjectsStore.getState().setPreferences({
      voiceTts: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'ghost', rate: 1 },
    })
    render(<NarrationPanel onOpenProvider={() => undefined} />)
    await waitFor(() => expect(prefs().voiceTts.voice).toBe('nova'))
  })

  it('keeps a saved provider default when the list loads', async () => {
    useProjectsStore.getState().setPreferences({
      voiceTts: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: null, rate: 1 },
    })
    render(<NarrationPanel onOpenProvider={() => undefined} />)
    await waitFor(() => expect(tauri.ttsVoices).toHaveBeenCalledWith('openai', 'gpt-4o-mini-tts'))
    await flush()
    expect(prefs().voiceTts.voice).toBeNull()
  })

  it('keeps the chosen local model when its card is clicked again', async () => {
    tauri.speechListModels.mockResolvedValue([
      { id: 'piper-a', label: 'Piper A', kind: 'download', capability: 'tts', sizeBytes: 1 },
      { id: 'piper-b', label: 'Piper B', kind: 'download', capability: 'tts', sizeBytes: 1 },
    ])
    tauri.speechModelStates.mockResolvedValue([
      { id: 'piper-a', status: 'ready' },
      { id: 'piper-b', status: 'ready' },
    ])
    useProjectsStore.getState().setPreferences({
      voiceTts: { provider: 'local', model: 'piper-b', voice: null, rate: 1 },
    })
    render(<NarrationPanel onOpenProvider={() => undefined} />)
    expect(await screen.findByText('Piper B')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'voice.provider.local' }))
    expect(prefs().voiceTts.model).toBe('piper-b')
  })

  it('offers to manage models when no local voice is downloaded', async () => {
    const onOpen = vi.fn()
    render(<NarrationPanel onOpenProvider={onOpen} />)
    const local = await screen.findByRole('radio', { name: 'voice.provider.local' })
    expect((local as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceActionManageModels' }))
    expect(onOpen).toHaveBeenCalledWith('local')
  })

  it('shows the privacy note on the selected cloud card only', async () => {
    useProjectsStore.getState().setPreferences({
      voiceTts: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova', rate: 1 },
    })
    render(<NarrationPanel onOpenProvider={() => undefined} />)
    expect(
      await screen.findByText('prefs.voiceCloudSendsText:{"provider":"voice.provider.openai"}'),
    ).toBeTruthy()
    expect(screen.queryByText(/voiceCloudSendsText.*openrouter/)).toBeNull()
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
