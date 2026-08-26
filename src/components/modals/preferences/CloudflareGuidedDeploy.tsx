import { Check, Cloud, Copy, ExternalLink, Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useAgentInstall } from '../../../hooks/useAgentInstall'
import { type CloudflareDeployStep, useCloudflareDeploy } from '../../../hooks/useCloudflareDeploy'
import { type InstallToolchain, nodeInstallMethods } from '../../../lib/agentInstall'
import { plainTextFromPtyLog } from '../../../lib/ansi'
import { useT } from '../../../lib/i18n'
import { probeInstallToolchain } from '../../../lib/tauri'
import controls from '../controls.module.css'
import styles from './CloudflareGuidedDeploy.module.css'

const STEP_ORDER: CloudflareDeployStep[] = [
  'preparing',
  'installing',
  'login',
  'secret',
  'deploying',
  'success',
]

export function CloudflareGuidedDeploy({
  onDeployed,
  alreadyDeployedUrl,
}: {
  onDeployed: (url: string) => void
  /** The endpoint already persisted from a previous deploy (this session or an earlier one) —
   * lets the component open straight into the compact "already published" summary instead of
   * the full step-by-step flow, which otherwise had no memory of a deploy that already happened. */
  alreadyDeployedUrl?: string | null
}) {
  const t = useT()
  const [toolchain, setToolchain] = useState<InstallToolchain | null>(null)
  const [probing, setProbing] = useState(true)
  const [logCopied, setLogCopied] = useState(false)
  const [redeploying, setRedeploying] = useState(false)
  const { step, failed, needsWorkersDevSubdomain, log, workerUrl, start, reset } =
    useCloudflareDeploy()
  const nodeInstall = useAgentInstall('shell', 'cloudflare-deploy-node')

  useEffect(() => {
    let active = true
    setProbing(true)
    probeInstallToolchain()
      .then((result) => {
        if (active) setToolchain(result)
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setProbing(false)
      })
    return () => {
      active = false
    }
  }, [nodeInstall.status])

  useEffect(() => {
    if (step === 'success' && workerUrl) onDeployed(workerUrl)
  }, [step, workerUrl, onDeployed])

  const running = step !== 'idle' && step !== 'success' && !failed
  const missingNode = !probing && !toolchain?.npm
  // Already published (from a previous deploy, this session or an earlier one) and nothing new
  // is running right now — show the compact summary instead of the full step-by-step flow.
  const showCompactPublished =
    step === 'idle' && !redeploying && Boolean(alreadyDeployedUrl) && !running

  return (
    <div className={styles.container}>
      <div className={styles.heading}>
        <Cloud size={14} aria-hidden="true" />
        {t('collaboration.cloudflareDeploy.title')}
      </div>
      <p className={styles.description}>{t('collaboration.cloudflareDeploy.description')}</p>

      {showCompactPublished ? (
        <div className={styles.resultRow}>
          <Check size={14} aria-hidden="true" />
          <span>
            {t('collaboration.cloudflareDeploy.alreadyPublished')} <code>{alreadyDeployedUrl}</code>
          </span>
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => {
              setRedeploying(true)
              void start()
            }}
          >
            {t('collaboration.cloudflareDeploy.redeploy')}
          </button>
        </div>
      ) : missingNode ? (
        <div className={styles.actionsRow}>
          <button
            type="button"
            className={controls.btn}
            disabled={nodeInstall.status === 'running'}
            onClick={() => {
              const method = nodeInstallMethods(toolchain)[0]
              if (method) void nodeInstall.install(method)
            }}
          >
            {nodeInstall.status === 'running' ? (
              <Loader2 size={13} className={styles.spin} />
            ) : null}
            {t('collaboration.cloudflareDeploy.installNode')}
          </button>
          <a className={controls.btn} href="https://nodejs.org/" target="_blank" rel="noreferrer">
            <ExternalLink size={13} aria-hidden="true" />
            {t('collaboration.cloudflareDeploy.downloadNode')}
          </a>
        </div>
      ) : (
        <>
          <div className={styles.steps}>
            {STEP_ORDER.map((candidate) => {
              const currentIndex = STEP_ORDER.indexOf(step)
              const candidateIndex = STEP_ORDER.indexOf(candidate)
              const isFailed = failed && candidateIndex === currentIndex
              const isDone =
                candidateIndex < currentIndex ||
                (step === 'success' && candidateIndex === currentIndex)
              const isActive = step === candidate && !failed
              return (
                <span
                  key={candidate}
                  className={`${styles.step} ${isActive ? styles.stepActive : ''} ${
                    isDone ? styles.stepDone : ''
                  } ${isFailed ? styles.stepFailed : ''}`}
                >
                  {isDone ? (
                    <Check size={11} />
                  ) : isActive ? (
                    <Loader2 size={11} className={styles.spin} />
                  ) : null}
                  {t(`collaboration.cloudflareDeploy.step.${candidate}`)}
                </span>
              )
            })}
          </div>

          {log ? (
            <div className={styles.logWrap}>
              <div className={styles.log}>{plainTextFromPtyLog(log).trim() || log}</div>
              <button
                type="button"
                className={styles.copyLogBtn}
                onClick={() => {
                  navigator.clipboard
                    .writeText(log)
                    .then(() => {
                      setLogCopied(true)
                      window.setTimeout(() => setLogCopied(false), 1500)
                    })
                    .catch(() => undefined)
                }}
                title={t('collaboration.cloudflareDeploy.copyLog')}
              >
                {logCopied ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </div>
          ) : null}

          {step === 'success' && workerUrl ? (
            <div className={styles.resultRow}>
              <Check size={14} aria-hidden="true" />
              {t('collaboration.cloudflareDeploy.success')} <code>{workerUrl}</code>
            </div>
          ) : null}

          {failed && needsWorkersDevSubdomain ? (
            <div className={`${styles.resultRow} ${styles.failedRow}`}>
              <X size={14} aria-hidden="true" />
              <span>
                {t('collaboration.cloudflareDeploy.needsSubdomain')}{' '}
                <a
                  href="https://dash.cloudflare.com/?to=/:account/workers-and-pages"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('collaboration.cloudflareDeploy.openDashboard')}
                  <ExternalLink size={11} aria-hidden="true" />
                </a>
              </span>
            </div>
          ) : failed ? (
            <div className={`${styles.resultRow} ${styles.failedRow}`}>
              <X size={14} aria-hidden="true" />
              {t('collaboration.cloudflareDeploy.failed')}
            </div>
          ) : null}

          <div className={styles.actionsRow}>
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              disabled={running}
              onClick={() => void start()}
            >
              {running ? <Loader2 size={13} className={styles.spin} /> : <Cloud size={13} />}
              {failed
                ? t('collaboration.cloudflareDeploy.retry')
                : step === 'success'
                  ? t('collaboration.cloudflareDeploy.redeploy')
                  : t('collaboration.cloudflareDeploy.start')}
            </button>
            {step !== 'idle' ? (
              <button type="button" className={controls.btn} onClick={reset}>
                {running
                  ? t('collaboration.cloudflareDeploy.cancel')
                  : t('collaboration.cloudflareDeploy.reset')}
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}
