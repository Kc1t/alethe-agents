import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { agentInputFor, waitForAgentInput } from '../agentInputRegistry'
import { PaneHiddenError, TerminalPromptOpenError } from '../agentPromptDelivery'
import { agentLabel } from '../agentProviders'
import { restartAgentTab } from '../agentTabRestart'
import { graphifyRepoOf } from '../claudeMcpConfigs'
import { computeVisibleFocusedPtyIds } from '../ptyVisibility'
import { inSidebarOrder } from '../sidebarOrder'
import { lastPtySize, listenPtyData, listenPtyExit, writePty } from '../tauri'
import { isShellAgentType, type Project, type SubTab, type Terminal } from '../types'
import type {
  Disposable,
  PluginTerminals,
  TerminalSession,
  TerminalSubmitError,
  TerminalSubmitErrorCode,
} from './types'
import { isPlainTerminal, liveProjects, typeIntoPty } from './workspace'

export const MAX_SCREEN_LINES = 2_000
const ESCAPE = '\x1b'

const sessionByPty = new Map<string, string>()
const ptyBySession = new Map<string, string>()
let sessionCount = 0

function sessionIdFor(ptyId: string): string {
  const known = sessionByPty.get(ptyId)
  if (known) return known
  sessionCount += 1
  const id = `session-${sessionCount}`
  sessionByPty.set(ptyId, id)
  ptyBySession.set(id, ptyId)
  return id
}

function unknownSession(sessionId: string): TerminalSubmitError {
  return Object.assign(new Error(`unknown_session:${sessionId}`), {
    code: 'unknown_session' as const,
  })
}

export function ptyOf(sessionId: string): string {
  const ptyId = ptyBySession.get(sessionId)
  if (!ptyId) throw unknownSession(sessionId)
  return ptyId
}

type Located = { project: Project; terminal: Terminal; tab: SubTab; ptyId: string }

function orderedLiveProjects(): Project[] {
  const { groups, ungroupedOrder } = useProjectsStore.getState()
  const live = liveProjects()
  const ordered = inSidebarOrder(live, groups, ungroupedOrder)
  const listed = new Set(ordered.map((project) => project.id))
  return [...ordered, ...live.filter((project) => !listed.has(project.id))]
}

function frontTabId(terminal: Terminal): string | undefined {
  return terminal.tabs.some((tab) => tab.id === terminal.activeTabId)
    ? terminal.activeTabId
    : terminal.tabs[0]?.id
}

function liveTabs(): Located[] {
  const runtimes = useTerminalsStore.getState().byPtyId
  const located: Located[] = []
  for (const project of orderedLiveProjects()) {
    for (const terminal of project.terminals) {
      if (!isPlainTerminal(terminal)) continue
      for (const tab of terminal.tabs) {
        if (!tab.ptyId || !runtimes[tab.ptyId]?.alive) continue
        located.push({ project, terminal, tab, ptyId: tab.ptyId })
      }
    }
  }
  return located
}

export function terminalSessions(): TerminalSession[] {
  const runtimes = useTerminalsStore.getState().byPtyId
  const { visible } = computeVisibleFocusedPtyIds()
  return liveTabs().map(({ project, terminal, tab, ptyId }, order) => ({
    id: sessionIdFor(ptyId),
    terminalId: terminal.id,
    projectId: project.id,
    projectName: project.name,
    name: terminal.name,
    tabName: tab.name,
    agent: String(tab.type),
    agentLabel: agentLabel(tab.type),
    shell: isShellAgentType(tab.type),
    status: runtimes[ptyId].status,
    cwd: tab.cwd || terminal.cwd,
    tabActive: tab.id === frontTabId(terminal),
    visible: visible.has(ptyId),
    agentSessionId: tab.sessionId ?? null,
    disabled: Boolean(terminal.disabled),
    order,
  }))
}

// null for a pty outside the live tabs, so an event from elsewhere never mints a session id
export function liveSessionIdOf(ptyId: string): string | null {
  return liveTabs().some((located) => located.ptyId === ptyId) ? sessionIdFor(ptyId) : null
}

export function locateSession(sessionId: string): Located {
  const ptyId = ptyOf(sessionId)
  const located = liveTabs().find((item) => item.ptyId === ptyId)
  if (!located) throw unknownSession(sessionId)
  return located
}

function submitError(code: TerminalSubmitErrorCode): TerminalSubmitError {
  return Object.assign(new Error(`submit_refused:${code}`), { code })
}

function requireAgent(located: Located) {
  if (isShellAgentType(located.tab.type)) throw submitError('not_an_agent')
}

function signature(sessions: TerminalSession[]): string {
  return JSON.stringify(sessions)
}

function focusSession({ project, terminal, tab }: Located) {
  const projects = useProjectsStore.getState()
  projects.setActiveProjectOnly(project.id)
  projects.focusWorkspaceTerminal(project.id, terminal.id)
  projects.setActiveTab(project.id, terminal.id, tab.id)
  const ui = useUiStore.getState()
  ui.setActiveView('workspace')
  ui.setActiveTerminal(project.id, terminal.id)
  ui.requestPaneFocus(terminal.id)
}

export function createPluginTerminals(
  require: (capability: string) => void,
  subscriptions: Disposable[],
): PluginTerminals {
  const hold = (stop: () => void): Disposable => {
    const disposable: Disposable = {
      dispose: () => {
        const index = subscriptions.indexOf(disposable)
        if (index !== -1) subscriptions.splice(index, 1)
        stop()
      },
    }
    subscriptions.push(disposable)
    return disposable
  }

  const listenTo = <T>(
    start: (emit: (payload: T) => void) => Promise<() => void>,
    handler: (payload: T) => void,
  ): Disposable => {
    let target: ((payload: T) => void) | null = handler
    let unlisten: (() => void) | null = null
    void start((payload) => target?.(payload)).then(
      (stop) => {
        if (target) unlisten = stop
        else stop()
      },
      () => undefined,
    )
    return hold(() => {
      target = null
      unlisten?.()
      unlisten = null
    })
  }

  return {
    sessions: () => {
      require('terminal.read')
      return terminalSessions()
    },
    onChange: (handler) => {
      require('terminal.read')
      let last = signature(terminalSessions())
      const check = () => {
        const next = signature(terminalSessions())
        if (next === last) return
        last = next
        handler()
      }
      const stopProjects = useProjectsStore.subscribe(check)
      const stopTerminals = useTerminalsStore.subscribe(check)
      const stopUi = useUiStore.subscribe(check)
      return hold(() => {
        stopProjects()
        stopTerminals()
        stopUi()
      })
    },
    onOutput: (sessionId, handler) => {
      require('terminal.read')
      const ptyId = ptyOf(sessionId)
      return listenTo<string>((emit) => listenPtyData(ptyId, emit), handler)
    },
    onExit: (sessionId, handler) => {
      require('terminal.read')
      const ptyId = ptyOf(sessionId)
      return listenTo(
        (emit) => listenPtyExit(ptyId, ({ code, reason }) => emit({ code, reason })),
        handler,
      )
    },
    size: (sessionId) => {
      require('terminal.read')
      return lastPtySize(ptyOf(sessionId))
    },
    write: async (sessionId, text) => {
      require('terminal.write')
      await typeIntoPty(ptyOf(sessionId), text)
    },
    submit: async (sessionId, text) => {
      require('terminal.write')
      const located = locateSession(sessionId)
      requireAgent(located)
      const input = agentInputFor(located.ptyId)
      if (!input) throw submitError('not_mounted')
      try {
        await input.submit(text)
      } catch (error) {
        if (error instanceof PaneHiddenError) throw submitError('pane_hidden')
        if (error instanceof TerminalPromptOpenError) throw submitError('prompt_open')
        throw error
      }
    },
    interrupt: async (sessionId) => {
      require('terminal.write')
      const located = locateSession(sessionId)
      requireAgent(located)
      await writePty(located.ptyId, ESCAPE)
    },
    readScreen: (sessionId, lines) => {
      require('terminal.read')
      if (!Number.isSafeInteger(lines) || lines < 1) throw new Error('invalid_screen_lines')
      const { ptyId } = locateSession(sessionId)
      return agentInputFor(ptyId)?.readScreen(Math.min(MAX_SCREEN_LINES, lines)) ?? null
    },
    focus: async (sessionId) => {
      require('terminal.write')
      const located = locateSession(sessionId)
      focusSession(located)
      if (!(await waitForAgentInput(located.ptyId))) throw submitError('not_mounted')
      useUiStore.getState().requestPaneFocus(located.terminal.id)
    },
    restart: async (sessionId) => {
      require('terminal.restart')
      const located = locateSession(sessionId)
      requireAgent(located)
      if (located.terminal.disabled) throw submitError('terminal_disabled')
      await restartAgentTab({
        projectId: located.project.id,
        terminalId: located.terminal.id,
        terminalCwd: located.terminal.cwd,
        tab: located.tab,
        graphifyRepo: graphifyRepoOf(located.project, located.terminal.cwd),
      })
    },
  }
}
