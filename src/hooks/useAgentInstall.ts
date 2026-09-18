import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { installCommandLine, type InstallMethod } from '../lib/agentInstall'
import {
  agentCliVersion,
  attachPty,
  findCliLauncher,
  killPty,
  listenPtyData,
  listenPtyExit,
  ptyExists,
  spawnPty,
} from '../lib/tauri'
import { resolveAgentCliCommand } from '../lib/agentProviders'
import type { AgentType } from '../lib/types'

export type AgentInstallStatus = 'idle' | 'running' | 'success' | 'failed'

/**
 * Set only when a run finished with the installer reporting success and the resolver still
 * finding a binary, but the version at that binary never moved — the installer likely updated a
 * different install of the same CLI than the one PATH resolves to. Holds that binary's path so
 * the caller can name it.
 */
export type AgentInstallShadowConflict = { path: string }

const MAX_LOG_CHARS = 12_000
/**
 * A run that never reports back used to sit on "installing" forever, holding the app-wide package
 * lock with it — no other install could start until the app was restarted. Long enough for a slow
 * network, short enough that the person gets a real answer.
 */
const INSTALL_TIMEOUT_MS = 10 * 60_000

function trimLog(value: string): string {
  return value.length > MAX_LOG_CHARS ? value.slice(value.length - MAX_LOG_CHARS) : value
}

export { trimLog as trimInstallLog }

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

/** Takes the app-wide package-manager lock, or returns false when another run already holds it. */
export function acquireAgentOperation(key: string): boolean {
  if (busyAgent !== null) return false
  setBusyAgent(key)
  return true
}

export function releaseAgentOperation(key: string): void {
  if (busyAgent === key) setBusyAgent(null)
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
  const timerRef = useRef<number | null>(null)

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

      const command = method.verifyCommand ?? resolveAgentCliCommand(agent)
      // Only meaningful for an update of something already on PATH — a fresh install has
      // nothing to compare against, and verifyAbsent (uninstall) checks absence, not a version.
      const beforeVersion = command && !method.verifyAbsent ? await agentCliVersion(command) : null

      const ptyId = `agent-install:${lockKey}:${Date.now()}`
      try {
        // A bare shell, then the command written into it: the native installers
        // are pipelines (`irm ... | iex`), which cannot be expressed as a
        // launcher plus argv.
        // The shell runs the line and ends with it, so `pty://exit` is the honest signal that the
        // run is over — see `installCommandLine`.
        const spawned = await spawnPty({
          cols: 100,
          rows: 24,
          id: ptyId,
          commandLine: installCommandLine(method.command),
        })
        if (disposedRef.current) {
          void killPty(spawned.id).catch(() => undefined)
          return
        }
        ptyIdRef.current = spawned.id
        timerRef.current = window.setTimeout(() => {
          if (disposedRef.current || ptyIdRef.current !== spawned.id) return
          setLog((current) => trimLog(`${current}\n[alethe] timed out; stopping.`))
          setStatus('failed')
          teardown()
        }, INSTALL_TIMEOUT_MS)

        cleanupRef.current.push(
          await listenPtyData(spawned.id, (chunk) => {
            setLog((current) => trimLog(current + chunk))
          }),
        )
        // The command starts with the shell, so the first lines can land before the listener above
        // exists. Ask for what it already printed rather than showing a pane that looks stalled.
        void attachPty(spawned.id)
          .then((replay) => {
            if (!disposedRef.current && replay) setLog((current) => trimLog(replay + current))
          })
          .catch(() => undefined)
        // `code` is null when the run ended before the exit listener existed. A real non-zero code
        // is still trusted: the installer itself reported failure (network error, permission
        // denied, ...), and falling through to the resolver would find the previous binary on PATH
        // and misreport the run as a success.
        let settled = false
        const settle = (code: number | null) => {
          if (settled) return
          settled = true
          ptyIdRef.current = null
          clearTimer()
          if (busyAgent === lockKey) setBusyAgent(null)
          if (code !== null && code !== 0) {
            setStatus('failed')
            return
          }
          if (!command) {
            setStatus('failed')
            return
          }
          // A clean exit still doesn't confirm the binary landed somewhere we can launch it from,
          // so ask the resolver.
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
        }

        cleanupRef.current.push(
          await listenPtyExit(spawned.id, (payload) => settle(payload.code)),
        )

        // The command starts with the shell, so a fast one can be over before the listener above
        // exists — and its exit event is emitted to nobody, leaving the run stuck on "running"
        // forever. Ask whether the PTY is still there; if it is already gone, the run is done.
        if (!(await ptyExists(spawned.id).catch(() => true))) settle(null)

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
