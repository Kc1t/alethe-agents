import {
  Bot,
  BrainCircuit,
  GitBranch,
  Globe2,
  ListTodo,
  Network,
  Plug,
  Workflow,
} from 'lucide-react'

import { FEATURES } from '../../../lib/features'
import { useT } from '../../../lib/i18n'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useUiStore } from '../../../stores/uiStore'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'

const FEATURE_ICONS = {
  todos: ListTodo,
  git: GitBranch,
  aiMemory: BrainCircuit,
  browser: Globe2,
  graphify: Network,
  mcp: Plug,
  playwright: Bot,
  orchestrator: Workflow,
} as const

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
            <button
              key={feature.id}
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
