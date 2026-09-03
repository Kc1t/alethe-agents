import { Fragment } from 'react'

import { FEATURES } from '../../../lib/features'
import { useT } from '../../../lib/i18n'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useUiStore } from '../../../stores/uiStore'
import { FEATURE_ICONS } from '../../icons/featureIcons'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'

export function FeaturesPage() {
  const t = useT()
  const preferences = useProjectsStore((state) => state.preferences)
  const setPreferences = useProjectsStore((state) => state.setPreferences)

  return (
    <div id="optional-features">
      <div className={styles.featureList}>
        {FEATURES.map((feature) => {
          const enabled = preferences.enabledFeatures[feature.id]
          const FeatureIcon = FEATURE_ICONS[feature.id]
          return (
            <Fragment key={feature.id}>
              <button
                type="button"
                className={enabled ? styles.featureEnabled : undefined}
                onClick={() =>
                  setPreferences({
                    enabledFeatures: {
                      ...preferences.enabledFeatures,
                      [feature.id]: !enabled,
                    },
                    ...(feature.id === 'todos' && !enabled ? { rightSidebarVisible: true } : {}),
                  })
                }
                aria-pressed={enabled}
              >
                <span className={styles.featureIcon}>
                  <FeatureIcon size={17} />
                </span>
                <span className={styles.featureCopy}>
                  <strong>{t(feature.titleKey)}</strong>
                  <span>{t(feature.descriptionKey)}</span>
                </span>
                <span className={styles.featureStatus}>
                  {enabled ? t('prefs.featureEnabled') : t('prefs.featureDisabled')}
                </span>
                <span className={styles.featureSwitch} aria-hidden>
                  <span />
                </span>
              </button>
              {feature.id === 'playwright' && enabled ? (
                <div className={styles.featureSubPanel}>
                  <div className={controls.field}>
                    <label className={controls.label}>
                      {t('features.playwright.browserMode.label')}
                    </label>
                    <div className={controls.pillRow}>
                      {(['shared', 'dedicated'] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={`${controls.pill} ${
                            preferences.playwrightBrowserMode === mode ? controls.pillActive : ''
                          }`}
                          onClick={() => setPreferences({ playwrightBrowserMode: mode })}
                        >
                          {t(`features.playwright.browserMode.${mode}`)}
                        </button>
                      ))}
                    </div>
                    <span className={controls.hint}>
                      {t(
                        `features.playwright.browserMode.${preferences.playwrightBrowserMode}Hint`,
                      )}
                    </span>
                  </div>
                  {preferences.playwrightBrowserMode === 'dedicated' ? (
                    <label className={controls.checkboxRow}>
                      <input
                        type="checkbox"
                        checked={preferences.playwrightDedicatedHeadless}
                        onChange={(event) =>
                          setPreferences({ playwrightDedicatedHeadless: event.target.checked })
                        }
                      />
                      <span className={controls.checkboxLabel}>
                        {t('features.playwright.headless.label')}
                      </span>
                    </label>
                  ) : null}
                </div>
              ) : null}
            </Fragment>
          )
        })}
      </div>
      {preferences.enabledFeatures.mcp ? (
        <button
          type="button"
          className={controls.btnLink}
          onClick={() => useUiStore.getState().openModal_('mcpIntro')}
        >
          {t('mcp.runSetup')}
        </button>
      ) : null}
    </div>
  )
}
