import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeHudState, type HudViewState } from '../../lib/voice/hudState'
import { INITIAL_VOICE_CONVERSATION } from '../../stores/voiceConversationStore'
import { VoiceHud } from '.'

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  action: vi.fn(),
  moved: vi.fn(),
  stateHandler: null as null | ((json: string) => void),
  movedHandler: null as null | (() => void),
  startDragging: vi.fn(),
  listen: vi.fn(async () => () => undefined),
  hydrate: vi.fn(async () => undefined),
  store: {
    hydrated: true,
    preferences: { uiTheme: 'dark', language: 'en', visualStyle: 'normal' } as Record<
      string,
      unknown
    >,
  },
}))

vi.mock('../../lib/i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('../../lib/themes', () => ({ useAppliedTheme: () => 'dark' }))
vi.mock('../../stores/projectsStore', () => {
  const state = () => ({ ...mocks.store, hydrate: mocks.hydrate })
  const useProjectsStore = (selector: (s: unknown) => unknown) => selector(state())
  useProjectsStore.getState = state
  useProjectsStore.setState = (patch: { preferences: Record<string, unknown> }) => {
    mocks.store = { ...mocks.store, ...patch }
  }
  return { useProjectsStore }
})
vi.mock('../VoiceSpectrum', () => ({ VoiceSpectrum: () => null }))
vi.mock('../../lib/tauri', () => ({
  voiceHudSnapshot: mocks.snapshot,
  voiceHudAction: mocks.action,
  voiceHudMoved: mocks.moved,
  onVoiceHudState: async (handler: (json: string) => void) => {
    mocks.stateHandler = handler
    return () => undefined
  },
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    startDragging: mocks.startDragging,
    onMoved: async (handler: () => void) => {
      mocks.movedHandler = handler
      return () => undefined
    },
  }),
}))

const hudState = (patch: Partial<HudViewState['state']>): string =>
  encodeHudState({
    state: { ...INITIAL_VOICE_CONVERSATION, ...patch },
    targets: [],
    hint: '',
    approvalChannel: 'both',
    destructiveNeedsHud: true,
    rate: 1,
    language: 'pt-BR',
    uiTheme: 'light',
    visualStyle: 'clean',
  })

const flush = () => act(async () => undefined)

describe('VoiceHud', () => {
  beforeEach(() => {
    mocks.snapshot.mockResolvedValue(null)
    mocks.action.mockResolvedValue(undefined)
    mocks.moved.mockResolvedValue(undefined)
    mocks.startDragging.mockResolvedValue(undefined)
    mocks.stateHandler = null
    mocks.movedHandler = null
    mocks.store = {
      hydrated: true,
      preferences: { uiTheme: 'dark', language: 'en', visualStyle: 'normal' },
    }
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  // The window can show before the first state arrives; it must not be a blank gray box.
  it('shows a placeholder until a snapshot or state arrives', async () => {
    render(<VoiceHud />)
    await flush()
    expect(screen.getByLabelText('voice.hud.drag')).toBeTruthy()
    expect(screen.getByText('voice.conv.phase.idle')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'voice.conv.close' }))
    expect(mocks.action).toHaveBeenCalledWith('{"kind":"dismiss"}')
    act(() => mocks.stateHandler?.(hudState({ turn: 'working', transcript: 'live' })))
    expect(screen.getByText('live')).toBeTruthy()
  })

  it('renders the snapshot, then live updates', async () => {
    mocks.snapshot.mockResolvedValue(hudState({ turn: 'working', transcript: 'first' }))
    render(<VoiceHud />)
    await flush()
    expect(screen.getByText('first')).toBeTruthy()
    act(() => mocks.stateHandler?.(hudState({ turn: 'working', transcript: 'second' })))
    expect(screen.getByText('second')).toBeTruthy()
  })

  it('takes the language and theme from the published state, not from saves', async () => {
    mocks.snapshot.mockResolvedValue(hudState({ turn: 'working' }))
    render(<VoiceHud />)
    await flush()
    expect(mocks.store.preferences).toMatchObject({
      language: 'pt-BR',
      uiTheme: 'light',
      visualStyle: 'clean',
    })
    expect(mocks.hydrate).toHaveBeenCalledTimes(1)
    expect(mocks.listen).not.toHaveBeenCalledWith('projects://saved', expect.anything())
  })

  it('sends an answer bound to the card', async () => {
    mocks.snapshot.mockResolvedValue(
      hudState({
        turn: 'awaiting-permission',
        permission: { requestId: 'r9', tool: 'Bash', subject: 'ls', destructive: false },
      }),
    )
    render(<VoiceHud />)
    await flush()
    fireEvent.click(screen.getByText('voice.conv.allow'))
    expect(mocks.action).toHaveBeenCalledTimes(1)
    const sent = String(mocks.action.mock.calls[0][0])
    expect(sent).toContain('"kind":"answer"')
    expect(sent).toContain('"requestId":"r9"')
  })

  it('starts dragging from the drag strip', async () => {
    mocks.snapshot.mockResolvedValue(hudState({ turn: 'working' }))
    render(<VoiceHud />)
    await flush()
    fireEvent.mouseDown(screen.getByLabelText('voice.hud.drag'))
    expect(mocks.startDragging).toHaveBeenCalled()
  })

  it('does not report a move that no drag started', async () => {
    vi.useFakeTimers()
    mocks.snapshot.mockResolvedValue(hudState({ turn: 'working' }))
    render(<VoiceHud />)
    await flush()
    // The main window placing the HUD moves it too.
    mocks.movedHandler?.()
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    expect(mocks.moved).not.toHaveBeenCalled()
  })

  it('reports a drag once after the debounce, then stops reporting', async () => {
    vi.useFakeTimers()
    mocks.snapshot.mockResolvedValue(hudState({ turn: 'working' }))
    render(<VoiceHud />)
    await flush()
    fireEvent.mouseDown(screen.getByLabelText('voice.hud.drag'))
    mocks.movedHandler?.()
    mocks.movedHandler?.()
    expect(mocks.moved).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(mocks.moved).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    mocks.movedHandler?.()
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(mocks.moved).toHaveBeenCalledTimes(1)
  })

  it('reports the final spot of a drag that paused on the way', async () => {
    vi.useFakeTimers()
    mocks.snapshot.mockResolvedValue(hudState({ turn: 'working' }))
    render(<VoiceHud />)
    await flush()
    fireEvent.mouseDown(screen.getByLabelText('voice.hud.drag'))
    mocks.movedHandler?.()
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    mocks.movedHandler?.()
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(mocks.moved).toHaveBeenCalledTimes(2)
  })
})
