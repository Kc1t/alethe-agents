import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TranscriptSnapshot } from '../tauri/handoff'

const tauri = vi.hoisted(() => ({
  speechPrepare: vi.fn(async () => true),
  speechStartCapture: vi.fn(async () => undefined),
  speechStopAndTranscribe: vi.fn(async () => 'fix the build'),
  speechStopCapture: vi.fn(async () => ({ samples: [], sampleRate: 16000, peak: 0 })),
  ttsSpeak: vi.fn(async () => 1),
  ttsStop: vi.fn(async () => undefined),
  onTtsEnd: vi.fn(async (handler: (id: number) => void) => {
    ttsEnd = handler
    return () => undefined
  }),
  onTtsStart: vi.fn(async (handler: (id: number) => void) => {
    ttsStart = handler
    return () => undefined
  }),
  agentPermissionDecide: vi.fn(async () => undefined),
  voiceSetTargets: vi.fn(async (_ptyIds: string[]) => undefined),
  agentVoiceHookedPtys: vi.fn(async (): Promise<string[]> => ['pty-1', 'pty-2']),
  onAgentPermissionReleased: vi.fn(async (handler: (e: { requestId: string }) => void) => {
    released = handler
    return () => undefined
  }),
  agentTranscriptSnapshot: vi.fn(async (..._args: unknown[]): Promise<TranscriptSnapshot> => ({
    sessionId: 's1',
    revision: 1,
    unchanged: false,
    firstIndex: 0,
    messages: [],
  })),
}))
let ttsEnd: (id: number) => void = () => undefined
let ttsStart: (id: number) => void = () => undefined
let released: (e: { requestId: string }) => void = () => undefined
let hook: (e: { payload: Record<string, unknown> }) => void = () => undefined
vi.mock('../tauri', () => tauri)
const events = vi.hoisted(() => ({
  listen: vi.fn(
    async (
      _name: string,
      handler: (e: { payload: Record<string, unknown> }) => void,
    ): Promise<() => void> => {
      hook = handler
      return () => undefined
    },
  ),
}))
vi.mock('@tauri-apps/api/event', () => events)

const input = { submit: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined) }
vi.mock('../agentInputRegistry', () => ({ agentInputFor: vi.fn(() => input) }))

const target = {
  ptyId: 'pty-1',
  projectId: 'p',
  terminalId: 't',
  label: 'P · Claude',
  cwd: '/w',
  sessionId: 's1',
}
const otherTarget = { ...target, ptyId: 'pty-2', terminalId: 't2', label: 'Q · Claude' }
let currentTarget = target
vi.mock('./target', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target')>()),
  listClaudeTargets: vi.fn((_projects: unknown, usable: (ptyId: string) => boolean) =>
    [target, otherTarget].filter((item) => usable(item.ptyId)),
  ),
  resolveTarget: vi.fn(
    (candidates: (typeof target)[]) =>
      candidates.find((item) => item.ptyId === currentTarget.ptyId) ?? null,
  ),
}))

const prefs = {
  language: 'en',
  voiceCaptureMode: 'push-to-talk',
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
  dictationMicrophoneId: null,
  voiceJevTrigger: 'alethe',
  voiceInterruptWords: ['stop', 'espera', 'cancela'],
  voiceMidTaskDefault: 'queue',
  voiceVerbosity: 'silent',
  voiceFillAfterMs: 8000,
  voiceTts: { provider: 'system', model: '', voice: null as string | null, rate: 1 },
  voiceApprovalChannel: 'both',
  voiceDestructiveNeedsHud: true,
  voiceCommandApiKey: '',
}
const setStt = (provider: 'local' | 'apple' | 'openai', model: string, locale: string | null) => {
  prefs.voiceStt = {
    dictation: { provider, model, locale },
    conversation: { provider, model, locale },
  }
}
const workspace = vi.hoisted(() => ({
  setActiveProjectOnly: vi.fn(),
  focusWorkspaceTerminal: vi.fn(),
  setActiveTerminal: vi.fn(),
  requestPaneFocus: vi.fn(),
}))
vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      preferences: prefs,
      projects: [],
      setActiveProjectOnly: workspace.setActiveProjectOnly,
      focusWorkspaceTerminal: workspace.focusWorkspaceTerminal,
    }),
    subscribe: vi.fn(() => () => undefined),
  },
}))
vi.mock('../../stores/terminalsStore', () => ({
  useTerminalsStore: {
    getState: () => ({ byPtyId: { 'pty-1': { alive: true }, 'pty-2': { alive: true } } }),
    subscribe: vi.fn(() => () => undefined),
  },
}))
const openVoiceCommand = vi.fn()
vi.mock('../../stores/uiStore', () => ({
  useUiStore: {
    getState: () => ({
      activeTerminal: { projectId: 'p', terminalId: 't' },
      openVoiceCommand,
      setActiveTerminal: workspace.setActiveTerminal,
      requestPaneFocus: workspace.requestPaneFocus,
    }),
    subscribe: vi.fn(() => () => undefined),
  },
}))

import {
  INITIAL_VOICE_CONVERSATION,
  useVoiceConversationStore,
} from '../../stores/voiceConversationStore'
import { PaneHiddenError, TerminalPromptOpenError } from '../agentPromptDelivery'
import { VoiceConversationController } from './controller'

const state = () => useVoiceConversationStore.getState()

describe('VoiceConversationController', () => {
  let controller: VoiceConversationController

  beforeEach(async () => {
    vi.clearAllMocks()
    useVoiceConversationStore.setState(INITIAL_VOICE_CONVERSATION)
    tauri.speechStopAndTranscribe.mockResolvedValue('fix the build')
    prefs.voiceVerbosity = 'silent'
    setStt('local', 'parakeet-tdt-0.6b-v3-int8', null)
    currentTarget = target
    controller = new VoiceConversationController()
    await controller.start()
  })

  afterEach(() => {
    controller.dispose()
  })

  const speak = async (text: string) => {
    tauri.speechStopAndTranscribe.mockResolvedValueOnce(text)
    await controller.press({ jev: false })
    await controller.release()
  }

  // A main-window reload leaves the Rust voice targets set; requests must not stay held.
  it('clears stale voice targets before subscribing to anything', () => {
    expect(tauri.voiceSetTargets).toHaveBeenCalledWith([])
    const cleared = tauri.voiceSetTargets.mock.invocationCallOrder[0]
    const subscriptions = [
      ...events.listen.mock.invocationCallOrder,
      ...tauri.onAgentPermissionReleased.mock.invocationCallOrder,
      ...tauri.onTtsEnd.mock.invocationCallOrder,
    ]
    expect(subscriptions.length).toBeGreaterThan(0)
    for (const order of subscriptions) expect(cleared).toBeLessThan(order)
  })

  it('sends what was said to the target pane and starts the turn', async () => {
    await controller.press({ jev: false })
    expect(state().capture).toBe('listening')
    await controller.release()
    expect(input.submit).toHaveBeenCalledWith('fix the build')
    expect(input.interrupt).not.toHaveBeenCalled()
    expect(state().turn).toBe('working')
    expect(state().capture).toBe('idle')
    expect(tauri.voiceSetTargets).toHaveBeenCalledWith(['pty-1'])
  })

  // Push-to-talk released before the mic finished opening must still stop the capture.
  it('handles a release that arrives while the capture is still starting', async () => {
    let finishStart: () => void = () => undefined
    tauri.speechStartCapture.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (finishStart = () => resolve(undefined))),
    )
    const pressing = controller.press({ jev: false })
    await Promise.resolve()
    const releasing = controller.release()
    finishStart()
    await pressing
    await releasing
    await vi.waitFor(() => expect(tauri.speechStopAndTranscribe).toHaveBeenCalled())
    expect(state().capture).toBe('idle')
  })

  it('stops speech when the person starts talking', async () => {
    await controller.press({ jev: false })
    expect(tauri.ttsStop).toHaveBeenCalled()
  })

  it('interrupts first when the transcript starts with an interrupt word', async () => {
    await speak('Stop, use pnpm')
    expect(input.interrupt).toHaveBeenCalled()
    expect(input.submit).toHaveBeenCalledWith('use pnpm')
  })

  // Claude Code runs no Stop hook after an interrupt.
  it('ends the turn on an interrupt-only utterance, with no status fill after it', async () => {
    vi.useFakeTimers()
    try {
      prefs.voiceVerbosity = 'normal'
      await speak('fix the build')
      hook({
        payload: {
          hook_event_name: 'PreToolUse',
          plannerId: 'pty-1',
          tool_name: 'Bash',
          tool_input: { command: 'cargo build' },
        },
      })
      const stopping = speak('Stop.')
      await vi.advanceTimersByTimeAsync(1000)
      await stopping
      expect(input.interrupt).toHaveBeenCalled()
      expect(state().turn).toBe('idle')
      expect(tauri.voiceSetTargets).toHaveBeenLastCalledWith([])
      tauri.ttsSpeak.mockClear()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(tauri.ttsSpeak).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // No local engine could take over: the notice names the provider and the reason, not the code.
  it('explains a cloud transcription failure in words', async () => {
    setStt('openai', 'gpt-4o-transcribe', null)
    tauri.speechStopAndTranscribe.mockRejectedValueOnce('voice_cloud_quota (HTTP 429)')
    await controller.press({ jev: false })
    await controller.release()
    const reason = String(state().notice?.params?.reason)
    expect(state().notice?.key).toBe('voice.conv.failed')
    expect(reason).toContain('OpenAI')
    expect(reason).not.toContain('voice_cloud_')
  })

  it('keeps the transcript and says why when silence was heard', async () => {
    await speak('   ')
    expect(input.submit).not.toHaveBeenCalled()
    expect(state().notice?.key).toBe('voice.conv.heardNothing')
  })

  it('does not capture when the speech model is missing', async () => {
    tauri.speechPrepare.mockResolvedValueOnce(false)
    await controller.press({ jev: false })
    expect(tauri.speechStartCapture).not.toHaveBeenCalled()
    expect(state().notice?.key).toBe('voice.conv.modelMissing')
  })

  describe('native speech engine', () => {
    it('asks for a locale and does not capture without one', async () => {
      setStt('apple', 'apple-speech', null)
      await controller.press({ jev: false })
      expect(tauri.speechPrepare).not.toHaveBeenCalled()
      expect(tauri.speechStartCapture).not.toHaveBeenCalled()
      expect(state().notice?.key).toBe('speech.nativeLocaleRequired')
    })

    it('prepares and transcribes with the chosen locale', async () => {
      setStt('apple', 'apple-speech', 'pt-BR')
      await controller.press({ jev: false })
      await controller.release()
      expect(tauri.speechPrepare).toHaveBeenCalledWith('apple-speech', 'pt-BR', 'apple')
      expect(tauri.speechStopAndTranscribe).toHaveBeenCalledWith('apple-speech', 'pt-BR', {
        provider: 'apple',
        fallbackLocale: 'pt-BR',
        usage: 'conversation',
      })
    })

    it('says Apple recognition is not ready when preparing fails', async () => {
      setStt('apple', 'apple-speech', 'pt-BR')
      tauri.speechPrepare.mockResolvedValueOnce(false)
      await controller.press({ jev: false })
      expect(tauri.speechStartCapture).not.toHaveBeenCalled()
      expect(state().notice?.key).toBe('speech.nativeNotReady')
    })
  })

  it('says Jev is not configured when there is no API key', async () => {
    await speak('Alethe, open Claude in billing')
    expect(openVoiceCommand).toHaveBeenCalledWith('')
    expect(state().notice?.key).toBe('voice.conv.jevNotConfigured')
  })

  describe('permissions', () => {
    const askToRun = async (command: string) => {
      await controller.press({ jev: false })
      await controller.release()
      hook({
        payload: {
          hook_event_name: 'PermissionRequest',
          plannerId: 'pty-1',
          permissionRequestId: 'req-1',
          tool_name: 'Bash',
          tool_input: { command },
          cwd: '/w',
        },
      })
    }

    it('shows the card and accepts a spoken yes for a safe command', async () => {
      await askToRun('npm install express')
      expect(state().permission).toMatchObject({ requestId: 'req-1', destructive: false })
      expect(state().turn).toBe('awaiting-permission')
      await speak('yes')
      expect(tauri.agentPermissionDecide).toHaveBeenCalledWith('req-1', 'allow', undefined)
      expect(state().permission).toBeNull()
      expect(state().turn).toBe('working')
    })

    it('refuses a spoken yes for a destructive command and waits for a click', async () => {
      await askToRun('rm -rf node_modules')
      await speak('yes')
      expect(tauri.agentPermissionDecide).not.toHaveBeenCalled()
      expect(state().notice?.key).toBe('voice.conv.voiceApprovalBlocked')
      await controller.answer({ kind: 'allow' }, 'req-1')
      expect(tauri.agentPermissionDecide).toHaveBeenCalledWith('req-1', 'allow', undefined)
    })

    it('sends a spoken reason with a deny', async () => {
      await askToRun('npm install express')
      await speak('no, use pnpm')
      expect(tauri.agentPermissionDecide).toHaveBeenCalledWith('req-1', 'deny', 'use pnpm')
    })

    it('drops the card when Alethe released the hold', async () => {
      await askToRun('npm install express')
      released({ requestId: 'req-1' })
      expect(state().permission).toBeNull()
      expect(state().notice?.key).toBe('voice.conv.permissionReleased')
    })

    // Claude now shows its own dialog; the submit's Enter would approve it.
    it('refuses to send after a defer until Claude moves on', async () => {
      await askToRun('npm install express')
      await controller.answer({ kind: 'defer' }, 'req-1')
      expect(tauri.agentPermissionDecide).toHaveBeenCalledWith('req-1', 'defer', undefined)
      input.submit.mockClear()
      await speak('fix the build')
      expect(input.submit).not.toHaveBeenCalled()
      expect(input.interrupt).not.toHaveBeenCalled()
      expect(state().notice?.key).toBe('voice.conv.terminalPromptOpen')
      expect(state().transcript).toBe('fix the build')
      hook({ payload: { hook_event_name: 'PreToolUse', plannerId: 'pty-1', tool_name: 'Bash' } })
      await speak('fix the build')
      expect(input.submit).toHaveBeenCalledWith('fix the build')
    })

    it('refuses to send after the hold was released', async () => {
      await askToRun('npm install express')
      released({ requestId: 'req-1' })
      input.submit.mockClear()
      await speak('fix the build')
      expect(input.submit).not.toHaveBeenCalled()
      expect(state().notice?.key).toBe('voice.conv.terminalPromptOpen')
    })

    it('refuses to send when the answer arrived after the hold ended', async () => {
      await askToRun('npm install express')
      tauri.agentPermissionDecide.mockRejectedValueOnce(new Error('gone'))
      await controller.answer({ kind: 'allow' }, 'req-1')
      expect(state().notice?.key).toBe('voice.conv.permissionReleased')
      input.submit.mockClear()
      await speak('fix the build')
      expect(input.submit).not.toHaveBeenCalled()
      expect(state().notice?.key).toBe('voice.conv.terminalPromptOpen')
    })

    // The click was meant for the card the person saw, not whatever replaced it.
    it('refuses a panel answer for a card that is no longer shown', async () => {
      await askToRun('npm install express')
      await controller.answer({ kind: 'allow' }, 'req-old')
      expect(tauri.agentPermissionDecide).not.toHaveBeenCalled()
      expect(state().permission?.requestId).toBe('req-1')
    })

    it('decides once when the panel answer is clicked twice', async () => {
      await askToRun('npm install express')
      await Promise.all([
        controller.answer({ kind: 'allow' }, 'req-1'),
        controller.answer({ kind: 'allow' }, 'req-1'),
      ])
      expect(tauri.agentPermissionDecide).toHaveBeenCalledTimes(1)
    })

    it('a failed decide leaves a newer card alone', async () => {
      await askToRun('npm install express')
      let fail: () => void = () => undefined
      tauri.agentPermissionDecide.mockImplementationOnce(
        () => new Promise<undefined>((_, reject) => (fail = () => reject(new Error('gone')))),
      )
      const answering = controller.answer({ kind: 'allow' }, 'req-1')
      released({ requestId: 'req-1' })
      hook({
        payload: {
          hook_event_name: 'PermissionRequest',
          plannerId: 'pty-1',
          permissionRequestId: 'req-2',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        },
      })
      expect(state().permission?.requestId).toBe('req-2')
      fail()
      await answering
      expect(state().permission?.requestId).toBe('req-2')
      expect(state().turn).toBe('awaiting-permission')
    })

    it('names a request without a tool through i18n', async () => {
      await controller.press({ jev: false })
      await controller.release()
      hook({
        payload: {
          hook_event_name: 'PermissionRequest',
          plannerId: 'pty-1',
          permissionRequestId: 'req-1',
          tool_input: { command: 'ls' },
        },
      })
      expect(state().permission?.tool).toBe('a tool')
    })

    it("ignores another CLI's permission request", async () => {
      await controller.press({ jev: false })
      await controller.release()
      hook({
        payload: {
          hook_event_name: 'PermissionRequest',
          plannerId: 'pty-1',
          sourceAgent: 'codex',
          permissionRequestId: 'req-1',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        },
      })
      expect(state().permission).toBeNull()
      expect(tauri.agentPermissionDecide).not.toHaveBeenCalled()
    })

    // Held, but no card can show it: hand it back now rather than after the 290 s deadline.
    it('defers a held request that arrives outside a voice turn', () => {
      hook({
        payload: {
          hook_event_name: 'PermissionRequest',
          plannerId: 'pty-1',
          permissionRequestId: 'req-9',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        },
      })
      expect(tauri.agentPermissionDecide).toHaveBeenCalledWith('req-9', 'defer')
      expect(state().permission).toBeNull()
    })
  })

  it('refuses to send while Claude shows its own permission prompt', async () => {
    hook({
      payload: { hook_event_name: 'PermissionRequest', plannerId: 'pty-1', tool_name: 'Bash' },
    })
    await speak('fix the build')
    expect(input.submit).not.toHaveBeenCalled()
    expect(state().notice?.key).toBe('voice.conv.terminalPromptOpen')
    expect(state().transcript).toBe('fix the build')
    hook({ payload: { hook_event_name: 'PostToolUse', plannerId: 'pty-1', tool_name: 'Bash' } })
    await speak('fix the build')
    expect(input.submit).toHaveBeenCalledWith('fix the build')
  })

  it('refuses an interrupt-only send while Claude shows its own permission prompt', async () => {
    hook({
      payload: { hook_event_name: 'PermissionRequest', plannerId: 'pty-1', tool_name: 'Bash' },
    })
    await speak('Stop.')
    expect(input.interrupt).not.toHaveBeenCalled()
    expect(state().notice?.key).toBe('voice.conv.terminalPromptOpen')
  })

  it('only a main-agent event clears the terminal prompt', async () => {
    hook({
      payload: { hook_event_name: 'PermissionRequest', plannerId: 'pty-1', tool_name: 'Bash' },
    })
    hook({ payload: { hook_event_name: 'PostToolUse', plannerId: 'pty-1', agent_id: 'sub' } })
    hook({ payload: { hook_event_name: 'PostToolUse', plannerId: 'pty-2' } })
    await speak('fix the build')
    expect(input.submit).not.toHaveBeenCalled()
  })

  it('ends the turn on Stop and stops holding permissions', async () => {
    await controller.press({ jev: false })
    await controller.release()
    hook({
      payload: { hook_event_name: 'Stop', plannerId: 'pty-1', last_assistant_message: 'Done.' },
    })
    await vi.waitFor(() => expect(state().turn).toBe('idle'))
    expect(tauri.voiceSetTargets).toHaveBeenLastCalledWith([])
  })

  it('ignores hooks from other panes and from subagents', async () => {
    await controller.press({ jev: false })
    await controller.release()
    hook({ payload: { hook_event_name: 'Stop', plannerId: 'pty-2' } })
    hook({ payload: { hook_event_name: 'Stop', plannerId: 'pty-1', agent_id: 'sub' } })
    expect(state().turn).toBe('working')
  })

  // A transcript poll that has not answered yet.
  const pendingPoll = (messages: TranscriptSnapshot['messages']) => {
    let finish: () => void = () => undefined
    tauri.agentTranscriptSnapshot.mockImplementationOnce(
      () =>
        new Promise<TranscriptSnapshot>(
          (resolve) =>
            (finish = () =>
              resolve({ sessionId: 's1', revision: 2, unchanged: false, firstIndex: 0, messages })),
        ),
    )
    return () => finish()
  }
  const spoken = () => tauri.ttsSpeak.mock.calls.map((call) => call[0] as unknown as string)
  /** Ends every utterance until `check` passes (the mocked engine reports no end on its own). */
  const finishSpeaking = (check: () => void) =>
    vi.waitFor(() => {
      ttsEnd(1)
      check()
    })

  // Cloud and local voices synthesize after tts_speak returns: the estimate runs from tts://start.
  it('times a cloud utterance from when its audio starts, not from the request', async () => {
    vi.useFakeTimers()
    prefs.voiceTts = { provider: 'openai', model: 'gpt-4o-mini-tts', voice: null, rate: 1 }
    try {
      prefs.voiceVerbosity = 'normal'
      await speak('fix the build')
      hook({
        payload: { hook_event_name: 'Stop', plannerId: 'pty-1', last_assistant_message: 'Done.' },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(spoken()).toContain('Done.')
      // Well past the estimate for "Done." (about 2 s), but no audio yet.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(state().turn).not.toBe('idle')
      ttsStart(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(state().turn).not.toBe('idle')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(state().turn).toBe('idle')
    } finally {
      prefs.voiceTts = { provider: 'system', model: '', voice: null, rate: 1 }
      vi.useRealTimers()
    }
  })

  it('does not wait forever for a cloud utterance that never starts', async () => {
    vi.useFakeTimers()
    prefs.voiceTts = { provider: 'openai', model: 'gpt-4o-mini-tts', voice: null, rate: 1 }
    try {
      prefs.voiceVerbosity = 'normal'
      await speak('fix the build')
      hook({
        payload: { hook_event_name: 'Stop', plannerId: 'pty-1', last_assistant_message: 'Done.' },
      })
      await vi.advanceTimersByTimeAsync(40_000)
      expect(state().turn).toBe('idle')
    } finally {
      prefs.voiceTts = { provider: 'system', model: '', voice: null, rate: 1 }
      vi.useRealTimers()
    }
  })

  it('keeps the turn and the transcript when the pane shows a choice menu', async () => {
    input.submit.mockRejectedValueOnce(new TerminalPromptOpenError())
    await speak('fix the build')
    expect(state().notice?.key).toBe('voice.conv.terminalPromptOpen')
    expect(state().transcript).toBe('fix the build')
    expect(state().turn).toBe('idle')
    expect(tauri.voiceSetTargets).toHaveBeenLastCalledWith([])
    // The screen is read again on every submit, so a false positive clears itself: no lock.
    input.submit.mockClear()
    await speak('fix the build')
    expect(input.submit).toHaveBeenCalledWith('fix the build')
    expect(state().turn).toBe('working')
  })

  it('holds permissions for the target before submitting', async () => {
    await speak('fix the build')
    const targeted = tauri.voiceSetTargets.mock.calls.findIndex(([ids]) => ids[0] === 'pty-1')
    expect(tauri.voiceSetTargets.mock.invocationCallOrder[targeted]).toBeLessThan(
      input.submit.mock.invocationCallOrder[0],
    )
  })

  // Rust streams nothing to a hidden pane, so its screen guard would read a stale buffer.
  it('brings a hidden target into view and keeps what was said', async () => {
    input.submit.mockRejectedValueOnce(new PaneHiddenError())
    await speak('fix the build')
    expect(state().notice?.key).toBe('voice.conv.targetHidden')
    expect(state().transcript).toBe('fix the build')
    expect(state().turn).toBe('idle')
    expect(tauri.voiceSetTargets).toHaveBeenLastCalledWith([])
    expect(workspace.setActiveProjectOnly).toHaveBeenCalledWith('p')
    expect(workspace.focusWorkspaceTerminal).toHaveBeenCalledWith('p', 't')
    expect(workspace.setActiveTerminal).toHaveBeenCalledWith('p', 't')
    expect(workspace.requestPaneFocus).toHaveBeenCalledWith('t')
  })

  // A Claude launched before voice was on has no PermissionRequest/Stop hooks.
  it('does not target a pane launched without the voice hooks', async () => {
    tauri.agentVoiceHookedPtys.mockResolvedValueOnce(['pty-2'])
    await speak('fix the build')
    expect(tauri.agentVoiceHookedPtys).toHaveBeenCalledTimes(2)
    expect(state().voiceHookedPtyIds).toEqual(['pty-2'])
    expect(input.submit).not.toHaveBeenCalled()
    expect(state().notice?.key).toBe('voice.conv.noTarget')
  })

  it('a held request that arrives while the turn ends still blocks the next send', async () => {
    prefs.voiceVerbosity = 'normal'
    await speak('fix the build')
    hook({
      payload: { hook_event_name: 'Stop', plannerId: 'pty-1', last_assistant_message: 'Done.' },
    })
    await vi.waitFor(() => expect(spoken()).toContain('Done.'))
    expect(tauri.ttsSpeak).toHaveBeenCalledWith(
      'Done.',
      expect.objectContaining({ provider: 'system' }),
    )
    hook({
      payload: {
        hook_event_name: 'PermissionRequest',
        plannerId: 'pty-1',
        permissionRequestId: 'req-2',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      },
    })
    await finishSpeaking(() => expect(state().turn).toBe('idle'))
    input.submit.mockClear()
    await speak('fix the build')
    expect(input.submit).not.toHaveBeenCalled()
    expect(state().notice?.key).toBe('voice.conv.terminalPromptOpen')
  })

  it('does not take an utterance as the answer to a card that appeared while it was spoken', async () => {
    await speak('fix the build')
    await controller.press({ jev: false })
    hook({
      payload: {
        hook_event_name: 'PermissionRequest',
        plannerId: 'pty-1',
        permissionRequestId: 'req-1',
        tool_name: 'Bash',
        tool_input: { command: 'npm install express' },
      },
    })
    tauri.speechStopAndTranscribe.mockResolvedValueOnce('yes')
    await controller.release()
    expect(tauri.agentPermissionDecide).not.toHaveBeenCalled()
    expect(state().notice?.key).toBe('voice.conv.answerUnclear')
    expect(state().permission?.requestId).toBe('req-1')
  })

  describe('dispose', () => {
    // StrictMode mounts, unmounts and remounts: the first controller must not keep listening.
    it('does not subscribe when disposed before start() finished', async () => {
      let finishClear: () => void = () => undefined
      tauri.voiceSetTargets.mockImplementationOnce(
        () => new Promise<undefined>((resolve) => (finishClear = () => resolve(undefined))),
      )
      hook = () => undefined
      const early = new VoiceConversationController()
      const starting = early.start()
      early.dispose()
      finishClear()
      await starting
      hook({
        payload: {
          hook_event_name: 'PermissionRequest',
          plannerId: 'pty-1',
          permissionRequestId: 'req-9',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        },
      })
      expect(state().permission).toBeNull()
      expect(tauri.agentPermissionDecide).not.toHaveBeenCalled()
    })

    it('drops a listener that resolves after dispose', async () => {
      const off = vi.fn()
      let finishListen: () => void = () => undefined
      events.listen.mockImplementationOnce(
        () => new Promise<() => void>((resolve) => (finishListen = () => resolve(off))),
      )
      const early = new VoiceConversationController()
      const starting = early.start()
      await vi.waitFor(() => expect(events.listen).toHaveBeenCalledTimes(2))
      early.dispose()
      finishListen()
      await starting
      expect(off).toHaveBeenCalled()
      expect(tauri.onAgentPermissionReleased).toHaveBeenCalledTimes(1)
    })

    it('resets the conversation but keeps the pinned pane', () => {
      useVoiceConversationStore.setState({
        pinnedPtyId: 'pty-2',
        transcript: 'fix the build',
        notice: { key: 'voice.conv.heardNothing' },
        narration: 'Done.',
      })
      controller.dispose()
      expect(state()).toMatchObject({
        ...INITIAL_VOICE_CONVERSATION,
        pinnedPtyId: 'pty-2',
      })
    })

    it('closes the mic when disposed while listening', async () => {
      await controller.press({ jev: false })
      controller.dispose()
      expect(tauri.speechStopCapture).toHaveBeenCalled()
      expect(state().capture).toBe('idle')
    })

    it('closes a mic that finishes opening after dispose', async () => {
      let finishStart: () => void = () => undefined
      tauri.speechStartCapture.mockImplementationOnce(
        () => new Promise<undefined>((resolve) => (finishStart = () => resolve(undefined))),
      )
      const pressing = controller.press({ jev: false })
      await vi.waitFor(() => expect(tauri.speechStartCapture).toHaveBeenCalled())
      controller.dispose()
      const stopsBefore = tauri.speechStopCapture.mock.calls.length
      finishStart()
      await pressing
      expect(tauri.speechStopCapture.mock.calls.length).toBeGreaterThan(stopsBefore)
      expect(state().capture).toBe('idle')
    })
  })

  describe('narration', () => {
    it('does not narrate the previous pane after switching target mid-turn', async () => {
      prefs.voiceVerbosity = 'normal'
      await speak('fix the build')
      const finishPoll = pendingPoll([{ role: 'assistant', text: 'Old pane text' }])
      await vi.waitFor(() => expect(tauri.agentTranscriptSnapshot).toHaveBeenCalledTimes(2), {
        timeout: 2000,
      })
      currentTarget = otherTarget
      await speak('now the other one')
      expect(input.submit).toHaveBeenLastCalledWith('now the other one')
      finishPoll()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(spoken()).not.toContain('Old pane text')
    })

    it('speaks the final answer once when a poll is in flight at Stop', async () => {
      prefs.voiceVerbosity = 'normal'
      await speak('fix the build')
      const finishPoll = pendingPoll([{ role: 'assistant', text: 'Done.' }])
      await vi.waitFor(() => expect(tauri.agentTranscriptSnapshot).toHaveBeenCalledTimes(2), {
        timeout: 2000,
      })
      hook({
        payload: { hook_event_name: 'Stop', plannerId: 'pty-1', last_assistant_message: 'Done.' },
      })
      finishPoll()
      await finishSpeaking(() => expect(state().turn).toBe('idle'))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(spoken()).toEqual(['Done.'])
    })
  })
})
