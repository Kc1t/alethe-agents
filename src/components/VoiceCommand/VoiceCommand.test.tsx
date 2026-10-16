import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '../../stores/uiStore'
import { useVoiceConversationStore } from '../../stores/voiceConversationStore'
import { useVoiceHistoryStore } from '../../stores/voiceHistoryStore'
import { VoiceCommand } from '.'

const jevDecide = vi.hoisted(() => vi.fn())
const writePty = vi.hoisted(() => vi.fn())
const saveJevKey = vi.hoisted(() => vi.fn())
const agentInput = vi.hoisted(() => ({
  submit: vi.fn(),
  interrupt: vi.fn(),
  readScreen: () => '',
}))
const speechStartCapture = vi.hoisted(() => vi.fn())
const speechPrepare = vi.hoisted(() => vi.fn())
const speechStopAndTranscribe = vi.hoisted(() => vi.fn())
const mockPrefs = vi.hoisted(() => ({
  voiceProviders: { openrouter: { configured: true, invalid: false } } as Record<
    string,
    { configured: boolean; invalid: boolean }
  >,
  voiceConversationEnabled: false,
  voiceStt: {
    dictation: {
      provider: 'local',
      model: 'parakeet-tdt-0.6b-v3-int8',
      locale: null as string | null,
    },
    conversation: {
      provider: 'local',
      model: 'parakeet-tdt-0.6b-v3-int8',
      locale: null as string | null,
    },
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
  writePty,
}))
vi.mock('../../lib/voice/jevKey', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/voice/jevKey')>()),
  saveJevKey,
  migrateLegacyJevKey: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/agentInputRegistry', () => ({
  agentInputFor: (ptyId: string) => (ptyId === 'pty-agent' ? agentInput : null),
  waitForAgentInput: vi.fn().mockResolvedValue(null),
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
    writePty.mockReset()
    writePty.mockResolvedValue(undefined)
    saveJevKey.mockReset()
    saveJevKey.mockResolvedValue(undefined)
    agentInput.submit.mockReset()
    agentInput.submit.mockResolvedValue(undefined)
    mockPrefs.voiceProviders = { openrouter: { configured: true, invalid: false } }
    mockPrefs.voiceConversationEnabled = false
    useUiStore.setState({ notifications: [] })
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
    const chord = { key: 'J', code: 'KeyJ', ctrlKey: true, shiftKey: true }
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

  // A tap too short to record is not a failure: a hint in the history, no failed entry, no toast.
  it('treats a recording too short to transcribe as a hint, not a failure', async () => {
    speechStartCapture.mockResolvedValue(undefined)
    speechStopAndTranscribe.mockRejectedValue('speech_too_short')
    useUiStore.setState({ notifications: [] })
    useVoiceHistoryStore.getState().clear()
    render(<VoiceCommand />)
    await act(async () => {
      useUiStore.getState().openVoiceCommand('')
    })
    const mic = screen.getByLabelText('Start recording')
    await act(async () => {
      fireEvent.click(mic)
    })
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Stop recording'))
    })
    await act(async () => undefined)
    expect(speechStopAndTranscribe).toHaveBeenCalled()
    expect(useUiStore.getState().notifications).toHaveLength(0)
    const [entry] = useVoiceHistoryStore.getState().entries
    expect(entry.status).not.toBe('failed')
    expect(entry.error ?? null).toBeNull()
    expect(entry.summary).toBe('Recording was too short — hold a bit longer, then release.')
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

  it('says voice conversation is off instead of asking for a key on its chord', async () => {
    render(<VoiceCommand />)
    await act(async () => {
      fireEvent.keyDown(window, {
        key: ' ',
        code: 'Space',
        ctrlKey: true,
        shiftKey: true,
      })
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useUiStore.getState().notifications.at(-1)?.title).toBe('Voice conversation is off')
  })

  it('asks for the OpenRouter key and saves it to the keychain on Enter', async () => {
    mockPrefs.voiceProviders = {}
    render(<VoiceCommand />)
    await act(async () => {
      useUiStore.getState().openVoiceCommand('')
    })
    const field = screen.getByLabelText('OpenRouter API key')
    expect(field.getAttribute('type')).toBe('password')
    fireEvent.change(field, { target: { value: ' sk-or-1 ' } })
    expect(saveJevKey).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter', code: 'Enter' })
    })
    expect(saveJevKey).toHaveBeenCalledWith('sk-or-1')
  })

  describe('sending a task to an open pane', () => {
    const decision = (terminal: string) => ({
      addressed: { choice: 'yes', confidence: 0.9 },
      action: { choice: 'send_prompt', confidence: 0.9 },
      project: { choice: 'none', confidence: 0 },
      terminal: { choice: terminal, confidence: 0.9 },
      agents: [],
      prompt: { choice: 'span_0', confidence: 0.9, spans: ['fix the build'] },
      destructive: { choice: 'no', confidence: 0.9 },
      latencyMs: 1,
      costUsd: 0,
    })

    it('goes through the agent pane guarded submit, never a raw write', async () => {
      const plan = await import('../../lib/voiceCommand')
      vi.spyOn(plan, 'planFromDecision').mockReturnValue({
        kind: 'reuse',
        projectId: 'p',
        terminalId: 't',
        terminalName: 'claude · p',
        ptyId: 'pty-agent',
        agent: 'claude',
        prompt: 'fix the build',
      })
      vi.spyOn(plan, 'planWarnings').mockReturnValue([])
      jevDecide.mockResolvedValue(decision('t'))
      render(<VoiceCommand />)
      await act(async () => {
        useUiStore.getState().openVoiceCommand('tell claude to fix the build')
      })
      await act(async () => undefined)
      expect(agentInput.submit).toHaveBeenCalledWith('fix the build')
      expect(writePty).not.toHaveBeenCalled()
      vi.restoreAllMocks()
    })

    it('refuses while the agent shows its own approval menu', async () => {
      const { TerminalPromptOpenError } = await import('../../lib/agentPromptDelivery')
      agentInput.submit.mockRejectedValue(new TerminalPromptOpenError())
      const plan = await import('../../lib/voiceCommand')
      vi.spyOn(plan, 'planFromDecision').mockReturnValue({
        kind: 'reuse',
        projectId: 'p',
        terminalId: 't',
        terminalName: 'claude · p',
        ptyId: 'pty-agent',
        agent: 'claude',
        prompt: 'yes',
      })
      vi.spyOn(plan, 'planWarnings').mockReturnValue([])
      jevDecide.mockResolvedValue(decision('t'))
      render(<VoiceCommand />)
      await act(async () => {
        useUiStore.getState().openVoiceCommand('tell claude yes')
      })
      await act(async () => undefined)
      expect(writePty).not.toHaveBeenCalled()
      expect(useUiStore.getState().notifications.at(-1)?.body).toBe(
        'The agent is asking in the terminal. Answer there first.',
      )
      vi.restoreAllMocks()
    })

    it('still types into a shell, which has no guarded submit', async () => {
      const plan = await import('../../lib/voiceCommand')
      vi.spyOn(plan, 'planFromDecision').mockReturnValue({
        kind: 'reuse',
        projectId: 'p',
        terminalId: 't',
        terminalName: 'shell · p',
        ptyId: 'pty-shell',
        agent: 'shell',
        prompt: 'ls',
      })
      vi.spyOn(plan, 'planWarnings').mockReturnValue([])
      jevDecide.mockResolvedValue(decision('t'))
      render(<VoiceCommand />)
      await act(async () => {
        useUiStore.getState().openVoiceCommand('run ls in the shell')
      })
      await act(async () => undefined)
      expect(writePty).toHaveBeenCalledWith('pty-shell', 'ls\r')
      vi.restoreAllMocks()
    })
  })
})
