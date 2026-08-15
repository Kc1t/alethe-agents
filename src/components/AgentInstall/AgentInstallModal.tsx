import { Download, ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useAgentInstall, useAgentOperationBusy } from '../../hooks/useAgentInstall'
import {
  installDocsUrl,
  type InstallMethod,
  installMethodsFor,
  type InstallToolchain,
  needsNodeToolchain,
  NODE_DOWNLOAD_URL,
  nodeInstallMethods,
} from '../../lib/agentInstall'
import { useT } from '../../lib/i18n'
import { openInBrowser, probeInstallToolchain } from '../../lib/tauri'
import type { AgentType } from '../../lib/types'
import { Modal } from '../modals/Modal'
import controls from '../modals/controls.module.css'
import styles from './agentActions.module.css'

type Props = {
  agent: AgentType
  label: string
  open: boolean
  onClose: () => void
  onInstalled?: () => void
  nested?: boolean
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f]/g

const METHOD_LABEL_KEY = {
  native: 'agentInstall.method.native',
  npm: 'agentInstall.method.npm',
  winget: 'agentInstall.method.winget',
  scoop: 'agentInstall.method.scoop',
  choco: 'agentInstall.method.choco',
} as const

export function AgentInstallModal({ agent, label, open, onClose, onInstalled, nested }: Props) {
  const t = useT()
  const [toolchain, setToolchain] = useState<InstallToolchain | null>(null)
  const [probing, setProbing] = useState(true)
  const [chosenId, setChosenId] = useState<InstallMethod['id'] | null>(null)
  const { status, log, install, reset } = useAgentInstall(agent)
  const nodeInstall = useAgentInstall(agent, 'node-toolchain')
  const busyAgent = useAgentOperationBusy()
  const notifiedRef = useRef(false)

  const probe = () => {
    setProbing(true)
    return probeInstallToolchain()
      .then((result) => setToolchain(result))
      .catch(() => undefined)
      .finally(() => setProbing(false))
  }

  useEffect(() => {
    if (!open) return
    notifiedRef.current = false
    reset()
    void probe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (status !== 'success' || notifiedRef.current) return
    notifiedRef.current = true
    onClose()
    onInstalled?.()
  }, [status, onClose, onInstalled])

  // Node just landed, so the agent's npm method is viable now.
  useEffect(() => {
    if (nodeInstall.status !== 'success') return
    void probe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeInstall.status])

  const methods = installMethodsFor(agent, toolchain)
  const chosen = methods.find((method) => method.id === chosenId) ?? methods[0]
  const docsUrl = installDocsUrl(agent)
  const running = status === 'running'
  const nodeRunning = nodeInstall.status === 'running'
  // Only one install may run app-wide, so each button is disabled while the lock belongs to anyone
  // else — otherwise it stays enabled and silently does nothing when clicked.
  const blockedByOther = (key: string) => busyAgent !== null && busyAgent !== key
  const blocked = blockedByOther(agent)
  const missingNode = !probing && methods.length === 0 && needsNodeToolchain(agent, toolchain)
  const nodeMethod = missingNode ? nodeInstallMethods(toolchain)[0] : undefined
  const cleanLog = log.replace(ANSI_PATTERN, '')
  const nodeLog = nodeInstall.log.replace(ANSI_PATTERN, '')

  return (
    <Modal
      open={open}
      onClose={() => {
        if (running || nodeRunning) return
        onClose()
      }}
      title={t('agentInstall.installTitle', { agent: label })}
      width={480}
      nested={nested}
      footer={
        <>
          <button
            type="button"
            className={controls.btn}
            disabled={running || nodeRunning}
            onClick={onClose}
          >
            {t('agentInstall.cancel')}
          </button>
          {chosen ? (
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              disabled={running || blocked}
              onClick={() => void install(chosen)}
            >
              <Download size={13} />
              {running ? t('agentInstall.installing') : t('agentInstall.install')}
            </button>
          ) : null}
        </>
      }
    >
      {probing ? <p className={styles.modalText}>{t('agentInstall.probing')}</p> : null}

      {!probing && methods.length > 0 ? (
        <>
          <p className={styles.modalText}>{t('agentInstall.chooseMethod', { agent: label })}</p>
          <div className={styles.methodList}>
            {methods.map((method) => (
              <label
                key={method.id}
                className={`${styles.method} ${chosen?.id === method.id ? styles.methodActive : ''}`}
              >
                <input
                  type="radio"
                  name={`install-method-${agent}`}
                  checked={chosen?.id === method.id}
                  disabled={running}
                  onChange={() => setChosenId(method.id)}
                />
                <span className={styles.methodBody}>
                  <b>{t(METHOD_LABEL_KEY[method.id])}</b>
                  <code>{method.command}</code>
                </span>
              </label>
            ))}
          </div>
        </>
      ) : null}

      {missingNode ? (
        <div className={styles.toolchain}>
          <p className={styles.modalText}>{t('agentInstall.needsNode')}</p>
          <div className={styles.row}>
            {nodeMethod ? (
              <button
                type="button"
                className={styles.installBtn}
                disabled={nodeRunning || blockedByOther('node-toolchain')}
                onClick={() => void nodeInstall.install(nodeMethod)}
              >
                <Download size={13} />
                {nodeRunning ? t('agentInstall.installing') : t('agentInstall.installNode')}
              </button>
            ) : null}
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => void openInBrowser(NODE_DOWNLOAD_URL).catch(() => undefined)}
            >
              <ExternalLink size={13} /> {t('agentInstall.downloadNode')}
            </button>
          </div>
          {nodeMethod ? <div className={styles.command}>{nodeMethod.command}</div> : null}
          {nodeLog.trim() ? <pre className={styles.log}>{nodeLog}</pre> : null}
        </div>
      ) : null}

      {!probing && methods.length === 0 && !missingNode ? (
        <p className={styles.modalText}>{t('agentInstall.noMethod')}</p>
      ) : null}

      {status === 'failed' ? (
        <p className={`${styles.modalText} ${styles.statusFailed}`}>{t('agentInstall.failed')}</p>
      ) : null}

      {cleanLog.trim() ? <pre className={styles.log}>{cleanLog}</pre> : null}

      {docsUrl ? (
        <button
          type="button"
          className={styles.docsLink}
          onClick={() => void openInBrowser(docsUrl).catch(() => undefined)}
        >
          <ExternalLink size={12} /> {t('agentInstall.docs')}
        </button>
      ) : null}
    </Modal>
  )
}
