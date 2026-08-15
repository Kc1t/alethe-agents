import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { installShellLine, type InstallMethod } from '../lib/agentInstall'
import {
  findCliLauncher,
  killPty,
  listenPtyData,
  listenPtyExit,
  spawnPty,
  writePty,
} from '../lib/tauri'
import { agentCliCommand, type AgentType } from '../lib/types'

export type AgentInstallStatus = 'idle' | 'running' | 'success' | 'failed'

const MAX_LOG_CHARS = 12_000
const PROMPT_SETTLE_MS = 400

function trimLog(value: string): string {
  return value.length > MAX_LOG_CHARS ? value.slice(value.length - MAX_LOG_CHARS) : value
}

/*
 * Package managers serialize badly: two `npm -g` runs fight over the same global directory, and
 * WinGet refuses to run twice at once. Only one agent operation is allowed at a time, app-wide.
 */
let busyAgent: string | null = null
const busyListeners = new Set<() => void>()

function setBusyAgent(agent: string | null): void {
  busyAgent = agent
  for (const listener of busyListeners) listener()
}

/** The agent whose install/uninstall is running right now, or null when nothing is. */
export function useAgentOperationBusy(): string | null {
  return useSyncExternalStore(
    (onChange) => {
      busyListeners.add(onChange)
      return () => busyListeners.delete(onChange)
    },
    () => busyAgent,
  )
}

/**
 * `lockKey` identifies the run that holds the app-wide lock. It defaults to the agent, and only
 * differs when the same screen also installs something else for that agent — the Node toolchain —
 * which must not look like the agent's own run or the two would be allowed to run together.
 */
export function useAgentInstall(agent: AgentType, lockKey: string = agent) {
  const [status, setStatus] = useState<AgentInstallStatus>('idle')
  const [log, setLog] = useState('')
  const ptyIdRef = useRef<string | null>(null)
  const cleanupRef = useRef<Array<() => void>>([])
  const disposedRef = useRef(false)

  const teardown = useCallback(() => {
    cleanupRef.current.forEach((stop) => stop())
    cleanupRef.current = []
    const ptyId = ptyIdRef.current
    ptyIdRef.current = null
    if (ptyId) void killPty(ptyId).catch(() => undefined)
    // Never leave the app-wide lock held by a run that is gone.
    if (busyAgent === lockKey) setBusyAgent(null)
  }, [lockKey])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      teardown()
    }
  }, [teardown])

  const install = useCallback(
    async (method: InstallMethod) => {
      if (status === 'running' || busyAgent !== null) return
      teardown()
      setLog('')
      setStatus('running')
      setBusyAgent(lockKey)

      const ptyId = `agent-install:${lockKey}:${Date.now()}`
      try {
        // A bare shell, then the command written into it: the native installers
        // are pipelines (`irm ... | iex`), which cannot be expressed as a
        // launcher plus argv.
        const spawned = await spawnPty({ cols: 100, rows: 24, id: ptyId })
        if (disposedRef.current) {
          void killPty(spawned.id).catch(() => undefined)
          return
        }
        ptyIdRef.current = spawned.id

        cleanupRef.current.push(
          await listenPtyData(spawned.id, (chunk) => {
            setLog((current) => trimLog(current + chunk))
          }),
        )
        cleanupRef.current.push(
          await listenPtyExit(spawned.id, () => {
            ptyIdRef.current = null
            if (busyAgent === lockKey) setBusyAgent(null)
            const command = method.verifyCommand ?? agentCliCommand(agent)
            if (!command) {
              setStatus('failed')
              return
            }
            // The exit code of the shell says nothing about whether the binary
            // landed somewhere we can launch it from, so ask the resolver.
            void findCliLauncher(command)
              .then((found) => {
                if (disposedRef.current) return
                const worked = method.verifyAbsent ? !found : Boolean(found)
                setStatus(worked ? 'success' : 'failed')
              })
              .catch(() => {
                if (!disposedRef.current) setStatus('failed')
              })
          }),
        )

        await new Promise((resolve) => setTimeout(resolve, PROMPT_SETTLE_MS))
        if (disposedRef.current) return
        await writePty(spawned.id, installShellLine(method.command))
      } catch (error) {
        setLog((current) => trimLog(`${current}\n${String(error)}`))
        setStatus('failed')
        teardown()
      }
    },
    [agent, lockKey, status, teardown],
  )

  const reset = useCallback(() => {
    teardown()
    setLog('')
    setStatus('idle')
  }, [teardown])

  return { status, log, install, reset }
}
