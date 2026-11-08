import { act, renderHook, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { plannerLabelFor } from '../../lib/claudeMcpConfigs'
import {
  resetCodexSessionTrackingForTests,
  trackCodexRollout,
} from '../../lib/codexSessionTracking'
import { resetSessionClaimsForTests } from '../../lib/sessionDiscovery'
import { peekSession, saveSession } from '../../lib/sessionResume'
import * as tauri from '../../lib/tauri'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import type { AgentHookPayload } from '../../stores/agentCanvasStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useXtermSession } from './useXtermSession'

const hooks = vi.hoisted(() => new Set<(event: { payload: AgentHookPayload }) => void>())
const pane = vi.hoisted(() => ({
  visible: false,
  written: [] as string[],
  onData: null as ((chunk: string) => void) | null,
  onExit: null as ((payload: { code: number | null; reason: string }) => void) | null,
}))
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
const exits = vi.hoisted(() => new Map<string, (payload: tauri.PtyExitPayload) => void>())
const terminals = vi.hoisted(
  () => [] as Array<{ writes: string[]; modes: Record<string, unknown> }>,
)
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    unicode = { activeVersion: '11' }
    options = { fontSize: 14 }
    buffer = {
      active: {
        type: 'normal' as 'normal' | 'alternate',
        baseY: 0,
        viewportY: 0,
        getLine: () => undefined,
      },
    }
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
      pane.written.push(data)
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
    // A full reset (RIS) leaves the alternate screen and turns the modes off.
    reset() {
      this.buffer.active.type = 'normal'
      this.modes = { mouseTrackingMode: 'none', bracketedPasteMode: false, sendFocusMode: false }
    }
    refresh() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('../../lib/ptyVisibility', () => ({ usePtyPanelVisible: () => pane.visible }))
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof tauri>()),
  ptyExists: vi.fn(async () => false),
  attachPty: vi.fn(async () => ''),
  setPtyVisible: vi.fn(async () => true),
  listenPtyData: vi.fn(async (_id: string, handler: (chunk: string) => void) => {
    pane.onData = handler
    return () => {}
  }),
  resumePtyOutput: vi.fn(async () => null),
  listenPtyActivity: vi.fn(async () => () => {}),
  listenPtyExit: vi.fn(async (id: string, handler: (payload: tauri.PtyExitPayload) => void) => {
    pane.onExit = handler
    exits.set(id, handler)
    return () => {
      exits.delete(id)
    }
  }),
  findCliLauncher: vi.fn(async () => 'claude'),
  claudeSessionExists: vi.fn(async () => true),
  snapshotCodexSessions: vi.fn(async () => []),
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
  pane.visible = false
  pane.written = []
  pane.onData = null
  pane.onExit = null
  exits.clear()
  terminals.length = 0
  hooks.clear()
  localStorage.clear()
  resetSessionClaimsForTests()
  resetCodexSessionTrackingForTests()
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

  it('starts a fresh conversation only when the saved transcript no longer exists', async () => {
    vi.mocked(tauri.claudeSessionExists).mockResolvedValueOnce(false)
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    const args = vi.mocked(tauri.spawnPty).mock.calls[0][0].extraArgs ?? []
    expect(tauri.claudeSessionExists).toHaveBeenCalledWith('D:/repo', 'bananas')
    expect(args).toContain('--session-id')
    expect(args).not.toContain('--resume')
  })

  it('keeps the conversation when the transcript lookup itself fails', async () => {
    vi.mocked(tauri.claudeSessionExists).mockRejectedValueOnce(new Error('lookup failed'))
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    expect(tauri.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ extraArgs: expect.arrayContaining(['--resume', 'bananas']) }),
    )
  })

  it('keeps the saved conversation when the app shuts the PTY down', async () => {
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(pane.onExit).not.toBeNull())
    act(() => pane.onExit?.({ code: null, reason: 'shutdown' }))
    expect(peekSession('tab-0')?.claudeSessionId).toBe('bananas')
    expect(input.onExitRef.current).not.toHaveBeenCalled()
    expect(input.onSessionIdRef.current).not.toHaveBeenCalledWith(undefined)

    act(() => pane.onExit?.({ code: 0, reason: 'exited' }))
    expect(peekSession('tab-0')).toBeNull()
  })
})

describe('Codex terminal session lifecycle', () => {
  function codexPane() {
    const state = useProjectsStore.getState()
    const project = state.createProject({ name: 'Codex' })
    const terminal = state.createTerminal(project.id, {
      name: 'Codex',
      cwd: 'D:/repo',
      firstTab: { type: 'codex', cwd: 'D:/repo' },
    })
    const tab = terminal.tabs[0]
    state.setSubTabPtyId(project.id, terminal.id, tab.id, 'pty-0')
    const input = params()
    input.command = 'codex'
    input.sessionId = undefined
    input.sessionPersistenceKey = tab.id
    return { input, tabId: tab.id }
  }

  it('waits for the session watcher instead of polling the rollout directory', async () => {
    const { input } = codexPane()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    expect(vi.mocked(tauri.spawnPty).mock.calls[0][0].extraArgs ?? []).not.toContain('resume')
    expect(tauri.snapshotCodexSessions).not.toHaveBeenCalled()
  })

  it('adopts the conversation the watcher reports, then the one created by /new', async () => {
    const { input, tabId } = codexPane()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    const rollout = (id: string) => ({
      id,
      cwd: 'D:\\repo',
      source: 'cli',
      started_at: new Date().toISOString(),
    })

    act(() => trackCodexRollout(rollout('first-chat')))
    expect(input.onSessionIdRef.current).toHaveBeenLastCalledWith('first-chat')
    expect(peekSession(tabId)?.codexSessionId).toBe('first-chat')

    act(() => trackCodexRollout({ ...rollout('exec-run'), source: 'exec' }))
    expect(peekSession(tabId)?.codexSessionId).toBe('first-chat')
  })
})

describe('pane visibility', () => {
  async function hiddenLivePane() {
    useTerminalsStore.getState().registerPty('pty-0')
    const input = params()
    const view = renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    await waitFor(() => expect(pane.onData).not.toBeNull())
    return view
  }

  it('writes what was missed while hidden before any output that arrived meanwhile', async () => {
    const view = await hiddenLivePane()
    vi.mocked(tauri.resumePtyOutput).mockImplementationOnce(async () => {
      pane.onData?.('live')
      return 'missed '
    })
    pane.visible = true
    view.rerender()
    await waitFor(() => expect(pane.written.join('')).toContain('missed live'))
    expect(tauri.attachPty).not.toHaveBeenCalled()
  })

  it('restores the reading position after replay and live output have both been parsed', async () => {
    useTerminalsStore.getState().registerPty('pty-0')
    const input = params()
    const view = renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    const terminal = input.terminalRef.current!
    Object.assign(terminal.buffer.active, { baseY: 100, viewportY: 50 })
    const scroll = vi.spyOn(terminal, 'scrollToLine')
    const outputAtRestore: string[] = []
    scroll.mockImplementation(() => {
      outputAtRestore.push(pane.written.join(''))
    })
    vi.mocked(tauri.attachPty).mockImplementationOnce(async () => {
      pane.onData?.('live after replay')
      return 'replayed history '
    })

    pane.visible = true
    view.rerender()

    await waitFor(() => expect(scroll).toHaveBeenCalledWith(50))
    expect(outputAtRestore.at(-1)).toContain('replayed history live after replay')
  })

  it('keeps the current screen and live output when fetching a replay fails', async () => {
    useTerminalsStore.getState().registerPty('pty-0')
    const input = params()
    const view = renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    const reset = vi.spyOn(input.terminalRef.current!, 'reset')
    act(() => pane.onData?.('current screen '))
    await waitFor(() => expect(pane.written.join('')).toContain('current screen '))
    vi.mocked(tauri.attachPty).mockImplementationOnce(async () => {
      pane.onData?.('live despite failed replay')
      throw new Error('replay unavailable')
    })

    pane.visible = true
    view.rerender()

    await waitFor(() =>
      expect(pane.written.join('')).toContain('current screen live despite failed replay'),
    )
    expect(reset).not.toHaveBeenCalled()
  })

  it('falls back to a full replay when the backlog is incomplete', async () => {
    const view = await hiddenLivePane()
    vi.mocked(tauri.resumePtyOutput).mockResolvedValueOnce(null)
    pane.visible = true
    view.rerender()
    await waitFor(() => expect(tauri.attachPty).toHaveBeenCalledWith('pty-0'))
  })
})

describe('fullscreen terminal lifecycle', () => {
  it('frees a pane when a fullscreen session exits without undoing its modes', async () => {
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(exits.has('pty-0')).toBe(true))

    // What Claude Code in fullscreen rendering leaves on the pane when it is killed.
    const terminal = paneTerminal(input)
    terminal.modes.mouseTrackingMode = 'vt200'
    // Past the early-exit window, so this is a real exit and not the start-up retry.
    input.spawnedAtRef.current = Date.now() - 30_000

    act(() => exits.get('pty-0')?.({ code: 0, reason: 'exited' }))

    await waitFor(() => expect(terminal.writes.join('')).toContain('\x1b[?1049l\x1b[?1000l'))
  })

  it('frees a pane whose fullscreen modes were still queued when the session exited', async () => {
    const data = new Map<string, (chunk: string) => void>()
    vi.mocked(tauri.listenPtyData).mockImplementation(async (id, handler) => {
      data.set(id, handler as (chunk: string) => void)
      return () => {}
    })
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(exits.has('pty-0') && data.has('pty-0')).toBe(true))
    const terminal = paneTerminal(input) as MockTerminal & {
      write: (chunk: string, callback?: () => void) => void
    }
    // The mock parses only what this needs: entering the alternate screen with the mouse on.
    const write = terminal.write.bind(terminal)
    terminal.write = (chunk, callback) => {
      if (chunk.includes('\x1b[?1049h')) {
        terminal.buffer.active.type = 'alternate'
        terminal.modes.mouseTrackingMode = 'vt200'
      }
      write(chunk, callback)
    }
    input.spawnedAtRef.current = Date.now() - 30_000

    // The renderer's last output is still in the pane's write queue when the exit arrives.
    act(() => {
      data.get('pty-0')?.('\x1b[?1049h\x1b[?1000h')
      exits.get('pty-0')?.({ code: 0, reason: 'exited' })
    })

    await waitFor(() => expect(terminal.writes.join('')).toContain('\x1b[?1049l\x1b[?1000l'))
  })

  it.each(['replay', 'backlog'])(
    'frees a dead pane again when %s restores the fullscreen it died in',
    async (source) => {
      const input = params()
      const view = renderHook(() => useXtermSession(input))
      await waitFor(() => expect(exits.has('pty-0')).toBe(true))
      const terminal = paneTerminal(input) as MockTerminal & {
        write: (chunk: string, callback?: () => void) => void
      }
      const write = terminal.write.bind(terminal)
      terminal.write = (chunk, callback) => {
        if (chunk.includes('\x1b[?1049h')) {
          terminal.buffer.active.type = 'alternate'
          terminal.modes.mouseTrackingMode = 'vt200'
        }
        write(chunk, callback)
      }
      input.spawnedAtRef.current = Date.now() - 30_000

      // Killed in fullscreen while the pane was hidden: its output never reached the screen.
      act(() => {
        useTerminalsStore.getState().recordIo('pty-0')
        exits.get('pty-0')?.({ code: 0, reason: 'exited' })
      })
      const fullscreen = '\x1b[?1049h\x1b[?1000hthe fullscreen UI'
      vi.mocked(tauri.attachPty).mockResolvedValue(fullscreen)
      if (source === 'backlog') vi.mocked(tauri.resumePtyOutput).mockResolvedValueOnce(fullscreen)
      terminal.writes.length = 0

      // Shown again, the pane rebuilds itself from the scrollback, fullscreen bytes included.
      pane.visible = true
      view.rerender()

      await waitFor(() => expect(terminal.writes.join('')).toContain('the fullscreen UI'))
      await waitFor(() => expect(terminal.writes.join('')).toContain('\x1b[?1049l\x1b[?1000l'))
    },
  )

  it('gives a dead pane its scrollback back on the wheel', async () => {
    const input = params()
    renderHook(() => useXtermSession(input))
    await waitFor(() => expect(exits.has('pty-0')).toBe(true))
    input.spawnedAtRef.current = Date.now() - 30_000
    act(() => exits.get('pty-0')?.({ code: 0, reason: 'exited' }))

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
