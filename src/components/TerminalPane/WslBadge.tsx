import { useT } from '../../lib/i18n'
import { wslTargetFor } from '../../lib/wsl'
import { useProjectsStore } from '../../stores/projectsStore'
import styles from './WslBadge.module.css'

type WslBadgeProps = {
  cwd: string
}

export function WslBadge({ cwd }: WslBadgeProps) {
  const t = useT()
  const wslEnabled = useProjectsStore((s) => s.preferences.enabledFeatures.wsl)
  const target = wslTargetFor(cwd, wslEnabled)
  if (!target) return null

  const label = t('term.wslBadgeLabel', { distro: target.distro })

  return (
    <span className={styles.badge} title={label} aria-label={label}>
      {target.distro}
    </span>
  )
}
