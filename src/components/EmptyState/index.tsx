import type { ReactNode } from 'react'

import styles from './EmptyState.module.css'

type Action = {
  label: string
  onClick: () => void
  disabled?: boolean
}

type EmptyStateProps = {
  icon: ReactNode
  title: ReactNode
  description?: ReactNode
  primaryAction?: Action
  secondaryAction?: Action
  compact?: boolean
  tone?: 'default' | 'positive'
  className?: string
}

export function EmptyState({
  icon,
  title,
  description,
  primaryAction,
  secondaryAction,
  compact = false,
  tone = 'default',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={[
        styles.root,
        compact ? styles.compact : '',
        tone === 'positive' ? styles.positive : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={styles.iconWrap} aria-hidden>
        {icon}
      </div>
      <div className={styles.copy}>
        <div className={styles.title}>{title}</div>
        {description ? <div className={styles.description}>{description}</div> : null}
      </div>
      {primaryAction || secondaryAction ? (
        <div className={styles.actions}>
          {secondaryAction ? (
            <button
              type="button"
              className={styles.secondary}
              onClick={secondaryAction.onClick}
              disabled={secondaryAction.disabled}
            >
              {secondaryAction.label}
            </button>
          ) : null}
          {primaryAction ? (
            <button
              type="button"
              className={styles.primary}
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled}
            >
              {primaryAction.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
