import { Download } from 'lucide-react'
import { useState } from 'react'

import { useAgentOperationBusy } from '../../hooks/useAgentInstall'
import { useT } from '../../lib/i18n'
import type { AgentType } from '../../lib/types'
import { AgentInstallModal } from './AgentInstallModal'
import styles from './agentActions.module.css'

type Props = {
  agent: AgentType
  label: string
  onInstalled?: () => void
  nested?: boolean
}

export function AgentInstallButton({ agent, label, onInstalled, nested }: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const busyAgent = useAgentOperationBusy()

  return (
    <>
      <button
        type="button"
        className={styles.installBtn}
        disabled={busyAgent !== null && busyAgent !== agent}
        onClick={() => setOpen(true)}
      >
        <Download size={13} /> {t('agentInstall.install')}
      </button>
      <AgentInstallModal
        agent={agent}
        label={label}
        open={open}
        onClose={() => setOpen(false)}
        onInstalled={onInstalled}
        nested={nested}
      />
    </>
  )
}
