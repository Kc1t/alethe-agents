import { Minus, Plus, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'

import { clampOrchestratorMaxWorkers } from '../../../lib/agentLaunchDefaults'
import { agentLabel } from '../../../lib/agentProviders'
import { type MessageKey, useT } from '../../../lib/i18n'
import {
  normalizeOrchestrationTabOrder,
  normalizeOrchestratorPolicy,
} from '../../../lib/orchestratorPolicy'
import { moveItem } from '../../../lib/reorder'
import {
  DEFAULT_ORCHESTRATOR_POLICY,
  type OrchestrationTabId,
  ORCHESTRATOR_DEFAULT_MAX_WORKERS,
  ORCHESTRATOR_MAX_KEPT_FINISHED,
  ORCHESTRATOR_MAX_WORKERS,
  ORCHESTRATOR_MIN_WORKERS,
  ORCHESTRATOR_PLANNER_AGENTS,
  ORCHESTRATOR_TIMEOUT_CHOICES,
  ORCHESTRATOR_WORKER_AGENTS,
  type OrchestratorPolicyPreferences,
} from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { Dropdown } from '../../ui/Dropdown'
import { SortableList } from '../../ui/SortableList'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'
import { AgentLaunchDefaultsList } from './AgentLaunchDefaultsList'
import page from './OrchestrationPage.module.css'
import { OrchestrationRoutingSettings } from './OrchestrationRoutingSettings'
import { SettingsSection } from './primitives'

const TAB_LABELS: Record<OrchestrationTabId, MessageKey> = {
  routing: 'prefs.orchestrationTab.routing',
  workers: 'prefs.orchestrationTab.workers',
  permissions: 'prefs.orchestrationTab.permissions',
  models: 'prefs.orchestrationTab.models',
}

/** The sub-tab each section lives on, so a search result or a shortcut can land on it. */
const TAB_OF_SECTION: Record<string, OrchestrationTabId> = {
  'orchestration-routing': 'routing',
  'orchestration-project-routing': 'routing',
  'orchestration-max-workers': 'workers',
  'orchestration-rules': 'permissions',
  'orchestration-planner': 'models',
  'orchestration-worker': 'models',
}

type StepperProps = {
  value: number
  min: number
  max: number
  fallback: number
  onChange: (value: number) => void
  labels: { decrease: MessageKey; increase: MessageKey; reset: MessageKey }
}

function Stepper({ value, min, max, fallback, onChange, labels }: StepperProps) {
  const t = useT()
  return (
    <div className={`${styles.zoomControl} ${page.stepper}`}>
      <button
        type="button"
        onClick={() => onChange(value - 1)}
        disabled={value <= min}
        aria-label={t(labels.decrease)}
      >
        <Minus size={15} />
      </button>
      <strong>{value}</strong>
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        disabled={value >= max}
        aria-label={t(labels.increase)}
      >
        <Plus size={15} />
      </button>
      <button
        type="button"
        onClick={() => onChange(fallback)}
        disabled={value === fallback}
        aria-label={t(labels.reset)}
      >
        <RotateCcw size={15} />
      </button>
    </div>
  )
}

type RuleRowProps = {
  title: string
  description: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}

function RuleRow({ title, description, value, options, onChange }: RuleRowProps) {
  return (
    <div className={styles.optionRow}>
      <span className={styles.optionCopy}>
        <strong>{title}</strong>
        <span>{description}</span>
      </span>
      <div className={styles.rowActions}>
        <Dropdown
          className={styles.select}
          value={value}
          options={options}
          onChange={onChange}
          ariaLabel={title}
        />
      </div>
    </div>
  )
}

/** The person's worker rules, read normalized and written back whole. */
function usePolicy() {
  const stored = useProjectsStore((state) => state.preferences.orchestratorPolicy)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const policy = normalizeOrchestratorPolicy(stored)
  const update = (patch: Partial<OrchestratorPolicyPreferences>) =>
    setPreferences({ orchestratorPolicy: normalizeOrchestratorPolicy({ ...policy, ...patch }) })
  return { policy, update }
}

/** How many workers run, for how long, and what stays around afterwards. */
function WorkerLimits() {
  const t = useT()
  const { policy, update } = usePolicy()
  const stored = useProjectsStore((state) => state.preferences.orchestratorMaxWorkers)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const maxWorkers = clampOrchestratorMaxWorkers(stored ?? ORCHESTRATOR_DEFAULT_MAX_WORKERS)
  const notify = useProjectsStore((state) => state.preferences.orchestratorNotify ?? true)

  const timeoutLabel = (minutes: number) => {
    if (minutes === 0) return t('prefs.orchestrationTimeoutNone')
    if (minutes >= 60 && minutes % 60 === 0) {
      return t('prefs.orchestrationTimeoutHours', { hours: minutes / 60 })
    }
    return t('prefs.orchestrationTimeoutMinutes', { minutes })
  }

  return (
    <div className={styles.optionList}>
      <div className={styles.optionRow}>
        <span className={styles.optionCopy}>
          <strong>{t('prefs.orchestrationMaxWorkers')}</strong>
          <span>{t('prefs.orchestrationMaxWorkersDesc')}</span>
        </span>
        <div className={styles.rowActions}>
          <Stepper
            value={maxWorkers}
            min={ORCHESTRATOR_MIN_WORKERS}
            max={ORCHESTRATOR_MAX_WORKERS}
            fallback={ORCHESTRATOR_DEFAULT_MAX_WORKERS}
            onChange={(value) =>
              setPreferences({ orchestratorMaxWorkers: clampOrchestratorMaxWorkers(value) })
            }
            labels={{
              decrease: 'prefs.orchestrationMaxWorkersDecrease',
              increase: 'prefs.orchestrationMaxWorkersIncrease',
              reset: 'prefs.orchestrationMaxWorkersReset',
            }}
          />
        </div>
      </div>
      <RuleRow
        title={t('prefs.orchestrationTimeout')}
        description={t('prefs.orchestrationTimeoutDesc')}
        value={String(policy.timeoutMinutes)}
        options={ORCHESTRATOR_TIMEOUT_CHOICES.map((minutes) => ({
          value: String(minutes),
          label: timeoutLabel(minutes),
        }))}
        onChange={(value) => update({ timeoutMinutes: Number(value) })}
      />
      <div className={styles.optionRow}>
        <span className={styles.optionCopy}>
          <strong>{t('prefs.orchestrationKeepFinished')}</strong>
          <span>{t('prefs.orchestrationKeepFinishedDesc')}</span>
        </span>
        <div className={styles.rowActions}>
          <Stepper
            value={policy.keepFinished}
            min={0}
            max={ORCHESTRATOR_MAX_KEPT_FINISHED}
            fallback={DEFAULT_ORCHESTRATOR_POLICY.keepFinished}
            onChange={(keepFinished) => update({ keepFinished })}
            labels={{
              decrease: 'prefs.orchestrationKeepFinishedDecrease',
              increase: 'prefs.orchestrationKeepFinishedIncrease',
              reset: 'prefs.orchestrationKeepFinishedReset',
            }}
          />
        </div>
      </div>
      <RuleRow
        title={t('prefs.orchestrationNotify')}
        description={t('prefs.orchestrationNotifyDesc')}
        value={notify ? 'on' : 'off'}
        options={[
          { value: 'on', label: t('prefs.orchestrationNotifyOn') },
          { value: 'off', label: t('prefs.orchestrationNotifyOff') },
        ]}
        onChange={(value) => setPreferences({ orchestratorNotify: value === 'on' })}
      />
      <RuleRow
        title={t('prefs.orchestrationDefaultAgent')}
        description={t('prefs.orchestrationDefaultAgentDesc')}
        value={policy.defaultAgent}
        options={[
          { value: 'auto', label: t('prefs.orchestrationDefaultAgentAuto') },
          ...ORCHESTRATOR_WORKER_AGENTS.map((agent) => ({
            value: agent,
            label: agentLabel(agent),
          })),
        ]}
        onChange={(value) =>
          update({ defaultAgent: value as OrchestratorPolicyPreferences['defaultAgent'] })
        }
      />
    </div>
  )
}

/** What workers may do on their own; a rule fixed here wins over what the planner asks for. */
function WorkerPermissions() {
  const t = useT()
  const { policy, update } = usePolicy()
  const planner = t('prefs.orchestrationRulePlanner')

  return (
    <div className={styles.optionList}>
      <RuleRow
        title={t('prefs.orchestrationApprovals')}
        description={t('prefs.orchestrationApprovalsDesc')}
        value={policy.approvals}
        options={[
          { value: 'planner', label: planner },
          { value: 'always', label: t('prefs.orchestrationApprovalsAlways') },
          { value: 'never', label: t('prefs.orchestrationApprovalsNever') },
        ]}
        onChange={(value) =>
          update({ approvals: value as OrchestratorPolicyPreferences['approvals'] })
        }
      />
      <RuleRow
        title={t('prefs.orchestrationIsolation')}
        description={t('prefs.orchestrationIsolationDesc')}
        value={policy.isolation}
        options={[
          { value: 'planner', label: planner },
          { value: 'always', label: t('prefs.orchestrationIsolationAlways') },
        ]}
        onChange={(value) =>
          update({ isolation: value as OrchestratorPolicyPreferences['isolation'] })
        }
      />
      <RuleRow
        title={t('prefs.orchestrationWebSearch')}
        description={t('prefs.orchestrationWebSearchDesc')}
        value={policy.webSearch}
        options={[
          { value: 'planner', label: planner },
          { value: 'never', label: t('prefs.orchestrationWebSearchNever') },
        ]}
        onChange={(value) =>
          update({ webSearch: value as OrchestratorPolicyPreferences['webSearch'] })
        }
      />
      <RuleRow
        title={t('prefs.orchestrationCodexSandbox')}
        description={t('prefs.orchestrationCodexSandboxDesc')}
        value={policy.codexSandbox}
        options={[
          { value: 'workspace-write', label: t('prefs.orchestrationCodexSandboxWorkspace') },
          { value: 'danger-full-access', label: t('prefs.orchestrationCodexSandboxFull') },
        ]}
        onChange={(value) =>
          update({ codexSandbox: value as OrchestratorPolicyPreferences['codexSandbox'] })
        }
      />
    </div>
  )
}

const PROJECT_PROFILES = ['economy', 'balanced', 'quality'] as const

/** A project can route by a profile of its own; its planners then ignore the shared routing. */
function ProjectRouting() {
  const t = useT()
  const projects = useProjectsStore((state) => state.projects)
  const setPreset = useProjectsStore((state) => state.setProjectRoutingPreset)
  const listed = projects.filter((project) => !project.archived)
  if (listed.length === 0) {
    return <p className={page.empty}>{t('prefs.orchestrationProjectRoutingEmpty')}</p>
  }
  return (
    <div className={styles.optionList}>
      {listed.map((project) => (
        <RuleRow
          key={project.id}
          title={project.name}
          description={t(
            project.orchestratorRoutingPreset
              ? 'prefs.orchestrationProjectRoutingOwnDesc'
              : 'prefs.orchestrationProjectRoutingSharedDesc',
          )}
          value={project.orchestratorRoutingPreset ?? 'shared'}
          options={[
            { value: 'shared', label: t('prefs.orchestrationProjectRoutingShared') },
            ...PROJECT_PROFILES.map((preset) => ({
              value: preset,
              label: t(`prefs.orchestrationRoutingPreset.${preset}` as MessageKey),
            })),
          ]}
          onChange={(value) =>
            setPreset(
              project.id,
              value === 'shared' ? undefined : (value as (typeof PROJECT_PROFILES)[number]),
            )
          }
        />
      ))}
    </div>
  )
}

/**
 * Everything the orchestrator can be told, one subject per sub-tab. The sub-tabs can be dragged
 * into any order, and the first one is the one the page opens on.
 */
export function OrchestrationPage({ target }: { target: string | null }) {
  const t = useT()
  const storedOrder = useProjectsStore((state) => state.preferences.orchestrationTabOrder)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const order = normalizeOrchestrationTabOrder(storedOrder)
  const [selected, setSelected] = useState<OrchestrationTabId>(order[0])
  // A section asked for by a search result or a shortcut decides the tab for that render, so the
  // section is on the page by the time it is scrolled to.
  const targeted = target ? TAB_OF_SECTION[target] : undefined
  const tab = targeted ?? selected

  useEffect(() => {
    if (targeted) setSelected(targeted)
  }, [targeted])

  return (
    <>
      <SortableList
        orientation="horizontal"
        keyboard="alt-arrows"
        className={controls.tabRow}
        items={order}
        getId={(id) => id}
        onReorder={(from, to) =>
          setPreferences({ orchestrationTabOrder: moveItem(order, from, to) })
        }
        renderItem={(id, _, drag) => (
          <button
            type="button"
            {...drag.handleProps}
            role="tab"
            aria-selected={tab === id}
            className={`${controls.tabBtn} ${tab === id ? controls.tabBtnActive : ''}`}
            onClick={() => setSelected(id)}
            title={t('prefs.orchestrationTabDrag')}
          >
            {t(TAB_LABELS[id])}
          </button>
        )}
      />

      {tab === 'routing' ? (
        <SettingsSection
          id="orchestration-routing"
          title={t('prefs.orchestrationRouting')}
          description={t('prefs.orchestrationRoutingDesc')}
        >
          <OrchestrationRoutingSettings />
        </SettingsSection>
      ) : null}

      {tab === 'routing' ? (
        <SettingsSection
          id="orchestration-project-routing"
          title={t('prefs.orchestrationProjectRouting')}
          description={t('prefs.orchestrationProjectRoutingDesc')}
        >
          <ProjectRouting />
        </SettingsSection>
      ) : null}

      {tab === 'workers' ? (
        <SettingsSection
          id="orchestration-max-workers"
          title={t('prefs.orchestrationLimits')}
          description={t('prefs.orchestrationLimitsDesc')}
        >
          <WorkerLimits />
        </SettingsSection>
      ) : null}

      {tab === 'permissions' ? (
        <SettingsSection
          id="orchestration-rules"
          title={t('prefs.orchestrationRules')}
          description={t('prefs.orchestrationRulesDesc')}
        >
          <WorkerPermissions />
        </SettingsSection>
      ) : null}

      {tab === 'models' ? (
        <>
          <SettingsSection
            id="orchestration-planner"
            title={t('prefs.orchestrationPlanner')}
            description={t('prefs.orchestrationPlannerDesc')}
          >
            <AgentLaunchDefaultsList scope="planner" agents={ORCHESTRATOR_PLANNER_AGENTS} />
          </SettingsSection>
          <SettingsSection
            id="orchestration-worker"
            title={t('prefs.orchestrationWorker')}
            description={t('prefs.orchestrationWorkerDesc')}
          >
            <AgentLaunchDefaultsList scope="worker" agents={ORCHESTRATOR_WORKER_AGENTS} />
          </SettingsSection>
        </>
      ) : null}
    </>
  )
}
