import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../../../lib/types'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { useVoiceConversationStore } from '../../../../stores/voiceConversationStore'
import { useVoiceServersStore } from '../../../../stores/voiceServersStore'
import { NarrationPanel } from './NarrationPanel'

const tauri = vi.hoisted(() => ({
  speechListModels: vi.fn(),
  speechModelStates: vi.fn(),
  voiceProviderCatalog: vi.fn(),
  voiceOpenrouterModels: vi.fn(),
  ttsVoices: vi.fn(),
  ttsSpeak: vi.fn(),
  voiceServersList: vi.fn(),
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

const server = {
  id: 'V1StGXR8_Z5jdHi6B-myT',
  name: 'Chatterbox',
  kind: 'openai' as const,
  baseUrl: 'http://localhost:4123',
  model: null,
  hasKey: false,
}

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
    tauri.voiceServersList.mockReset().mockResolvedValue([server])
    useVoiceServersStore.setState({ servers: [], loaded: false, health: {} })
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
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
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
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
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
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    await screen.findByText('Kokoro')
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceConvVoice' }))
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4))
    const labels = screen.getAllByRole('option').map((option) => option.textContent)
    expect(labels[0]).toBe('prefs.voiceDefaultVoice')
    expect(labels[1]).toBe('Dora (prefs.voiceGenderFemale) · português (Brasil)')
    expect(labels[2]).toBe('Kore · prefs.voiceLangMulti')
  })

  it('keeps an explicit provider default after the automatic pick', async () => {
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
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
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    fireEvent.click(await screen.findByRole('radio', { name: 'voice.provider.system' }))
    await waitFor(() => expect(tauri.ttsVoices).toHaveBeenCalledWith('system', undefined))
    await flush()
    expect(prefs().voiceTts).toMatchObject({ provider: 'system', voice: null })
  })

  it('explains multilingual voices under the picker', async () => {
    useProjectsStore.getState().setPreferences({
      voiceTts: { provider: 'openrouter', model: 'hexgrad/kokoro-82m', voice: 'Kore', rate: 1 },
    })
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
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
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    await waitFor(() => expect(prefs().voiceTts.voice).toBe('nova'))
  })

  it('keeps a saved provider default when the list loads', async () => {
    useProjectsStore.getState().setPreferences({
      voiceTts: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: null, rate: 1 },
    })
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    await waitFor(() => expect(tauri.ttsVoices).toHaveBeenCalledWith('openai', 'gpt-4o-mini-tts'))
    await flush()
    expect(prefs().voiceTts.voice).toBeNull()
  })

  it('gives an ElevenLabs choice without a voice an account voice in the app language', async () => {
    useProjectsStore.getState().setPreferences({
      language: 'pt-BR',
      voiceProviders: { elevenlabs: { configured: true, invalid: false } },
      voiceTts: { provider: 'elevenlabs', model: 'eleven_flash_v2_5', voice: null, rate: 1 },
    })
    tauri.ttsVoices.mockImplementation(async (provider?: string) =>
      provider === 'elevenlabs'
        ? [
            { id: 'el-rachel', name: 'Rachel', language: 'en' },
            { id: 'el-camila', name: 'Camila', language: 'pt-BR' },
          ]
        : [],
    )
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    await waitFor(() =>
      expect(tauri.ttsVoices).toHaveBeenCalledWith('elevenlabs', 'eleven_flash_v2_5'),
    )
    await waitFor(() => expect(prefs().voiceTts.voice).toBe('el-camila'))
    expect(prefs().voiceTts).toMatchObject({ provider: 'elevenlabs', model: 'eleven_flash_v2_5' })
  })

  it('keeps a saved OpenRouter provider default when its voices load', async () => {
    useProjectsStore.getState().setPreferences({
      language: 'pt-BR',
      voiceTts: { provider: 'openrouter', model: 'hexgrad/kokoro-82m', voice: null, rate: 1 },
    })
    // Before the live catalog arrives the panel asks the backend, which lists the model's voices.
    tauri.ttsVoices.mockImplementation(async (provider?: string) =>
      provider === 'openrouter' ? routerVoices.map((id) => ({ id, name: id, language: '' })) : [],
    )
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    await waitFor(() =>
      expect(tauri.ttsVoices).toHaveBeenCalledWith('openrouter', 'hexgrad/kokoro-82m'),
    )
    await flush()
    expect(prefs().voiceTts).toMatchObject({ provider: 'openrouter', voice: null })
  })

  it('keeps a saved local provider default (single-speaker model)', async () => {
    useProjectsStore.getState().setPreferences({
      voiceTts: { provider: 'local', model: 'piper-pt', voice: null, rate: 1 },
    })
    tauri.ttsVoices.mockImplementation(async (provider?: string) =>
      provider === 'local' ? [{ id: 'piper-pt', name: 'Faber', language: 'pt-BR' }] : [],
    )
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    await waitFor(() => expect(tauri.ttsVoices).toHaveBeenCalledWith('local', 'piper-pt'))
    await flush()
    expect(prefs().voiceTts.voice).toBeNull()
  })

  it('replaces a saved OpenRouter voice the model does not have', async () => {
    useProjectsStore.getState().setPreferences({
      language: 'pt-BR',
      voiceTts: { provider: 'openrouter', model: 'hexgrad/kokoro-82m', voice: 'ghost', rate: 1 },
    })
    tauri.ttsVoices.mockImplementation(async (provider?: string) =>
      provider === 'openrouter' ? routerVoices.map((id) => ({ id, name: id, language: '' })) : [],
    )
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    await waitFor(() => expect(prefs().voiceTts.voice).toBe('pf_dora'))
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
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    expect(await screen.findByText('Piper B')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'voice.provider.local' }))
    expect(prefs().voiceTts.model).toBe('piper-b')
  })

  it('sums up the chosen local voice on its card', async () => {
    tauri.speechListModels.mockResolvedValue([
      {
        id: 'piper-pt-br-faber-medium',
        label: 'Piper Faber',
        kind: 'download',
        capability: 'tts',
        sizeBytes: 1,
      },
    ])
    tauri.speechModelStates.mockResolvedValue([{ id: 'piper-pt-br-faber-medium', status: 'ready' }])
    useProjectsStore.getState().setPreferences({
      voiceTts: { provider: 'local', model: 'piper-pt-br-faber-medium', voice: null, rate: 1 },
    })
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    const local = await screen.findByRole('article', { name: 'voice.provider.local' })
    expect(await within(local).findByText(/^Portuguese \(Brazil\)/)).toBeTruthy()
    expect(
      within(local).getByRole('img', {
        name: 'prefs.voiceTierLabel:{"label":"prefs.voiceColSpeed","tier":3}',
      }),
    ).toBeTruthy()
    expect(
      within(local).getByRole('img', {
        name: 'prefs.voiceTierLabel:{"label":"prefs.voiceColQuality","tier":2}',
      }),
    ).toBeTruthy()
  })

  it('offers to manage models when no local voice is downloaded', async () => {
    const onOpen = vi.fn()
    render(<NarrationPanel onOpenProvider={onOpen} />)
    const local = await screen.findByRole('radio', { name: 'voice.provider.local' })
    expect((local as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceActionManageModels' }))
    expect(onOpen).toHaveBeenCalledWith('local', 'tts')
  })

  it('warns instead of "In use" when the chosen local voice was removed', async () => {
    tauri.speechListModels.mockResolvedValue([
      { id: 'piper-a', label: 'Piper A', kind: 'download', capability: 'tts', sizeBytes: 1 },
    ])
    tauri.speechModelStates.mockResolvedValue([{ id: 'piper-a', status: 'not-downloaded' }])
    useProjectsStore.getState().setPreferences({
      voiceTts: { provider: 'local', model: 'piper-a', voice: null, rate: 1 },
    })
    const onOpen = vi.fn()
    render(<NarrationPanel onOpenProvider={onOpen} />)
    const local = await screen.findByRole('article', { name: 'voice.provider.local' })
    expect(await within(local).findByText('prefs.voiceWarnNotDownloaded')).toBeTruthy()
    expect(within(local).getByText('prefs.voiceStatusNotReady')).toBeTruthy()
    expect(within(local).queryByText('prefs.voiceStatusInUse')).toBeNull()
    fireEvent.click(within(local).getByRole('button', { name: 'prefs.voiceActionManageModels' }))
    expect(onOpen).toHaveBeenCalledWith('local', 'tts')
  })

  it('shows the privacy note on the selected cloud card only', async () => {
    useProjectsStore.getState().setPreferences({
      voiceTts: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova', rate: 1 },
    })
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    expect(
      await screen.findByText('prefs.voiceCloudSendsText:{"provider":"voice.provider.openai"}'),
    ).toBeTruthy()
    expect(screen.queryByText(/voiceCloudSendsText.*openrouter/)).toBeNull()
  })

  it('tests the selected voice with the current settings', async () => {
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceTest' }))
    await waitFor(() =>
      expect(tauri.ttsSpeak).toHaveBeenCalledWith('prefs.voiceTestSentence', prefs().voiceTts),
    )
  })

  // A paused conversation holds the player, so a test would play nothing.
  it('disables the voice test while the narration is paused, and says why', async () => {
    useVoiceConversationStore.setState({ narrationPaused: true })
    try {
      render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
      const button = screen.getByRole('button', { name: 'prefs.voiceTest' })
      expect((button as HTMLButtonElement).disabled).toBe(true)
      expect(button.getAttribute('title')).toBe('prefs.voiceTestPausedHint')
      expect(screen.getByText('prefs.voiceTestPausedHint')).toBeTruthy()
      fireEvent.click(button)
      expect(tauri.ttsSpeak).not.toHaveBeenCalled()
      act(() => useVoiceConversationStore.setState({ narrationPaused: false }))
      expect((button as HTMLButtonElement).disabled).toBe(false)
      expect(screen.queryByText('prefs.voiceTestPausedHint')).toBeNull()
    } finally {
      useVoiceConversationStore.setState({ narrationPaused: false })
    }
  })

  it('sets the narration speed', () => {
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    fireEvent.click(screen.getByRole('radio', { name: 'prefs.voiceConvRateValue:{"rate":1.25}' }))
    expect(prefs().voiceTts.rate).toBe(1.25)
  })

  it('picks a local server and lists its voices', async () => {
    tauri.ttsVoices.mockImplementation(async (provider?: string) =>
      provider === 'server' ? [{ id: 'pt-ref', name: 'pt-ref', language: '' }] : [],
    )
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    fireEvent.click(await screen.findByRole('radio', { name: 'Chatterbox' }))
    expect(prefs().voiceTts).toMatchObject({ provider: 'server', server: server.id, model: '' })
    await waitFor(() =>
      expect(tauri.ttsVoices).toHaveBeenCalledWith('server', undefined, server.id),
    )
    await waitFor(() => expect(prefs().voiceTts.voice).toBe('pt-ref'))
  })

  it("shows the server's tested health, not a fixed Connected", async () => {
    useVoiceServersStore.setState({ health: {} })
    const { unmount } = render(
      <NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />,
    )
    const card = (await screen.findByRole('radio', { name: 'Chatterbox' })).closest('article')!
    expect(within(card).getByText('prefs.voiceStatusDisconnected')).toBeTruthy()
    unmount()
    useVoiceServersStore.setState({ health: { [server.id]: 'connected' } })
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    const next = (await screen.findByRole('radio', { name: 'Chatterbox' })).closest('article')!
    expect(within(next).getByText('prefs.voiceStatusConnected')).toBeTruthy()
    expect(
      within(next).getByRole('button', { name: 'prefs.voiceActionManage · Chatterbox' }),
    ).toBeTruthy()
  })

  it('offers a free-text voice when the server lists none', async () => {
    tauri.ttsVoices.mockResolvedValue([])
    useProjectsStore.getState().setPreferences({
      voiceTts: { provider: 'server', model: '', voice: null, rate: 1, server: server.id },
    })
    render(<NarrationPanel onOpenProvider={() => undefined} onOpenServer={() => undefined} />)
    const input = await screen.findByLabelText('prefs.voiceServerVoiceFree')
    fireEvent.change(input, { target: { value: 'narrador' } })
    fireEvent.blur(input)
    expect(prefs().voiceTts.voice).toBe('narrador')
  })
})
