import { AlertTriangle, CircleCheck, GitBranch } from 'lucide-react'
import { useEffect, useState } from 'react'

import { readableError } from '../../lib/errors'
import { useT } from '../../lib/i18n'
import { discoverProviderModels, gitInit, gitStatus } from '../../lib/tauri'
import {
  AGENT_TYPE_LABELS,
  ALL_AGENT_TYPES,
  PROVIDER_MODELS,
  type AgentType,
} from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AgentIcon } from '../icons/AgentIcons'
import { ModelSearchablePicker, type ModelOption } from './ModelSearchablePicker'
import controls from './controls.module.css'
import styles from './EditProjectModal.module.css'

const ALL_AGENTS: { type: AgentType; label: string }[] = ALL_AGENT_TYPES.map((type) => ({
  type,
  label: AGENT_TYPE_LABELS[type],
}))

// Cache module-level (sobrevive a troca de aba/remount deste componente) —

const globalModelsCache: Record<string, ModelOption[]> = {}

export function EditProjectAgentSettings({
  projectId,
  cwd,
  worktreeMode,
  onWorktreeModeChange,
  validationCommandsStr,
  onValidationCommandsChange,
  healthCheckCommand,
  onHealthCheckCommandChange,
  healthCheckPath,
  onHealthCheckPathChange,
  conflictProvider,
  onConflictProviderChange,
  conflictModel,
  onConflictModelChange,
  autoWorktree,
  onAutoWorktreeChange,
  graphifyEnabled,
  onGraphifyEnabledChange,
  gsdWatcherEnabled,
  onGsdWatcherEnabledChange,
}: {
  projectId: string
  cwd: string
  worktreeMode: 'gitWorktree' | 'localCopy'
  onWorktreeModeChange: (mode: 'gitWorktree' | 'localCopy') => void
  validationCommandsStr: string
  onValidationCommandsChange: (value: string) => void
  healthCheckCommand: string
  onHealthCheckCommandChange: (value: string) => void
  healthCheckPath: string
  onHealthCheckPathChange: (value: string) => void
  conflictProvider: AgentType
  onConflictProviderChange: (provider: AgentType) => void
  conflictModel: string
  onConflictModelChange: (modelId: string) => void
  autoWorktree: boolean
  onAutoWorktreeChange: (enabled: boolean) => void
  graphifyEnabled: boolean
  onGraphifyEnabledChange: (enabled: boolean) => void
  gsdWatcherEnabled: boolean
  onGsdWatcherEnabledChange: (enabled: boolean) => void
}) {
  const t = useT()
  const pushToast = useUiStore((s) => s.pushToast)
  const enabledAgents = useProjectsStore((s) => s.preferences.enabledAgents)
  const terminalTheme = useProjectsStore(
    (s) => s.preferences.terminalTheme ?? s.preferences.uiTheme,
  )
  const migrateProjectTerminalsToWorktrees = useProjectsStore(
    (s) => s.migrateProjectTerminalsToWorktrees,
  )

  const availableAgents = ALL_AGENTS.filter((a) => enabledAgents[a.type])
  const conflictAgents = availableAgents.length > 0 ? availableAgents : ALL_AGENTS

  const [discoveredModels, setDiscoveredModels] = useState<ModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [migratingWorktrees, setMigratingWorktrees] = useState(false)

  const [hasGit, setHasGit] = useState<boolean | null>(null)
  const [gitInitBusy, setGitInitBusy] = useState(false)

  useEffect(() => {
    let active = true
    if (!cwd) {
      setHasGit(null)
      return
    }
    gitStatus(cwd)
      .then(() => {
        if (active) setHasGit(true)
      })
      .catch((cause) => {
        if (active) setHasGit(!String(cause).includes('not_a_git_repository'))
      })
    return () => {
      active = false
    }
  }, [cwd])

  const handleInitGit = async () => {
    if (!cwd || gitInitBusy) return
    if (!confirm(t('git.initOffer.confirm'))) return
    setGitInitBusy(true)
    try {
      await gitInit(cwd)
      pushToast({ title: t('git.initOffer.successTitle'), body: t('git.initOffer.successBody') })
      setHasGit(true)
    } catch (cause) {
      pushToast({
        title: t('git.initOffer.failedTitle'),
        body: t('git.initOffer.failedBody', { error: readableError(cause) }),
      })
    } finally {
      setGitInitBusy(false)
    }
  }

  useEffect(() => {
    let active = true
    const targetProvider = conflictProvider
    const fallback = PROVIDER_MODELS[targetProvider] ?? []
    const cached = globalModelsCache[targetProvider]
    setDiscoveredModels(cached || fallback)

    // With the cache already filled, this is just a silent background
    // revalidation — no need to flash "Loading..." again (ModelSearchablePicker
    // only shows that text when there are no options to display yet).
    if (!cached) setLoadingModels(true)
    discoverProviderModels(targetProvider)
      .then((list) => {
        if (!active) return
        if (list && list.length > 0) {
          globalModelsCache[targetProvider] = list
          setDiscoveredModels(list)
        } else {
          globalModelsCache[targetProvider] = fallback
          setDiscoveredModels(fallback)
        }
      })
      .catch(() => {
        if (!active) return
        globalModelsCache[targetProvider] = fallback
        setDiscoveredModels(fallback)
      })
      .finally(() => {
        if (active) setLoadingModels(false)
      })

    return () => {
      active = false
    }
  }, [conflictProvider])

  return (
    <>
      <div className={styles.sectionIntro}>
        <h3>{t('crud.editProjectAgentSettings')}</h3>
        <p>{t('crud.editProjectAgentSettingsDesc')}</p>
      </div>

      {hasGit === false ? (
        <div className={controls.gitInitBanner}>
          <span className={controls.gitInitBannerIcon}>
            <AlertTriangle size={16} />
          </span>
          <div className={controls.gitInitBannerText}>
            <strong>{t('git.initOffer.title')}</strong>
            <span>{t('git.initOffer.body')}</span>
          </div>
          <button
            type="button"
            className={controls.gitInitBannerBtn}
            disabled={gitInitBusy}
            onClick={() => void handleInitGit()}
          >
            <GitBranch size={13} />
            {gitInitBusy ? t('git.initOffer.busy') : t('git.initOffer.button')}
          </button>
        </div>
      ) : null}

      <div className={controls.field}>
        <label className={controls.label}>{t('crud.editProjectWorktreeMode')}</label>
        <div className={styles.choiceRow}>
          <label className={styles.choice}>
            <input
              type="radio"
              name="worktreeMode"
              value="gitWorktree"
              checked={worktreeMode === 'gitWorktree'}
              onChange={() => onWorktreeModeChange('gitWorktree')}
            />
            {t('crud.editProjectGitWorktree')}
          </label>
          <label className={styles.choice}>
            <input
              type="radio"
              name="worktreeMode"
              value="localCopy"
              checked={worktreeMode === 'localCopy'}
              onChange={() => onWorktreeModeChange('localCopy')}
            />
            {t('crud.editProjectLocalCopy')}
          </label>
        </div>
      </div>

      <div className={controls.field}>
        <label className={controls.label}>{t('crud.editProjectValidationCommands')}</label>
        <textarea
          className={`${controls.input} ${styles.commandInput}`}
          placeholder={t('crud.editProjectValidationPlaceholder')}
          value={validationCommandsStr}
          onChange={(e) => onValidationCommandsChange(e.target.value)}
        />
      </div>

      <div className={controls.field}>
        <label className={controls.label}>{t('crud.editProjectHealthCheckCommand')}</label>
        <input
          type="text"
          className={controls.input}
          placeholder={t('crud.editProjectHealthCheckCommandPlaceholder')}
          value={healthCheckCommand}
          onChange={(e) => onHealthCheckCommandChange(e.target.value)}
        />
        <p className={controls.hint}>{t('crud.editProjectHealthCheckCommandHint')}</p>
      </div>

      {healthCheckCommand.trim() ? (
        <div className={controls.field}>
          <label className={controls.label}>{t('crud.editProjectHealthCheckPath')}</label>
          <input
            type="text"
            className={controls.input}
            placeholder={t('crud.editProjectHealthCheckPathPlaceholder')}
            value={healthCheckPath}
            onChange={(e) => onHealthCheckPathChange(e.target.value)}
          />
        </div>
      ) : null}

      <div className={controls.field}>
        <label className={controls.label}>{t('merge.providerLabel')}</label>
        <div className={controls.agentGrid}>
          {conflictAgents.map((agent) => {
            const active = conflictProvider === agent.type
            return (
              <button
                key={agent.type}
                type="button"
                className={`${controls.agentCard} ${active ? controls.agentCardActive : ''}`}
                onClick={() => onConflictProviderChange(agent.type)}
              >
                <span className={controls.agentIcon}>
                  <AgentIcon type={agent.type} size={20} theme={terminalTheme} />
                </span>
                <span className={controls.agentLabel}>{agent.label}</span>
                {active ? <CircleCheck size={16} className={controls.selectedIcon} /> : null}
              </button>
            )
          })}
        </div>
      </div>

      <div className={controls.field} style={{ marginTop: 10 }}>
        <label className={controls.label}>
          {t('merge.modelLabel', { provider: conflictProvider.toUpperCase() })}
        </label>
        <ModelSearchablePicker
          value={conflictModel}
          onChange={onConflictModelChange}
          options={discoveredModels}
          loading={loadingModels}
          providerName={conflictProvider.toUpperCase()}
        />
      </div>

      <div className={`${controls.field} ${styles.toggleRow}`}>
        <input
          type="checkbox"
          id="autoWorktree"
          checked={autoWorktree}
          onChange={(e) => onAutoWorktreeChange(e.target.checked)}
        />
        <label htmlFor="autoWorktree" className={styles.toggleLabel}>
          {t('multiAgent.autoWorktree')}
        </label>
      </div>

      {/* Migrating ALREADY existing terminals is an explicit, separate action
          from the toggle above — the toggle only affects new agents. Migrating
          existing ones kills/suspends the PTY and restarts the agent from
          scratch on the new worktree (no conversation continuity). */}
      <div style={{ marginTop: 4, marginBottom: 4 }}>
        <button
          type="button"
          className={controls.btn}
          disabled={migratingWorktrees}
          onClick={() => {
            if (migratingWorktrees) return
            if (!confirm(t('multiAgent.migrateExistingConfirm'))) return
            setMigratingWorktrees(true)
            void migrateProjectTerminalsToWorktrees(projectId, gsdWatcherEnabled).finally(() =>
              setMigratingWorktrees(false),
            )
          }}
        >
          {migratingWorktrees
            ? t('multiAgent.migrateExistingBusy')
            : t('multiAgent.migrateExisting')}
        </button>
        <p style={{ fontSize: 10, color: 'var(--fg-muted)', marginTop: 4 }}>
          {t('multiAgent.migrateExistingHint')}
        </p>
      </div>

      <div className={`${controls.field} ${styles.toggleRow}`}>
        <input
          type="checkbox"
          id="graphifyEnabled"
          checked={graphifyEnabled}
          onChange={(e) => onGraphifyEnabledChange(e.target.checked)}
        />
        <label htmlFor="graphifyEnabled" className={styles.toggleLabel}>
          {t('project.graphifyEnabled')}
        </label>
      </div>

      <div className={`${controls.field} ${styles.toggleRow}`}>
        <input
          type="checkbox"
          id="gsdWatcher"
          checked={gsdWatcherEnabled}
          onChange={(e) => onGsdWatcherEnabledChange(e.target.checked)}
        />
        <label htmlFor="gsdWatcher" className={styles.toggleLabel}>
          {t('crud.editProjectGsdWatcher')}
        </label>
      </div>
    </>
  )
}
