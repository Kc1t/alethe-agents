import { useProviderModels } from '../../../hooks/useProviderModels'
import {
  effortLevelsForModel,
  isValidModelName,
  normalizeAgentDefaultsPreferences,
  resolveLaunchDefaults,
} from '../../../lib/agentLaunchDefaults'
import { agentLabel } from '../../../lib/agentProviders'
import { type MessageKey, useT } from '../../../lib/i18n'
import type {
  AgentDefaultsPreferences,
  AgentEffortLevel,
  AgentLaunchDefaults,
  AgentType,
} from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useUiStore } from '../../../stores/uiStore'
import { AgentIcon } from '../../icons/AgentIcons'
import { Dropdown } from '../../ui/Dropdown'
import { ModelSearchablePicker } from '../ModelSearchablePicker'
import styles from '../PreferencesModal.module.css'
import rowStyles from './AgentLaunchDefaultsList.module.css'

type Scope = keyof AgentDefaultsPreferences

const EFFORT_LABEL_KEYS: Record<AgentEffortLevel, MessageKey> = {
  none: 'prefs.agentDefaultsEffortNone',
  minimal: 'prefs.agentDefaultsEffortMinimal',
  low: 'prefs.agentDefaultsEffortLow',
  medium: 'prefs.agentDefaultsEffortMedium',
  high: 'prefs.agentDefaultsEffortHigh',
  xhigh: 'prefs.agentDefaultsEffortXhigh',
  max: 'prefs.agentDefaultsEffortMax',
  ultra: 'prefs.agentDefaultsEffortUltra',
}

/**
 * One row per agent with its model and effort for `scope`. On a role scope an empty field falls
 * back to the provider default, and the row says which value that is.
 */
export function AgentLaunchDefaultsList({
  scope,
  agents,
}: {
  scope: Scope
  agents: readonly AgentType[]
}) {
  return (
    <div className={styles.agentList}>
      {agents.map((agent) => (
        <AgentLaunchDefaultsRow key={agent} scope={scope} agent={agent} />
      ))}
    </div>
  )
}

function AgentLaunchDefaultsRow({ scope, agent }: { scope: Scope; agent: AgentType }) {
  const t = useT()
  const agentDefaults = useProjectsStore((state) => state.preferences.agentDefaults)
  const theme = useProjectsStore(
    (state) => state.preferences.terminalTheme ?? state.preferences.uiTheme,
  )
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const pushToast = useUiStore((state) => state.pushToast)
  const { models, all, loading } = useProviderModels(agent)

  const current: AgentLaunchDefaults = agentDefaults?.[scope]?.[agent] ?? {}
  // The effort choices follow the model this row ends up launching, inherited or not: what one
  // model takes, another may not.
  const effective = resolveLaunchDefaults(
    agentDefaults,
    agent,
    scope === 'providers' ? undefined : scope,
  )
  const levels = effortLevelsForModel(agent, effective.model, all, current.effort)
  const label = agentLabel(agent)

  // What a row ends up launching with, or nothing when it is all left to the CLI.
  const describe = (defaults: AgentLaunchDefaults) =>
    [defaults.model, defaults.effort && t(EFFORT_LABEL_KEYS[defaults.effort])]
      .filter(Boolean)
      .join(' · ')
  const hasOwnValue = Boolean(current.model || current.effort)
  const own = describe(effective)
  const inherited = describe(resolveLaunchDefaults(agentDefaults, agent))
  // A role with nothing of its own says where its values come from; with nothing set anywhere,
  // every row says the same plain thing.
  const summary =
    scope === 'providers' || hasOwnValue
      ? own || t('prefs.agentDefaultsCliDefault')
      : inherited
        ? t('prefs.agentDefaultsInherited', { value: inherited })
        : t('prefs.agentDefaultsCliDefault')

  const update = (next: AgentLaunchDefaults) => {
    const base = normalizeAgentDefaultsPreferences(agentDefaults)
    const scoped = { ...base[scope] }
    const cleaned: AgentLaunchDefaults = {}
    if (next.model) cleaned.model = next.model
    if (next.effort) cleaned.effort = next.effort
    if (cleaned.model || cleaned.effort) scoped[agent] = cleaned
    else delete scoped[agent]
    setPreferences({ agentDefaults: { ...base, [scope]: scoped } })
  }

  const onModelChange = (value: string) => {
    const model = value.trim()
    if (model && !isValidModelName(model)) {
      pushToast({
        title: t('prefs.agentDefaultsInvalidModel'),
        body: t('prefs.agentDefaultsInvalidModelBody', { model }),
      })
      return
    }
    update({ ...current, model: model || undefined })
  }

  // The empty choice is named for what it is; the line under the agent's name says what it
  // resolves to.
  const effortOptions = [
    { value: '', label: t('prefs.agentDefaultsEffortDefault') },
    ...levels.map((level) => ({ value: level, label: t(EFFORT_LABEL_KEYS[level]) })),
  ]

  return (
    <div className={rowStyles.row}>
      <span className={styles.agentIcon}>
        <AgentIcon type={agent} size={20} theme={theme} />
      </span>
      <span className={styles.agentCopy}>
        <strong>{label}</strong>
        <span title={summary}>{summary}</span>
      </span>
      <div className={rowStyles.controls}>
        <ModelSearchablePicker
          value={current.model ?? ''}
          onChange={onModelChange}
          options={models}
          loading={loading}
          providerName={label}
          placeholder={t('prefs.agentDefaultsModelDefault')}
        />
        {levels.length > 0 ? (
          <Dropdown
            value={current.effort ?? ''}
            options={effortOptions}
            onChange={(value) =>
              update({ ...current, effort: (value || undefined) as AgentEffortLevel | undefined })
            }
            ariaLabel={t('prefs.agentDefaultsEffortLabel', { agent: label })}
            placeholder={t('prefs.agentDefaultsEffortDefault')}
          />
        ) : (
          // An agent with no effort levels keeps the column, so the model fields line up.
          <span aria-hidden />
        )}
        <button
          type="button"
          className={rowStyles.reset}
          disabled={!hasOwnValue}
          onClick={() => update({})}
        >
          {t('prefs.agentDefaultsReset')}
        </button>
      </div>
    </div>
  )
}
