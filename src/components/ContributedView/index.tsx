import { CircleAlert } from 'lucide-react'
import { useEffect } from 'react'

import { useT } from '../../lib/i18n'
import {
  activateForView,
  usePlugins,
  type SidebarTabContribution,
  type SidebarTabProps,
} from '../../lib/plugins'
import styles from './ContributedView.module.css'

export type ContributedViewProps = SidebarTabProps & {
  view: SidebarTabContribution
}

/**
 * Renders a manifest-declared view. The tab exists before its plugin does, so
 * revealing it is what triggers activation.
 */
export function ContributedView({ view, ...props }: ContributedViewProps) {
  const t = useT()
  const owner = usePlugins().find((plugin) => plugin.manifest.id === view.pluginId)

  useEffect(() => {
    void activateForView(view.id)
  }, [view.id])

  const Component = view.component
  if (Component) return <Component {...props} />

  // A view whose plugin failed must say so; an endless placeholder reads as a
  // hang and hides the reason.
  if (owner?.error) {
    return (
      <div className={styles.failed} role="alert">
        <CircleAlert size={16} />
        <p>{t('ws.viewFailed', { name: owner.manifest.name })}</p>
        <code className={styles.reason}>{owner.error}</code>
      </div>
    )
  }

  return <div className={styles.loading} aria-busy="true" />
}
