import { ChevronDown, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { type FeatureDefinition,FEATURES } from '../../../lib/features'
import { type TFunction,useT } from '../../../lib/i18n'
import type { FeatureId } from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { FEATURE_ICONS } from '../../icons/featureIcons'
import styles from './FeaturesStep.module.css'

type GroupId = 'workspace' | 'agents' | 'others'

const GROUP_OF: Record<FeatureId, GroupId> = {
  todos: 'workspace',
  browser: 'workspace',
  mcp: 'agents',
  playwright: 'agents',
  orchestrator: 'agents',
  graphify: 'others',
  aiMemory: 'others',
}

const GROUPS: GroupId[] = ['workspace', 'agents', 'others']

const GROUP_LABEL: Record<
  GroupId,
  | 'onboarding.featuresGroupWorkspace'
  | 'onboarding.featuresGroupAgents'
  | 'onboarding.featuresGroupOthers'
> = {
  workspace: 'onboarding.featuresGroupWorkspace',
  agents: 'onboarding.featuresGroupAgents',
  others: 'onboarding.featuresGroupOthers',
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function matches(feature: FeatureDefinition, needle: string, t: TFunction): boolean {
  if (!needle) return true
  const haystack = normalize(
    [t(feature.titleKey), t(feature.descriptionKey), t(feature.keywordsKey), feature.id].join(' '),
  )
  return haystack.includes(needle)
}

export function FeaturesStep() {
  const t = useT()
  const enabledFeatures = useProjectsStore((s) => s.preferences.enabledFeatures)
  const playwrightBrowserMode = useProjectsStore((s) => s.preferences.playwrightBrowserMode)
  const setPreferences = useProjectsStore((s) => s.setPreferences)

  const [term, setTerm] = useState('')
  const [expanded, setExpanded] = useState(false)

  const needle = normalize(term.trim())
  const searching = needle.length > 0

  const visible = useMemo(
    () => FEATURES.filter((feature) => matches(feature, needle, t)),
    [needle, t],
  )
  const secondaryCount = FEATURES.filter((feature) => feature.secondary).length

  const toggle = (feature: FeatureDefinition) => {
    const active = enabledFeatures[feature.id]
    setPreferences({
      enabledFeatures: { ...enabledFeatures, [feature.id]: !active },
      ...(feature.id === 'todos' && !active ? { rightSidebarVisible: true } : {}),
    })
  }

  return (
    <div className={styles.step}>
      <div className={styles.search}>
        <Search size={14} />
        <input
          data-autofocus
          data-no-submit
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t('onboarding.featuresSearch')}
          aria-label={t('onboarding.featuresSearch')}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault()
          }}
        />
        {term ? (
          <button
            type="button"
            className={styles.clear}
            aria-label={t('onboarding.featuresClearSearch')}
            onClick={() => setTerm('')}
          >
            <X size={12} />
          </button>
        ) : null}
      </div>

      {GROUPS.map((group) => {
        if (group === 'others' && !searching && !expanded) return null
        const rows = visible.filter((feature) => GROUP_OF[feature.id] === group)
        if (rows.length === 0) return null
        return (
          <section key={group} className={styles.group}>
            <h3 className={styles.groupTitle}>{t(GROUP_LABEL[group])}</h3>
            {rows.map((feature, index) => {
              const active = enabledFeatures[feature.id]
              const Icon = FEATURE_ICONS[feature.id]
              return (
                <div key={feature.id}>
                  <button
                    type="button"
                    className={styles.row}
                    data-first={index === 0 ? '' : undefined}
                    data-on={active ? '' : undefined}
                    aria-pressed={active}
                    onClick={() => toggle(feature)}
                  >
                    <span className={styles.icon}>
                      <Icon size={15} />
                    </span>
                    <span className={styles.rowCopy}>
                      <span className={styles.rowTitle}>
                        {t(feature.titleKey)}
                        {feature.id === 'orchestrator' ? (
                          <span className={styles.tagExperimental}>
                            {t('onboarding.featuresExperimental')}
                          </span>
                        ) : null}
                      </span>
                      <span className={styles.rowDesc}>{t(feature.descriptionKey)}</span>
                    </span>
                    <span className={styles.track} aria-hidden>
                      <b />
                    </span>
                  </button>

                  {feature.id === 'playwright' && active ? (
                    <div className={styles.subRow}>
                      <span className={styles.rowCopy}>
                        <span className={styles.subTitle}>
                          {t('features.playwright.browserMode.label')}
                        </span>
                        <span className={styles.subDesc}>
                          {t(`features.playwright.browserMode.${playwrightBrowserMode}Hint`)}
                        </span>
                      </span>
                      <span className={styles.segmented}>
                        {(['shared', 'dedicated'] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            data-on={playwrightBrowserMode === mode ? '' : undefined}
                            onClick={() => setPreferences({ playwrightBrowserMode: mode })}
                          >
                            {t(`features.playwright.browserMode.${mode}`)}
                          </button>
                        ))}
                      </span>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </section>
        )
      })}

      {visible.length === 0 ? (
        <div className={styles.empty}>{t('onboarding.featuresNoMatch')}</div>
      ) : null}

      {!searching && !expanded ? (
        <button type="button" className={styles.more} onClick={() => setExpanded(true)}>
          <span>{t('onboarding.featuresShowMore', { count: secondaryCount })}</span>
          <ChevronDown size={13} />
        </button>
      ) : null}
    </div>
  )
}
