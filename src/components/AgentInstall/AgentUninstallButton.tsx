import { Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useAgentInstall, useAgentOperationBusy } from '../../hooks/useAgentInstall'
import {
  type InstallToolchain,
  stripInstallLogAnsi,
  uninstallMethodsFor,
} from '../../lib/agentInstall'
import { useT } from '../../lib/i18n'
import { probeInstallToolchain } from '../../lib/tauri'
import type { AgentType } from '../../lib/types'
import controls from '../modals/controls.module.css'
import { Modal } from '../modals/Modal'
import styles from './agentActions.module.css'

type Props = {
  agent: AgentType
  label: string
  onUninstalled?: () => void
  nested?: boolean
}

export function AgentUninstallButton({ agent, label, onUninstalled, nested }: Props) {
  const t = useT()
  const [toolchain, setToolchain] = useState<InstallToolchain | null>(null)
  const [open, setOpen] = useState(false)
  const { status, log, install, reset } = useAgentInstall(agent)
  const busyAgent = useAgentOperationBusy()
  const notifiedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void probeInstallToolchain()
      .then((result) => {
        if (!cancelled) setToolchain(result)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (status !== 'success' || notifiedRef.current) return
    notifiedRef.current = true
    setOpen(false)
    onUninstalled?.()
  }, [status, onUninstalled])

  const method = uninstallMethodsFor(agent, toolchain)[0]
  if (!method) return null

  const running = status === 'running'
  const blocked = busyAgent !== null && busyAgent !== agent
  const cleanLog = stripInstallLogAnsi(log)

  return (
    <>
      <button
        type="button"
        className={styles.dangerBtn}
        disabled={running || blocked}
        onClick={() => {
          reset()
          notifiedRef.current = false
          setOpen(true)
        }}
      >
        <Trash2 size={13} /> {t('agentInstall.uninstall')}
      </button>

      <Modal
        open={open}
        onClose={() => {
          if (running) return
          setOpen(false)
        }}
        title={t('agentInstall.uninstallTitle', { agent: label })}
        nested={nested}
        footer={
          <>
            <button
              type="button"
              className={controls.btn}
              disabled={running}
              onClick={() => setOpen(false)}
            >
              {t('agentInstall.cancel')}
            </button>
            <button
              type="button"
              className={`${controls.btn} ${controls.btnDanger}`}
              disabled={running}
              onClick={() => void install(method)}
            >
              {running ? t('agentInstall.uninstalling') : t('agentInstall.uninstallConfirmAction')}
            </button>
          </>
        }
      >
        <p className={styles.modalText}>{t('agentInstall.uninstallConfirm', { agent: label })}</p>
        <div className={styles.command}>{method.command}</div>
        {status === 'failed' ? (
          <p className={`${styles.modalText} ${styles.statusFailed}`}>
            {t('agentInstall.uninstallFailed')}
          </p>
        ) : null}
        {cleanLog.trim() ? <pre className={styles.log}>{cleanLog}</pre> : null}
      </Modal>
    </>
  )
}
