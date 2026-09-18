import { useCallback, useEffect, useRef, useState } from 'react'

import { installCommandLine } from '../lib/agentInstall'
import {
  attachPty,
  killPty,
  listenPtyData,
  listenPtyExit,
  ptyExists,
  router9InstallCommand,
  router9Status,
  router9Stop,
  router9UninstallCommand,
  spawnPty,
} from '../lib/tauri'
import {
  acquireAgentOperation,
  type AgentInstallStatus,
  releaseAgentOperation,
  trimInstallLog,
} from './useAgentInstall'

export type Router9InstallAction = 'install' | 'uninstall'

const LOCK_KEY = 'router9'
/**
 * A run that never reports back used to sit on "installing" forever, holding the app-wide package
 * lock with it — no other install could start until the app was restarted. Long enough for a slow
 * network, short enough that the person gets a real answer.
 */
const INSTALL_TIMEOUT_MS = 10 * 60_000

export function useRouter9Install(onSettled?: () => void) {
  const [status, setStatus] = useState<AgentInstallStatus>('idle')
  const [action, setAction] = useState<Router9InstallAction | null>(null)
  const [log, setLog] = useState('')
  const ptyIdRef = useRef<string | null>(null)
  const cleanupRef = useRef<Array<() => void>>([])
  const disposedRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const settledRef = useRef(onSettled)
  settledRef.current = onSettled

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const teardown = useCallback(() => {
    clearTimer()
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
        // The shell runs the line and ends with it, so `pty://exit` is the honest signal that the
        // run is over — see `installCommandLine`.
        const spawned = await spawnPty({
          cols: 100,
          rows: 24,
          id: ptyId,
          commandLine: installCommandLine(command),
        })
        if (disposedRef.current) {
          void killPty(spawned.id).catch(() => undefined)
          return
        }
        ptyIdRef.current = spawned.id
        timerRef.current = window.setTimeout(() => {
          if (disposedRef.current || ptyIdRef.current !== spawned.id) return
          setLog((current) => trimInstallLog(`${current}\n[alethe] timed out; stopping.`))
          setStatus('failed')
          teardown()
        }, INSTALL_TIMEOUT_MS)

        cleanupRef.current.push(
          await listenPtyData(spawned.id, (chunk) => {
            setLog((current) => trimInstallLog(current + chunk))
          }),
        )
        // The command starts with the shell, so the first lines can land before the listener above
        // exists. Ask for what it already printed rather than showing a pane that looks stalled.
        void attachPty(spawned.id)
          .then((replay) => {
            if (!disposedRef.current && replay) setLog((current) => trimInstallLog(replay + current))
          })
          .catch(() => undefined)
        // `code` is null when the run ended before the exit listener existed: the outcome is read
        // off disk either way, so a missing code costs nothing.
        let settled = false
        const settle = (code: number | null) => {
          if (settled) return
          settled = true
          ptyIdRef.current = null
          clearTimer()
          releaseAgentOperation(LOCK_KEY)
          if (code !== null && code !== 0) {
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
        }

        cleanupRef.current.push(
          await listenPtyExit(spawned.id, (payload) => settle(payload.code)),
        )

        // The command starts with the shell, so a fast one (`npm uninstall` takes a second) can be
        // over before the listener above exists — and its exit event is emitted to nobody, leaving
        // the run stuck on "running" forever. Ask whether the PTY is still there; if it is already
        // gone, the run is done and the outcome is on disk.
        if (!(await ptyExists(spawned.id).catch(() => true))) settle(null)

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
