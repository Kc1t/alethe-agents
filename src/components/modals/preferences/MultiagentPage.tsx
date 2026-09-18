import { useCallback, useEffect, useRef, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { builtinShortcuts, resolveShortcuts } from '../../../lib/orchestratorShortcuts'
import type { EventBusPayload, MetricData, PlanningCommit } from '../../../lib/tauri'
import {
  getPlanningAutocommit,
  getTelemetryMetrics,
  getTelemetryTraces,
  orchestratorDefaultRuleSets,
  planningAuditHistory,
  setPlanningAutocommit,
} from '../../../lib/tauri'
import type { OrchestratorShortcut, RuleSet, ShortcutRule } from '../../../lib/types'
import type { DefaultRuleSetsStatus } from '../../../lib/workerRules'
import {
  isDuplicateRuleSetName,
  isProtectedRuleSet,
  resolveRuleSets,
  ruleSetsEditorState,
  uniqueRuleSetName,
} from '../../../lib/workerRules'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useSchedulerStore } from '../../../stores/schedulerStore'
import { useUiStore } from '../../../stores/uiStore'
import { Dropdown } from '../../ui/Dropdown'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'
import multiagentStyles from './MultiagentPage.module.css'
import { SettingsSection } from './primitives'

export function MultiagentPage() {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const projects = useProjectsStore((state) => state.projects)
  const [selectedProjectId, setSelectedProjectId] = useState<string>(projects[0]?.id ?? '')
  const schedulerStore = useSchedulerStore()

  const storedShortcuts = useProjectsStore((state) => state.preferences.orchestratorShortcuts)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const shortcuts = resolveShortcuts(storedShortcuts, t)
  const builtins = builtinShortcuts(t)
  const saveShortcuts = (next: OrchestratorShortcut[]) =>
    setPreferences({ orchestratorShortcuts: next })
  const updateShortcut = (index: number, patch: Partial<OrchestratorShortcut>) =>
    saveShortcuts(shortcuts.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  const restoreDefaults = () => setPreferences({ orchestratorShortcuts: null })

  const storedRuleSets = useProjectsStore((state) => state.preferences.workerRuleSets)
  const [defaultRuleSets, setDefaultRuleSets] = useState<RuleSet[]>([])
  const [defaultRuleSetsStatus, setDefaultRuleSetsStatus] =
    useState<DefaultRuleSetsStatus>('loading')

  // Retrying leaves the earlier request in flight, so a slow first answer can land after a fast
  // second one. Only the newest attempt is allowed to write: a stale failure that overwrote a
  // fresh list would disable the editor while the sets sit right there on screen.
  const ruleSetsLoadRef = useRef(0)
  const loadDefaultRuleSets = useCallback(async () => {
    const attempt = ++ruleSetsLoadRef.current
    setDefaultRuleSetsStatus('loading')
    try {
      const sets = await orchestratorDefaultRuleSets()
      if (ruleSetsLoadRef.current !== attempt) return
      setDefaultRuleSets(sets)
      setDefaultRuleSetsStatus('ready')
    } catch (err) {
      if (ruleSetsLoadRef.current !== attempt) return
      console.error('Failed to load Alethe’s rule sets:', err)
      // Deliberately no empty list here: "we could not read ours" is not "there are none", and the
      // core is still serving its own defaults because App's publish effect failed the same way.
      setDefaultRuleSetsStatus('failed')
    }
  }, [])

  useEffect(() => {
    void loadDefaultRuleSets()
  }, [loadDefaultRuleSets])

  const ruleSets = resolveRuleSets(storedRuleSets, defaultRuleSets)
  const ruleEditorState = ruleSetsEditorState(storedRuleSets, defaultRuleSetsStatus)
  // Without ours and without a list of the person's own, no list can be built: one that left out
  // General would silently drop it from every worker and from the lead agent's briefing.
  const canEditRuleSets = ruleEditorState === 'ready'
  const saveRuleSets = (next: RuleSet[]) => setPreferences({ workerRuleSets: next })
  const updateRuleSet = (index: number, patch: Partial<RuleSet>) =>
    saveRuleSets(ruleSets.map((set, i) => (i === index ? { ...set, ...patch } : set)))

  const [metrics, setMetrics] = useState<Record<string, MetricData>>({})
  const [traces, setTraces] = useState<EventBusPayload[]>([])
  const [loadingTelemetry, setLoadingTelemetry] = useState(true)
  const [telemetryError, setTelemetryError] = useState(false)

  const [autocommit, setAutocommit] = useState(false)
  const [auditLogs, setAuditLogs] = useState<PlanningCommit[]>([])
  const [loadingAudit, setLoadingAudit] = useState(false)

  const loadTelemetry = useCallback(async () => {
    try {
      const [m, tr] = await Promise.all([getTelemetryMetrics(), getTelemetryTraces()])
      setMetrics(m)
      setTraces(tr.slice(-15).reverse())
      setTelemetryError(false)
    } catch (err) {
      console.error('Failed to load telemetry:', err)
      setTelemetryError(true)
    } finally {
      setLoadingTelemetry(false)
    }
  }, [])

  const loadAutocommitState = useCallback(async () => {
    try {
      const enabled = await getPlanningAutocommit()
      setAutocommit(enabled)
    } catch (err) {
      console.error('Failed to read autocommit state:', err)
    }
  }, [])

  const selectedProject = projects.find((p) => p.id === selectedProjectId)
  const repoPath = selectedProject?.terminals[0]?.cwd

  const loadAuditHistory = useCallback(async (path: string) => {
    setLoadingAudit(true)
    try {
      const history = await planningAuditHistory(path, 15)
      setAuditLogs(history)
    } catch (err) {
      console.error('Failed to load GSD audit history:', err)
      setAuditLogs([])
    } finally {
      setLoadingAudit(false)
    }
  }, [])

  useEffect(() => {
    void loadTelemetry()
    const interval = setInterval(loadTelemetry, 3000)
    return () => clearInterval(interval)
  }, [loadTelemetry])

  useEffect(() => {
    void loadAutocommitState()
  }, [loadAutocommitState])

  useEffect(() => {
    return schedulerStore.initListener()
  }, [])

  useEffect(() => {
    if (selectedProjectId) {
      void schedulerStore.loadTasks(selectedProjectId)
      if (repoPath) {
        void loadAuditHistory(repoPath)
      }
    } else {
      setAuditLogs([])
    }
  }, [selectedProjectId, repoPath, loadAuditHistory])

  const handleTick = () => {
    if (selectedProjectId && repoPath) {
      void schedulerStore.tick(selectedProjectId, repoPath)
    }
  }

  const handleToggleAutocommit = async (enabled: boolean) => {
    try {
      await setPlanningAutocommit(enabled)
      setAutocommit(enabled)
    } catch (err) {
      pushToast({ title: t('prefs.multiagentAutocommitError'), body: String(err) })
    }
  }

  return (
    <>
      <SettingsSection
        id="multiagent-scheduler"
        title={t('prefs.multiagentSchedulerTitle')}
        description={t('prefs.multiagentSchedulerDesc')}
      >
        <div className={multiagentStyles.toolbar}>
          <Dropdown
            className={styles.select}
            value={selectedProjectId}
            onChange={setSelectedProjectId}
            ariaLabel={t('prefs.multiagentSelectProjectOption')}
            options={[
              { value: '', label: t('prefs.multiagentSelectProjectOption') },
              ...projects.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />

          {selectedProjectId && repoPath ? (
            <button
              type="button"
              className={`${styles.secondaryButton} ${multiagentStyles.runTickButton}`}
              onClick={handleTick}
            >
              {t('prefs.multiagentRunTick')}
            </button>
          ) : null}
        </div>

        {selectedProjectId ? (
          schedulerStore.loading ? (
            <div className={multiagentStyles.mutedNote}>{t('prefs.multiagentLoadingQueue')}</div>
          ) : schedulerStore.tasks.length === 0 ? (
            <div className={multiagentStyles.emptyNote}>{t('prefs.multiagentNoTasks')}</div>
          ) : (
            <div className={multiagentStyles.list}>
              {schedulerStore.tasks.map((task) => (
                <div key={task.id} className={multiagentStyles.taskRow}>
                  <div className={multiagentStyles.taskBody}>
                    <div className={multiagentStyles.taskTitleRow}>
                      <span>
                        #{task.id}: {task.title}
                      </span>
                      <span className={multiagentStyles.statusBadge} data-status={task.status}>
                        {task.status.toUpperCase()}
                      </span>
                    </div>
                    {task.dependencies.length > 0 ? (
                      <div className={multiagentStyles.taskMeta}>
                        {t('prefs.multiagentDependsOn')} <code>{task.dependencies.join(', ')}</code>
                      </div>
                    ) : null}
                    {task.assignedAgentId ? (
                      <div className={multiagentStyles.taskAssignee}>
                        {t('prefs.multiagentAssignedTo', { agentId: task.assignedAgentId })}
                      </div>
                    ) : null}
                  </div>
                  {task.status === 'running' ? (
                    <button
                      type="button"
                      className={multiagentStyles.cancelButton}
                      onClick={() => schedulerStore.cancel(task.id)}
                    >
                      {t('prefs.multiagentCancel')}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )
        ) : (
          <div className={multiagentStyles.emptyNote}>{t('prefs.multiagentSelectProjectHint')}</div>
        )}
      </SettingsSection>

      <SettingsSection
        id="multiagent-metrics"
        title={t('prefs.multiagentMetricsTitle')}
        description={t('prefs.multiagentMetricsDesc')}
      >
        {loadingTelemetry ? (
          <div className={multiagentStyles.mutedNote}>{t('prefs.multiagentLoadingMetrics')}</div>
        ) : telemetryError ? (
          <div className={multiagentStyles.errorNote}>{t('prefs.multiagentTelemetryError')}</div>
        ) : Object.keys(metrics).length === 0 ? (
          <div className={multiagentStyles.emptyNote}>{t('prefs.multiagentNoMetrics')}</div>
        ) : (
          <div className={multiagentStyles.metricGrid}>
            {Object.entries(metrics).map(([key, data]) => {
              const name = key.replace('alethe_event_', '').toUpperCase()
              return (
                <div key={key} className={multiagentStyles.metricCard}>
                  <div className={multiagentStyles.metricLabel}>{name}</div>
                  <div className={multiagentStyles.metricValue}>{data.count}</div>
                  {data.last_value > 0 ? (
                    <div className={multiagentStyles.metricLast}>
                      {t('prefs.multiagentLastValue', { value: data.last_value.toFixed(2) })}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        id="multiagent-traces"
        title={t('prefs.multiagentTracesTitle')}
        description={t('prefs.multiagentTracesDesc')}
      >
        {loadingTelemetry ? (
          <div className={multiagentStyles.mutedNote}>{t('prefs.multiagentLoadingTraces')}</div>
        ) : traces.length === 0 ? (
          <div className={multiagentStyles.emptyNote}>{t('prefs.multiagentNoTraces')}</div>
        ) : (
          <div className={multiagentStyles.scrollLog}>
            {traces.map((trace, idx) => (
              <div key={idx} className={multiagentStyles.traceRow}>
                <div className={multiagentStyles.traceBody}>
                  <span className={multiagentStyles.traceType}>{trace.event_type}</span>
                  {trace.task_id ? (
                    <span className={multiagentStyles.traceTask}>
                      {t('prefs.multiagentTraceTask', { id: trace.task_id })}
                    </span>
                  ) : null}
                  <div className={multiagentStyles.traceCorrId}>
                    {t('prefs.multiagentTraceCorrId', { id: trace.correlation_id })}
                  </div>
                </div>
                <div className={multiagentStyles.traceTime}>
                  {new Date(trace.timestamp_ms).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        id="multiagent-gsd-audit"
        title={t('prefs.multiagentAuditTitle')}
        description={t('prefs.multiagentAuditDesc')}
      >
        <div className={multiagentStyles.autocommitRow}>
          <input
            type="checkbox"
            id="planningAutocommit"
            checked={autocommit}
            onChange={(e) => void handleToggleAutocommit(e.target.checked)}
          />
          <label htmlFor="planningAutocommit">{t('prefs.multiagentAutocommitLabel')}</label>
        </div>

        {selectedProjectId ? (
          loadingAudit ? (
            <div className={multiagentStyles.mutedNote}>{t('prefs.multiagentLoadingAudit')}</div>
          ) : auditLogs.length === 0 ? (
            <div className={multiagentStyles.emptyNote}>{t('prefs.multiagentNoAuditLogs')}</div>
          ) : (
            <div className={multiagentStyles.scrollLog}>
              {auditLogs.map((log) => (
                <div key={log.hash} className={multiagentStyles.auditRow}>
                  <div>
                    <span className={multiagentStyles.auditHash}>{log.hash.slice(0, 7)}</span>
                    <span>{log.subject}</span>
                    <div className={multiagentStyles.auditAuthor}>
                      {t('prefs.multiagentAuditAuthor', { author: log.author })}{' '}
                      {log.agentId ? t('prefs.multiagentAuditAgent', { agentId: log.agentId }) : ''}
                    </div>
                  </div>
                  <div className={multiagentStyles.auditTime}>
                    {new Date(log.timestampMs).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className={multiagentStyles.emptyNote}>
            {t('prefs.multiagentSelectProjectAuditHint')}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        id="orchestrator-shortcuts"
        title={t('prefs.orchestratorShortcuts')}
        description={t('prefs.orchestratorShortcutsDesc')}
      >
        {shortcuts.length === 0 ? (
          <div className={multiagentStyles.shortcutsEmpty}>
            <span className={multiagentStyles.emptyNote}>{t('prefs.shortcutsEmpty')}</span>
            <button
              type="button"
              className={`${controls.btn} ${controls.btnSm}`}
              onClick={restoreDefaults}
            >
              {t('prefs.shortcutsRestoreDefaults')}
            </button>
          </div>
        ) : (
          <div className={multiagentStyles.shortcutList}>
            {shortcuts.map((shortcut, index) => {
              const isBuiltin = builtins.some((entry) => entry.id === shortcut.id)
              return (
                <div key={shortcut.id} className={multiagentStyles.shortcut}>
                  <input
                    className={controls.input}
                    value={shortcut.name}
                    aria-label={t('prefs.shortcutName')}
                    onChange={(event) => updateShortcut(index, { name: event.target.value })}
                  />
                  <select
                    className={controls.input}
                    value={shortcut.rule}
                    aria-label={t('prefs.shortcutRule')}
                    onChange={(event) =>
                      updateShortcut(index, { rule: event.target.value as ShortcutRule })
                    }
                  >
                    <option value="any">{t('prefs.shortcutRuleAny')}</option>
                    <option value="finished">{t('prefs.shortcutRuleFinished')}</option>
                    <option value="finishedIsolated">{t('prefs.shortcutRuleIsolated')}</option>
                  </select>
                  <textarea
                    className={multiagentStyles.shortcutText}
                    value={shortcut.text}
                    rows={3}
                    aria-label={t('prefs.shortcutText')}
                    onChange={(event) => updateShortcut(index, { text: event.target.value })}
                  />
                  <div className={multiagentStyles.shortcutActions}>
                    <button
                      type="button"
                      className={`${controls.btn} ${controls.btnSm}`}
                      disabled={!isBuiltin}
                      onClick={() => {
                        const original = builtins.find((entry) => entry.id === shortcut.id)
                        if (original) updateShortcut(index, original)
                      }}
                    >
                      {t('prefs.shortcutRestore')}
                    </button>
                    <button
                      type="button"
                      className={`${controls.btn} ${controls.btnSm} ${controls.btnSmDanger}`}
                      onClick={() => saveShortcuts(shortcuts.filter((_, i) => i !== index))}
                    >
                      {t('prefs.shortcutDelete')}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <p className={multiagentStyles.shortcutHint}>{t('prefs.shortcutPlaceholders')}</p>
        <button
          type="button"
          className={`${controls.btn} ${controls.btnSm}`}
          onClick={() =>
            saveShortcuts([
              ...shortcuts,
              {
                id: `custom-${crypto.randomUUID()}`,
                name: t('prefs.shortcutNewName'),
                text: '',
                rule: 'any',
              },
            ])
          }
        >
          {t('prefs.shortcutAdd')}
        </button>
      </SettingsSection>

      <SettingsSection
        id="worker-rules"
        title={t('prefs.workerRules')}
        description={t('prefs.workerRulesDesc')}
      >
        <div className={multiagentStyles.ruleList}>
          {ruleSets.map((set, index) => (
            <RuleSetCard
              key={set.id}
              set={set}
              allSets={ruleSets}
              ours={defaultRuleSets.find((entry) => entry.id === set.id)}
              onPatch={(patch) => updateRuleSet(index, patch)}
              onDelete={() => saveRuleSets(ruleSets.filter((_, i) => i !== index))}
            />
          ))}
        </div>
        {ruleEditorState === 'loading' ? (
          <p className={multiagentStyles.shortcutHint}>{t('prefs.ruleSetsLoading')}</p>
        ) : ruleEditorState === 'unavailable' ? (
          <div className={multiagentStyles.ruleUnavailable}>
            <span className={multiagentStyles.errorNote}>{t('prefs.ruleSetsUnavailable')}</span>
            <button
              type="button"
              className={`${controls.btn} ${controls.btnSm}`}
              onClick={() => void loadDefaultRuleSets()}
            >
              {t('prefs.ruleSetsRetry')}
            </button>
          </div>
        ) : ruleSets.length === 0 ? (
          <p className={multiagentStyles.shortcutHint}>{t('prefs.ruleSetsEmpty')}</p>
        ) : null}
        <div className={multiagentStyles.ruleActions}>
          <button
            type="button"
            className={controls.btn}
            disabled={!canEditRuleSets}
            onClick={() =>
              saveRuleSets([
                ...ruleSets,
                {
                  id: `custom-${crypto.randomUUID()}`,
                  // Born unique: "Add set" twice in a row is the obvious thing to do, and the core
                  // would only ever deliver the first of two sets sharing a name.
                  name: uniqueRuleSetName(ruleSets, t('prefs.ruleSetNewName')),
                  text: '',
                },
              ])
            }
          >
            {t('prefs.ruleSetAdd')}
          </button>
          <button
            type="button"
            className={controls.btn}
            onClick={() => setPreferences({ workerRuleSets: null })}
          >
            {t('prefs.ruleSetsRestoreAll')}
          </button>
        </div>
      </SettingsSection>
    </>
  )
}

/**
 * One rule set.
 *
 * The name is edited as a draft and only committed when the field is left, because a duplicate has
 * to be refused: committing per keystroke would either store an unreachable set or reject the
 * half-typed names every real rename passes through.
 */
function RuleSetCard({
  set,
  allSets,
  ours,
  onPatch,
  onDelete,
}: {
  set: RuleSet
  allSets: readonly RuleSet[]
  ours: RuleSet | undefined
  onPatch: (patch: Partial<RuleSet>) => void
  onDelete: () => void
}) {
  const t = useT()
  const isGeneral = isProtectedRuleSet(set)
  const [draftName, setDraftName] = useState(set.name)
  const [rejectedName, setRejectedName] = useState<string | null>(null)

  useEffect(() => {
    setDraftName(set.name)
    setRejectedName(null)
  }, [set.name])

  const duplicate = isDuplicateRuleSetName(allSets, draftName, set.id)

  const commitName = () => {
    if (draftName === set.name) return
    if (isDuplicateRuleSetName(allSets, draftName, set.id)) {
      // Say what happened and put the working name back, rather than dropping the edit in silence.
      setRejectedName(draftName)
      setDraftName(set.name)
      return
    }
    setRejectedName(null)
    onPatch({ name: draftName })
  }

  const hint = duplicate
    ? t('prefs.ruleSetDuplicate')
    : rejectedName
      ? t('prefs.ruleSetDuplicateRejected', { name: rejectedName })
      : null
  const hintId = `worker-rule-name-${set.id}`

  return (
    <div className={multiagentStyles.ruleSet}>
      <input
        className={controls.input}
        value={draftName}
        disabled={isGeneral}
        aria-label={t('prefs.ruleSetName')}
        aria-invalid={duplicate || undefined}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => {
          setDraftName(event.target.value)
          setRejectedName(null)
        }}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          event.currentTarget.blur()
        }}
      />
      {hint ? (
        <span id={hintId} className={multiagentStyles.ruleWarn}>
          {hint}
        </span>
      ) : null}
      <textarea
        className={multiagentStyles.ruleText}
        value={set.text}
        rows={10}
        aria-label={t('prefs.ruleSetText')}
        onChange={(event) => onPatch({ text: event.target.value })}
      />
      <div className={multiagentStyles.ruleFoot}>
        <span className={multiagentStyles.ruleCount}>
          {t('prefs.ruleSetSize', { count: set.text.length })}
        </span>
        {ours ? (
          <button
            type="button"
            className={`${controls.btn} ${controls.btnSm}`}
            onClick={() => {
              // Another set may have taken our name while this one was renamed; restoring the text
              // is still right, restoring the name on top of it would not be.
              if (isDuplicateRuleSetName(allSets, ours.name, set.id)) {
                setRejectedName(ours.name)
                onPatch({ text: ours.text })
                return
              }
              onPatch({ name: ours.name, text: ours.text })
            }}
          >
            {t('prefs.shortcutRestore')}
          </button>
        ) : null}
        {!isGeneral ? (
          <button
            type="button"
            className={`${controls.btn} ${controls.btnSm} ${controls.btnSmDanger}`}
            onClick={onDelete}
          >
            {t('prefs.shortcutDelete')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
