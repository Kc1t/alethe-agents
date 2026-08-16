import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { installShellLine, type InstallMethod } from '../lib/agentInstall'
import {
  agentCliVersion,
  findCliLauncher,
  killPty,
  listenPtyData,
  listenPtyExit,
  spawnPty,
  writePty,
} from '../lib/tauri'
import { agentCliCommand, type AgentType } from '../lib/types'

export type AgentInstallStatus = 'idle' | 'running' | 'success' | 'failed'

/**
 * Set only when a run finished with the installer reporting success and the resolver still
 * finding a binary, but the version at that binary never moved — the installer likely updated a
 * different install of the same CLI than the one PATH resolves to. Holds that binary's path so
 * the caller can name it.
 */
export type AgentInstallShadowConflict = { path: string }

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
  const [shadowConflict, setShadowConflict] = useState<AgentInstallShadowConflict | null>(null)
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
      setShadowConflict(null)
      setStatus('running')
      setBusyAgent(lockKey)

      const command = method.verifyCommand ?? agentCliCommand(agent)
      // Only meaningful for an update of something already on PATH — a fresh install has
      // nothing to compare against, and verifyAbsent (uninstall) checks absence, not a version.
      const beforeVersion = command && !method.verifyAbsent ? await agentCliVersion(command) : null

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
          await listenPtyExit(spawned.id, (payload) => {
            ptyIdRef.current = null
            if (busyAgent === lockKey) setBusyAgent(null)
            // `installShellLine` ends the shell with a bare `exit`, which carries the
            // installer command's own exit status. A non-zero code means the installer
            // itself reported failure (network error, permission denied, ...) — trust it
            // instead of falling through to the resolver, which would still find the
            // previous binary on PATH and misreport the run as a success.
            if (payload.code !== 0) {
              setStatus('failed')
              return
            }
            if (!command) {
              setStatus('failed')
              return
            }
            // A zero exit code still doesn't confirm the binary landed somewhere we
            // can launch it from, so ask the resolver.
            void findCliLauncher(command)
              .then(async (found) => {
                if (disposedRef.current) return
                const worked = method.verifyAbsent ? !found : Boolean(found)
                if (!worked) {
                  setStatus('failed')
                  return
                }
                // The resolver found a binary and the installer exited clean, but if that
                // binary's version is exactly what it was before, the installer likely
                // reached a different install of this CLI than the one PATH resolves to —
                // a shadowing install earlier on PATH that the update never touched.
                if (beforeVersion && found) {
                  const afterVersion = await agentCliVersion(command)
                  if (disposedRef.current) return
                  if (afterVersion && afterVersion === beforeVersion) {
                    setShadowConflict({ path: found })
                    setStatus('failed')
                    return
                  }
                }
                setStatus('success')
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
    setShadowConflict(null)
    setStatus('idle')
  }, [teardown])

  return { status, log, shadowConflict, install, reset }
}
