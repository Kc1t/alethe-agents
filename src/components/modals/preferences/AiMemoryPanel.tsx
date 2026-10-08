import { useCallback, useEffect, useRef, useState } from 'react'

import {
  AI_MEMORY_DEFAULT_PORT,
  AI_MEMORY_REPO,
  type AiMemoryCounts,
  aiMemoryCounts,
  aiMemoryErrorMessage,
  aiMemoryInstall,
  aiMemoryStart,
  type AiMemoryStatus,
  aiMemoryStop,
  canStart,
  offerInstall,
  portOwnedByOther,
} from '../../../lib/aiMemory'
import { useT } from '../../../lib/i18n'
import { aiMemoryDetect } from '../../../lib/tauri'
import { useUiStore } from '../../../stores/uiStore'
import controls from '../controls.module.css'
import styles from './AiMemoryPanel.module.css'

// A 46 MB binary opening SQLite and a git wiki has not necessarily bound the port the instant
// `spawn` succeeds, so a Start that just resolved is polled rather than trusted outright: a few
// attempts over a couple of seconds, bounded, not an unending interval.
const START_POLL_ATTEMPTS = 6
const START_POLL_INTERVAL_MS = 400

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function AiMemoryPanel() {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const [status, setStatus] = useState<AiMemoryStatus | null>(null)
  const [counts, setCounts] = useState<AiMemoryCounts | null>(null)
  const [busy, setBusy] = useState<'install' | 'start' | 'stop' | null>(null)
  const mountedRef = useRef(true)

  // `shouldApply` lets a caller skip both setters once the panel has unmounted — `aiMemoryDetect` can
  // resolve after that (a subprocess spawn plus a loopback connect with up to a 250ms timeout, longer
  // under antivirus scanning). It defaults to the same ref the unmount effect flips, so `run` and the
  // start poll below get the same guard as the initial mount fetch without passing it explicitly.
  const refresh = useCallback(async (shouldApply: () => boolean = () => mountedRef.current) => {
    const next = await aiMemoryDetect().catch(() => null)
    if (!shouldApply()) return next
    setStatus(next)
    const nextCounts = next?.installed ? await aiMemoryCounts().catch(() => null) : null
    if (!shouldApply()) return next
    setCounts(nextCounts)
    return next
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    return () => {
      mountedRef.current = false
    }
  }, [refresh])

  // Stops as soon as the server answers as running, or once the attempts run out — whichever first.
  const pollUntilRunning = useCallback(async () => {
    for (let attempt = 0; attempt < START_POLL_ATTEMPTS; attempt += 1) {
      const next = await refresh()
      if (!mountedRef.current || next?.running) return
      if (attempt < START_POLL_ATTEMPTS - 1) await wait(START_POLL_INTERVAL_MS)
    }
  }, [refresh])

  const run = async (
    kind: 'install' | 'start' | 'stop',
    action: () => Promise<unknown>,
    errorKey: 'aiMemory.installError' | 'aiMemory.startError' | 'aiMemory.stopError',
  ) => {
    setBusy(kind)
    try {
      await action()
      if (kind === 'start') {
        await pollUntilRunning()
      } else {
        await refresh()
      }
    } catch (cause) {
      pushToast({ title: t(errorKey), body: aiMemoryErrorMessage(cause, t) })
    } finally {
      if (mountedRef.current) setBusy(null)
    }
  }

  return (
    <div className={styles.panel}>
      <p className={styles.captures}>{t('aiMemory.panelCaptures')}</p>

      <p className={styles.state}>
        {status === null
          ? t('aiMemory.checking')
          : status.installed
            ? `${t(status.managed ? 'aiMemory.installedManaged' : 'aiMemory.installedExternal')} — ${t('aiMemory.at', { path: status.command })}`
            : status.supported === false
              ? t('aiMemory.unsupported')
              : t('aiMemory.missing')}
      </p>

      {status?.installed ? (
        <p className={styles.state}>
          {status.running
            ? t('aiMemory.running', { endpoint: status.endpoint })
            : t('aiMemory.stopped')}
          {counts
            ? ` · ${t('aiMemory.counts', {
                pages: counts.pages,
                sessions: counts.sessions,
                observations: counts.observations,
              })}`
            : ''}
        </p>
      ) : null}

      {portOwnedByOther(status) ? (
        <p className={styles.warning}>
          {t('aiMemory.portBusy', { endpoint: status?.endpoint ?? '' })}
        </p>
      ) : null}

      <div className={styles.actions}>
        {offerInstall(status) ? (
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            disabled={busy !== null}
            onClick={() => void run('install', aiMemoryInstall, 'aiMemory.installError')}
          >
            {busy === 'install' ? t('aiMemory.installing') : t('aiMemory.install')}
          </button>
        ) : null}
        {status?.running && status.ours ? (
          <button
            type="button"
            className={controls.btn}
            disabled={busy !== null}
            onClick={() => void run('stop', aiMemoryStop, 'aiMemory.stopError')}
          >
            {busy === 'stop' ? t('aiMemory.stopping') : t('aiMemory.stop')}
          </button>
        ) : (
          <button
            type="button"
            className={controls.btn}
            disabled={busy !== null || !canStart(status)}
            onClick={() =>
              void run('start', () => aiMemoryStart(AI_MEMORY_DEFAULT_PORT), 'aiMemory.startError')
            }
          >
            {busy === 'start' ? t('aiMemory.starting') : t('aiMemory.start')}
          </button>
        )}
        <a className={styles.link} href={AI_MEMORY_REPO} target="_blank" rel="noreferrer">
          {t('aiMemory.openRepo')}
        </a>
      </div>
    </div>
  )
}
