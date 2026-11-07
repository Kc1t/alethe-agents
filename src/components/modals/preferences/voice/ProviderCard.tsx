import type { LucideIcon } from 'lucide-react'
import { ChevronRight } from 'lucide-react'
import { useId } from 'react'

import { useT } from '../../../../lib/i18n'
import styles from './ProviderCard.module.css'

export type ProviderStatus = 'connected' | 'disconnected' | 'invalid'

const STATUS_KEY = {
  connected: 'prefs.voiceStatusConnected',
  disconnected: 'prefs.voiceStatusDisconnected',
  invalid: 'prefs.voiceStatusInvalid',
} as const

export function ProviderCard({
  icon: Icon,
  title,
  description,
  status,
  actionLabel,
  onAction,
}: {
  icon: LucideIcon
  title: string
  description: string
  status: ProviderStatus
  actionLabel: string
  onAction: () => void
}) {
  const t = useT()
  const titleId = useId()
  return (
    <article className={styles.card} aria-labelledby={titleId}>
      <div className={styles.top}>
        <span className={styles.icon} aria-hidden="true">
          <Icon size={18} />
        </span>
        <span className={styles.badge} data-status={status}>
          <span className={styles.dot} aria-hidden="true" />
          {t(STATUS_KEY[status])}
        </span>
      </div>
      <h3 id={titleId} className={styles.title}>
        {title}
      </h3>
      <p className={styles.description}>{description}</p>
      <button
        type="button"
        className={styles.action}
        aria-label={`${actionLabel} ${title}`}
        onClick={onAction}
      >
        <span>{actionLabel}</span>
        <ChevronRight size={14} aria-hidden="true" />
      </button>
    </article>
  )
}
