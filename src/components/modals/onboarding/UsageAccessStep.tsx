import { useT } from '../../../lib/i18n'
import { USAGE_PROVIDERS } from '../../../lib/usageProviders'
import { useProjectsStore } from '../../../stores/projectsStore'
import { UsageProviderIcon } from '../../icons/UsageProviderIcon'
import styles from './FeaturesStep.module.css'

/**
 * One switch per provider for reading its usage. Shared by onboarding and Preferences, the same
 * way the features list is.
 */
export function UsageAccessStep() {
  const t = useT()
  const usageAccess = useProjectsStore((s) => s.preferences.usageAccess)
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)
  const setPreferences = useProjectsStore((s) => s.setPreferences)

  return (
    <div className={styles.step}>
      {USAGE_PROVIDERS.map((provider, index) => {
        const on = usageAccess[provider.id]
        const label = provider.label
        return (
          <button
            key={provider.id}
            type="button"
            className={styles.row}
            data-first={index === 0 ? '' : undefined}
            data-on={on ? '' : undefined}
            aria-pressed={on}
            onClick={() => setPreferences({ usageAccess: { ...usageAccess, [provider.id]: !on } })}
          >
            <span className={styles.icon}>
              <UsageProviderIcon provider={provider} size={15} theme={uiTheme} />
            </span>
            <span className={styles.rowCopy}>
              <span className={styles.rowTitle}>{label}</span>
              <span className={styles.rowDesc}>
                {t(
                  provider.credential === 'key'
                    ? 'usageAccess.providerKeyHint'
                    : 'usageAccess.providerHint',
                  { provider: label, vendor: provider.vendor },
                )}
              </span>
            </span>
            <span className={styles.track} aria-hidden>
              <b />
            </span>
          </button>
        )
      })}
    </div>
  )
}
