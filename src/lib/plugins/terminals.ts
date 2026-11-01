import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { agentLabel } from '../agentProviders'
import { lastPtySize, listenPtyData, listenPtyExit } from '../tauri'
import { isShellAgentType } from '../types'
import type { Disposable, PluginTerminals, TerminalSession } from './types'
import { isPlainTerminal, liveProjects, typeIntoPty } from './workspace'

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

function ptyOf(sessionId: string): string {
  const ptyId = ptyBySession.get(sessionId)
  if (!ptyId) throw new Error(`unknown_session:${sessionId}`)
  return ptyId
}

export function terminalSessions(): TerminalSession[] {
  const runtimes = useTerminalsStore.getState().byPtyId
  const sessions: TerminalSession[] = []
  for (const project of liveProjects()) {
    for (const terminal of project.terminals) {
      if (!isPlainTerminal(terminal)) continue
      for (const tab of terminal.tabs) {
        const runtime = tab.ptyId ? runtimes[tab.ptyId] : undefined
        if (!tab.ptyId || !runtime?.alive) continue
        sessions.push({
          id: sessionIdFor(tab.ptyId),
          terminalId: terminal.id,
          projectId: project.id,
          name: terminal.name,
          agent: String(tab.type),
          agentLabel: agentLabel(tab.type),
          shell: isShellAgentType(tab.type),
          status: runtime.status,
        })
      }
    }
  }
  return sessions
}

function signature(sessions: TerminalSession[]): string {
  return sessions
    .map((session) => [session.id, session.terminalId, session.status, session.name].join('\t'))
    .join('\n')
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
      return hold(() => {
        stopProjects()
        stopTerminals()
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
  }
}
