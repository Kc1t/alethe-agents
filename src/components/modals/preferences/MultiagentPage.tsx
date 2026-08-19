import { useCallback, useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import {
  getPlanningAutocommit,
  getTelemetryMetrics,
  getTelemetryTraces,
  planningAuditHistory,
  setPlanningAutocommit,
} from '../../../lib/tauri'
import type { EventBusPayload, MetricData, PlanningCommit } from '../../../lib/tauri'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useSchedulerStore } from '../../../stores/schedulerStore'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'
import { Dropdown } from '../../ui/Dropdown'

export function MultiagentPage() {
  const t = useT()
  const projects = useProjectsStore((state) => state.projects)
  const [selectedProjectId, setSelectedProjectId] = useState<string>(projects[0]?.id ?? '')
  const schedulerStore = useSchedulerStore()

  const [metrics, setMetrics] = useState<Record<string, MetricData>>({})
  const [traces, setTraces] = useState<EventBusPayload[]>([])
  const [loadingTelemetry, setLoadingTelemetry] = useState(true)

  const [autocommit, setAutocommit] = useState(false)
  const [auditLogs, setAuditLogs] = useState<PlanningCommit[]>([])
  const [loadingAudit, setLoadingAudit] = useState(false)

  const loadTelemetry = useCallback(async () => {
    try {
      const [m, tr] = await Promise.all([getTelemetryMetrics(), getTelemetryTraces()])
      setMetrics(m)
      setTraces(tr.slice(-15).reverse())
    } catch (err) {
      console.error('Falha ao carregar telemetria:', err)
    } finally {
      setLoadingTelemetry(false)
    }
  }, [])

  const loadAutocommitState = useCallback(async () => {
    try {
      const enabled = await getPlanningAutocommit()
      setAutocommit(enabled)
    } catch (err) {
      console.error('Falha ao obter estado de autocommit:', err)
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

  // Inicializa o ouvinte do barramento no schedulerStore
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
      alert(t('prefs.multiagentAutocommitError', { error: String(err) }))
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending':
        return 'var(--fg-muted)'
      case 'ready':
        return 'var(--status-ready-fg, #38bdf8)'
      case 'running':
        return 'var(--status-running-fg, #f59e0b)'
      case 'completed':
        return 'var(--status-completed-fg, #10b981)'
      case 'failed':
        return 'var(--status-failed-fg, #ef4444)'
      case 'blocked':
        return '#6b7280'
      default:
        return 'var(--fg)'
    }
  }

  return (
    <>
      <SettingsSection
        id="multiagent-scheduler"
        title={t('prefs.multiagentSchedulerTitle')}
        description={t('prefs.multiagentSchedulerDesc')}
      >
        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <Dropdown
            className={controls.input}
            value={selectedProjectId}
            onChange={setSelectedProjectId}
            ariaLabel={t('prefs.multiagentSelectProjectOption')}
            options={[
              { value: '', label: t('prefs.multiagentSelectProjectOption') },
              ...projects.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />

          {selectedProjectId && repoPath && (
            <button
              type="button"
              className={styles.secondaryButton}
              style={{ height: 32, padding: '0 12px', fontSize: 11 }}
              onClick={handleTick}
            >
              {t('prefs.multiagentRunTick')}
            </button>
          )}
        </div>

        {selectedProjectId ? (
          schedulerStore.loading ? (
            <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
              {t('prefs.multiagentLoadingQueue')}
            </div>
          ) : schedulerStore.tasks.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>
              {t('prefs.multiagentNoTasks')}
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                maxHeight: 220,
                overflowY: 'auto',
              }}
            >
              {schedulerStore.tasks.map((task) => (
                <div
                  key={task.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-active)',
                    border: '1px solid var(--border)',
                    fontSize: 11,
                  }}
                >
                  <div style={{ overflow: 'hidden', marginRight: 12 }}>
                    <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>
                        #{task.id}: {task.title}
                      </span>
                      <span
                        style={{
                          fontSize: 9,
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: 'var(--border)',
                          color: getStatusColor(task.status),
                          fontWeight: 700,
                        }}
                      >
                        {task.status.toUpperCase()}
                      </span>
                    </div>
                    {task.dependencies.length > 0 && (
                      <div style={{ fontSize: 9, color: 'var(--fg-muted)', marginTop: 2 }}>
                        {t('prefs.multiagentDependsOn')}{' '}
                        <span style={{ fontFamily: 'monospace' }}>
                          {task.dependencies.join(', ')}
                        </span>
                      </div>
                    )}
                    {task.assignedAgentId && (
                      <div style={{ fontSize: 9, color: 'var(--accent)', marginTop: 2 }}>
                        {t('prefs.multiagentAssignedTo', { agentId: task.assignedAgentId })}
                      </div>
                    )}
                  </div>
                  {task.status === 'running' && (
                    <button
                      type="button"
                      onClick={() => schedulerStore.cancel(task.id)}
                      style={{
                        padding: '4px 8px',
                        fontSize: 10,
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--status-failed-bg, #4c1d1d)',
                        color: '#ff8888',
                        border: 'none',
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      {t('prefs.multiagentCancel')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )
        ) : (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>
            {t('prefs.multiagentSelectProjectHint')}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        id="multiagent-metrics"
        title={t('prefs.multiagentMetricsTitle')}
        description={t('prefs.multiagentMetricsDesc')}
      >
        {loadingTelemetry ? (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
            {t('prefs.multiagentLoadingMetrics')}
          </div>
        ) : Object.keys(metrics).length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>
            {t('prefs.multiagentNoMetrics')}
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
              gap: 8,
            }}
          >
            {Object.entries(metrics).map(([key, data]) => {
              const name = key.replace('alethe_event_', '').toUpperCase()
              return (
                <div
                  key={key}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-active)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div style={{ fontSize: 10, color: 'var(--fg-muted)', fontWeight: 600 }}>
                    {name}
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>{data.count}</div>
                  {data.last_value > 0 && (
                    <div style={{ fontSize: 9, color: 'var(--accent)', marginTop: 2 }}>
                      {t('prefs.multiagentLastValue', { value: data.last_value.toFixed(2) })}
                    </div>
                  )}
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
          <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
            {t('prefs.multiagentLoadingTraces')}
          </div>
        ) : traces.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>
            {t('prefs.multiagentNoTraces')}
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              maxHeight: 180,
              overflowY: 'auto',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: 8,
              background: 'var(--bg-active)',
            }}
          >
            {traces.map((trace, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 10,
                  paddingBottom: 4,
                  borderBottom: '1px solid color-mix(in srgb, var(--border) 40%, transparent)',
                }}
              >
                <div style={{ overflow: 'hidden', marginRight: 12 }}>
                  <span style={{ fontWeight: 600, color: 'var(--accent)' }}>
                    {trace.event_type}
                  </span>
                  {trace.task_id && (
                    <span style={{ color: 'var(--fg-muted)', marginLeft: 6 }}>
                      {t('prefs.multiagentTraceProject', { id: trace.task_id })}
                    </span>
                  )}
                  <div
                    style={{
                      color: 'var(--fg-muted)',
                      fontSize: 9,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {t('prefs.multiagentTraceCorrId', { id: trace.correlation_id })}
                  </div>
                </div>
                <div style={{ textAlign: 'right', color: 'var(--fg-muted)', flexShrink: 0 }}>
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <input
            type="checkbox"
            id="planningAutocommit"
            checked={autocommit}
            onChange={(e) => handleToggleAutocommit(e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
          <label
            htmlFor="planningAutocommit"
            style={{ fontSize: 11, cursor: 'pointer', userSelect: 'none' }}
          >
            {t('prefs.multiagentAutocommitLabel')}
          </label>
        </div>

        {selectedProjectId ? (
          loadingAudit ? (
            <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
              {t('prefs.multiagentLoadingAudit')}
            </div>
          ) : auditLogs.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>
              {t('prefs.multiagentNoAuditLogs')}
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                maxHeight: 180,
                overflowY: 'auto',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: 8,
                background: 'var(--bg-active)',
              }}
            >
              {auditLogs.map((log) => (
                <div
                  key={log.hash}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 10,
                    paddingBottom: 4,
                    borderBottom: '1px solid color-mix(in srgb, var(--border) 40%, transparent)',
                  }}
                >
                  <div>
                    <span
                      style={{
                        fontFamily: 'monospace',
                        fontWeight: 600,
                        color: 'var(--accent)',
                        marginRight: 6,
                      }}
                    >
                      {log.hash.slice(0, 7)}
                    </span>
                    <span>{log.subject}</span>
                    <div style={{ color: 'var(--fg-muted)', fontSize: 9 }}>
                      {t('prefs.multiagentAuditAuthor', { author: log.author })}
                      {log.agentId ? ` ${t('prefs.multiagentAuditAgent', { agentId: log.agentId })}` : ''}
                    </div>
                  </div>
                  <div
                    style={{
                      textAlign: 'right',
                      color: 'var(--fg-muted)',
                      fontSize: 9,
                      flexShrink: 0,
                    }}
                  >
                    {new Date(log.timestampMs).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>
            {t('prefs.multiagentSelectProjectAuditHint')}
          </div>
        )}
      </SettingsSection>
    </>
  )
}
