import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_PREFERENCES, type Preferences, type Project } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import {
  INITIAL_VOICE_CONVERSATION,
  useVoiceConversationStore,
} from '../../stores/voiceConversationStore'
import { VoiceConversation } from '.'

type ShortcutEvent = { state: 'pressed' | 'released'; jev: boolean }
type Controller = {
  start: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  press: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
  answer: ReturnType<typeof vi.fn>
  pinTarget: ReturnType<typeof vi.fn>
  stopSpeaking: ReturnType<typeof vi.fn>
  toggleMute: ReturnType<typeof vi.fn>
  togglePause: ReturnType<typeof vi.fn>
  dismiss: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => ({
  shortcutSet: vi.fn(),
  hudShow: vi.fn(),
  hudHide: vi.fn(),
  hudPublish: vi.fn(),
  setPreferences: vi.fn(),
  shortcutHandler: null as null | ((event: ShortcutEvent) => void),
  actionHandler: null as null | ((json: string) => void),
  movedHandler: null as null | ((pos: { monitor: string; x: number; y: number }) => void),
  focusHandler: null as null | ((event: { payload: boolean }) => void),
  controllers: [] as Controller[],
}))

vi.mock('../../lib/i18n', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useT: () => (key: string) => key,
  translate: (_locale: string, key: string) => key,
}))
vi.mock('../VoiceSpectrum', () => ({ VoiceSpectrum: () => null }))
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  voiceShortcutSet: mocks.shortcutSet,
  voiceHudShow: mocks.hudShow,
  voiceHudHide: mocks.hudHide,
  voiceHudPublish: mocks.hudPublish,
  onVoiceShortcut: async (handler: (event: ShortcutEvent) => void) => {
    mocks.shortcutHandler = handler
    return () => undefined
  },
  onVoiceHudAction: async (handler: (json: string) => void) => {
    mocks.actionHandler = handler
    return () => undefined
  },
  onVoiceHudMoved: async (handler: (pos: { monitor: string; x: number; y: number }) => void) => {
    mocks.movedHandler = handler
    return () => undefined
  },
}))
vi.mock('@tauri-apps/api/window', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCurrentWindow: () => ({
    onFocusChanged: async (handler: (event: { payload: boolean }) => void) => {
      mocks.focusHandler = handler
      return () => undefined
    },
  }),
}))
const restartVoiceSession = vi.hoisted(() => vi.fn(async (_ptyId: string) => true))
vi.mock('../../lib/voice/restartSessions', () => ({ restartVoiceSession }))
vi.mock('../../lib/voice/controller', () => ({
  VoiceConversationController: class {
    start = vi.fn(async () => undefined)
    dispose = vi.fn()
    press = vi.fn(async () => undefined)
    release = vi.fn(async () => undefined)
    answer = vi.fn(async () => undefined)
    pinTarget = vi.fn()
    stopSpeaking = vi.fn()
    toggleMute = vi.fn(async () => undefined)
    togglePause = vi.fn(async () => undefined)
    dismiss = vi.fn()
    constructor() {
      mocks.controllers.push(this as unknown as Controller)
    }
  },
}))

const flush = () => act(async () => undefined)
const controller = () => mocks.controllers[mocks.controllers.length - 1]
const voice = (patch: Partial<typeof INITIAL_VOICE_CONVERSATION>) =>
  act(() => useVoiceConversationStore.getState().patch(patch))
const focus = (focused: boolean) => act(() => mocks.focusHandler?.({ payload: focused }))
const chord = () =>
  fireEvent.keyDown(window, { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true })

function setPrefs(patch: Partial<Preferences>) {
  useProjectsStore.setState({
    preferences: {
      ...DEFAULT_PREFERENCES,
      voiceConversationEnabled: true,
      voiceShortcut: 'CmdOrCtrl+Shift+Space',
      voiceCaptureMode: 'push-to-talk',
      ...patch,
    },
  })
}

async function mount() {
  const view = render(<VoiceConversation />)
  await flush()
  return view
}

describe('VoiceConversation session', () => {
  beforeEach(() => {
    mocks.controllers.length = 0
    mocks.shortcutHandler = null
    mocks.actionHandler = null
    mocks.movedHandler = null
    mocks.focusHandler = null
    mocks.shortcutSet.mockResolvedValue(undefined)
    mocks.hudShow.mockResolvedValue(undefined)
    mocks.hudHide.mockResolvedValue(undefined)
    mocks.hudPublish.mockResolvedValue(undefined)
    useProjectsStore.setState({ setPreferences: mocks.setPreferences })
    setPrefs({})
    useVoiceConversationStore.setState({ ...INITIAL_VOICE_CONVERSATION })
    useUiStore.setState({ notifications: [] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.restoreAllMocks()
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('registers the shortcut system-wide and clears it on unmount', async () => {
    const view = await mount()
    expect(mocks.shortcutSet).toHaveBeenCalledWith('CmdOrCtrl+Shift+Space')
    view.unmount()
    expect(mocks.shortcutSet).toHaveBeenLastCalledWith(null)
  })

  it('ignores the in-window chord while the global shortcut is registered', async () => {
    await mount()
    chord()
    expect(controller().press).not.toHaveBeenCalled()
    expect(useUiStore.getState().notifications).toHaveLength(0)
  })

  it('falls back to the in-window chord and toasts when registration fails', async () => {
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    mocks.shortcutSet.mockImplementation(async (accelerator: string | null) => {
      if (accelerator) throw new Error('taken')
    })
    await mount()
    chord()
    expect(controller().press).toHaveBeenCalledWith({ jev: false })
    expect(useUiStore.getState().notifications[0]?.title).toBe('voice.conv.shortcutTakenTitle')
  })

  it('keeps the fallback without the "taken" toast outside Tauri', async () => {
    mocks.shortcutSet.mockRejectedValue(new Error('no ipc'))
    await mount()
    chord()
    expect(controller().press).toHaveBeenCalledWith({ jev: false })
    expect(useUiStore.getState().notifications).toHaveLength(0)
  })

  it('does not blame another app for a shortcut it cannot parse', async () => {
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    setPrefs({ voiceShortcut: 'CmdOrCtrl+Shift+Enter' })
    mocks.shortcutSet.mockRejectedValue(new Error('invalid accelerator'))
    await mount()
    expect(useUiStore.getState().notifications).toHaveLength(0)
  })

  it('drives the controller from the global shortcut events', async () => {
    await mount()
    act(() => mocks.shortcutHandler?.({ state: 'pressed', jev: false }))
    expect(controller().press).toHaveBeenLastCalledWith({ jev: false })
    act(() => mocks.shortcutHandler?.({ state: 'pressed', jev: true }))
    expect(controller().press).toHaveBeenLastCalledWith({ jev: true })
    act(() => mocks.shortcutHandler?.({ state: 'released', jev: false }))
    expect(controller().release).toHaveBeenCalledTimes(1)
  })

  it('does not release on key-up in toggle mode', async () => {
    setPrefs({ voiceCaptureMode: 'toggle' })
    await mount()
    act(() => mocks.shortcutHandler?.({ state: 'released', jev: false }))
    expect(controller().release).not.toHaveBeenCalled()
  })

  it('clears a HUD dismissal on a new press', async () => {
    await mount()
    voice({ hudDismissed: true })
    act(() => mocks.shortcutHandler?.({ state: 'pressed', jev: false }))
    expect(useVoiceConversationStore.getState().hudDismissed).toBe(false)
  })

  it('pauses both shortcuts while a new shortcut is being recorded', async () => {
    mocks.shortcutSet.mockImplementation(async (accelerator: string | null) => {
      if (accelerator) throw new Error('taken')
    })
    await mount()
    voice({ shortcutRecording: true })
    act(() => mocks.shortcutHandler?.({ state: 'pressed', jev: false }))
    chord()
    expect(controller().press).not.toHaveBeenCalled()
  })

  it('shows the HUD at the saved placement when Alethe loses focus mid-conversation', async () => {
    setPrefs({ voiceHudPosition: 'top-left' })
    await mount()
    focus(true)
    voice({ capture: 'listening' })
    expect(screen.getByLabelText('voice.conv.title')).toBeTruthy()
    expect(mocks.hudShow).not.toHaveBeenCalled()

    focus(false)
    await flush()
    expect(mocks.hudShow).toHaveBeenCalledWith({ kind: 'preset', preset: 'top-left' })
    expect(screen.queryByLabelText('voice.conv.title')).toBeNull()

    mocks.hudHide.mockClear()
    focus(true)
    await flush()
    expect(mocks.hudHide).toHaveBeenCalled()
    expect(screen.getByLabelText('voice.conv.title')).toBeTruthy()
  })

  it('publishes to the visible HUD at most every 100 ms', async () => {
    vi.useFakeTimers()
    await mount()
    focus(false)
    voice({ turn: 'working' })
    await flush()
    expect(mocks.hudShow).toHaveBeenCalled()
    expect(mocks.hudPublish).toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(200))
    mocks.hudPublish.mockClear()
    voice({ transcript: 'a' })
    voice({ transcript: 'b' })
    voice({ transcript: 'c' })
    expect(mocks.hudPublish.mock.calls.length).toBeLessThanOrEqual(2)
    act(() => vi.advanceTimersByTime(100))
    expect(mocks.hudPublish).toHaveBeenCalledTimes(2)
    const last = JSON.parse(mocks.hudPublish.mock.calls[1][0] as string)
    expect(last.state.transcript).toBe('c')
    expect(last.rate).toBe(1)
  })

  it('publishes the language and theme, and publishes again when they change', async () => {
    vi.useFakeTimers()
    setPrefs({ language: 'en', uiTheme: 'dark', visualStyle: 'normal' })
    await mount()
    focus(false)
    voice({ turn: 'working' })
    await flush()
    const first = JSON.parse(mocks.hudPublish.mock.calls[0][0] as string)
    expect(first).toMatchObject({ language: 'en', uiTheme: 'dark', visualStyle: 'normal' })

    act(() => vi.advanceTimersByTime(200))
    mocks.hudPublish.mockClear()
    act(() =>
      useProjectsStore.setState((s) => ({
        preferences: { ...s.preferences, language: 'pt-BR', uiTheme: 'light' },
      })),
    )
    act(() => vi.advanceTimersByTime(100))
    const calls = mocks.hudPublish.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    const last = JSON.parse(calls[calls.length - 1][0] as string)
    expect(last).toMatchObject({ language: 'pt-BR', uiTheme: 'light' })
  })

  // The picker reads like the sidebar and names the session the next utterance goes to.
  it('lists sessions in sidebar order and shows and publishes the one voice talks to', async () => {
    vi.useFakeTimers()
    const pane = (id: string, ptyId: string) => ({
      id,
      name: 'Claude',
      kind: 'terminal',
      cwd: '/w',
      activeTabId: `${id}-tab`,
      tabs: [{ id: `${id}-tab`, type: 'claude', name: 'Claude', cwd: '/w', ptyId }],
    })
    const before = useProjectsStore.getState()
    useProjectsStore.setState({
      projects: [
        { id: 'a', name: 'Alpha', terminals: [pane('ta', 'pty-a')] },
        { id: 'b', name: 'Beta', terminals: [pane('tb', 'pty-b')] },
      ] as unknown as Project[],
      groups: [],
      ungroupedOrder: ['b', 'a'],
    })
    useTerminalsStore.setState({
      byPtyId: { 'pty-a': { alive: true }, 'pty-b': { alive: true } } as never,
    })
    useUiStore.setState({ activeTerminal: { projectId: 'a', terminalId: 'ta' } })
    try {
      await mount()
      focus(true)
      voice({ turn: 'working', voiceHookedPtyIds: ['pty-a', 'pty-b'] })
      const trigger = screen.getByRole('button', { name: 'voice.conv.target' })
      expect(trigger.textContent).toBe('Alpha · Claude')
      fireEvent.click(trigger)
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
        'voice.conv.followActive',
        'Beta · Claude',
        'Alpha · Claude',
      ])

      focus(false)
      await flush()
      const calls = mocks.hudPublish.mock.calls
      const published = JSON.parse(calls[calls.length - 1][0] as string)
      expect(published.current.ptyId).toBe('pty-a')
      expect(published.targets.map((item: { ptyId: string }) => item.ptyId)).toEqual([
        'pty-b',
        'pty-a',
      ])
    } finally {
      useProjectsStore.setState({
        projects: before.projects,
        groups: before.groups,
        ungroupedOrder: before.ungroupedOrder,
      })
      useTerminalsStore.setState({ byPtyId: {} })
      useUiStore.setState({ activeTerminal: null })
    }
  })

  // A Claude launched while voice was off: listed to restart, never talked to.
  it('lists running sessions without voice hooks for a restart, and restarts one from the HUD', async () => {
    vi.useFakeTimers()
    const pane = (id: string, ptyId: string) => ({
      id,
      name: 'Claude',
      kind: 'terminal',
      cwd: '/w',
      activeTabId: `${id}-tab`,
      tabs: [{ id: `${id}-tab`, type: 'claude', name: 'Claude', cwd: '/w', ptyId }],
    })
    const before = useProjectsStore.getState()
    useProjectsStore.setState({
      projects: [
        { id: 'a', name: 'Alpha', terminals: [pane('ta', 'pty-a')] },
        { id: 'b', name: 'Beta', terminals: [pane('tb', 'pty-b')] },
      ] as unknown as Project[],
      groups: [],
      ungroupedOrder: ['a', 'b'],
    })
    useTerminalsStore.setState({
      byPtyId: { 'pty-a': { alive: true }, 'pty-b': { alive: true } } as never,
    })
    useUiStore.setState({ activeTerminal: { projectId: 'b', terminalId: 'tb' } })
    try {
      await mount()
      focus(false)
      voice({ turn: 'working', voiceHookedPtyIds: ['pty-a'] })
      await flush()
      act(() => vi.advanceTimersByTime(200))
      const calls = mocks.hudPublish.mock.calls
      const published = JSON.parse(calls[calls.length - 1][0] as string)
      expect(published.targets.map((item: { ptyId: string }) => item.ptyId)).toEqual(['pty-a'])
      expect(published.restartable.map((item: { ptyId: string }) => item.ptyId)).toEqual(['pty-b'])
      // The active pane runs the stale session: voice does not resolve to it.
      expect(published.current?.ptyId ?? null).not.toBe('pty-b')

      // A disabled pane cannot be restarted, so it is not offered.
      mocks.hudPublish.mockClear()
      act(() =>
        useProjectsStore.setState({
          projects: useProjectsStore.getState().projects.map((project) => ({
            ...project,
            terminals: project.terminals.map((terminal) => ({ ...terminal, disabled: true })),
          })),
        }),
      )
      act(() => vi.advanceTimersByTime(200))
      const after = mocks.hudPublish.mock.calls
      expect(JSON.parse(after[after.length - 1][0] as string).restartable).toEqual([])

      act(() => mocks.actionHandler?.('{"kind":"restart-session","ptyId":"pty-b"}'))
      expect(restartVoiceSession).toHaveBeenCalledWith('pty-b')
    } finally {
      useProjectsStore.setState({
        projects: before.projects,
        groups: before.groups,
        ungroupedOrder: before.ungroupedOrder,
      })
      useTerminalsStore.setState({ byPtyId: {} })
      useUiStore.setState({ activeTerminal: null })
    }
  })

  it('applies decoded HUD actions and drops malformed ones', async () => {
    await mount()
    focus(false)
    voice({ turn: 'working' })
    await flush()

    act(() => mocks.actionHandler?.('{"kind":"answer","answer":{"kind":"allow"},"requestId":"r1"}'))
    expect(controller().answer).toHaveBeenCalledWith({ kind: 'allow' }, 'r1')

    act(() => mocks.actionHandler?.('{"kind":"rate","rate":2}'))
    expect(mocks.setPreferences).toHaveBeenCalledWith({
      voiceTts: expect.objectContaining({ rate: 2 }),
    })

    act(() => mocks.actionHandler?.('{"kind":"answer"}'))
    act(() => mocks.actionHandler?.('not json'))
    expect(controller().answer).toHaveBeenCalledTimes(1)
    expect(controller().dismiss).not.toHaveBeenCalled()

    mocks.hudHide.mockClear()
    act(() => mocks.actionHandler?.('{"kind":"dismiss"}'))
    await flush()
    expect(controller().dismiss).toHaveBeenCalled()
    expect(useVoiceConversationStore.getState().hudDismissed).toBe(true)
    expect(mocks.hudHide).toHaveBeenCalled()
  })

  it('routes the narration controls from the HUD and publishes their state', async () => {
    vi.useFakeTimers()
    await mount()
    focus(false)
    voice({ turn: 'working' })
    await flush()

    act(() => mocks.actionHandler?.('{"kind":"toggle-mute"}'))
    act(() => mocks.actionHandler?.('{"kind":"toggle-pause"}'))
    act(() => mocks.actionHandler?.('{"kind":"stop-speaking"}'))
    expect(controller().toggleMute).toHaveBeenCalledTimes(1)
    expect(controller().togglePause).toHaveBeenCalledTimes(1)
    expect(controller().stopSpeaking).toHaveBeenCalledTimes(1)

    act(() => vi.advanceTimersByTime(200))
    mocks.hudPublish.mockClear()
    voice({ muted: true, narrationPaused: true, narrationActive: true })
    act(() => vi.advanceTimersByTime(200))
    const calls = mocks.hudPublish.mock.calls
    const last = JSON.parse(calls[calls.length - 1][0] as string)
    expect(last.state.muted).toBe(true)
    expect(last.state.narrationPaused).toBe(true)
    expect(last.state.narrationActive).toBe(true)
  })

  it('saves where the HUD was dragged as a custom position', async () => {
    await mount()
    act(() => mocks.movedHandler?.({ monitor: 'DELL', x: 0.2, y: 0.8 }))
    expect(mocks.setPreferences).toHaveBeenCalledWith({
      voiceHudPosition: 'custom',
      voiceHudCustomPosition: { monitor: 'DELL', x: 0.2, y: 0.8 },
    })
  })

  it('hides the HUD 4 s after the turn goes idle', async () => {
    vi.useFakeTimers()
    await mount()
    focus(false)
    voice({ turn: 'working' })
    await flush()
    expect(mocks.hudShow).toHaveBeenCalled()

    voice({ turn: 'idle' })
    expect(useVoiceConversationStore.getState().idleSince).not.toBeNull()
    mocks.hudHide.mockClear()
    act(() => vi.advanceTimersByTime(3500))
    expect(mocks.hudHide).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(600))
    await flush()
    expect(mocks.hudHide).toHaveBeenCalled()
  })

  it('keeps the panel while unfocused when the HUD cannot be shown, and retries later', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mocks.hudShow.mockRejectedValue(new Error('the HUD is not available'))
    await mount()
    focus(false)
    voice({ turn: 'working' })
    await flush()
    expect(mocks.hudShow).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('voice.conv.title')).toBeTruthy()
    expect(warn).toHaveBeenCalledTimes(1)

    focus(true)
    await flush()
    focus(false)
    await flush()
    expect(mocks.hudShow).toHaveBeenCalledTimes(2)
    expect(screen.getByLabelText('voice.conv.title')).toBeTruthy()
    expect(warn).toHaveBeenCalledTimes(1)

    mocks.hudShow.mockResolvedValue(undefined)
    focus(true)
    await flush()
    focus(false)
    await flush()
    expect(mocks.hudShow).toHaveBeenCalledTimes(3)
    expect(screen.queryByLabelText('voice.conv.title')).toBeNull()
  })

  it('publishes the current state right before showing the HUD', async () => {
    vi.useFakeTimers()
    await mount()
    focus(false)
    voice({ turn: 'working', transcript: 'now' })
    await flush()
    expect(mocks.hudShow).toHaveBeenCalledTimes(1)
    const firstPublish = mocks.hudPublish.mock.invocationCallOrder[0]
    expect(firstPublish).toBeLessThan(mocks.hudShow.mock.invocationCallOrder[0])
    expect(JSON.parse(mocks.hudPublish.mock.calls[0][0] as string).state.transcript).toBe('now')
  })

  it('dismisses the HUD only from the HUD, not from the panel close button', async () => {
    await mount()
    focus(true)
    voice({ turn: 'working' })
    fireEvent.click(screen.getByLabelText('voice.conv.close'))
    expect(controller().dismiss).toHaveBeenCalledTimes(1)
    expect(useVoiceConversationStore.getState().hudDismissed).toBe(false)
  })

  it('brings a dismissed HUD back when a new permission card arrives', async () => {
    await mount()
    focus(false)
    voice({ turn: 'working' })
    await flush()
    act(() => mocks.actionHandler?.('{"kind":"dismiss"}'))
    await flush()
    expect(useVoiceConversationStore.getState().hudDismissed).toBe(true)

    mocks.hudShow.mockClear()
    voice({
      turn: 'awaiting-permission',
      permission: { requestId: 'r2', tool: 'Bash', subject: 'rm -rf build', destructive: true },
    })
    await flush()
    expect(useVoiceConversationStore.getState().hudDismissed).toBe(false)
    expect(mocks.hudShow).toHaveBeenCalledTimes(1)
  })
})
