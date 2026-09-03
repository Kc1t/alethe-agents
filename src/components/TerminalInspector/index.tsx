import {
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  History,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Power,
  RefreshCw,
  TerminalSquare,
  Trash2,
} from 'lucide-react'
import { type ReactNode,useMemo, useState } from 'react'

import { preparePtyRuntimeLaunch } from '../../lib/agentRuntimeAdapter'
import { useT } from '../../lib/i18n'
import { buildAgentLaunch } from '../../lib/sessionLaunch'
import {
  getPtyCwd,
  openInBrowser,
  openInFileExplorer,
  openInVscode,
  restartPty,
} from '../../lib/tauri'
import { agentCliCommand, type SubTab, type Terminal } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { AgentIcon, VSCodeIcon } from '../icons/AgentIcons'
import { ClaudeHistoryModal } from '../modals/ClaudeHistoryModal'
import styles from './TerminalInspector.module.css'

function findSelection(
  projects: ReturnType<typeof useProjectsStore.getState>['projects'],
  activeTerminal: { projectId: string; terminalId: string } | null,
) {
  if (!activeTerminal) return null
  const project = projects.find((item) => item.id === activeTerminal.projectId)
  if (!project) return null
  const terminal = project.terminals.find((item) => item.id === activeTerminal.terminalId)
  if (!terminal) return null
  return { project, terminal }
}

export function TerminalInspector() {
  const projects = useProjectsStore((state) => state.projects)
  const activeTerminal = useUiStore((state) => state.activeTerminal)
  const selection = useMemo(
    () => findSelection(projects, activeTerminal),
    [activeTerminal, projects],
  )

  if (!selection) return null
  return <InspectorBody projectId={selection.project.id} terminal={selection.terminal} />
}

function InspectorBody({ projectId, terminal }: { projectId: string; terminal: Terminal }) {
  const t = useT()
  const [historyOpen, setHistoryOpen] = useState(false)
  const focusedTerminalId = useUiStore((state) => state.focusedTerminalId)
  const setFocusedTerminal = useUiStore((state) => state.setFocusedTerminal)
  const requestPaneFocus = useUiStore((state) => state.requestPaneFocus)
  const openModal = useUiStore((state) => state.openModal_)
  const terminalTheme = useProjectsStore(
    (state) => state.preferences.terminalTheme ?? state.preferences.uiTheme,
  )
  const setActiveTab = useProjectsStore((state) => state.setActiveTab)
  const setLaneVisible = useProjectsStore((state) => state.setLaneVisible)
  const setTerminalDisabled = useProjectsStore((state) => state.setTerminalDisabled)
  const killTerminal = useProjectsStore((state) => state.killTerminal)
  const deleteTerminal = useProjectsStore((state) => state.deleteTerminal)
  const setSubTabSessionId = useProjectsStore((state) => state.setSubTabSessionId)
  const activeTab = useMemo(
    () => terminal.tabs.find((tab) => tab.id === terminal.activeTabId) ?? terminal.tabs[0],
    [terminal.activeTabId, terminal.tabs],
  )
  const runtime = useTerminalsStore((state) =>
    activeTab?.ptyId ? (state.byPtyId[activeTab.ptyId] ?? null) : null,
  )
  const status = terminal.disabled
    ? 'disabled'
    : (runtime?.status ?? (activeTab ? 'waiting' : 'stopped'))
  const isFocusMode = focusedTerminalId === terminal.id
  const effectiveLaneVisible = terminal.tabs.length > 1 ? true : terminal.laneVisible === true
  const cwd = activeTab?.cwd?.trim() || terminal.cwd?.trim() || ''
  const detailsPath = terminal.url || terminal.filePath || cwd
  const isTerminalPane = !terminal.kind || terminal.kind === 'terminal'
  const isFilePane = terminal.kind === 'markdown' || terminal.kind === 'file'
  const isWebPane = terminal.kind === 'web'
  const isAgentWithHistory =
    activeTab &&
    (activeTab.type === 'claude' || activeTab.type === 'codex' || activeTab.type === 'opencode')

  const resolveCwd = async (): Promise<string | null> => {
    if (cwd) return cwd
    if (activeTab?.ptyId) {
      try {
        const live = await getPtyCwd(activeTab.ptyId)
        if (live && live.trim()) return live
      } catch {
        /* live cwd is best-effort */
      }
    }
    return null
  }

  const openWithCwd = async (action: (path: string) => Promise<void>, label: string) => {
    const path = await resolveCwd()
    if (!path) {
      window.alert(t('ui.terminal.noCwdAvailable', { label }))
      return
    }
    try {
      await action(path)
    } catch (err) {
      window.alert(t('ui.terminal.openFailed', { label, error: String(err) }))
    }
  }

  const onRestart = async () => {
    if (!activeTab?.ptyId || terminal.disabled) return
    const preparedRuntime = preparePtyRuntimeLaunch(
      activeTab.type,
      activeTab.runtimeProfile,
      activeTab.extraArgs ?? [],
    )
    const launch = buildAgentLaunch(activeTab.type, preparedRuntime.args, activeTab.sessionId)
    if (launch.sessionId && launch.sessionId !== activeTab.sessionId) {
      setSubTabSessionId(projectId, terminal.id, activeTab.id, launch.sessionId)
    }
    useTerminalsStore.getState().beginRestart(activeTab.ptyId)
    try {
      await restartPty({
        id: activeTab.ptyId,
        cols: 80,
        rows: 24,
        command: agentCliCommand(activeTab.type),
        cwd: activeTab.cwd || undefined,
        extraArgs: launch.args,
        env: preparedRuntime.env,
      })
      window.dispatchEvent(
        new CustomEvent('alethe:terminal-resize-request', { detail: { ptyId: activeTab.ptyId } }),
      )
    } catch (err) {
      window.alert(
        t('ui.terminal.openFailed', { label: t('ui.terminal.restart'), error: String(err) }),
      )
    }
  }

  const onKill = () => {
    killTerminal(projectId, terminal.id)
    if (isFocusMode) setFocusedTerminal(null)
  }

  const onDeletePane = () => {
    const key = isWebPane ? 'webPane.confirmClose' : 'ui.markdown.confirmClose'
    if (!window.confirm(t(key, { name: terminal.name }))) return
    deleteTerminal(projectId, terminal.id)
    if (isFocusMode) setFocusedTerminal(null)
  }

  return (
    <section className={styles.inspector} aria-label={t('terminalInspector.title')}>
      <header className={styles.header}>
        <div className={styles.icon}>
          {isTerminalPane && activeTab ? (
            <AgentIcon type={activeTab.type} size={16} theme={terminalTheme} />
          ) : (
            <TerminalSquare size={15} />
          )}
        </div>
        <div className={styles.titleBlock}>
          <span className={styles.eyebrow}>{t('terminalInspector.title')}</span>
          <strong className={styles.name} title={terminal.name}>
            {terminal.name}
          </strong>
        </div>
        <span className={`${styles.status} ${styles[`status_${status}`] ?? ''}`} title={status} />
      </header>

      {detailsPath ? (
        <div className={styles.path} title={detailsPath}>
          {detailsPath}
        </div>
      ) : null}

      <div className={styles.actionsGrid}>
        <InspectorAction
          icon={isFocusMode ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          label={isFocusMode ? t('ui.terminal.exitFocusMode') : t('ui.terminal.focusMode')}
          onClick={() => setFocusedTerminal(isFocusMode ? null : terminal.id)}
        />
        <InspectorAction
          icon={<TerminalSquare size={14} />}
          label={t('terminalInspector.reveal')}
          onClick={() => requestPaneFocus(terminal.id)}
        />
        {isTerminalPane ? (
          <>
            <InspectorAction
              icon={<FolderOpen size={14} />}
              label={t('ui.terminal.openInExplorer')}
              onClick={() => void openWithCwd(openInFileExplorer, 'Explorer')}
            />
            <InspectorAction
              icon={<VSCodeIcon size={14} />}
              label={t('ui.terminal.openInVscode')}
              onClick={() => void openWithCwd(openInVscode, 'VS Code')}
            />
            <InspectorAction
              icon={<RefreshCw size={14} />}
              label={t('ui.terminal.restart')}
              onClick={() => void onRestart()}
              disabled={!activeTab?.ptyId || terminal.disabled}
            />
            <InspectorAction
              icon={terminal.disabled ? <Eye size={14} /> : <EyeOff size={14} />}
              label={terminal.disabled ? t('ui.sidebar.reactivate') : t('ui.terminal.disable')}
              onClick={() => setTerminalDisabled(projectId, terminal.id, !terminal.disabled)}
            />
            <InspectorAction
              icon={
                effectiveLaneVisible ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />
              }
              label={
                effectiveLaneVisible ? t('ui.terminal.hideTabsLane') : t('ui.terminal.showTabsLane')
              }
              onClick={() =>
                setLaneVisible(projectId, terminal.id, effectiveLaneVisible ? false : true)
              }
              disabled={terminal.tabs.length > 1}
            />
            {isAgentWithHistory ? (
              <InspectorAction
                icon={<History size={14} />}
                label={t('ui.terminal.history')}
                onClick={() => setHistoryOpen(true)}
              />
            ) : null}
            <InspectorAction
              icon={<Power size={14} />}
              label={t('ui.terminal.kill')}
              onClick={onKill}
              danger
            />
          </>
        ) : null}
        {isFilePane ? (
          <>
            <InspectorAction
              icon={<FolderOpen size={14} />}
              label={t('ui.terminal.openInExplorer')}
              onClick={() => void openInFileExplorer(parentDir(terminal.filePath ?? ''))}
              disabled={!terminal.filePath}
            />
            <InspectorAction
              icon={<Trash2 size={14} />}
              label={t('ui.markdown.close')}
              onClick={onDeletePane}
              danger
            />
          </>
        ) : null}
        {isWebPane ? (
          <>
            <InspectorAction
              icon={<ExternalLink size={14} />}
              label={t('xterm.openInBrowser')}
              onClick={() => void openInBrowser(terminal.url ?? '')}
              disabled={!terminal.url}
            />
            <InspectorAction
              icon={<Trash2 size={14} />}
              label={t('webPane.close')}
              onClick={onDeletePane}
              danger
            />
          </>
        ) : null}
      </div>

      {isTerminalPane ? (
        <div className={styles.tabs}>
          <div className={styles.sectionTitle}>
            <span>{t('terminalInspector.tabs')}</span>
            <button
              type="button"
              className={styles.addTab}
              onClick={() => openModal('newSubTab', { projectId, terminalId: terminal.id })}
            >
              {t('ui.subtabs.newTab')}
            </button>
          </div>
          {terminal.tabs.map((tab) => (
            <TabRow
              key={tab.id}
              tab={tab}
              active={tab.id === terminal.activeTabId}
              onClick={() => setActiveTab(projectId, terminal.id, tab.id)}
            />
          ))}
        </div>
      ) : null}

      {activeTab && isAgentWithHistory ? (
        <ClaudeHistoryModal
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          projectId={projectId}
          terminalId={terminal.id}
          tabId={activeTab.id}
          ptyId={activeTab.ptyId}
          cwd={cwd}
          agentType={activeTab.type}
          extraArgs={activeTab.extraArgs}
        />
      ) : null}
    </section>
  )
}

function InspectorAction({
  icon,
  label,
  onClick,
  disabled = false,
  danger = false,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      className={`${styles.action} ${danger ? styles.actionDanger : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function TabRow({ tab, active, onClick }: { tab: SubTab; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`${styles.tabRow} ${active ? styles.tabRowActive : ''}`}
      onClick={onClick}
      title={tab.cwd || tab.name}
    >
      <span className={styles.tabType}>{tab.type}</span>
      <span className={styles.tabName}>{tab.name}</span>
      {tab.completionUnread ? <span className={styles.unread} /> : null}
    </button>
  )
}

function parentDir(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return idx > 0 ? cleaned.slice(0, idx) : cleaned
}
