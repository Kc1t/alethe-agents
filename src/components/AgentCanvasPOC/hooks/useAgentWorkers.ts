import { listen } from '@tauri-apps/api/event'
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react'

import { MAX_LIVE_WORKERS } from '../../../lib/agentCanvasConfig'
import { type CodexWorker, execArgsFor, tailSummary } from '../../../lib/agentCanvasUtils'
import { useT } from '../../../lib/i18n'
import { attachPty, killPty, listenPtyExit, spawnPty } from '../../../lib/tauri'
import { agentCliCommand, type AgentType } from '../../../lib/types'
import { useUiStore } from '../../../stores/uiStore'

type Session = { folder: string; ptyId: string }

export function useAgentWorkers(sessionRef: MutableRefObject<Session | null>) {
  const t = useT()
  const [codexWorkers, setCodexWorkers] = useState<CodexWorker[]>([])
  const [expandedCodexId, setExpandedCodexId] = useState<string | null>(null)

  const codexWorkersRef = useRef<CodexWorker[]>([])
  const workerExitUnlistenersRef = useRef(new Map<string, () => void>())
  useEffect(() => {
    codexWorkersRef.current = codexWorkers
  }, [codexWorkers])

  const spawnAgentWorker = useCallback(
    (
      agent: AgentType,
      title: string,
      opts: { open?: boolean; task?: string } = {},
    ): string | null => {
      const folder = sessionRef.current?.folder
      if (!folder) return null
      const ptyId = `${agent}-worker-${Date.now()}`
      const args = opts.task ? execArgsFor(agent, opts.task) : undefined
      console.log(
        '[AgentCanvasPOC] criando worker',
        agent,
        ptyId,
        '· task=',
        !!opts.task,
        '·',
        title,
      )
      setCodexWorkers((prev) => [
        ...prev,
        { ptyId, agent, title, cwd: folder, startedAt: Date.now(), exitedCode: null, args },
      ])
      void spawnPty({
        cols: 120,
        rows: 30,
        id: ptyId,
        command: agentCliCommand(agent),
        cwd: folder,
        extraArgs: args,
      })
        .then(() => {
          let unlistenExit: (() => void) | null = null
          let exited = false
          void listenPtyExit(ptyId, (payload) => {
            const code = payload.code
            exited = true
            unlistenExit?.()
            workerExitUnlistenersRef.current.delete(ptyId)
            console.log('[AgentCanvasPOC] worker', ptyId, 'saiu, code', code)
            setCodexWorkers((prev) =>
              prev.map((w) => (w.ptyId === ptyId ? { ...w, exitedCode: code ?? 0 } : w)),
            )

            void attachPty(ptyId)
              .then((scrollback) => {
                const result = tailSummary(scrollback)
                if (!result) return
                setCodexWorkers((prev) =>
                  prev.map((w) => (w.ptyId === ptyId ? { ...w, result } : w)),
                )
              })
              .catch(() => {})
          })
            .then((unlisten) => {
              unlistenExit = unlisten

              if (exited) unlisten()
              else workerExitUnlistenersRef.current.set(ptyId, unlisten)
            })
            .catch(() => {})
        })
        .catch((err) => console.error('[AgentCanvasPOC] falha spawnando PTY do worker:', err))
      if (opts.open) setExpandedCodexId(ptyId)
      return ptyId
    },
    [sessionRef],
  )

  const spawnCodexWorker = useCallback(
    (title: string, opts: { open?: boolean; task?: string } = {}): string | null =>
      spawnAgentWorker('codex', title, opts),
    [spawnAgentWorker],
  )

  const killCodexWorker = useCallback((ptyId: string) => {
    console.log('[AgentCanvasPOC] matando worker', ptyId)
    workerExitUnlistenersRef.current.get(ptyId)?.()
    workerExitUnlistenersRef.current.delete(ptyId)
    void killPty(ptyId).catch(() => {})
    setCodexWorkers((prev) => prev.filter((w) => w.ptyId !== ptyId))
    setExpandedCodexId((cur) => (cur === ptyId ? null : cur))
  }, [])

  // Ponte de dispatch: o control plane spawna um processo real via POST /spawn

  const dispatchToAgent = useCallback(
    (payload: { agent?: string; task?: string; mode?: string }) => {
      const agent = payload.agent as AgentType | undefined
      if (agent !== 'claude' && agent !== 'codex' && agent !== 'opencode') return
      const rawTask = payload.task ?? ''
      // A task vira arg via PowerShell -> *.cmd (batch). Aspas duplas e newlines

      const safe = rawTask
        .replace(/"/g, "'")
        .replace(/\s*[\r\n]+\s*/g, ' ')
        .trim()
      const interactive = payload.mode === 'interactive' || !safe

      // a RAM spawnando dezenas de claude/codex.
      const liveWorkers = codexWorkersRef.current.filter((w) => w.exitedCode === null).length
      if (liveWorkers >= MAX_LIVE_WORKERS) {
        console.warn('[AgentCanvasPOC] teto de workers vivos atingido, recusando spawn:', agent)
        useUiStore.getState().pushToast({
          title: t('ws.workerCapTitle'),
          body: t('ws.workerCapBody', { max: MAX_LIVE_WORKERS }),
        })
        return
      }
      console.log(
        '[AgentCanvasPOC] dispatch',
        agent,
        interactive ? '(interativo)' : safe.slice(0, 80),
      )
      const title = safe ? (safe.length > 60 ? `${safe.slice(0, 60)}…` : safe) : agent
      spawnAgentWorker(agent, title, interactive ? { open: true } : { task: safe })
    },
    [spawnAgentWorker, t],
  )

  useEffect(() => {
    const unlistenPromise = listen('agent-spawn', (event) => {
      const payload = event.payload as { agent?: string; task?: string; mode?: string }
      console.log(
        '[AgentCanvasPOC] agent-spawn:',
        payload?.agent,
        String(payload?.task ?? '').slice(0, 60),
      )
      dispatchToAgent(payload)
    })
    return () => {
      void unlistenPromise.then((u) => u())
    }
  }, [dispatchToAgent])

  // sair do canvas e ao "limpar tudo".
  const killAllWorkers = useCallback(() => {
    for (const w of codexWorkersRef.current) {
      workerExitUnlistenersRef.current.get(w.ptyId)?.()
      void killPty(w.ptyId).catch(() => {})
    }
    workerExitUnlistenersRef.current.clear()
  }, [])

  useEffect(() => {
    return () => {
      killAllWorkers()
    }
  }, [killAllWorkers])

  return {
    codexWorkers,
    setCodexWorkers,
    expandedCodexId,
    setExpandedCodexId,
    spawnAgentWorker,
    spawnCodexWorker,
    killCodexWorker,
    dispatchToAgent,
    killAllWorkers,
  }
}
