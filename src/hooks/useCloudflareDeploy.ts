import { useCallback, useEffect, useRef, useState } from 'react'

import { generateCloudflareSecret, getCloudflareDeployWorkdir } from '../lib/api/cloudflareDeploy'
import { killPty, listenPtyData, listenPtyExit, spawnPty, writePty } from '../lib/tauri'

export type CloudflareDeployStep =
  'idle' | 'preparing' | 'installing' | 'login' | 'secret' | 'deploying' | 'success'

const MAX_LOG_CHARS = 20_000
// Matches the `*.workers.dev` URL `wrangler deploy` prints once it finishes publishing.
const WORKER_URL_PATTERN = /https:\/\/[a-z0-9.-]+\.workers\.dev\S*/gi
// Cloudflare API error 10063: the account has never had its `*.workers.dev` subdomain
// provisioned. This can only be done by visiting the dashboard once (opening "Workers & Pages"
// there auto-creates it) — no CLI flag or API call can do it. Detecting this exact, well-known
// failure lets the UI explain precisely what to do instead of a generic "deploy failed".
const NEEDS_WORKERS_DEV_SUBDOMAIN = 'you need a workers.dev subdomain'

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
  const [needsWorkersDevSubdomain, setNeedsWorkersDevSubdomain] = useState(false)
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
    setNeedsWorkersDevSubdomain(false)
    setStep('preparing')

    try {
      const workdir = await getCloudflareDeployWorkdir()
      const secret = await generateCloudflareSecret()
      if (disposedRef.current) return

      const ptyId = `cloudflare-deploy_${Date.now()}`
      const spawned = await spawnPty({ cols: 100, rows: 24, id: ptyId, cwd: workdir })
      if (disposedRef.current) {
        void killPty(spawned.id).catch(() => undefined)
        return
      }
      ptyIdRef.current = spawned.id

      let answeredSkillsPrompt = false
      cleanupRef.current.push(
        await listenPtyData(spawned.id, (chunk) => {
          setLog((current) => trimLog(current + chunk))
          const lower = chunk.toLowerCase()
          // Recent Wrangler versions ask an "install Cloudflare skills for AI agents?" y/n prompt
          // right after OAuth completes. Answering it by typing into the live PTY (instead of
          // piping "n" into stdin up front) matters: piping closes stdin as soon as it's read,
          // which can race with Wrangler still needing an open, interactive stdin to finish
          // persisting the OAuth token it just received from the browser callback — that race is
          // exactly what caused the deploy step to see no saved credentials and re-prompt login.
          if (!answeredSkillsPrompt && lower.includes('cloudflare skills')) {
            answeredSkillsPrompt = true
            void writePty(spawned.id, 'n\r').catch(() => undefined)
          }
          if (lower.includes(NEEDS_WORKERS_DEV_SUBDOMAIN)) setNeedsWorkersDevSubdomain(true)
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
        // Not piped — see the `listenPtyData` callback above for why the "install Cloudflare
        // skills" prompt is answered live instead, by typing into the still-open PTY.
        'npx wrangler login',
        'echo "__ALETHE_STEP_SECRET__"',
        `echo ${secret} | npx wrangler secret put ABUSE_HASH_KEY`,
        'echo "__ALETHE_STEP_DEPLOY__"',
        // A brand-new Cloudflare account fails here with API error 10063 (no `workers.dev`
        // subdomain provisioned yet) — detected above via `NEEDS_WORKERS_DEV_SUBDOMAIN` so the UI
        // can explain the one-time manual dashboard visit that fixes it; nothing here can work
        // around that requirement, Cloudflare only provisions it from the dashboard itself.
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
    setNeedsWorkersDevSubdomain(false)
    setStep('idle')
  }, [teardown])

  return { step, failed, needsWorkersDevSubdomain, log, workerUrl, start, reset }
}
