import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  preferences: {
    voiceProviders: { openrouter: { configured: true, invalid: false } } as Record<
      string,
      { configured: boolean; invalid: boolean }
    >,
    voiceCommandApiKey: '',
    dictationEnabled: true,
    voiceConversationEnabled: false,
    voiceKeepListening: false,
    voiceStt: {
      dictation: { provider: 'local', model: 'test-model', locale: null },
      conversation: { provider: 'local', model: 'test-model', locale: null as string | null },
    },
    voiceShortcut: 'CmdOrCtrl+Shift+Space',
    voiceCommandShortcut: 'CmdOrCtrl+Shift+J',
    dictationMicrophoneId: null,
  },
  setPreferences: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  transcribe: vi.fn(),
  partial: vi.fn(),
  prepare: vi.fn(),
  decide: vi.fn(),
  createTerminal: vi.fn(),
}))

vi.mock('../../lib/i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ preferences: mocks.preferences, setPreferences: mocks.setPreferences }),
    {
      getState: () => ({
        preferences: { ...mocks.preferences, enabledAgents: { claude: true } },
        projects: [{ id: 'lab', name: 'Jev Lab', terminals: [] }],
        createAgentTerminal: mocks.createTerminal,
        setActiveProjectOnly: vi.fn(),
        focusWorkspaceTerminal: vi.fn(),
      }),
    },
  ),
  getProjectDefaultCwd: vi.fn(),
  selectActiveProject: () => ({ id: 'lab' }),
}))
vi.mock('../../lib/tauri', () => ({
  speechStartCapture: mocks.start,
  speechStopCapture: mocks.stop,
  speechListInputDevices: vi.fn().mockResolvedValue([]),
  speechPrepare: mocks.prepare,
  speechCaptureLevel: vi.fn().mockResolvedValue(0),
  speechVadStatus: vi.fn().mockResolvedValue(null),
  speechPrepareVad: vi.fn().mockResolvedValue(true),
  speechTranscribePartial: mocks.partial,
  speechStopAndTranscribe: mocks.transcribe,
  jevDecide: mocks.decide,
  writePty: vi.fn(),
}))

import { useVoiceHistoryStore } from '../../stores/voiceHistoryStore'
import { VoiceCommand } from './index'

const CONFIGURED = { openrouter: { configured: true, invalid: false } }

function open() {
  fireEvent.keyDown(window, { key: 'J', code: 'KeyJ', ctrlKey: true, shiftKey: true })
}

function useConversationEngine(provider: string, model: string) {
  mocks.preferences.voiceStt = {
    ...mocks.preferences.voiceStt,
    conversation: { provider, model, locale: null },
  }
}

describe('voice pill capture lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.preferences.voiceProviders = CONFIGURED
    mocks.preferences.voiceKeepListening = false
    useConversationEngine('local', 'test-model')
    mocks.partial.mockResolvedValue('')
    mocks.prepare.mockResolvedValue(undefined)
    mocks.start.mockResolvedValue(undefined)
    mocks.stop.mockResolvedValue(undefined)
    useVoiceHistoryStore.getState().clear()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('stops a live capture when the open shortcut closes the pill', async () => {
    render(<VoiceCommand />)
    open()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'voice.bar.startRecording' }))
    })
    open()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mocks.stop).toHaveBeenCalledOnce()
  })

  it('stops a capture that finishes starting after Escape', async () => {
    let finish!: () => void
    mocks.start.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    render(<VoiceCommand />)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'voice.bar.startRecording' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    await act(async () => {
      finish()
    })
    expect(mocks.stop).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('does not start continuous capture without an API key', async () => {
    mocks.preferences.voiceProviders = {}
    mocks.preferences.voiceKeepListening = true
    render(<VoiceCommand />)
    open()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('does not allow typing commands or keys in the pill', () => {
    mocks.preferences.voiceProviders = {}
    render(<VoiceCommand />)
    open()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(document.querySelector('input')).toBeNull()
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(mocks.setPreferences).not.toHaveBeenCalled()
    expect(screen.getByText('voice.bar.noKeyHint')).toBeInTheDocument()
  })

  it('re-arms continuous capture only after transcription finishes', async () => {
    mocks.preferences.voiceKeepListening = true
    let finish!: (text: string) => void
    mocks.transcribe.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve
      }),
    )
    render(<VoiceCommand />)
    open()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(mocks.start).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'voice.bar.stopRecording' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(mocks.start).toHaveBeenCalledOnce()
    await act(async () => {
      finish('')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(mocks.start).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('transcribes through OpenRouter without local model work when selected', async () => {
    useConversationEngine('openrouter', 'openai/gpt-audio-mini')
    mocks.prepare.mockResolvedValue(true)
    mocks.transcribe.mockResolvedValue('')
    render(<VoiceCommand />)
    open()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'voice.bar.startRecording' }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'voice.bar.stopRecording' }))
    })
    expect(mocks.partial).not.toHaveBeenCalled()
    // Only the key check before capture; no local model is loaded.
    expect(mocks.prepare).not.toHaveBeenCalledWith(expect.anything(), null, 'local')
    expect(mocks.transcribe).toHaveBeenCalledWith('openai/gpt-audio-mini', null, {
      provider: 'openrouter',
      fallbackLocale: null,
      usage: 'conversation',
    })
  })

  it('creates and records all three terminals requested by a voice decision', async () => {
    const answer = (choice: string) => ({ choice, confidence: 0.95, probabilities: {} })
    mocks.transcribe.mockResolvedValue('open up three terminals')
    mocks.decide.mockResolvedValue({
      action: answer('new_terminal'),
      agent: answer('claude'),
      project: answer('lab'),
      terminal: answer('none'),
      prompt: '',
      promptConfidence: 0,
      tasks: [],
      leadCount: 0.9,
      parallel: 0,
      howMany: 0.5,
      addressedToApp: 0.95,
      destructive: 0,
      latencyMs: 10,
      costUsd: 0,
    })
    mocks.createTerminal.mockImplementation(async () => ({
      id: `terminal-${mocks.createTerminal.mock.calls.length}`,
    }))
    render(<VoiceCommand />)
    open()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'voice.bar.startRecording' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'voice.bar.stopRecording' }))
    })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(3)
    const entry = useVoiceHistoryStore.getState().entries[0]
    expect(entry.status).toBe('ran')
    expect(entry.actions).toHaveLength(3)
    expect(entry.plan?.kind === 'spawn' && entry.plan.jobs.length).toBe(3)
  })
})
