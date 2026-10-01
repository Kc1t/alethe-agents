import { useCallback, useEffect, useRef, useState } from 'react'

import { installShellLine } from '../lib/agentInstall'
import {
  killPty,
  listenPtyData,
  listenPtyExit,
  router9InstallCommand,
  router9Status,
  router9Stop,
  router9UninstallCommand,
  spawnPty,
  writePty,
} from '../lib/tauri'
import {
  acquireAgentOperation,
  type AgentInstallStatus,
  releaseAgentOperation,
  trimInstallLog,
} from './useAgentInstall'

export type Router9InstallAction = 'install' | 'uninstall'

const LOCK_KEY = 'router9'
const PROMPT_SETTLE_MS = 400

export function useRouter9Install(onSettled?: () => void) {
  const [status, setStatus] = useState<AgentInstallStatus>('idle')
  const [action, setAction] = useState<Router9InstallAction | null>(null)
  const [log, setLog] = useState('')
  const ptyIdRef = useRef<string | null>(null)
  const cleanupRef = useRef<Array<() => void>>([])
  const disposedRef = useRef(false)
  const settledRef = useRef(onSettled)
  settledRef.current = onSettled

  const teardown = useCallback(() => {
    cleanupRef.current.forEach((stop) => stop())
    cleanupRef.current = []
    const ptyId = ptyIdRef.current
    ptyIdRef.current = null
    if (ptyId) void killPty(ptyId).catch(() => undefined)
    releaseAgentOperation(LOCK_KEY)
  }, [])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      teardown()
    }
  }, [teardown])

  const run = useCallback(
    async (next: Router9InstallAction) => {
      if (status === 'running') return
      teardown()
      if (!acquireAgentOperation(LOCK_KEY)) return
      setLog('')
      setAction(next)
      setStatus('running')

      // Removing the package under a live process would leave an orphan holding the port.
      if (next === 'uninstall') await router9Stop().catch(() => undefined)

      const ptyId = `router9-${next}:${Date.now()}`
      try {
        const command =
          next === 'install' ? await router9InstallCommand() : await router9UninstallCommand()
        const spawned = await spawnPty({ cols: 100, rows: 24, id: ptyId })
        if (disposedRef.current) {
          void killPty(spawned.id).catch(() => undefined)
          return
        }
        ptyIdRef.current = spawned.id

        cleanupRef.current.push(
          await listenPtyData(spawned.id, (chunk) => {
            setLog((current) => trimInstallLog(current + chunk))
          }),
        )
        cleanupRef.current.push(
          await listenPtyExit(spawned.id, (payload) => {
            ptyIdRef.current = null
            releaseAgentOperation(LOCK_KEY)
            if (payload.code !== 0) {
              setStatus('failed')
              return
            }
            // npm exiting clean is not proof the package landed: ask the backend what is on disk.
            void router9Status()
              .then((result) => {
                if (disposedRef.current) return
                const worked =
                  next === 'install' ? result.managed.installed : !result.managed.installed
                setStatus(worked ? 'success' : 'failed')
                settledRef.current?.()
              })
              .catch(() => {
                if (!disposedRef.current) setStatus('failed')
              })
          }),
        )

        await new Promise((resolve) => setTimeout(resolve, PROMPT_SETTLE_MS))
        if (disposedRef.current) return
        await writePty(spawned.id, installShellLine(command))
      } catch (error) {
        setLog((current) => trimInstallLog(`${current}\n${String(error)}`))
        setStatus('failed')
        teardown()
      }
    },
    [status, teardown],
  )

  const reset = useCallback(() => {
    teardown()
    setLog('')
    setAction(null)
    setStatus('idle')
  }, [teardown])

  return { status, action, log, run, reset }
}
