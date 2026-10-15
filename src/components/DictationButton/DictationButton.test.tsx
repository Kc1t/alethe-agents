import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectsStore } from '../../stores/projectsStore'
import { useVoiceConversationStore } from '../../stores/voiceConversationStore'
import { DictationButton } from '.'

const tauri = vi.hoisted(() => ({
  speechPrepare: vi.fn(),
  speechStartCapture: vi.fn(),
  speechStopAndTranscribe: vi.fn(),
  speechStopCapture: vi.fn(),
  writePty: vi.fn(),
}))

vi.mock('../../lib/tauri', () => tauri)
vi.mock('../../lib/i18n', () => ({ useT: () => (key: string) => key }))

const press = async () => {
  await act(async () => {
    fireEvent.keyDown(window, { key: 'e', ctrlKey: true })
  })
}

const appleStt = (locale: string | null) => ({
  voiceStt: {
    dictation: { provider: 'apple' as const, model: 'apple-speech', locale },
    conversation: { provider: 'apple' as const, model: 'apple-speech', locale },
  },
})

const setPrefs = (patch: Record<string, unknown>) =>
  useProjectsStore.setState((s) => ({ preferences: { ...s.preferences, ...patch } }))

describe('DictationButton native engine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useVoiceConversationStore.setState({ shortcutRecording: false })
    tauri.speechPrepare.mockResolvedValue(true)
    tauri.speechStartCapture.mockResolvedValue(undefined)
    tauri.speechStopAndTranscribe.mockResolvedValue('')
    tauri.speechStopCapture.mockResolvedValue(undefined)
    setPrefs({
      dictationEnabled: true,
      dictationMode: 'toggle',
      ...appleStt(null),
    })
  })

  it('leaves the chord to the voice shortcut recorder while it is capturing', async () => {
    setPrefs({ ...appleStt('pt-BR') })
    useVoiceConversationStore.setState({ shortcutRecording: true })
    render(<DictationButton />)
    await press()
    expect(tauri.speechPrepare).not.toHaveBeenCalled()
    expect(tauri.speechStartCapture).not.toHaveBeenCalled()
  })

  it('asks for a language and never captures without one', async () => {
    render(<DictationButton />)
    await press()
    expect(tauri.speechStartCapture).not.toHaveBeenCalled()
    expect(screen.getByTitle('speech.nativeLocaleRequired')).toBeTruthy()
  })

  it('transcribes with the chosen locale', async () => {
    setPrefs({ ...appleStt('pt-BR') })
    render(<DictationButton />)
    await press()
    expect(tauri.speechPrepare).toHaveBeenCalledWith('apple-speech', 'pt-BR', 'apple')
    expect(tauri.speechStartCapture).toHaveBeenCalledTimes(1)
    await press()
    expect(tauri.speechStopAndTranscribe).toHaveBeenCalledWith('apple-speech', 'pt-BR', {
      provider: 'apple',
      fallbackLocale: 'pt-BR',
      usage: 'dictation',
    })
  })

  it('does not capture when Apple recognition is not ready', async () => {
    setPrefs({ ...appleStt('pt-BR') })
    tauri.speechPrepare.mockResolvedValue(false)
    render(<DictationButton />)
    await press()
    expect(tauri.speechStartCapture).not.toHaveBeenCalled()
    expect(screen.getByTitle('speech.nativeNotReady')).toBeTruthy()
  })

  it('stops the capture when the key is released while permission is pending', async () => {
    setPrefs({ ...appleStt('pt-BR'), dictationMode: 'hold' })
    let resolvePrepare: (ready: boolean) => void = () => undefined
    tauri.speechPrepare.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolvePrepare = resolve
      }),
    )
    render(<DictationButton />)
    await press()
    await act(async () => {
      fireEvent.keyUp(window, { key: 'e', ctrlKey: true })
    })
    await act(async () => {
      resolvePrepare(true)
    })
    expect(tauri.speechStartCapture).toHaveBeenCalledTimes(1)
    expect(tauri.speechStopAndTranscribe).toHaveBeenCalledWith('apple-speech', 'pt-BR', {
      provider: 'apple',
      fallbackLocale: 'pt-BR',
      usage: 'dictation',
    })
  })

  it('ignores a second press while permission is pending', async () => {
    setPrefs({ ...appleStt('pt-BR') })
    let resolvePrepare: (ready: boolean) => void = () => undefined
    tauri.speechPrepare.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolvePrepare = resolve
      }),
    )
    render(<DictationButton />)
    await press()
    await press()
    await act(async () => {
      resolvePrepare(true)
    })
    expect(tauri.speechPrepare).toHaveBeenCalledTimes(1)
    expect(tauri.speechStartCapture).toHaveBeenCalledTimes(1)
    expect(tauri.speechStopAndTranscribe).toHaveBeenCalledTimes(1)
  })

  // No local engine could take over: say which provider failed and why, and flag a rejected key.
  it('explains a cloud failure in words and marks a rejected key invalid', async () => {
    setPrefs({
      voiceStt: {
        dictation: { provider: 'openai', model: 'gpt-4o-transcribe', locale: null },
        conversation: { provider: 'local', model: 'parakeet-tdt-0.6b-v3-int8', locale: null },
      },
      voiceProviders: { openai: { configured: true, invalid: false } },
    })
    tauri.speechStopAndTranscribe.mockRejectedValue(new Error('voice_cloud_auth (HTTP 401)'))
    render(<DictationButton />)
    await press()
    await press()
    expect(screen.getByTitle('voice.fallback.title — prefs.voiceTestFailed.auth')).toBeTruthy()
    expect(useProjectsStore.getState().preferences.voiceProviders.openai?.invalid).toBe(true)
  })
})
