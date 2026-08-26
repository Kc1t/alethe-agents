import { useCallback, useEffect, useRef, useState } from 'react'

import {
  generateCloudflareSecret,
  getCloudflareDeployWorkdir,
  probeCloudflareState,
} from '../lib/api/cloudflareDeploy'
import { killPty, listenPtyData, listenPtyExit, spawnPty, writePty } from '../lib/tauri'

export type CloudflareDeployStep =
  'idle' | 'preparing' | 'installing' | 'login' | 'secret' | 'deploying' | 'success'

// A real deploy's full log (npm install's spinner + wrangler's three banners) comes in well under
// this — it exists only as a hard ceiling against a truly runaway process, not a size a normal run
// should ever reach.
const MAX_LOG_CHARS = 200_000
// Matches the `*.workers.dev` URL `wrangler deploy` prints once it finishes publishing.
const WORKER_URL_PATTERN = /https:\/\/[a-z0-9.-]+\.workers\.dev\S*/gi
// Cloudflare API error 10063: the account has never had its `*.workers.dev` subdomain
// provisioned. This can only be done by visiting the dashboard once (opening "Workers & Pages"
// there auto-creates it) — no CLI flag or API call can do it. Detecting this exact, well-known
// failure lets the UI explain precisely what to do instead of a generic "deploy failed".
const NEEDS_WORKERS_DEV_SUBDOMAIN = 'you need a workers.dev subdomain'

function trimLog(value: string): string {
  if (value.length <= MAX_LOG_CHARS) return value
  const cut = value.length - MAX_LOG_CHARS
  // Cut at the next newline after the naive boundary, never mid-line — a blind character-count
  // slice can land inside an ANSI escape sequence, stripping its leading ESC byte and leaving the
  // rest (e.g. "32m") behind as literal visible text that `plainTextFromPtyLog` no longer
  // recognizes as a code to remove.
  const nextNewline = value.indexOf('\n', cut)
  return nextNewline === -1 ? value.slice(cut) : value.slice(nextNewline + 1)
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
      // `wrangler login` always opens a fresh browser OAuth flow unconditionally, even when
      // already authenticated — it never checks for a still-valid existing token first the way
      // `wrangler whoami` does. Without this check, every single "Publicar" click forced the user
      // through the browser again, even right after a previous successful login in the same
      // session — skip the login step entirely when `probeCloudflareState` confirms one isn't
      // needed.
      const probe = await probeCloudflareState().catch(() => ({
        installed: false,
        loggedIn: false,
      }))
      const alreadyLoggedIn = probe.installed && probe.loggedIn
      if (disposedRef.current) return

      const ptyId = `cloudflare-deploy_${Date.now()}`
      const spawned = await spawnPty({ cols: 100, rows: 24, id: ptyId, cwd: workdir })
      if (disposedRef.current) {
        void killPty(spawned.id).catch(() => undefined)
        return
      }
      ptyIdRef.current = spawned.id

      let answeredSkillsPrompt = false
      let lastGenericPromptAnswerAt = 0
      let succeededEarly = false
      cleanupRef.current.push(
        await listenPtyData(spawned.id, (chunk) => {
          setLog((current) => {
            const next = trimLog(current + chunk)
            // Detect success from the stream itself instead of only on process exit: `wrangler
            // deploy` prints the final `*.workers.dev` URL and then, on some setups, leaves the
            // shell sitting at an interactive prompt for a while instead of promptly running the
            // trailing `; exit` — waiting only for `listenPtyExit` left the UI stuck on
            // "Publicando" even though the real deploy had already finished successfully.
            if (!succeededEarly) {
              const url = extractWorkerUrl(next)
              if (url) {
                succeededEarly = true
                setWorkerUrl(url)
                setStep('success')
                // The shell may keep sitting at an interactive prompt instead of promptly running
                // the trailing `; exit` — nothing more is needed from it once the URL is in hand.
                teardown()
              }
            }
            return next
          })
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
          // Generic fallback for any other Wrangler y/n prompt (e.g. confirming the `workers_dev`
          // default) — matches "(y/n)", "[y/n]", or "» (Y/n)" style hints. Debounced instead of a
          // one-shot flag because more than one distinct prompt can appear later in the same run;
          // the time gap keeps it from re-answering the exact same still-visible line on the next
          // chunk before Wrangler has had a chance to move past it.
          if (
            /[[(]\s*y\s*\/\s*n\s*[\])]/i.test(chunk) &&
            Date.now() - lastGenericPromptAnswerAt > 2_000
          ) {
            lastGenericPromptAnswerAt = Date.now()
            void writePty(spawned.id, 'y\r').catch(() => undefined)
          }
          if (lower.includes(NEEDS_WORKERS_DEV_SUBDOMAIN)) setNeedsWorkersDevSubdomain(true)
        }),
      )
      cleanupRef.current.push(
        await listenPtyExit(spawned.id, (payload) => {
          ptyIdRef.current = null
          if (disposedRef.current || succeededEarly) return
          if (payload.code !== 0) {
            setFailed(true)
            setLog((current) => {
              // Always visible in DevTools (F12), even if the on-screen log box renders blank for
              // any reason — the raw tail is what actually tells us why Wrangler/npm exited
              // non-zero (e.g. Cloudflare's own API error text), so this stays permanent rather
              // than a one-off debugging aid.

              console.error('[cloudflare-deploy] failed, raw log tail:', current.slice(-4000))
              return current
            })
            return
          }
          setLog((current) => {
            const url = extractWorkerUrl(current)
            setWorkerUrl(url)
            if (url) setStep('success')
            else {
              setFailed(true)

              console.error(
                '[cloudflare-deploy] exited 0 but no worker url found, raw log tail:',
                current.slice(-4000),
              )
            }
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
        // Skipped entirely when already logged in (see the `probeCloudflareState` check above) —
        // otherwise not piped, see the `listenPtyData` callback above for why the "install
        // Cloudflare skills" prompt is answered live instead, by typing into the still-open PTY.
        ...(alreadyLoggedIn ? [] : ['npx wrangler login']),
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
