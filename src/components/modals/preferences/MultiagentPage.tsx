import { useCallback, useEffect, useState } from 'react'

import {
  getPlanningAutocommit,
  getTelemetryMetrics,
  getTelemetryTraces,
  planningAuditHistory,
  pluginInstall,
  pluginUninstall,
  pluginsList,
  setPlanningAutocommit,
} from '../../../lib/tauri'
import type {
  EventBusPayload,
  MetricData,
  PluginManifest,
  PlanningCommit,
} from '../../../lib/tauri'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useSchedulerStore } from '../../../stores/schedulerStore'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'
import { Dropdown } from '../../ui/Dropdown'

export function MultiagentPage() {
  const projects = useProjectsStore((state) => state.projects)
  const [selectedProjectId, setSelectedProjectId] = useState<string>(projects[0]?.id ?? '')
  const schedulerStore = useSchedulerStore()

  const [metrics, setMetrics] = useState<Record<string, MetricData>>({})
  const [traces, setTraces] = useState<EventBusPayload[]>([])
  const [loadingTelemetry, setLoadingTelemetry] = useState(true)

  const [plugins, setPlugins] = useState<PluginManifest[]>([])
  const [loadingPlugins, setLoadingPlugins] = useState(true)

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

  const loadPlugins = useCallback(async () => {
    try {
      const list = await pluginsList()
      setPlugins(list)
    } catch (err) {
      console.error('Falha ao listar plugins:', err)
    } finally {
      setLoadingPlugins(false)
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
    void loadPlugins()
    void loadAutocommitState()
  }, [loadPlugins, loadAutocommitState])

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

  const handleInstallPlugin = async () => {
    const raw = prompt('Cole o JSON do Manifest do plugin:')?.trim()
    if (!raw) return
    try {
      const manifest = JSON.parse(raw) as PluginManifest
      if (!manifest.name || !manifest.version || !manifest.kind) {
        alert('Invalid manifest. Fill in name, version, and kind.')
        return
      }
      await pluginInstall(manifest)
      alert('Plugin instalado com sucesso!')
      void loadPlugins()
    } catch (err) {
      alert('Erro ao instalar plugin: ' + err)
    }
  }

  const handleUninstallPlugin = async (id: string) => {
    if (confirm(`Tem certeza que deseja desinstalar o plugin "${id}"?`)) {
      try {
        await pluginUninstall(id)
        alert('Plugin desinstalado!')
        void loadPlugins()
      } catch (err) {
        alert('Erro ao desinstalar plugin: ' + err)
      }
    }
  }

  const handleToggleAutocommit = async (enabled: boolean) => {
    try {
      await setPlanningAutocommit(enabled)
      setAutocommit(enabled)
    } catch (err) {
      alert('Erro ao alterar autocommit: ' + err)
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
        title="Scheduler & task queue"
        description="Manage execution waves (Task DAG) per project."
      >
        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <Dropdown
            className={controls.input}
            value={selectedProjectId}
            onChange={setSelectedProjectId}
            ariaLabel="Select a project"
            options={[{ value: '', label: '-- Select a project --' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
          />

          {selectedProjectId && repoPath && (
            <button
              type="button"
              className={styles.secondaryButton}
              style={{ height: 32, padding: '0 12px', fontSize: 11 }}
              onClick={handleTick}
            >
              Run tick (force queue)
            </button>
          )}
        </div>

        {selectedProjectId ? (
          schedulerStore.loading ? (
            <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
              Carregando fila do projeto...
            </div>
          ) : schedulerStore.tasks.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>
              Nenhuma tarefa de planejamento (GSD) encontrada em `.planning/`.
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
                        Depende de:{' '}
                        <span style={{ fontFamily: 'monospace' }}>
                          {task.dependencies.join(', ')}
                        </span>
                      </div>
                    )}
                    {task.assignedAgentId && (
                      <div style={{ fontSize: 9, color: 'var(--accent)', marginTop: 2 }}>
                        Alocado para: Agente {task.assignedAgentId}
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
                      Cancelar
                    </button>
                  )}
                </div>
              ))}
            </div>
          )
        ) : (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>
            Select a project to inspect and orchestrate its tasks.
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        id="multiagent-metrics"
        title="Execution metrics (phases 1/2)"
        description="Accumulated global counters from the internal event bus."
      >
        {loadingTelemetry ? (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>Loading metrics...</div>
        ) : Object.keys(metrics).length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>
            No accumulated event metrics.
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
                      Last: {data.last_value.toFixed(2)}
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
        title="Recent event history"
        description="Real-time tracking of structured Event Bus logs."
      >
        {loadingTelemetry ? (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>Loading traces...</div>
        ) : traces.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>
            No recent events recorded.
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
                      Task: {trace.task_id}
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
                    CorrId: {trace.correlation_id}
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
        id="multiagent-plugins"
        title="Plugin manager"
        description="View and install orchestrator plugins and custom tools."
      >
        <button
          type="button"
          className={styles.secondaryButton}
          style={{ marginBottom: 12, fontSize: 11 }}
          onClick={handleInstallPlugin}
        >
          Install new plugin (JSON)
        </button>

        {loadingPlugins ? (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>Carregando plugins...</div>
        ) : plugins.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>
            Nenhum plugin instalado no momento.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {plugins.map((plug) => (
              <div
                key={plug.name}
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
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {plug.name} (v{plug.version})
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--fg-muted)' }}>Tipo: {plug.kind}</div>
                  <div style={{ fontSize: 10, color: 'var(--fg-muted)', marginTop: 2 }}>
                    {plug.description}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleUninstallPlugin(plug.name)}
                  style={{
                    padding: '4px 8px',
                    fontSize: 10,
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--status-failed-bg, #4c1d1d)',
                    color: '#ff8888',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  Desinstalar
                </button>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        id="multiagent-gsd-audit"
        title="GSD audit & autocommit"
        description="Monitor task changes in `.planning/` and configure automatic audit commits."
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
            Ativar Auto-commit de Auditoria (Opt-in)
          </label>
        </div>

        {selectedProjectId ? (
          loadingAudit ? (
            <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
              Carregando logs de auditoria...
            </div>
          ) : auditLogs.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>
              No changes recorded in `.planning/` through Git.
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
                      Autor: {log.author} {log.agentId ? `· Agente: ${log.agentId}` : ''}
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
            Select a project above to view the GSD audit history.
          </div>
        )}
      </SettingsSection>
    </>
  )
}
