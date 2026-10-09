import { act, renderHook, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { plannerLabelFor } from '../../lib/claudeMcpConfigs'
import { resetSessionClaimsForTests } from '../../lib/sessionDiscovery'
import { peekSession, saveSession } from '../../lib/sessionResume'
import * as tauri from '../../lib/tauri'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import type { AgentHookPayload } from '../../stores/agentCanvasStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useXtermSession } from './useXtermSession'

const hooks = vi.hoisted(() => new Set<(event: { payload: AgentHookPayload }) => void>())
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name, handler) => {
    hooks.add(handler)
    return () => {
      hooks.delete(handler)
    }
  }),
}))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}))
const exits = vi.hoisted(() => new Map<string, (payload: { code?: number }) => void>())
const terminals = vi.hoisted(
  () => [] as Array<{ writes: string[]; modes: Record<string, unknown> }>,
)
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    unicode = { activeVersion: '11' }
    options = { fontSize: 14 }
    buffer = { active: { type: 'normal' as 'normal' | 'alternate', baseY: 0, viewportY: 0 } }
    modes = {
      mouseTrackingMode: 'none',
      bracketedPasteMode: false,
      sendFocusMode: false,
    }
    writes: string[] = []
    scrollLines = vi.fn()
    scrollToLine = vi.fn()
    scrollToBottom() {}
    constructor() {
      terminals.push(this)
    }
    write(data: string, callback?: () => void) {
      this.writes.push(data)
      if (callback) queueMicrotask(callback)
    }
    loadAddon() {}
    open() {}
    focus() {}
    registerLinkProvider() {
      return { dispose() {} }
    }
    onScroll() {
      return { dispose() {} }
    }
    attachCustomKeyEventHandler() {}
    onData() {}
    dispose() {}
    writeln() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('../../lib/ptyVisibility', () => ({ usePtyPanelVisible: () => false }))
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof tauri>()),
  ptyExists: vi.fn(async () => false),
  setPtyVisible: vi.fn(async () => true),
  listenPtyData: vi.fn(async () => () => {}),
  listenPtyActivity: vi.fn(async () => () => {}),
  listenPtyExit: vi.fn(async (id: string, handler: (payload: { code?: number }) => void) => {
    exits.set(id, handler)
    return () => {
      exits.delete(id)
    }
  }),
  findCliLauncher: vi.fn(async () => 'claude'),
  snapshotClaudeSessions: vi.fn(async () => [
    { id: 'bananas', modified_at_ms: 1 },
    { id: 'new-chat', modified_at_ms: 2 },
  ]),
  agentHooksSettingsPath: vi.fn(async () => 'hooks.json'),
  spawnPty: vi.fn(async () => ({ id: 'pty-0' })),
}))

function emit(sessionId: string, plannerId = 'pty-0') {
  for (const handler of hooks)
    handler({
      payload: {
        hook_event_name: 'SessionStart',
        session_id: sessionId,
        plannerId,
      },
    })
}

const ref = <T>(current: T) => ({ current })
function params(): Parameters<typeof useXtermSession>[0] {
  return {
    ptyId: 'pty-0',
    command: 'claude',
    cwd: 'D:/repo',
    sessionId: 'bananas',
    runtimeProfile: 'lean',
    terminalTheme: 'dark',
    cliPathOverride: null,
    sessionPersistenceKey: 'tab-0',
    retryKey: 0,
    containerRef: ref(document.createElement('div')),
    terminalRef: ref(null),
    ptyIdRef: ref(null),
    lastCtrlCRef: ref(0),
    linkActionsRef: ref(null),
    spawnedAtRef: ref(0),
    usedResumeRef: ref(false),
    earlyExitRetriedRef: ref(false),
    forceFreshRef: ref(false),
    onSpawnedRef: ref(vi.fn()),
    onSessionIdRef: ref(vi.fn()),
    onInitialInputSentRef: ref(vi.fn()),
    onExitRef: ref(vi.fn()),
    onLaunchErrorRef: ref(vi.fn()),
    onAgentCompleteRef: ref(vi.fn()),
    setBootPhase: vi.fn(),
    setCommandNotFound: vi.fn(),
    setLinkActions: vi.fn(),
    setRetryKey: vi.fn(),
    setDropActive: vi.fn(),
    showLinkActionsMenu: vi.fn(),
    recordPromptInput: () => false,
    navigateHistory: vi.fn(),
  }
}

type MockTerminal = {
  writes: string[]
  buffer: { active: { type: 'normal' | 'alternate' } }
  modes: { mouseTrackingMode: string; bracketedPasteMode: boolean; sendFocusMode: boolean }
  scrollLines: Mock
}

/** The terminal the hook built, with the pieces these tests read and drive. */
function paneTerminal(input: Parameters<typeof useXtermSession>[0]): MockTerminal {
  return input.terminalRef.current as unknown as MockTerminal
}

beforeEach(() => {
  vi.clearAllMocks()
  hooks.clear()
  localStorage.clear()
  resetSessionClaimsForTests()
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  useTerminalsStore.setState({ byPtyId: {} })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('plannerLabelFor', () => {
  // Only what the lookup reads: a project's terminals, their names and their tabs' ids.
  function withTerminal(name: string, tab: { id: string; ptyId: string | null }) {
    useProjectsStore.setState({ projects: [{ terminals: [{ name, tabs: [tab] }] }] } as never)
  }

  it('names a planner by its terminal before the first spawn has given the tab a pty (#264)', () => {
    // The pane spawns under `tab.ptyId ?? tab.id`; the tab only gets its ptyId after the spawn.
    withTerminal('Night planner', { id: 'tab-1', ptyId: null })
    expect(plannerLabelFor('tab-1')).toBe('Night planner')
  })

  it('still finds a terminal by the pty its tab already has', () => {
    withTerminal('Night planner', { id: 'tab-1', ptyId: 'pty-9' })
    expect(plannerLabelFor('pty-9')).toBe('Night planner')
  })

  it('falls back to the id when no terminal has it', () => {
    withTerminal('Night planner', { id: 'tab-1', ptyId: 'pty-9' })
    expect(plannerLabelFor('tab-1')).toBe('tab-1')
    expect(plannerLabelFor('elsewhere')).toBe('elsewhere')
  })
})

describe('Claude terminal session lifecycle', () => {
  it.each(['frontend', 'backend'])(
    'tracks /new after attaching a live PTY found in the %s',
    async (source) => {
      if (source === 'frontend') useTerminalsStore.getState().registerPty('pty-0')
      else vi.mocked(tauri.ptyExists).mockResolvedValueOnce(true)
      const input = params()
      const view = renderHook(() => useXtermSession(input))
      await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
      act(() => emit('new-chat'))
      expect(peekSession('tab-0')?.claudeSessionId).toBe('new-chat')
      expect(input.onSessionIdRef.current).toHaveBeenLastCalledWith('new-chat')
      expect(tauri.spawnPty).not.toHaveBeenCalled()
      view.unmount()
      expect(hooks.size).toBe(0)
    },
  )

  it('does not overwrite a SessionStart received before spawn finishes', async () => {
    vi.mocked(tauri.spawnPty).mockImplementationOnce(async () => {
      emit('new-chat')
      return { id: 'pty-0' }
    })
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    expect(input.onLaunchErrorRef.current).not.toHaveBeenCalled()
    expect(peekSession('tab-0')?.claudeSessionId).toBe('new-chat')
    expect(input.onSessionIdRef.current).toHaveBeenLastCalledWith('new-chat')
  })

  it('resumes the synchronous saved conversation when projects.json still has the old ID', async () => {
    saveSession('tab-0', {
      sessionId: 'pty-0',
      claudeSessionId: 'new-chat',
      agent: 'claude',
      cwd: 'D:/repo',
      timestamp: 1,
    })
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    expect(tauri.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({
        extraArgs: expect.arrayContaining(['--resume', 'new-chat']),
      }),
    )
    expect(peekSession('tab-0')?.claudeSessionId).toBe('new-chat')
  })

  it('keeps the session callback tied to its tab and ignores other panes', async () => {
    useTerminalsStore.getState().registerPty('pty-0')
    const input = params()
    const original = input.onSessionIdRef.current
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    input.onSessionIdRef.current = vi.fn()
    act(() => {
      emit('neighbour', 'pty-1')
      emit('new-chat')
    })
    expect(original).toHaveBeenLastCalledWith('new-chat')
    expect(input.onSessionIdRef.current).not.toHaveBeenCalled()
    expect(peekSession('tab-0')?.claudeSessionId).toBe('new-chat')
  })

  it('frees a pane when a fullscreen session exits without undoing its modes', async () => {
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(exits.has('pty-0')).toBe(true))

    // What Claude Code in fullscreen rendering leaves on the pane when it is killed.
    const terminal = paneTerminal(input)
    terminal.modes.mouseTrackingMode = 'vt200'
    // Past the early-exit window, so this is a real exit and not the start-up retry.
    input.spawnedAtRef.current = Date.now() - 30_000

    act(() => exits.get('pty-0')?.({ code: 0 }))

    expect(terminal.writes.join('')).toContain('\x1b[?1049l\x1b[?1000l')
  })

  it('gives a dead pane its scrollback back on the wheel', async () => {
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(exits.has('pty-0')).toBe(true))
    input.spawnedAtRef.current = Date.now() - 30_000
    act(() => exits.get('pty-0')?.({ code: 0 }))

    const terminal = paneTerminal(input)
    terminal.buffer.active.type = 'alternate'
    terminal.modes.mouseTrackingMode = 'vt200'
    terminal.writes.length = 0

    act(() => {
      input.containerRef.current.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }),
      )
    })

    // The pane is stuck on a screen nobody owns: the modes come off, then the scroll happens.
    expect(terminal.writes.join('')).toContain('\x1b[?1049l')
    await waitFor(() => expect(terminal.scrollLines).toHaveBeenCalled())
  })

  it('leaves the wheel to a live fullscreen session', async () => {
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))

    const terminal = paneTerminal(input)
    terminal.buffer.active.type = 'alternate'
    terminal.modes.mouseTrackingMode = 'vt200'
    terminal.writes.length = 0

    act(() => {
      input.containerRef.current.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }),
      )
    })

    expect(terminal.scrollLines).not.toHaveBeenCalled()
    expect(terminal.writes.join('')).not.toContain('\x1b[?1049l')
  })
})
