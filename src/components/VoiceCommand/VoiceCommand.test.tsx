import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '../../stores/uiStore'
import { useVoiceConversationStore } from '../../stores/voiceConversationStore'
import { VoiceCommand } from '.'

const jevDecide = vi.hoisted(() => vi.fn())
const speechStartCapture = vi.hoisted(() => vi.fn())
const speechPrepare = vi.hoisted(() => vi.fn())
const speechStopAndTranscribe = vi.hoisted(() => vi.fn())
const mockPrefs = vi.hoisted(() => ({
  voiceStt: {
    dictation: { provider: 'local', model: 'parakeet-tdt-0.6b-v3-int8', locale: null as string | null },
    conversation: { provider: 'local', model: 'parakeet-tdt-0.6b-v3-int8', locale: null as string | null },
  },
}))
const setStt = (provider: 'local' | 'apple', model: string, locale: string | null) => {
  mockPrefs.voiceStt = {
    dictation: { provider, model, locale },
    conversation: { provider, model, locale },
  }
}

vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  jevDecide,
  speechListInputDevices: vi.fn().mockResolvedValue([]),
  speechPrepare,
  speechStopAndTranscribe,
  speechStartCapture,
  speechStopCapture: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../stores/projectsStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/projectsStore')>()
  const base = actual.useProjectsStore.getState()
  const state = {
    ...base,
    // A getter so each test's mockPrefs changes are seen on the next render.
    get preferences() {
      return {
        ...base.preferences,
        voiceCommandApiKey: 'key',
        dictationEnabled: true,
        ...mockPrefs,
      }
    },
  }
  const useProjectsStore = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    { getState: () => state, setState: () => undefined, subscribe: () => () => undefined },
  )
  return { ...actual, useProjectsStore }
})

describe('VoiceCommand request hand-off', () => {
  beforeEach(() => {
    useUiStore.setState({ voiceCommandRequest: null })
    useVoiceConversationStore.setState({ shortcutRecording: false })
    setStt('local', 'parakeet-tdt-0.6b-v3-int8', null)
    speechStartCapture.mockReset()
    speechPrepare.mockReset()
    speechPrepare.mockResolvedValue(true)
    speechStopAndTranscribe.mockReset()
    speechStopAndTranscribe.mockResolvedValue('')
    jevDecide.mockReset()
    jevDecide.mockImplementation(() => new Promise(() => undefined))
  })

  it('consumes a request once, however often it re-renders, and can be closed', async () => {
    const { rerender } = render(<VoiceCommand />)
    await act(async () => {
      useUiStore.getState().openVoiceCommand('open claude in billing')
    })
    for (let i = 0; i < 5; i++) rerender(<VoiceCommand />)
    expect(jevDecide).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape', code: 'Escape' })
    })
    for (let i = 0; i < 3; i++) rerender(<VoiceCommand />)
    expect(jevDecide).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('leaves its chord to the voice shortcut recorder while it is capturing', async () => {
    render(<VoiceCommand />)
    const chord = { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true }
    useVoiceConversationStore.setState({ shortcutRecording: true })
    await act(async () => {
      fireEvent.keyDown(window, chord)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    useVoiceConversationStore.setState({ shortcutRecording: false })
    await act(async () => {
      fireEvent.keyDown(window, chord)
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('opens the bar without deciding when the text is empty', async () => {
    render(<VoiceCommand />)
    await act(async () => {
      useUiStore.getState().openVoiceCommand('')
    })
    expect(jevDecide).not.toHaveBeenCalled()
  })

  it('does not record with the native engine until a language is chosen', async () => {
    setStt('apple', 'apple-speech', null)
    render(<VoiceCommand />)
    await act(async () => {
      useUiStore.getState().openVoiceCommand('')
    })
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Start recording'))
    })
    expect(speechStartCapture).not.toHaveBeenCalled()
    expect(screen.getByText(/native recognition language/)).toBeTruthy()
  })

  it('transcribes once and prepares once when the mic is toggled during the permission prompt', async () => {
    setStt('apple', 'apple-speech', 'pt-BR')
    let resolvePrepare: (ready: boolean) => void = () => undefined
    speechPrepare.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolvePrepare = resolve
      }),
    )
    speechStartCapture.mockResolvedValue(undefined)
    render(<VoiceCommand />)
    await act(async () => {
      useUiStore.getState().openVoiceCommand('')
    })
    speechPrepare.mockClear()
    const mic = screen.getByLabelText('Start recording')
    await act(async () => {
      fireEvent.click(mic)
    })
    await act(async () => {
      fireEvent.click(mic)
    })
    await act(async () => {
      resolvePrepare(true)
    })
    expect(speechPrepare).toHaveBeenCalledTimes(1)
    expect(speechStartCapture).toHaveBeenCalledTimes(1)
    expect(speechStopAndTranscribe).toHaveBeenCalledWith('apple-speech', 'pt-BR', {
      provider: 'apple',
      fallbackLocale: 'pt-BR',
      usage: 'conversation',
    })
  })

  it('does not prepare in the background until a language is chosen', async () => {
    setStt('apple', 'apple-speech', null)
    render(<VoiceCommand />)
    await act(async () => {
      useUiStore.getState().openVoiceCommand('')
    })
    expect(speechPrepare).not.toHaveBeenCalled()
  })

  it('never prepares the native engine in the background, even with a language', async () => {
    setStt('apple', 'apple-speech', 'pt-BR')
    render(<VoiceCommand />)
    await act(async () => {
      useUiStore.getState().openVoiceCommand('')
    })
    expect(speechPrepare).not.toHaveBeenCalled()
  })

  it('warms the downloaded engine in the background when the bar opens', async () => {
    render(<VoiceCommand />)
    await act(async () => {
      useUiStore.getState().openVoiceCommand('')
    })
    expect(speechPrepare).toHaveBeenCalledWith('parakeet-tdt-0.6b-v3-int8', null, 'local')
  })
})
