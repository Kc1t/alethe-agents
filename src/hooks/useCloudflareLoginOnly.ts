import { useCallback, useEffect, useRef, useState } from 'react'

import { getCloudflareDeployWorkdir } from '../lib/api/cloudflareDeploy'
import { withFallback } from '../lib/resilience'
import { killPty, listenPtyData, listenPtyExit, spawnPty, writePty } from '../lib/tauri'

export type CloudflareLoginStep = 'idle' | 'running' | 'success' | 'failed'

const MAX_LOG_CHARS = 8_000

function trimLog(value: string): string {
  return value.length > MAX_LOG_CHARS ? value.slice(value.length - MAX_LOG_CHARS) : value
}

/**
 * The "just connect my Cloudflare account" half of `useCloudflareDeploy`, for when `wrangler` is
 * already installed (`node_modules/wrangler` present, per `probeCloudflareState`) but this device
 * isn't authenticated yet — runs only `wrangler login` (opens this machine's own browser;
 * Cloudflare's OAuth token is stored by Wrangler locally, never seen by Alethe), no `npm install`
 * and no deploy. Deploying a Worker still goes through the full guided flow in Preferences.
 */
export function useCloudflareLoginOnly() {
  const [step, setStep] = useState<CloudflareLoginStep>('idle')
  const [log, setLog] = useState('')
  const ptyIdRef = useRef<string | null>(null)
  const cleanupRef = useRef<Array<() => void>>([])
  const disposedRef = useRef(false)

  const teardown = useCallback(() => {
    cleanupRef.current.forEach((stop) => stop())
    cleanupRef.current = []
    const ptyId = ptyIdRef.current
    ptyIdRef.current = null
    if (ptyId) void killPty(ptyId).catch(withFallback('killPty', undefined))
  }, [])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      teardown()
    }
  }, [teardown])

  const start = useCallback(async () => {
    if (step === 'running') return
    teardown()
    setLog('')
    setStep('running')

    try {
      const workdir = await getCloudflareDeployWorkdir()
      if (disposedRef.current) return

      const ptyId = `cloudflare-login_${Date.now()}`
      const spawned = await spawnPty({ cols: 100, rows: 24, id: ptyId, cwd: workdir })
      if (disposedRef.current) {
        void killPty(spawned.id).catch(withFallback('killPty', undefined))
        return
      }
      ptyIdRef.current = spawned.id

      let answeredSkillsPrompt = false
      cleanupRef.current.push(
        await listenPtyData(spawned.id, (chunk) => {
          setLog((current) => trimLog(current + chunk))
          // See `useCloudflareDeploy.ts`'s identical comment: answering this prompt by typing
          // into the still-open PTY (instead of piping stdin, which closes it) avoids a race
          // where Wrangler needs an open interactive stdin to finish persisting the OAuth token.
          if (!answeredSkillsPrompt && chunk.toLowerCase().includes('cloudflare skills')) {
            answeredSkillsPrompt = true
            void writePty(spawned.id, 'n\r').catch(withFallback('writePty', undefined))
          }
        }),
      )
      cleanupRef.current.push(
        await listenPtyExit(spawned.id, (payload) => {
          ptyIdRef.current = null
          if (disposedRef.current) return
          setStep(payload.code === 0 ? 'success' : 'failed')
        }),
      )

      await new Promise((resolve) => setTimeout(resolve, 300))
      if (disposedRef.current) return
      await writePty(spawned.id, 'npx wrangler login; exit\r')
    } catch (error) {
      setLog((current) => trimLog(`${current}\n${String(error)}`))
      setStep('failed')
      teardown()
    }
  }, [step, teardown])

  const reset = useCallback(() => {
    teardown()
    setLog('')
    setStep('idle')
  }, [teardown])

  return { step, log, start, reset }
}
