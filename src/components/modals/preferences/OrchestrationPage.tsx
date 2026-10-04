import { Minus, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { agentLabel } from '../../../lib/agentProviders'
import { useT } from '../../../lib/i18n'
import {
  canFallBackToName,
  CLAUDE_EFFORTS,
  CODEX_EFFORTS,
  isOrchestrationName,
  MAX_CONCURRENT_LIMITS,
  MAX_TIMEOUT_SECONDS,
  pluginIds,
} from '../../../lib/orchestrationSettings'
import { type CodexModelOption, orchestratorCodexModels } from '../../../lib/tauri/orchestrator'
import type { OrchestrationRole, OrchestrationSettings } from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { Dropdown } from '../../ui/Dropdown'
import controls from '../controls.module.css'
import styles from './OrchestrationPage.module.css'
import { SettingsSection } from './primitives'
import { RoutingSection } from './RoutingSection'

const AGENTS: OrchestrationRole['agent'][] = ['codex', 'claude']
const ORCHESTRATORS: NonNullable<OrchestrationRole['orchestrator']>[] = ['claude', 'codex']

function nextRoleName(roles: OrchestrationRole[]): string {
  const taken = new Set(roles.map((role) => role.name))
  let n = 1
  while (taken.has(`role-${n}`)) n += 1
  return `role-${n}`
}

/** A whole number of seconds from an input, or null when it is left empty. */
function secondsFrom(raw: string): number | null | undefined {
  if (raw.trim() === '') return null
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 && value <= MAX_TIMEOUT_SECONDS ? value : undefined
}

export function OrchestrationPage() {
  const t = useT()
  const settings = useProjectsStore((state) => state.preferences.orchestration)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const [models, setModels] = useState<CodexModelOption[] | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  // A name being typed that cannot be saved yet, tied to the saved name of its row.
  const [nameDraft, setNameDraft] = useState<{ index: number; base: string; text: string } | null>(
    null,
  )
  // The plugin list as typed, so a trailing comma or line survives until the field loses focus.
  const [pluginsDraft, setPluginsDraft] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    orchestratorCodexModels()
      .then((list) => live && setModels(list))
      .catch((error: unknown) => live && setModelsError(String(error)))
    return () => {
      live = false
    }
  }, [])

  // A fallback that no longer names a role this one may run as is dropped as the roles change.
  const withValidFallbacks = (roles: OrchestrationRole[]) =>
    roles.map((role) =>
      role.fallback && !canFallBackToName(role, role.fallback, roles)
        ? { ...role, fallback: null }
        : role,
    )
  const save = (patch: Partial<OrchestrationSettings>) =>
    setPreferences({
      orchestration: {
        ...settings,
        ...patch,
        ...(patch.roles ? { roles: withValidFallbacks(patch.roles) } : {}),
      },
    })
  const saveRole = (index: number, patch: Partial<OrchestrationRole>) =>
    save({ roles: settings.roles.map((role, i) => (i === index ? { ...role, ...patch } : role)) })

  const effortsOf = (model: string | null): string[] => {
    const listed = models ?? []
    // Codex has not answered, or could not: its common efforts, instead of none at all.
    if (listed.length === 0) return [...CODEX_EFFORTS]
    const match = listed.find((option) => option.model === model)
    if (match) return match.efforts
    // The CLI's default model, or one Codex did not list: offer every effort Codex knows.
    return [...new Set(listed.flatMap((option) => option.efforts))]
  }

  // A rename is saved only once the orchestrator accepts the name and no other row for the same
  // orchestrator has it, so it can never hand one role's name, and what that role allows, to another.
  const renameRole = (index: number, role: OrchestrationRole, text: string) => {
    const next = text.trim()
    const taken = settings.roles.some(
      (other, i) => i !== index && other.name === next && other.orchestrator === role.orchestrator,
    )
    if (isOrchestrationName(next) && !taken) {
      setNameDraft(null)
      // Roles that fall back to this one follow it to its new name, unless another row keeps the
      // old one.
      const follow = !settings.roles.some((other, i) => i !== index && other.name === role.name)
      save({
        roles: settings.roles.map((other, i) =>
          i === index
            ? { ...other, name: next }
            : follow && other.fallback === role.name
              ? { ...other, fallback: next }
              : other,
        ),
      })
    } else {
      setNameDraft({ index, base: role.name, text: next })
    }
  }

  const setAgent = (index: number, agent: OrchestrationRole['agent']) =>
    // A model and its efforts belong to one CLI, and Claude has no read-only launch.
    saveRole(index, { agent, model: null, effort: null, readOnly: false })

  const setModel = (index: number, role: OrchestrationRole, value: string) => {
    if (value !== '' && !isOrchestrationName(value)) return
    const model = value || null
    const efforts: readonly string[] = role.agent === 'codex' ? effortsOf(model) : CLAUDE_EFFORTS
    const effort = role.effort && efforts.includes(role.effort) ? role.effort : null
    saveRole(index, { model, effort })
  }

  const modelOptions = (role: OrchestrationRole) => {
    const listed =
      role.agent === 'codex'
        ? (models ?? []).map((option) => ({ value: option.model, label: option.name }))
        : []
    const current =
      role.model && !listed.some((option) => option.value === role.model)
        ? [{ value: role.model, label: role.model }]
        : []
    return [{ value: '', label: t('prefs.orchestrationCliDefault') }, ...listed, ...current]
  }

  const concurrency = settings.maxConcurrent

  return (
    <>
      <SettingsSection
        id="orchestration-limits"
        title={t('prefs.orchestrationLimits')}
        description={t('prefs.orchestrationLimitsDesc')}
      >
        <div className={styles.limits}>
          <label className={controls.field}>
            <span className={controls.label}>{t('prefs.orchestrationConcurrency')}</span>
            <div className={styles.stepper}>
              <button
                type="button"
                className={controls.iconBtn}
                onClick={() => save({ maxConcurrent: concurrency - 1 })}
                disabled={concurrency <= MAX_CONCURRENT_LIMITS.min}
                aria-label={t('prefs.orchestrationConcurrencyDecrease')}
              >
                <Minus size={15} />
              </button>
              <strong className={controls.stepperValue}>{concurrency}</strong>
              <button
                type="button"
                className={controls.iconBtn}
                onClick={() => save({ maxConcurrent: concurrency + 1 })}
                disabled={concurrency >= MAX_CONCURRENT_LIMITS.max}
                aria-label={t('prefs.orchestrationConcurrencyIncrease')}
              >
                <Plus size={15} />
              </button>
            </div>
          </label>
          <label className={controls.field}>
            <span className={controls.label}>{t('prefs.orchestrationDefaultTimeout')}</span>
            <input
              className={controls.input}
              type="number"
              min={0}
              max={MAX_TIMEOUT_SECONDS}
              step={1}
              value={settings.defaultTimeoutSeconds}
              onChange={(event) => {
                const seconds = secondsFrom(event.target.value)
                if (typeof seconds === 'number') save({ defaultTimeoutSeconds: seconds })
              }}
            />
            <span className={controls.hint}>{t('prefs.orchestrationTimeoutHint')}</span>
          </label>
          <label className={`${controls.field} ${styles.pluginList}`}>
            <span className={controls.label}>{t('prefs.orchestrationWorkerPlugins')}</span>
            <textarea
              className={controls.input}
              aria-label={t('prefs.orchestrationWorkerPlugins')}
              rows={3}
              spellCheck={false}
              value={pluginsDraft ?? settings.workerDisabledPlugins.join('\n')}
              onChange={(event) => {
                setPluginsDraft(event.target.value)
                save({ workerDisabledPlugins: pluginIds(event.target.value.split(/[\s,]+/)) })
              }}
              onBlur={() => setPluginsDraft(null)}
            />
            <span className={controls.hint}>{t('prefs.orchestrationWorkerPluginsHint')}</span>
          </label>
        </div>
      </SettingsSection>

      <SettingsSection
        id="orchestration-roles"
        title={t('prefs.orchestrationRoles')}
        description={t('prefs.orchestrationRolesDesc')}
      >
        {modelsError ? (
          <p className={controls.hint}>
            {t('prefs.orchestrationModelsFailed', { error: modelsError })}
          </p>
        ) : models === null ? (
          <p className={controls.hint}>{t('prefs.orchestrationModelsLoading')}</p>
        ) : null}

        {settings.roles.length === 0 ? (
          <p className={controls.hint}>{t('prefs.orchestrationRolesEmpty')}</p>
        ) : (
          <div className={styles.roles}>
            <div className={styles.roleHeader} aria-hidden>
              <span>{t('prefs.orchestrationRoleName')}</span>
              <span>{t('prefs.orchestrationOrchestrator')}</span>
              <span>{t('prefs.orchestrationAgent')}</span>
              <span>{t('prefs.orchestrationModel')}</span>
              <span>{t('prefs.orchestrationEffort')}</span>
              <span>{t('prefs.orchestrationReadOnly')}</span>
              <span>{t('prefs.orchestrationBudget')}</span>
              <span>{t('prefs.orchestrationFallback')}</span>
              <span />
            </div>
            {settings.roles.map((role, index) => {
              const name = role.name || String(index + 1)
              // Rows for different orchestrators can share a name, so the label tells them apart.
              const label = role.orchestrator
                ? t('prefs.orchestrationRoleOnOrchestrator', {
                    name,
                    agent: agentLabel(role.orchestrator),
                  })
                : name
              const codex = role.agent === 'codex'
              const draft =
                nameDraft && nameDraft.index === index && nameDraft.base === role.name
                  ? nameDraft.text
                  : null
              const nameInvalid = draft !== null
              return (
                <div key={index} className={styles.role}>
                  <div className={styles.roleRow}>
                    <input
                      className={controls.input}
                      value={draft ?? role.name}
                      aria-label={t('prefs.orchestrationRoleNameFor', { name: label })}
                      aria-invalid={nameInvalid}
                      onChange={(event) => renameRole(index, role, event.target.value)}
                    />
                    <Dropdown
                      value={role.orchestrator ?? ''}
                      ariaLabel={t('prefs.orchestrationOrchestratorFor', { name: label })}
                      options={[
                        { value: '', label: t('prefs.orchestrationOrchestratorAny') },
                        ...ORCHESTRATORS.map((agent) => ({
                          value: agent,
                          label: agentLabel(agent),
                        })),
                      ].map((option) => ({
                        ...option,
                        // One row per name and orchestrator.
                        disabled: settings.roles.some(
                          (other, i) =>
                            i !== index &&
                            other.name === role.name &&
                            (other.orchestrator ?? '') === option.value,
                        ),
                      }))}
                      onChange={(value) =>
                        saveRole(index, {
                          orchestrator: (value || undefined) as OrchestrationRole['orchestrator'],
                        })
                      }
                    />
                    <Dropdown
                      value={role.agent}
                      ariaLabel={t('prefs.orchestrationAgentFor', { name: label })}
                      options={AGENTS.map((agent) => ({ value: agent, label: agentLabel(agent) }))}
                      onChange={(value) => {
                        if (value !== role.agent)
                          setAgent(index, value as OrchestrationRole['agent'])
                      }}
                    />
                    <Dropdown
                      value={role.model ?? ''}
                      ariaLabel={t('prefs.orchestrationModelFor', { name: label })}
                      options={modelOptions(role)}
                      searchable
                      allowCustomValue
                      customOptionLabel={(value) =>
                        t('prefs.orchestrationCustomModel', { value: value.trim() })
                      }
                      onChange={(value) => setModel(index, role, value.trim())}
                    />
                    <Dropdown
                      value={role.effort ?? ''}
                      ariaLabel={t('prefs.orchestrationEffortFor', { name: label })}
                      options={[
                        { value: '', label: t('prefs.orchestrationModelDefault') },
                        ...(codex ? effortsOf(role.model) : CLAUDE_EFFORTS).map((effort) => ({
                          value: effort,
                          label: effort,
                        })),
                      ]}
                      onChange={(value) => saveRole(index, { effort: value || null })}
                    />
                    <button
                      type="button"
                      role="switch"
                      className={styles.switch}
                      aria-checked={role.readOnly}
                      aria-label={t('prefs.orchestrationReadOnlyFor', { name: label })}
                      disabled={!codex}
                      title={codex ? undefined : t('prefs.orchestrationCodexOnly')}
                      onClick={() => saveRole(index, { readOnly: !role.readOnly })}
                    />
                    <input
                      className={controls.input}
                      type="number"
                      min={0}
                      max={MAX_TIMEOUT_SECONDS}
                      step={1}
                      placeholder={t('prefs.orchestrationBudgetDefault')}
                      value={role.timeoutSeconds ?? ''}
                      aria-label={t('prefs.orchestrationTimeoutFor', { name: label })}
                      onChange={(event) => {
                        const seconds = secondsFrom(event.target.value)
                        if (seconds !== undefined) saveRole(index, { timeoutSeconds: seconds })
                      }}
                    />
                    <Dropdown
                      value={role.fallback ?? ''}
                      ariaLabel={t('prefs.orchestrationFallbackFor', { name: label })}
                      options={[
                        { value: '', label: t('prefs.orchestrationFallbackNone') },
                        ...[...new Set(settings.roles.map((other) => other.name))]
                          .filter((other) => canFallBackToName(role, other, settings.roles))
                          .map((other) => ({ value: other, label: other })),
                      ]}
                      onChange={(value) => saveRole(index, { fallback: value || null })}
                    />
                    <button
                      type="button"
                      className={controls.iconBtnSm}
                      aria-label={t('prefs.orchestrationRemoveRole', { name: label })}
                      onClick={() => save({ roles: settings.roles.filter((_, i) => i !== index) })}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {nameInvalid ? (
                    <p className={styles.error}>{t('prefs.orchestrationRoleNameInvalid')}</p>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
        {settings.roles.length > 0 ? (
          <>
            <p className={controls.hint}>{t('prefs.orchestrationFallbackHint')}</p>
            <p className={controls.hint}>{t('prefs.orchestrationOrchestratorHint')}</p>
          </>
        ) : null}

        <button
          type="button"
          className={`${controls.btn} ${controls.btnSm}`}
          onClick={() =>
            save({
              roles: [
                ...settings.roles,
                {
                  name: nextRoleName(settings.roles),
                  agent: 'codex',
                  model: null,
                  effort: null,
                  readOnly: false,
                  timeoutSeconds: null,
                },
              ],
            })
          }
        >
          <Plus size={14} />
          {t('prefs.orchestrationAddRole')}
        </button>
      </SettingsSection>

      <RoutingSection />
    </>
  )
}
