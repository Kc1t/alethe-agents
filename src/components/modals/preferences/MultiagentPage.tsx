import { useCallback, useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { refreshLocalPlugins, setPluginEnabled, usePlugins } from '../../../lib/plugins'
import type {
  EventBusPayload,
  MetricData,
  PlanningCommit,
  PluginManifest,
} from '../../../lib/tauri'
import {
  getPlanningAutocommit,
  getTelemetryMetrics,
  getTelemetryTraces,
  planningAuditHistory,
  pluginInstall,
  pluginUninstall,
  setPlanningAutocommit,
} from '../../../lib/tauri'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useSchedulerStore } from '../../../stores/schedulerStore'
import { useUiStore } from '../../../stores/uiStore'
import { Dropdown } from '../../ui/Dropdown'
import styles from '../PreferencesModal.module.css'
import multiagentStyles from './MultiagentPage.module.css'
import { SettingsSection } from './primitives'

export function MultiagentPage() {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const projects = useProjectsStore((state) => state.projects)
  const [selectedProjectId, setSelectedProjectId] = useState<string>(projects[0]?.id ?? '')
  const schedulerStore = useSchedulerStore()

  const [metrics, setMetrics] = useState<Record<string, MetricData>>({})
  const [traces, setTraces] = useState<EventBusPayload[]>([])
  const [loadingTelemetry, setLoadingTelemetry] = useState(true)
  const [telemetryError, setTelemetryError] = useState(false)

  const plugins = usePlugins()
  const [pluginManifestInput, setPluginManifestInput] = useState('')

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

  const loadPlugins = useCallback(async () => {
    try {
      await refreshLocalPlugins()
    } catch (err) {
      console.error('Failed to list plugins:', err)
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
    void loadPlugins()
    void loadAutocommitState()
  }, [loadPlugins, loadAutocommitState])

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

  const handleInstallPlugin = async () => {
    const raw = pluginManifestInput.trim()
    if (!raw) return
    try {
      const manifest = JSON.parse(raw) as PluginManifest
      if (!manifest.id || !manifest.name || !manifest.version || !manifest.kind) {
        pushToast({ title: t('prefs.multiagentPluginInstallInvalid'), body: '' })
        return
      }
      await pluginInstall(manifest)
      pushToast({ title: t('prefs.multiagentPluginInstallSuccess'), body: '' })
      setPluginManifestInput('')
      void loadPlugins()
    } catch (err) {
      pushToast({
        title: t('prefs.multiagentPluginInstallError', { error: String(err) }),
        body: '',
      })
    }
  }

  const handleUninstallPlugin = async (id: string) => {
    if (!window.confirm(t('prefs.multiagentPluginUninstallConfirm', { name: id }))) return
    try {
      await pluginUninstall(id)
      pushToast({ title: t('prefs.multiagentPluginUninstallSuccess'), body: '' })
      void loadPlugins()
    } catch (err) {
      pushToast({
        title: t('prefs.multiagentPluginUninstallError', { error: String(err) }),
        body: '',
      })
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
        id="multiagent-plugins"
        title={t('prefs.multiagentPluginsTitle')}
        description={t('prefs.multiagentPluginsDesc')}
      >
        <div className={multiagentStyles.pluginForm}>
          <textarea
            className={multiagentStyles.pluginTextarea}
            value={pluginManifestInput}
            onChange={(event) => setPluginManifestInput(event.target.value)}
            placeholder={t('prefs.multiagentPluginInstallPlaceholder')}
            spellCheck={false}
          />
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={!pluginManifestInput.trim()}
            onClick={() => void handleInstallPlugin()}
          >
            {t('prefs.multiagentPluginInstallButton')}
          </button>
        </div>

        {plugins.length === 0 ? (
          <div className={multiagentStyles.emptyNote}>{t('prefs.multiagentNoPlugins')}</div>
        ) : (
          <div className={multiagentStyles.list}>
            {plugins.map((plug) => (
              <div key={plug.manifest.id} className={multiagentStyles.pluginRow}>
                <div>
                  <div className={multiagentStyles.pluginName}>
                    {plug.manifest.name} (v{plug.manifest.version})
                  </div>
                  <div className={multiagentStyles.pluginKind}>
                    {t('prefs.multiagentPluginKind', { kind: plug.manifest.kind })}
                    {plug.source === 'bundled'
                      ? ` · ${t('prefs.multiagentPluginBundled')}`
                      : null}
                  </div>
                  <div className={multiagentStyles.pluginDescription}>
                    {plug.manifest.description}
                  </div>
                  {plug.error ? (
                    <div className={multiagentStyles.pluginError}>
                      {t('prefs.multiagentPluginError', { error: plug.error })}
                    </div>
                  ) : null}
                </div>
                <div className={multiagentStyles.pluginActions}>
                  <label className={multiagentStyles.pluginToggle}>
                    <input
                      type="checkbox"
                      checked={plug.enabled}
                      onChange={(event) =>
                        void setPluginEnabled(plug.manifest.id, event.target.checked)
                      }
                    />
                    {t('prefs.multiagentPluginEnabled')}
                  </label>
                  {plug.source === 'local' ? (
                    <button
                      type="button"
                      className={multiagentStyles.cancelButton}
                      onClick={() => void handleUninstallPlugin(plug.manifest.id)}
                    >
                      {t('prefs.multiagentPluginUninstall')}
                    </button>
                  ) : null}
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
    </>
  )
}
