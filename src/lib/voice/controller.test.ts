import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TranscriptSnapshot } from '../tauri/handoff'
import type { VoiceNarration } from '../types'
import { NARRATION_PRESETS } from './narration'

const tauri = vi.hoisted(() => ({
  speechPrepare: vi.fn(async () => true),
  speechStartCapture: vi.fn(async () => undefined),
  speechStopAndTranscribe: vi.fn(async () => 'fix the build'),
  speechStopCapture: vi.fn(async () => ({ samples: [], sampleRate: 16000, peak: 0 })),
  ttsSpeak: vi.fn(async () => 1),
  ttsPrefetch: vi.fn(async () => undefined),
  ttsStop: vi.fn(async () => undefined),
  ttsPause: vi.fn(async () => undefined),
  ttsResume: vi.fn(async () => undefined),
  ttsSetMuted: vi.fn(async (_muted: boolean) => undefined),
  onTtsEnd: vi.fn(async (handler: (id: number) => void) => {
    ttsEnd = handler
    return () => undefined
  }),
  onTtsStart: vi.fn(async (handler: (id: number) => void) => {
    ttsStart = handler
    return () => undefined
  }),
  onTtsProgress: vi.fn(async (handler: (id: number, charOffset: number) => void) => {
    ttsProgress = handler
    return () => undefined
  }),
  agentPermissionDecide: vi.fn(async () => undefined),
  readClipboardText: vi.fn(async () => ''),
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
let ttsProgress: (id: number, charOffset: number) => void = () => undefined
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

const input = {
  submit: vi.fn(async () => undefined),
  interrupt: vi.fn(async () => undefined),
  readScreen: vi.fn(() => ''),
}
vi.mock('../agentInputRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agentInputRegistry')>()
  const agentInputFor = vi.fn(() => input)
  return {
    agentInputFor,
    // The real wait, polling the mocked registry.
    waitForAgentInput: (ptyId: string, current?: () => boolean) =>
      actual.waitForAgentInput(ptyId, current, agentInputFor),
  }
})

const target = {
  ptyId: 'pty-1',
  projectId: 'p',
  terminalId: 't',
  tabId: 'a',
  tabActive: true,
  agent: 'claude',
  label: 'P · Claude',
  cwd: '/w',
  sessionId: 's1',
}
/** Claude in a background tab of a pane in another project. */
const otherTarget = {
  ...target,
  ptyId: 'pty-2',
  projectId: 'q',
  terminalId: 't2',
  tabId: 'b',
  tabActive: false,
  label: 'Q · Claude',
}
/** Targets a test adds (another harness); cleared after each test. */
let extraTargets: (typeof target)[] = []
let currentTarget = target
/** Off: the target is whatever `currentTarget` says. On: the real pin/active-pane resolution. */
let realResolve = false
vi.mock('./target', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./target')>()
  return {
    ...actual,
    listAgentTargets: vi.fn(
      (_projects: unknown, usable: (ptyId: string, agent: string) => boolean) =>
        [target, otherTarget, ...extraTargets].filter((item) => usable(item.ptyId, item.agent)),
    ),
    resolveTarget: vi.fn((candidates: (typeof target)[], context) =>
      realResolve
        ? actual.resolveTarget(candidates, context)
        : (candidates.find((item) => item.ptyId === currentTarget.ptyId) ?? null),
    ),
  }
})

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
  voiceNarration: { ...NARRATION_PRESETS.silent } as VoiceNarration,
  voiceFillAfterMs: 8000,
  voiceTts: { provider: 'system', model: '', voice: null as string | null, rate: 1 },
  voiceApprovalChannel: 'both',
  voiceDestructiveNeedsHud: true,
  voiceProviders: {} as Record<string, { configured: boolean; invalid: boolean }>,
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
  setActiveTab: vi.fn(),
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
      setActiveTab: workspace.setActiveTab,
    }),
    subscribe: vi.fn(() => () => undefined),
  },
}))
type Runtime = Record<string, { alive?: boolean; status?: string }>
const terminals = vi.hoisted(() => ({
  byPtyId: {} as Record<string, { alive?: boolean; status?: string }>,
  listener: null as
    | null
    | ((
        next: { byPtyId: Record<string, { alive?: boolean; status?: string }> },
        previous: { byPtyId: Record<string, { alive?: boolean; status?: string }> },
      ) => void),
}))
const LIVE_RUNTIME: Runtime = { 'pty-1': { alive: true }, 'pty-2': { alive: true } }
vi.mock('../../stores/terminalsStore', () => ({
  useTerminalsStore: {
    getState: () => ({ byPtyId: terminals.byPtyId }),
    subscribe: vi.fn((listener: typeof terminals.listener) => {
      terminals.listener = listener
      return () => undefined
    }),
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
import { agentInputFor } from '../agentInputRegistry'
import { PaneHiddenError, TerminalPromptOpenError } from '../agentPromptDelivery'
import { VoiceConversationController } from './controller'
import { setFocusedSelection } from './readAloud'

const state = () => useVoiceConversationStore.getState()

describe('VoiceConversationController', () => {
  let controller: VoiceConversationController

  beforeEach(async () => {
    vi.clearAllMocks()
    useVoiceConversationStore.setState(INITIAL_VOICE_CONVERSATION)
    tauri.speechStopAndTranscribe.mockResolvedValue('fix the build')
    prefs.voiceNarration = { ...NARRATION_PRESETS.silent }
    setStt('local', 'parakeet-tdt-0.6b-v3-int8', null)
    currentTarget = target
    realResolve = false
    extraTargets = []
    terminals.byPtyId = { ...LIVE_RUNTIME }
    input.readScreen.mockReturnValue('')
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

  it('interrupts first when the transcript starts with an interrupt word', async () => {
    await speak('Stop, use pnpm')
    expect(input.interrupt).toHaveBeenCalled()
    expect(input.submit).toHaveBeenCalledWith('use pnpm')
  })

  // Claude Code runs no Stop hook after an interrupt.
  it('ends the turn on an interrupt-only utterance, with no status fill after it', async () => {
    vi.useFakeTimers()
    try {
      prefs.voiceNarration = { ...NARRATION_PRESETS.normal }
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

  // A tap of the shortcut, not an error: say how to use it and send nothing.
  it('shows the hold hint, not an error, when the recording was too short', async () => {
    tauri.speechStopAndTranscribe.mockRejectedValueOnce('speech_too_short')
    await controller.press({ jev: false })
    await controller.release()
    expect(state().notice).toEqual({ key: 'voice.conv.holdHint' })
    expect(state().capture).toBe('idle')
    expect(input.submit).not.toHaveBeenCalled()
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

  it('says Jev is not configured when there is no OpenRouter key', async () => {
    await speak('Alethe, open Claude in billing')
    expect(openVoiceCommand).toHaveBeenCalledWith('')
    expect(state().notice?.key).toBe('voice.conv.jevNotConfigured')
  })

  it('hands the request to Jev once the OpenRouter key is in the keychain', async () => {
    prefs.voiceProviders = { openrouter: { configured: true, invalid: false } }
    try {
      await speak('Alethe, open Claude in billing')
    } finally {
      prefs.voiceProviders = {}
    }
    expect(openVoiceCommand).toHaveBeenCalledWith('open Claude in billing')
    expect(state().notice?.key).not.toBe('voice.conv.jevNotConfigured')
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
      prefs.voiceNarration = { ...NARRATION_PRESETS.normal }
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

  // A cloud voice slower than the estimate kept playing: the next item must not cut it off.
  it('keeps waiting for a cloud utterance while the player reports progress', async () => {
    vi.useFakeTimers()
    prefs.voiceTts = { provider: 'openai', model: 'gpt-4o-mini-tts', voice: null, rate: 1 }
    try {
      controller.readAloud('Done.')
      await vi.advanceTimersByTimeAsync(0)
      ttsStart(1)
      // The estimate for "Done." is about 2 s; the voice is still on its first letters at 20 s.
      for (let second = 1; second <= 20; second += 1) {
        await vi.advanceTimersByTimeAsync(1_000)
        ttsProgress(1, 1)
      }
      expect(state().narrationActive).toBe(true)
      ttsEnd(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(state().narrationActive).toBe(false)
    } finally {
      prefs.voiceTts = { provider: 'system', model: '', voice: null, rate: 1 }
      vi.useRealTimers()
    }
  })

  it('prefetches the next item for a cloud voice only', async () => {
    prefs.voiceTts = { provider: 'openai', model: 'gpt-4o-mini-tts', voice: null, rate: 1 }
    try {
      controller.readAloud(`${'First part of the text. '.repeat(20)}Second part.`)
      await vi.waitFor(() => expect(tauri.ttsPrefetch).toHaveBeenCalled())
      expect(tauri.ttsPrefetch).toHaveBeenCalledWith(
        expect.stringContaining('Second part.'),
        prefs.voiceTts,
      )
    } finally {
      prefs.voiceTts = { provider: 'system', model: '', voice: null, rate: 1 }
    }
    controller.stopSpeaking()
    vi.mocked(tauri.ttsPrefetch).mockClear()
    controller.readAloud(`${'First part of the text. '.repeat(20)}Second part.`)
    await vi.waitFor(() => expect(tauri.ttsSpeak).toHaveBeenCalled())
    expect(tauri.ttsPrefetch).not.toHaveBeenCalled()
  })

  it('does not wait forever for a cloud utterance that never starts', async () => {
    vi.useFakeTimers()
    prefs.voiceTts = { provider: 'openai', model: 'gpt-4o-mini-tts', voice: null, rate: 1 }
    try {
      prefs.voiceNarration = { ...NARRATION_PRESETS.normal }
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

  describe('narration controls', () => {
    const finalAnswer = async (text: string) => {
      prefs.voiceNarration = { ...NARRATION_PRESETS.normal }
      await speak('fix the build')
      hook({
        payload: { hook_event_name: 'Stop', plannerId: 'pty-1', last_assistant_message: text },
      })
      await vi.advanceTimersByTimeAsync(0)
    }
    const useProvider = (provider: 'system' | 'openai') => {
      prefs.voiceTts =
        provider === 'system'
          ? { provider: 'system', model: '', voice: null, rate: 1 }
          : { provider: 'openai', model: 'gpt-4o-mini-tts', voice: null, rate: 1 }
    }

    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      useProvider('system')
      vi.useRealTimers()
    })

    it('mutes and unmutes in Rust and mirrors it in the store', async () => {
      await controller.toggleMute()
      expect(tauri.ttsSetMuted).toHaveBeenLastCalledWith(true)
      expect(state().muted).toBe(true)
      await controller.toggleMute()
      expect(tauri.ttsSetMuted).toHaveBeenLastCalledWith(false)
      expect(state().muted).toBe(false)
    })

    // The store outlives a webview reload of the controller; Rust keeps its own flag.
    it('tells Rust the mute state when it starts', async () => {
      useVoiceConversationStore.setState({ muted: true })
      const next = new VoiceConversationController()
      await next.start()
      expect(tauri.ttsSetMuted).toHaveBeenLastCalledWith(true)
      next.dispose()
      expect(state().muted).toBe(true)
    })

    // "First part. Second part." is estimated at 3.3 s; 2 s in is past "First part.".
    it('says the system-voice item again from the sentence reached, at the new volume', async () => {
      useProvider('system')
      await finalAnswer('First part. Second part.')
      expect(spoken()).toEqual(['First part. Second part.'])
      await vi.advanceTimersByTimeAsync(2_000)
      tauri.ttsStop.mockClear()
      await controller.toggleMute()
      await vi.advanceTimersByTimeAsync(0)
      expect(spoken()).toEqual(['First part. Second part.', 'Second part.'])
      expect(tauri.ttsStop).not.toHaveBeenCalled()
    })

    it('takes one mute toggle at a time', async () => {
      tauri.ttsSetMuted.mockClear()
      let finish: () => void = () => undefined
      tauri.ttsSetMuted.mockImplementationOnce(
        () => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))),
      )
      const first = controller.toggleMute()
      const second = controller.toggleMute()
      finish()
      await first
      await second
      expect(tauri.ttsSetMuted).toHaveBeenCalledTimes(1)
      expect(tauri.ttsSetMuted).toHaveBeenLastCalledWith(true)
      expect(state().muted).toBe(true)
    })

    it('ignores pause when nothing is narrated, and mirrors what is', async () => {
      await controller.togglePause()
      expect(state().narrationPaused).toBe(false)
      expect(tauri.ttsPause).not.toHaveBeenCalled()
      expect(tauri.ttsStop).not.toHaveBeenCalled()
      useProvider('system')
      await finalAnswer('Done.')
      expect(state().narrationActive).toBe(true)
      ttsEnd(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(state().narrationActive).toBe(false)
      expect(state().turn).toBe('idle')
    })

    it('keeps the store unmuted when Rust could not mute', async () => {
      tauri.ttsSetMuted.mockRejectedValueOnce(new Error('no ipc'))
      await controller.toggleMute()
      expect(state().muted).toBe(false)
    })

    it('holds a cloud utterance in the player and its timer until resumed', async () => {
      useProvider('openai')
      await finalAnswer('Done.')
      ttsStart(1)
      tauri.ttsResume.mockClear()
      await controller.togglePause()
      expect(tauri.ttsPause).toHaveBeenCalledTimes(1)
      expect(state().narrationPaused).toBe(true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(state().turn).not.toBe('idle')
      await controller.togglePause()
      expect(tauri.ttsResume).toHaveBeenCalledTimes(1)
      expect(state().narrationPaused).toBe(false)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(state().turn).toBe('idle')
    })

    it('pauses the system voice by stopping it and resumes from the sentence reached', async () => {
      useProvider('system')
      await finalAnswer('First part. Second part.')
      await vi.advanceTimersByTimeAsync(2_000)
      tauri.ttsStop.mockClear()
      await controller.togglePause()
      expect(tauri.ttsStop).toHaveBeenCalled()
      expect(tauri.ttsPause).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(spoken()).toEqual(['First part. Second part.'])
      expect(state().turn).not.toBe('idle')
      await controller.togglePause()
      await vi.advanceTimersByTimeAsync(0)
      expect(spoken()).toEqual(['First part. Second part.', 'Second part.'])
    })

    it('resumes the system voice from the start when paused right away', async () => {
      useProvider('system')
      await finalAnswer('First part. Second part.')
      await controller.togglePause()
      await controller.togglePause()
      await vi.advanceTimersByTimeAsync(0)
      expect(spoken()).toEqual(['First part. Second part.', 'First part. Second part.'])
    })

    it('stop discards the rest and clears the pause', async () => {
      useProvider('system')
      await finalAnswer('First part. Second part.')
      await controller.togglePause()
      controller.stopSpeaking()
      expect(state().narrationPaused).toBe(false)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(spoken()).toEqual(['First part. Second part.'])
      expect(state().turn).toBe('idle')
    })

    describe('spoken-word offset', () => {
      const offset = () => state().narrationSpokenOffset

      // 75 ms a character at rate 1. The store holds the start of the word reached, so it moves
      // once a word, not once a character: 300 ms is character 4 ("First"), 800 ms is character
      // 10, inside "part." (which starts at 6).
      it('estimates the system voice from its speaking time, frozen while paused', async () => {
        useProvider('system')
        await finalAnswer('First part. Second part.')
        expect(offset()).toBe(0)
        await vi.advanceTimersByTimeAsync(300)
        expect(offset()).toBe(0)
        await vi.advanceTimersByTimeAsync(500)
        expect(offset()).toBe(6)
        await controller.togglePause()
        await vi.advanceTimersByTimeAsync(2_000)
        expect(offset()).toBe(6)
      })

      it('follows the player exactly for cloud voices, only for the utterance playing', async () => {
        useProvider('openai')
        await finalAnswer('First part. Second part.')
        // Synthesizing: nothing is heard yet, so no word is highlighted, nor estimated.
        expect(offset()).toBeNull()
        await vi.advanceTimersByTimeAsync(2_000)
        expect(offset()).toBeNull()
        ttsStart(1)
        expect(offset()).toBe(0)
        ttsProgress(1, 8)
        expect(offset()).toBe(6)
        ttsProgress(99, 20)
        expect(offset()).toBe(6)
        // The player's offset wins over the estimate from then on.
        await vi.advanceTimersByTimeAsync(1_000)
        expect(offset()).toBe(6)
        ttsProgress(1, 500)
        expect(offset()).toBe(24)
      })

      // The estimate timer only paces the queue; with the player reporting, the audio may well
      // still be playing when it runs out.
      it('marks a cloud item spoken only when the player says it ended', async () => {
        useProvider('openai')
        await finalAnswer('First part. Second part.')
        ttsStart(1)
        ttsProgress(1, 8)
        // "First part. Second part." is estimated at 3.3 s.
        await vi.advanceTimersByTimeAsync(4_000)
        expect(offset()).toBe(6)
      })

      it('marks a cloud item spoken when it ends', async () => {
        useProvider('openai')
        await finalAnswer('First part. Second part.')
        ttsStart(1)
        ttsProgress(1, 8)
        ttsEnd(1)
        await vi.advanceTimersByTimeAsync(0)
        expect(offset()).toBe(24)
      })

      it('marks the item spoken when it ends', async () => {
        useProvider('system')
        await finalAnswer('Done now.')
        ttsEnd(1)
        await vi.advanceTimersByTimeAsync(0)
        expect(state().narration).toBe('Done now.')
        expect(offset()).toBe(9)
      })

      // The system voice says the rest again from the sentence reached: the highlight resumes
      // there, in the whole item still shown.
      it('counts a resumed sentence from where it sits in the item shown', async () => {
        useProvider('system')
        await finalAnswer('First part. Second part.')
        await vi.advanceTimersByTimeAsync(2_000)
        await controller.toggleMute()
        await vi.advanceTimersByTimeAsync(0)
        expect(spoken()).toEqual(['First part. Second part.', 'Second part.'])
        expect(state().narration).toBe('First part. Second part.')
        expect(offset()).toBe(12)
      })

      it('shows no highlight when speech output is unavailable', async () => {
        useProvider('system')
        tauri.ttsSpeak.mockRejectedValueOnce(new Error('no tts'))
        await finalAnswer('Done.')
        await vi.advanceTimersByTimeAsync(0)
        expect(state().narration).toBe('Done.')
        expect(offset()).toBeNull()
      })
    })

    describe('barge-in', () => {
      // A press holds the narration; only something actually sent discards it.
      it('a press holds a cloud utterance instead of discarding it', async () => {
        useProvider('openai')
        await finalAnswer('Done.')
        ttsStart(1)
        tauri.ttsStop.mockClear()
        await controller.press({ jev: false })
        expect(tauri.ttsPause).toHaveBeenCalledTimes(1)
        expect(tauri.ttsStop).not.toHaveBeenCalled()
        expect(state().narrationPaused).toBe(true)
      })

      it('a release that sends something discards the held narration', async () => {
        useProvider('system')
        await finalAnswer('First part. Second part.')
        await controller.press({ jev: false })
        tauri.ttsStop.mockClear()
        tauri.speechStopAndTranscribe.mockResolvedValueOnce('run the tests')
        await controller.release()
        expect(input.submit).toHaveBeenLastCalledWith('run the tests')
        expect(state().narrationPaused).toBe(false)
        expect(tauri.ttsStop).toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(30_000)
        expect(spoken()).toEqual(['First part. Second part.'])
      })

      it('nothing heard keeps it paused, and resume continues from the sentence reached', async () => {
        useProvider('system')
        await finalAnswer('First part. Second part.')
        await vi.advanceTimersByTimeAsync(2_000)
        tauri.speechStopAndTranscribe.mockResolvedValueOnce('   ')
        await controller.press({ jev: false })
        await controller.release()
        expect(state().notice?.key).toBe('voice.conv.heardNothing')
        expect(state().narrationPaused).toBe(true)
        await vi.advanceTimersByTimeAsync(30_000)
        expect(spoken()).toEqual(['First part. Second part.'])
        await controller.togglePause()
        await vi.advanceTimersByTimeAsync(0)
        expect(spoken()).toEqual(['First part. Second part.', 'Second part.'])
      })

      it('a tap too short to transcribe keeps it paused', async () => {
        useProvider('openai')
        await finalAnswer('Done.')
        ttsStart(1)
        tauri.ttsStop.mockClear()
        tauri.speechStopAndTranscribe.mockRejectedValueOnce('speech_too_short')
        await controller.press({ jev: false })
        await controller.release()
        expect(state().notice).toEqual({ key: 'voice.conv.holdHint' })
        expect(state().narrationPaused).toBe(true)
        expect(tauri.ttsStop).not.toHaveBeenCalled()
        await controller.togglePause()
        expect(tauri.ttsResume).toHaveBeenCalled()
        expect(state().narrationPaused).toBe(false)
      })

      it('a failed transcription keeps it paused', async () => {
        useProvider('openai')
        await finalAnswer('Done.')
        ttsStart(1)
        tauri.speechStopAndTranscribe.mockRejectedValueOnce(new Error('decoder crashed'))
        await controller.press({ jev: false })
        await controller.release()
        expect(state().notice?.key).toBe('voice.conv.failed')
        expect(state().narrationPaused).toBe(true)
      })

      it('a press that cannot open the speech model keeps it paused', async () => {
        useProvider('openai')
        await finalAnswer('Done.')
        ttsStart(1)
        tauri.speechPrepare.mockResolvedValueOnce(false)
        await controller.press({ jev: false })
        expect(state().notice?.key).toBe('voice.conv.modelMissing')
        expect(state().narrationPaused).toBe(true)
      })

      it('a press keeps a pause the person had set', async () => {
        useProvider('system')
        await finalAnswer('First part. Second part.')
        await controller.togglePause()
        tauri.speechStopAndTranscribe.mockResolvedValueOnce('')
        await controller.press({ jev: false })
        await controller.release()
        expect(state().narrationPaused).toBe(true)
      })
    })
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

  describe('picking a session', () => {
    beforeEach(() => {
      realResolve = true
    })

    const sentTo = () => {
      const calls = tauri.voiceSetTargets.mock.calls
      return calls[calls.length - 1]?.[0]
    }

    it('sends to the picked session, even Claude in a background tab', async () => {
      controller.pinTarget('pty-2')
      await speak('fix the build')
      expect(input.submit).toHaveBeenCalledWith('fix the build')
      expect(sentTo()).toEqual(['pty-2'])
      expect(state().target?.ptyId).toBe('pty-2')
    })

    it('brings the picked session to front: its project, its tab, its pane', () => {
      controller.pinTarget('pty-2')
      expect(state().pinnedPtyId).toBe('pty-2')
      expect(workspace.setActiveProjectOnly).toHaveBeenCalledWith('q')
      expect(workspace.focusWorkspaceTerminal).toHaveBeenCalledWith('q', 't2')
      expect(workspace.setActiveTab).toHaveBeenCalledWith('q', 't2', 'b')
      expect(workspace.setActiveTerminal).toHaveBeenCalledWith('q', 't2')
      expect(workspace.requestPaneFocus).toHaveBeenCalledWith('t2')
    })

    it('follows the active pane again after unpinning, without moving the workspace', async () => {
      controller.pinTarget('pty-2')
      vi.clearAllMocks()
      controller.pinTarget(null)
      expect(state().pinnedPtyId).toBeNull()
      expect(workspace.setActiveProjectOnly).not.toHaveBeenCalled()
      await speak('fix the build')
      expect(sentTo()).toEqual(['pty-1'])
      expect(state().target?.ptyId).toBe('pty-1')
    })

    // Only the tab in front mounts a terminal, so a background session has no input until shown.
    it('shows a session whose pane is not mounted, then sends once its terminal is up', async () => {
      useVoiceConversationStore.setState({ pinnedPtyId: 'pty-2' })
      vi.mocked(agentInputFor).mockImplementation((ptyId) =>
        ptyId === 'pty-2' && workspace.setActiveTab.mock.calls.length === 0 ? null : input,
      )
      vi.useFakeTimers()
      try {
        const speaking = speak('fix the build')
        await vi.advanceTimersByTimeAsync(1000)
        await speaking
      } finally {
        vi.useRealTimers()
        vi.mocked(agentInputFor).mockImplementation(() => input)
      }
      expect(workspace.setActiveTab).toHaveBeenCalledWith('q', 't2', 'b')
      expect(input.submit).toHaveBeenCalledWith('fix the build')
      expect(sentTo()).toEqual(['pty-2'])
      expect(state().notice).toBeNull()
    })

    it('asks to say it again when the shown session never gets a terminal', async () => {
      useVoiceConversationStore.setState({ pinnedPtyId: 'pty-2' })
      vi.mocked(agentInputFor).mockImplementation((ptyId) => (ptyId === 'pty-2' ? null : input))
      vi.useFakeTimers()
      try {
        const speaking = speak('fix the build')
        await vi.advanceTimersByTimeAsync(5000)
        await speaking
      } finally {
        vi.useRealTimers()
        vi.mocked(agentInputFor).mockImplementation(() => input)
      }
      expect(input.submit).not.toHaveBeenCalled()
      expect(state().notice?.key).toBe('voice.conv.targetHidden')
      expect(state().transcript).toBe('fix the build')
      expect(workspace.setActiveTab).toHaveBeenCalledWith('q', 't2', 'b')
      expect(workspace.requestPaneFocus).toHaveBeenCalledWith('t2')
    })
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
    prefs.voiceNarration = { ...NARRATION_PRESETS.normal }
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
      prefs.voiceNarration = { ...NARRATION_PRESETS.normal }
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
      prefs.voiceNarration = { ...NARRATION_PRESETS.normal }
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

  // Every harness Alethe runs can be talked to; only Claude Code has the hooks.
  describe('other harnesses', () => {
    const opencode = {
      ...target,
      ptyId: 'pty-5',
      terminalId: 't5',
      tabId: 'o',
      agent: 'opencode',
      label: 'P · OpenCode',
    }
    const codex = { ...opencode, ptyId: 'pty-6', agent: 'codex', label: 'P · Codex' }
    const quiet = (ptyId: string) => {
      const working = { ...terminals.byPtyId, [ptyId]: { alive: true, status: 'working' } }
      terminals.byPtyId = { ...working, [ptyId]: { alive: true, status: 'waiting' } }
      terminals.listener?.({ byPtyId: terminals.byPtyId }, { byPtyId: working })
    }
    const before = ['opencode v1', '> earlier question', 'earlier answer.'].join('\n')

    beforeEach(() => {
      extraTargets = [opencode, codex]
      terminals.byPtyId = { ...LIVE_RUNTIME, 'pty-5': { alive: true }, 'pty-6': { alive: true } }
      prefs.voiceNarration = { ...NARRATION_PRESETS.final }
    })

    afterEach(() => {
      tauri.agentTranscriptSnapshot.mockResolvedValue({
        sessionId: 's1',
        revision: 1,
        unchanged: false,
        firstIndex: 0,
        messages: [],
      })
    })

    it('sends to a running harness without voice hooks and holds no permission for it', async () => {
      currentTarget = opencode
      await speak('fix the build')
      expect(input.submit).toHaveBeenCalledWith('fix the build')
      expect(tauri.voiceSetTargets).toHaveBeenLastCalledWith([])
      expect(state().turn).toBe('working')
      expect(state().target?.ptyId).toBe('pty-5')
    })

    it('ends the turn when its output goes quiet and narrates the reply off its screen', async () => {
      currentTarget = opencode
      input.readScreen.mockReturnValue(before)
      await speak('fix the build')
      input.readScreen.mockReturnValue(
        [
          before,
          '> fix the build',
          'Fixed the build: the import was wrong.',
          'esc to interrupt',
        ].join('\n'),
      )
      quiet('pty-5')
      await vi.waitFor(() =>
        expect(tauri.ttsSpeak).toHaveBeenCalledWith(
          'Fixed the build: the import was wrong.',
          expect.anything(),
        ),
      )
      ttsEnd(1)
      await vi.waitFor(() => expect(state().turn).toBe('idle'))
    })

    it('says the harness is asking in its terminal when it stops on a choice menu', async () => {
      currentTarget = opencode
      await speak('delete the cache')
      input.readScreen.mockReturnValue(
        ['Permission required', 'Allow once   Allow always   Reject'].join('\n'),
      )
      quiet('pty-5')
      await vi.waitFor(() =>
        expect(tauri.ttsSpeak).toHaveBeenCalledWith(
          'OpenCode is asking something in the terminal. Answer it there.',
          expect.anything(),
        ),
      )
    })

    it('keeps a choice menu quiet when permission requests are not narrated', async () => {
      prefs.voiceNarration = { ...NARRATION_PRESETS.final, permissions: false }
      currentTarget = opencode
      await speak('delete the cache')
      input.readScreen.mockReturnValue(
        ['Permission required', 'Allow once   Allow always   Reject'].join('\n'),
      )
      quiet('pty-5')
      await vi.waitFor(() => expect(state().turn).toBe('idle'))
      expect(tauri.ttsSpeak).not.toHaveBeenCalled()
    })

    // Codex has no hooks: its thinking and tool calls come from its transcript.
    it("narrates a Codex turn's thinking and tool calls from its transcript", async () => {
      prefs.voiceNarration = { ...NARRATION_PRESETS.silent, thinking: true, tools: true }
      currentTarget = codex
      await speak('fix the build')
      tauri.agentTranscriptSnapshot.mockResolvedValue({
        sessionId: 's1',
        revision: 2,
        unchanged: false,
        firstIndex: 0,
        messages: [
          { role: 'thinking', text: '**Checking the build**' },
          { role: 'tool', text: 'shell', tool: { name: 'shell', command: 'cargo test' } },
          { role: 'assistant', text: 'Done, the build passes.' },
        ],
      })
      quiet('pty-6')
      await vi.waitFor(() =>
        expect(tauri.ttsSpeak).toHaveBeenCalledWith('Checking the build', expect.anything()),
      )
      ttsEnd(1)
      await vi.waitFor(() =>
        expect(tauri.ttsSpeak).toHaveBeenLastCalledWith('Running the tests.', expect.anything()),
      )
      ttsEnd(1)
      await vi.waitFor(() => expect(state().turn).toBe('idle'))
      // The final answer is off.
      expect(tauri.ttsSpeak).toHaveBeenCalledTimes(2)
    })

    it('ignores a quiet Claude pane: its turn ends on the Stop hook', async () => {
      await speak('fix the build')
      quiet('pty-1')
      await Promise.resolve()
      expect(state().turn).toBe('working')
    })

    it('reads a Codex transcript and speaks its last answer when the output goes quiet', async () => {
      currentTarget = codex
      await speak('fix the build')
      expect(tauri.agentTranscriptSnapshot).toHaveBeenCalledWith('codex', '/w', 's1', null)
      tauri.agentTranscriptSnapshot.mockResolvedValue({
        sessionId: 's1',
        revision: 2,
        unchanged: false,
        firstIndex: 0,
        messages: [{ role: 'assistant', text: 'Done, the build passes.' }] as never,
      })
      quiet('pty-6')
      await vi.waitFor(() =>
        expect(tauri.ttsSpeak).toHaveBeenCalledWith('Done, the build passes.', expect.anything()),
      )
    })
  })

  describe('read aloud', () => {
    it('reads a terminal selection as prose, whatever the verbosity', async () => {
      prefs.voiceNarration = { ...NARRATION_PRESETS.silent }
      useVoiceConversationStore.setState({ hudDismissed: true })
      controller.readAloud('│ The build failed because the\n│ import path was wrong. │')
      await vi.waitFor(() =>
        expect(tauri.ttsSpeak).toHaveBeenCalledWith(
          'The build failed because the import path was wrong.',
          expect.anything(),
        ),
      )
      expect(state().hudDismissed).toBe(false)
      expect(state().narrationActive).toBe(true)
    })

    it('the shortcut reads the focused selection, else the clipboard', async () => {
      const release = setFocusedSelection(() => 'Selected in the terminal.')
      await controller.readSelectionAloud()
      expect(tauri.ttsSpeak).toHaveBeenLastCalledWith(
        'Selected in the terminal.',
        expect.anything(),
      )
      release()
      tauri.readClipboardText.mockResolvedValueOnce('Copied by the TUI.')
      controller.stopSpeaking()
      await controller.readSelectionAloud()
      await vi.waitFor(() =>
        expect(tauri.ttsSpeak).toHaveBeenLastCalledWith('Copied by the TUI.', expect.anything()),
      )
    })

    it('the shortcut says there is nothing to read', async () => {
      await controller.readSelectionAloud()
      expect(state().notice).toEqual({ key: 'voice.conv.nothingToRead' })
      expect(tauri.ttsSpeak).not.toHaveBeenCalled()
    })

    it('ignores a selection with nothing to say', () => {
      controller.readAloud('──────\n│  │')
      expect(tauri.ttsSpeak).not.toHaveBeenCalled()
    })
  })
})
