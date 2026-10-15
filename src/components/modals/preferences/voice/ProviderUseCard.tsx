import type { LucideIcon } from 'lucide-react'
import { type ReactNode, useId } from 'react'

import { useT } from '../../../../lib/i18n'
import type { ProviderStatus } from './ProviderCard'
import styles from './ProviderUseCard.module.css'

export type ProviderUseStatus = 'inUse' | ProviderStatus

const STATUS_KEY = {
  inUse: 'prefs.voiceStatusInUse',
  connected: 'prefs.voiceStatusConnected',
  disconnected: 'prefs.voiceStatusDisconnected',
  invalid: 'prefs.voiceStatusInvalid',
} as const

/**
 * A provider as a choice for one voice use. Same anatomy as `ProviderCard`; the title is a radio
 * button stretched over the card, so the whole card selects it while the footer controls stay
 * independent.
 */
export function ProviderUseCard({
  icon: Icon,
  title,
  description,
  status,
  selected,
  onSelect,
  disabled = false,
  footer,
  note,
}: {
  icon: LucideIcon
  title: string
  description: string
  status: ProviderUseStatus
  selected: boolean
  onSelect: () => void
  disabled?: boolean
  footer?: ReactNode
  /** Muted line under the footer, e.g. where a cloud provider sends data. */
  note?: string
}) {
  const t = useT()
  const titleId = useId()
  // An invalid key keeps its warning even on the card in use; the selection still shows in the border.
  const badge: ProviderUseStatus = selected && status !== 'invalid' ? 'inUse' : status
  return (
    <article
      className={styles.card}
      aria-labelledby={titleId}
      data-selected={selected ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
    >
      <div className={styles.top}>
        <span className={styles.icon} aria-hidden="true">
          <Icon size={18} />
        </span>
        <span className={styles.badge} data-status={badge}>
          <span className={styles.dot} aria-hidden="true" />
          {t(STATUS_KEY[badge])}
        </span>
      </div>
      <h3 id={titleId} className={styles.title}>
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          disabled={disabled}
          className={styles.select}
          onClick={onSelect}
        >
          {title}
        </button>
      </h3>
      <p className={styles.description}>{description}</p>
      {footer || note ? (
        <div className={styles.footer}>
          {footer}
          {note ? <p className={styles.note}>{note}</p> : null}
        </div>
      ) : null}
    </article>
  )
}
