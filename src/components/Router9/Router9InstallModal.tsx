import { Download, ExternalLink, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useAgentInstall, useAgentOperationBusy } from '../../hooks/useAgentInstall'
import { type Router9InstallAction,useRouter9Install } from '../../hooks/useRouter9Install'
import {
  type InstallToolchain,
  NODE_DOWNLOAD_URL,
  nodeInstallMethods,
  stripInstallLogAnsi,
} from '../../lib/agentInstall'
import { useT } from '../../lib/i18n'
import { ROUTER9_ADVISORIES_URL } from '../../lib/router9'
import { openInBrowser, probeInstallToolchain } from '../../lib/tauri'
import styles from '../AgentInstall/agentActions.module.css'
import controls from '../modals/controls.module.css'
import { Modal } from '../modals/Modal'

const NODE_LOCK = 'node-toolchain'

type Props = {
  action: Router9InstallAction
  open: boolean
  onClose: () => void
  onSettled?: () => void
  nested?: boolean
}

export function Router9InstallModal({ action, open, onClose, onSettled, nested }: Props) {
  const t = useT()
  const [toolchain, setToolchain] = useState<InstallToolchain | null>(null)
  const [probing, setProbing] = useState(true)
  const { status, log, run, reset } = useRouter9Install(onSettled)
  // 9router is not an agent, but the Node install method verifies against npm rather than the
  // agent, so any agent works as the carrier for the shared toolchain installer.
  const nodeInstall = useAgentInstall('claude', NODE_LOCK)
  const busyAgent = useAgentOperationBusy()

  useEffect(() => {
    if (!open) return
    reset()
    setProbing(true)
    void probeInstallToolchain()
      .then(setToolchain)
      .catch(() => undefined)
      .finally(() => setProbing(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (nodeInstall.status !== 'success') return
    setProbing(true)
    void probeInstallToolchain()
      .then(setToolchain)
      .catch(() => undefined)
      .finally(() => setProbing(false))
     
  }, [nodeInstall.status])

  const running = status === 'running'
  const nodeRunning = nodeInstall.status === 'running'
  const blocked = busyAgent !== null && busyAgent !== 'router9'
  const missingNode = !probing && !toolchain?.npm
  const nodeMethod = missingNode ? nodeInstallMethods(toolchain)[0] : undefined
  const cleanLog = stripInstallLogAnsi(log)
  const nodeLog = stripInstallLogAnsi(nodeInstall.log)
  const installing = action === 'install'

  return (
    <Modal
      open={open}
      onClose={() => {
        if (running) return
        onClose()
      }}
      title={installing ? t('router9.installTitle') : t('router9.uninstallTitle')}
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
          <button
            type="button"
            className={`${controls.btn} ${installing ? controls.btnPrimary : controls.btnDanger}`}
            disabled={running || blocked || (installing && missingNode)}
            onClick={() => void run(action)}
          >
            {installing ? <Download size={13} /> : <Trash2 size={13} />}
            {running
              ? installing
                ? t('agentInstall.installing')
                : t('agentInstall.uninstalling')
              : installing
                ? t('agentInstall.install')
                : t('agentInstall.uninstall')}
          </button>
        </>
      }
    >
      {probing ? <p className={styles.modalText}>{t('agentInstall.probing')}</p> : null}

      {installing ? (
        <p className={styles.modalText}>{t('router9.installIntro')}</p>
      ) : (
        <p className={styles.modalText}>{t('router9.uninstallIntro')}</p>
      )}

      {installing ? (
        <div className={styles.toolchain}>
          <p className={styles.modalText}>{t('router9.securityNote')}</p>
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => void openInBrowser(ROUTER9_ADVISORIES_URL).catch(() => undefined)}
          >
            <ExternalLink size={13} /> {t('router9.securityAdvisories')}
          </button>
        </div>
      ) : null}

      {missingNode && installing ? (
        <div className={styles.toolchain}>
          <p className={styles.modalText}>{t('agentInstall.needsNode')}</p>
          <div className={styles.row}>
            {nodeMethod ? (
              <button
                type="button"
                className={styles.installBtn}
                disabled={nodeRunning || (busyAgent !== null && busyAgent !== NODE_LOCK)}
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

      {status === 'failed' ? (
        <p className={`${styles.modalText} ${styles.statusFailed}`}>{t('agentInstall.failed')}</p>
      ) : null}

      {status === 'success' ? (
        <p className={`${styles.modalText} ${styles.statusSuccess}`}>{t('agentInstall.done')}</p>
      ) : null}

      {cleanLog.trim() ? <pre className={styles.log}>{cleanLog}</pre> : null}
    </Modal>
  )
}
