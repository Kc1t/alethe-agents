import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agentInputFor } from '../../lib/agentInputRegistry'
import { PaneHiddenError } from '../../lib/agentPromptDelivery'
import { registerReadAloud } from '../../lib/voice/readAloud'
import {
  resetCodexSessionTrackingForTests,
  trackCodexRollout,
} from '../../lib/codexSessionTracking'
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
/** What the mocked terminal reports as selected, and the OSC handlers registered on it. */
const selection = vi.hoisted(() => ({ text: '' }))
const osc = vi.hoisted(() => new Map<number, (data: string) => boolean>())
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
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    unicode = { activeVersion: '11' }
    options = { fontSize: 14 }
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
    hasSelection() {
      return selection.text !== ''
    }
    getSelection() {
      return selection.text
    }
    clearSelection() {
      selection.text = ''
    }
    parser = {
      registerOscHandler(id: number, handler: (data: string) => boolean) {
        osc.set(id, handler)
        return { dispose: () => osc.delete(id) }
      },
    }
    onKey() {
      return { dispose() {} }
    }
    write(data: string, done?: () => void) {
      pane.written.push(data)
      done?.()
    }
    reset() {}
    refresh() {}
    scrollToBottom() {}
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
  setPtyVisible: vi.fn(async () => true),
  listenPtyData: vi.fn(async (_id: string, handler: (chunk: string) => void) => {
    pane.onData = handler
    return () => {}
  }),
  resumePtyOutput: vi.fn(async () => null),
  attachPty: vi.fn(async () => ''),
  listenPtyActivity: vi.fn(async () => () => {}),
  listenPtyExit: vi.fn(async (_id: string, handler: (payload: tauri.PtyExitPayload) => void) => {
    pane.onExit = handler
    return () => {}
  }),
  findCliLauncher: vi.fn(async () => 'claude'),
  claudeSessionExists: vi.fn(async () => true),
  snapshotCodexSessions: vi.fn(async () => []),
  agentHooksSettingsPath: vi.fn(async () => 'hooks.json'),
  spawnPty: vi.fn(async () => ({ id: 'pty-0' })),
  writePty: vi.fn(async () => undefined),
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
    showSelectionMenu: vi.fn(),
    recordPromptInput: () => false,
    navigateHistory: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  pane.visible = false
  pane.written = []
  pane.onData = null
  pane.onExit = null
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

  it('falls back to a full replay when the backlog is incomplete', async () => {
    const view = await hiddenLivePane()
    vi.mocked(tauri.resumePtyOutput).mockResolvedValueOnce(null)
    pane.visible = true
    view.rerender()
    await waitFor(() => expect(tauri.attachPty).toHaveBeenCalledWith('pty-0'))
  })
})

describe('voice input registration', () => {
  // Hidden panes get no pty://data, so the screen guard would read a stale buffer.
  it('refuses a submit while the pane is out of view, before pasting anything', async () => {
    useTerminalsStore.getState().registerPty('pty-0')
    const input = params()
    const view = renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    const agentInput = agentInputFor('pty-0')
    expect(agentInput).not.toBeNull()
    await expect(agentInput!.submit('fix the build')).rejects.toBeInstanceOf(PaneHiddenError)
    expect(tauri.writePty).not.toHaveBeenCalled()
    view.unmount()
  })

  it('does not register a pane whose attach finished after it unmounted', async () => {
    let backendHasPty: (exists: boolean) => void = () => undefined
    vi.mocked(tauri.ptyExists).mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (backendHasPty = resolve)),
    )
    const input = params()
    const view = renderHook(() => useXtermSession(input))
    await waitFor(() => expect(tauri.ptyExists).toHaveBeenCalled())
    view.unmount()
    await act(async () => {
      backendHasPty(true)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(agentInputFor('pty-0')).toBeNull()
  })
})

describe('other harnesses', () => {
  // Voice can talk to any harness, so every agent pane registers its input; a shell does not.
  it.each([
    ['opencode', true],
    ['kimi', true],
    ['shell', false],
  ] as const)('registers the voice input of a %s pane: %s', async (command, registered) => {
    useTerminalsStore.getState().registerPty('pty-0')
    const input = { ...params(), command }
    const view = renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    expect(agentInputFor('pty-0') !== null).toBe(registered)
    view.unmount()
  })
})

describe('selection context menu', () => {
  afterEach(() => {
    selection.text = ''
  })

  const rightClick = (container: HTMLElement) =>
    container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))

  it('opens the selection menu while something can read it aloud', async () => {
    useTerminalsStore.getState().registerPty('pty-0')
    const unregister = registerReadAloud(vi.fn())
    const input = params()
    const view = renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    selection.text = 'The build failed.'
    rightClick(input.containerRef.current!)
    expect(input.showSelectionMenu).toHaveBeenCalledWith(expect.any(MouseEvent), {
      text: 'The build failed.',
      paste: expect.any(Function),
    })
    expect(selection.text).toBe('The build failed.')
    unregister()
    view.unmount()
  })

  // xterm's own contextmenu listener (on its element, inside the container) selects the word under
  // the pointer; the menu must get the block that was selected before it runs.
  it('keeps a selected block that xterm would replace with the clicked word', async () => {
    useTerminalsStore.getState().registerPty('pty-0')
    const unregister = registerReadAloud(vi.fn())
    const input = params()
    const xtermElement = document.createElement('div')
    input.containerRef.current!.appendChild(xtermElement)
    xtermElement.addEventListener('contextmenu', () => {
      selection.text = 'falada.'
    })
    const view = renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    selection.text = 'First line of the block\nlast line falada.'
    rightClick(xtermElement)
    expect(input.showSelectionMenu).toHaveBeenCalledWith(expect.any(MouseEvent), {
      text: 'First line of the block\nlast line falada.',
      paste: expect.any(Function),
    })
    expect(selection.text).toBe('First line of the block\nlast line falada.')
    unregister()
    view.unmount()
  })

  // A TUI in mouse mode draws its own selection; xterm has none, so the menu offers the clipboard.
  it('offers reading the clipboard, and pasting, with nothing selected', async () => {
    useTerminalsStore.getState().registerPty('pty-0')
    const unregister = registerReadAloud(vi.fn())
    const input = params()
    const view = renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    rightClick(input.containerRef.current!)
    expect(input.showSelectionMenu).toHaveBeenCalledWith(expect.any(MouseEvent), {
      text: null,
      paste: expect.any(Function),
    })
    unregister()
    view.unmount()
  })

  it('takes what the TUI copied with OSC 52 as the selection until the next left click', async () => {
    useTerminalsStore.getState().registerPty('pty-0')
    const copy = vi.spyOn(tauri, 'writeClipboardText').mockResolvedValue(undefined)
    const unregister = registerReadAloud(vi.fn())
    const input = params()
    const view = renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    const container = input.containerRef.current!
    expect(osc.get(52)?.(`c;${btoa('Resumo da conversa')}`)).toBe(true)
    expect(copy).toHaveBeenCalledWith('Resumo da conversa')
    rightClick(container)
    expect(input.showSelectionMenu).toHaveBeenLastCalledWith(expect.any(MouseEvent), {
      text: 'Resumo da conversa',
      paste: expect.any(Function),
    })
    container.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }))
    rightClick(container)
    expect(input.showSelectionMenu).toHaveBeenLastCalledWith(expect.any(MouseEvent), {
      text: null,
      paste: expect.any(Function),
    })
    unregister()
    view.unmount()
  })

  // Voice conversation off: right-click keeps copying the selection at once.
  it('copies the selection right away when nothing reads aloud', async () => {
    useTerminalsStore.getState().registerPty('pty-0')
    const copy = vi.spyOn(tauri, 'writeClipboardText').mockResolvedValue(undefined)
    const input = params()
    const view = renderHook(() => useXtermSession(input))
    await waitFor(() => expect(input.setBootPhase).toHaveBeenCalledWith('ready'))
    selection.text = 'The build failed.'
    rightClick(input.containerRef.current!)
    expect(input.showSelectionMenu).not.toHaveBeenCalled()
    expect(copy).toHaveBeenCalledWith('The build failed.')
    view.unmount()
  })
})
