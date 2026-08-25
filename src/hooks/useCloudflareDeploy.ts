import { useCallback, useEffect, useRef, useState } from 'react'

import { generateCloudflareSecret, getCloudflareDeployWorkdir } from '../lib/api/cloudflareDeploy'
import { killPty, listenPtyData, listenPtyExit, spawnPty, writePty } from '../lib/tauri'

export type CloudflareDeployStep =
  'idle' | 'preparing' | 'installing' | 'login' | 'secret' | 'deploying' | 'success'

const MAX_LOG_CHARS = 20_000
// Matches the `*.workers.dev` URL `wrangler deploy` prints once it finishes publishing.
const WORKER_URL_PATTERN = /https:\/\/[a-z0-9.-]+\.workers\.dev\S*/gi

function trimLog(value: string): string {
  return value.length > MAX_LOG_CHARS ? value.slice(value.length - MAX_LOG_CHARS) : value
}

function extractWorkerUrl(log: string): string | null {
  const matches = log.match(WORKER_URL_PATTERN)
  if (!matches || matches.length === 0) return null
  // The deploy step's URL is always the last one printed — `wrangler login` can print unrelated
  // `*.workers.dev`-looking text in its own banner, but the final deploy line always comes last.
  return matches[matches.length - 1].replace(/[)\].,]+$/, '')
}

/**
 * Orchestrates the one-time "deploy your own Cloudflare rendezvous worker" flow over the existing
 * PTY infrastructure: `npm install`, `wrangler login` (opens the user's own browser; Cloudflare's
 * own OAuth token is stored by Wrangler on this machine, never by Alethe), a random per-deploy
 * `ABUSE_HASH_KEY` secret piped in non-interactively, then `wrangler deploy`. Every line of real
 * process output is surfaced through `log` so the caller can render it live.
 */
export function useCloudflareDeploy() {
  const [step, setStep] = useState<CloudflareDeployStep>('idle')
  const [failed, setFailed] = useState(false)
  const [log, setLog] = useState('')
  const [workerUrl, setWorkerUrl] = useState<string | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const cleanupRef = useRef<Array<() => void>>([])
  const disposedRef = useRef(false)

  const teardown = useCallback(() => {
    cleanupRef.current.forEach((stop) => stop())
    cleanupRef.current = []
    const ptyId = ptyIdRef.current
    ptyIdRef.current = null
    if (ptyId) void killPty(ptyId).catch(() => undefined)
  }, [])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      teardown()
    }
  }, [teardown])

  const start = useCallback(async () => {
    if (
      step === 'preparing' ||
      step === 'installing' ||
      step === 'login' ||
      step === 'secret' ||
      step === 'deploying'
    ) {
      return
    }
    teardown()
    setLog('')
    setWorkerUrl(null)
    setFailed(false)
    setStep('preparing')

    try {
      const workdir = await getCloudflareDeployWorkdir()
      const secret = await generateCloudflareSecret()
      if (disposedRef.current) return

      const ptyId = `cloudflare-deploy:${Date.now()}`
      const spawned = await spawnPty({ cols: 100, rows: 24, id: ptyId, cwd: workdir })
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
          if (disposedRef.current) return
          if (payload.code !== 0) {
            setFailed(true)
            return
          }
          setLog((current) => {
            const url = extractWorkerUrl(current)
            setWorkerUrl(url)
            if (url) setStep('success')
            else setFailed(true)
            return current
          })
        }),
      )

      setStep('installing')
      // A single portable-shell line (`&&`-chained — works in bash/zsh and PowerShell 7+):
      // install deps, log in to Cloudflare (opens this machine's browser), pipe a fresh random
      // secret into `wrangler secret put` non-interactively, then deploy. Each `echo` marker below
      // is only for the on-screen log, so the caller can move the step indicator forward live.
      const command = [
        'npm install',
        'echo "__ALETHE_STEP_LOGIN__"',
        'npx wrangler login',
        'echo "__ALETHE_STEP_SECRET__"',
        `echo ${secret} | npx wrangler secret put ABUSE_HASH_KEY`,
        'echo "__ALETHE_STEP_DEPLOY__"',
        'npx wrangler deploy',
      ].join(' && ')
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (disposedRef.current) return
      await writePty(spawned.id, `${command}; exit\r`)
    } catch (error) {
      setLog((current) => trimLog(`${current}\n${String(error)}`))
      setFailed(true)
      teardown()
    }
  }, [step, teardown])

  useEffect(() => {
    if (step !== 'installing' && step !== 'login' && step !== 'secret' && step !== 'deploying')
      return
    if (log.includes('__ALETHE_STEP_DEPLOY__')) setStep('deploying')
    else if (log.includes('__ALETHE_STEP_SECRET__')) setStep('secret')
    else if (log.includes('__ALETHE_STEP_LOGIN__')) setStep('login')
  }, [log, step])

  const reset = useCallback(() => {
    teardown()
    setLog('')
    setWorkerUrl(null)
    setFailed(false)
    setStep('idle')
  }, [teardown])

  return { step, failed, log, workerUrl, start, reset }
}
