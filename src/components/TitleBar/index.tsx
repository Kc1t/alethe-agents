import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  ArrowLeft,
  ArrowRight,
  Maximize2,
  Menu,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Pin,
  RefreshCw,
  Newspaper,
  Smartphone,
  Users,
  Workflow,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { ContextMenu, type MenuItem } from '../ProjectSidebar/ContextMenu'
import { AntigravityIcon, ClaudeIcon, CodexIcon } from '../icons/AgentIcons'

import { getCachedClaudeUsage } from '../../lib/claudeUsageCache'
import { getCachedCodexUsage } from '../../lib/codexUsageCache'
import { getCachedAntigravityUsage } from '../../lib/antigravityUsageCache'
import { requestAppClose } from '../../hooks/useCloseConfirmation'
import { observeClaudeReset, observeCodexReset } from '../../lib/limitResetWatch'
import { useT } from '../../lib/i18n'
import { formatShortcut } from '../../lib/platform'
import { killPty, remoteControlConnectedDevices } from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './TitleBar.module.css'

const CLAUDE_POLL_INTERVAL_MS = 5 * 60_000
const REMOTE_CONTROL_POLL_INTERVAL_MS = 2_000
const APP_TITLE = import.meta.env.DEV ? '(DEV) Alethe' : 'Alethe'

function usagePillColor(utilization: number): string {
  if (utilization >= 80) return 'var(--status-offline)'
  if (utilization >= 50) return 'var(--status-waiting)'
  return 'var(--status-working)'
}

function formatResetTime(resetsAt: string): string {
  try {
    const diff = new Date(resetsAt).getTime() - Date.now()
    if (diff <= 0) return 'resetting...'
    const h = Math.floor(diff / 3_600_000)
    const m = Math.floor((diff % 3_600_000) / 60_000)
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  } catch {
    return resetsAt
  }
}

function formatPct(value: number): string {
  return `${value.toFixed(0)}%`
}

function MemoryPillButton({ ramMb }: { ramMb: number }) {
  const memoryStats = useUiStore((s) => s.memoryStats)
  const openModal = useUiStore((s) => s.openModal_)
  const t = useT()
  const availableMb = memoryStats?.system_available_mb ?? 16384

  let pressureClass = ''
  if (availableMb < 256) {
    pressureClass = styles.ramPressureCritical
  } else if (availableMb < 512) {
    pressureClass = styles.ramPressureHigh
  } else if (availableMb < 1024) {
    pressureClass = styles.ramPressureMedium
  } else if (availableMb < 2048) {
    pressureClass = styles.ramPressureLow
  }

  return (
    <button
      type="button"
      className={`${styles.ramPill} ${pressureClass}`}
      title={`${t('ui.titlebar.openMemoryAnalytics')} · ${availableMb.toFixed(0)} MB livre`}
      onClick={() => openModal('memoryAnalytics')}
    >
      {ramMb.toFixed(0)} MB
    </button>
  )
}

export function TitleBar() {
  const t = useT()
  const toggleMainMenu = useUiStore((s) => s.toggleMainMenu)
  const activeView = useUiStore((s) => s.activeView)
  const agentCanvasSession = useUiStore((s) => s.agentCanvasSession)
  const setAgentCanvasSession = useUiStore((s) => s.setAgentCanvasSession)
  const setActiveView = useUiStore((s) => s.setActiveView)
  const ramMb = useUiStore((s) => s.ramMb)
  const claudeUsage = useUiStore((s) => s.claudeUsage)
  const codexUsage = useUiStore((s) => s.codexUsage)
  const antigravityUsage = useUiStore((s) => s.antigravityUsage)
  const updateInfo = useUiStore((s) => s.updateInfo)
  const setClaudeUsage = useUiStore((s) => s.setClaudeUsage)
  const setCodexUsage = useUiStore((s) => s.setCodexUsage)
  const setAntigravityUsage = useUiStore((s) => s.setAntigravityUsage)
  const openModal = useUiStore((s) => s.openModal_)
  const workspaceTabs = useProjectsStore((s) => s.workspace.tabs)
  const activeWorkspaceTabId = useProjectsStore((s) => s.workspace.activeTabId)
  const historyIndex = useProjectsStore((s) => s.workspace.historyIndex)
  const historyLength = useProjectsStore((s) => s.workspace.history.length)
  const profiles = useProjectsStore((s) => s.profiles)
  const activeProfileId = useProjectsStore((s) => s.activeProfileId)
  const preferences = useProjectsStore((s) => s.preferences)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const rightPanelEnabled =
    preferences.enabledFeatures.todos ||
    preferences.enabledFeatures.mcp ||
    (preferences.enabledFeatures.git && preferences.gitControlPlacement === 'right')
  const toggleWorkspaceTabPinned = useProjectsStore((s) => s.toggleWorkspaceTabPinned)
  const closeSavedWorkspaceTab = useProjectsStore((s) => s.closeSavedWorkspaceTab)
  const addWorkspaceTabToCurrent = useProjectsStore((s) => s.addWorkspaceTabToCurrent)
  const activateWorkspaceTab = useProjectsStore((s) => s.activateWorkspaceTab)
  const navigateWorkspaceHistory = useProjectsStore((s) => s.navigateWorkspaceHistory)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [remoteConnectedDevices, setRemoteConnectedDevices] = useState(0)
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null
  const threeAreas = preferences.topbarStyle === 'three-areas'
  const antigravityReady =
    antigravityUsage?.status === 'ready' && antigravityUsage.buckets.length > 0
  const remoteConnectedLabel = t(
    remoteConnectedDevices === 1
      ? 'remote.topbarDeviceConnected'
      : 'remote.topbarDevicesConnected',
    { count: remoteConnectedDevices },
  )

  const closeAgentPlanning = () => {
    if (!agentCanvasSession) return
    if (activeView === 'agentCanvas') {
      window.dispatchEvent(new CustomEvent('alethe:agent-canvas-exit'))
      return
    }
    void killPty(agentCanvasSession.ptyId).catch(() => {
                                   
    })
    setAgentCanvasSession(null)
  }

                                                                             
                                                                        
  const activeRef = useRef(true)

  useEffect(() => {
    let cancelled = false
    const refreshRemoteDevices = async () => {
      if (!activeRef.current) return
      try {
        const connectedDevices = await remoteControlConnectedDevices()
        if (!cancelled) {
          setRemoteConnectedDevices(connectedDevices)
        }
      } catch {
        if (!cancelled) setRemoteConnectedDevices(0)
      }
    }
    void refreshRemoteDevices()
    const interval = window.setInterval(
      () => void refreshRemoteDevices(),
      REMOTE_CONTROL_POLL_INTERVAL_MS,
    )
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])

                                                                            
  useEffect(() => {
    let cancelled = false
    let interval: number | null = null
    let consecutiveFailures = 0
    const tick = async () => {
      if (!activeRef.current) return
      try {
        const usage = await getCachedClaudeUsage()
        if (!cancelled) {
          setClaudeUsage(usage)
          observeClaudeReset(usage)
          consecutiveFailures = 0
        }
      } catch {
                                                                               
                                                                                  
        consecutiveFailures += 1
        if (consecutiveFailures >= 3 && !cancelled) {
          setClaudeUsage(null)
        }
      }
    }
    const startupDelay = window.setTimeout(() => {
      void tick()
      interval = window.setInterval(tick, CLAUDE_POLL_INTERVAL_MS)
    }, 1500)
    return () => {
      cancelled = true
      window.clearTimeout(startupDelay)
      if (interval !== null) window.clearInterval(interval)
    }
  }, [setClaudeUsage])

                                                                                
                                                                       
  useEffect(() => {
    let cancelled = false
    let interval: number | null = null
    let consecutiveFailures = 0
    const tick = async () => {
      if (!activeRef.current) return
      try {
        const usage = await getCachedCodexUsage()
        if (!cancelled) {
          setCodexUsage(usage)
          observeCodexReset(usage)
          consecutiveFailures = 0
        }
      } catch {
        consecutiveFailures += 1
        if (consecutiveFailures >= 3 && !cancelled) {
          setCodexUsage(null)
        }
      }
    }
    const startupDelay = window.setTimeout(() => {
      void tick()
      interval = window.setInterval(tick, CLAUDE_POLL_INTERVAL_MS)
    }, 2500)
    return () => {
      cancelled = true
      window.clearTimeout(startupDelay)
      if (interval !== null) window.clearInterval(interval)
    }
  }, [setCodexUsage])

                                                                                                     
  useEffect(() => {
    let cancelled = false
    let interval: number | null = null
    const tick = async () => {
      if (!activeRef.current) return
      try {
        const usage = await getCachedAntigravityUsage()
        if (!cancelled) {
          setAntigravityUsage(usage)
        }
      } catch {
        if (!cancelled) {
          setAntigravityUsage(null)
        }
      }
    }
    const startupDelay = window.setTimeout(() => {
      void tick()
      interval = window.setInterval(tick, CLAUDE_POLL_INTERVAL_MS)
    }, 3000)
    return () => {
      cancelled = true
      window.clearTimeout(startupDelay)
      if (interval !== null) window.clearInterval(interval)
    }
  }, [setAntigravityUsage])

  const win = getCurrentWindow()

                                                                             
  useEffect(() => {
    const update = (focused: boolean) => {
      activeRef.current = focused && document.visibilityState === 'visible'
    }
    update(document.hasFocus())
    const onVisibility = () => update(document.hasFocus())
    document.addEventListener('visibilitychange', onVisibility)
    let unlisten: (() => void) | undefined
    void win
      .onFocusChanged(({ payload }) => update(payload))
      .then((fn) => {
        unlisten = fn
      })
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      unlisten?.()
    }
  }, [win])

  useEffect(() => {
    document.title = APP_TITLE
    void win.setTitle(APP_TITLE)
  }, [win])

  return (
    <div
      className={styles.bar}
      data-style={preferences.topbarStyle}
      data-tauri-drag-region
      style={
        {
          '--topbar-left-width': preferences.leftSidebarVisible
            ? `${preferences.leftSidebarWidth}px`
            : '38px',
          '--topbar-right-width': preferences.rightSidebarVisible
            ? `${preferences.rightSidebarWidth}px`
            : '38px',
        } as React.CSSProperties
      }
    >
      <div className={styles.barStart}>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={toggleMainMenu}
          title={t('ui.titlebar.menu')}
          aria-label={t('ui.titlebar.menu')}
        >
          <Menu size={14} />
        </button>
        <button
          type="button"
          className={`${styles.iconBtn} ${preferences.leftSidebarVisible ? styles.iconBtnActive : ''}`}
          onClick={() => setPreferences({ leftSidebarVisible: !preferences.leftSidebarVisible })}
          title={`${
            preferences.leftSidebarVisible
              ? t('ui.titlebar.closeSidebar')
              : t('ui.titlebar.openSidebar')
          } (${formatShortcut('Ctrl+B')})`}
          aria-label={
            preferences.leftSidebarVisible
              ? t('ui.titlebar.closeSidebar')
              : t('ui.titlebar.openSidebar')
          }
          aria-pressed={preferences.leftSidebarVisible}
        >
          {preferences.leftSidebarVisible ? (
            <PanelLeftClose size={14} />
          ) : (
            <PanelLeftOpen size={14} />
          )}
        </button>
        {threeAreas ? (
          <button
            type="button"
            className={`${styles.iconBtn} ${updateInfo ? styles.whatsNewPending : ''}`}
            onClick={() => openModal('whatsNew')}
            title={t('whatsNew.button')}
            aria-label={t('whatsNew.button')}
          >
            <Newspaper size={13} />
            {updateInfo ? <span className={styles.whatsNewDot} /> : null}
          </button>
        ) : null}
      </div>
      {workspaceTabs.length > 0 || agentCanvasSession ? (
        <div
          className={styles.groupTabs}
          role="tablist"
          aria-label={t('ui.titlebar.recentTabs')}
          data-tauri-drag-region
        >
          <div className={styles.historyControls}>
            <button
              type="button"
              className={styles.historyBtn}
              disabled={historyIndex <= 0}
              onClick={() => {
                navigateWorkspaceHistory(-1)
                setActiveView('workspace')
              }}
              title={t('ui.titlebar.back')}
              aria-label={t('ui.titlebar.back')}
            >
              <ArrowLeft size={13} />
            </button>
            <button
              type="button"
              className={styles.historyBtn}
              disabled={historyIndex < 0 || historyIndex >= historyLength - 1}
              onClick={() => {
                navigateWorkspaceHistory(1)
                setActiveView('workspace')
              }}
              title={t('ui.titlebar.forward')}
              aria-label={t('ui.titlebar.forward')}
            >
              <ArrowRight size={13} />
            </button>
          </div>
          {workspaceTabs.map((tab) => {
            const active = activeWorkspaceTabId === tab.id
            const count = tab.snapshot.containers.reduce(
              (total, container) => total + container.paneIds.length,
              0,
            )
            return (
              <div
                key={tab.id}
                className={`${styles.groupTab} ${active ? styles.groupTabActive : ''} ${tab.pinned ? styles.groupTabPinned : ''}`}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setTabMenu({
                    x: event.clientX,
                    y: event.clientY,
                    items: [
                      {
                        kind: 'item',
                        label: t('ui.workspace.openIndividually'),
                        onClick: () => {
                          activateWorkspaceTab(tab.id)
                          setActiveView('workspace')
                        },
                      },
                      {
                        kind: 'item',
                        label: t('ui.workspace.addToCurrent'),
                        onClick: () => {
                          addWorkspaceTabToCurrent(tab.id)
                          setActiveView('workspace')
                        },
                      },
                      { kind: 'separator' },
                      {
                        kind: 'item',
                        label: tab.pinned ? t('ui.titlebar.unpinTab') : t('ui.titlebar.pinTab'),
                        onClick: () => toggleWorkspaceTabPinned(tab.id),
                      },
                      { kind: 'separator' },
                      {
                        kind: 'item',
                        label: t('ui.titlebar.removeFromTopbar'),
                        danger: true,
                        onClick: () => closeSavedWorkspaceTab(tab.id),
                      },
                    ],
                  })
                }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={styles.groupTabMain}
                  onClick={() => {
                    activateWorkspaceTab(tab.id)
                    setActiveView('workspace')
                  }}
                  title={tab.label}
                >
                  {tab.pinned ? <Pin size={11} className={styles.groupTabPinIcon} /> : null}
                  {tab.iconUrl ? (
                    <img src={tab.iconUrl} alt="" className={styles.groupTabIcon} />
                  ) : tab.kind === 'composition' ? (
                    <Workflow size={14} className={styles.groupTabIconSvg} />
                  ) : (
                    <span
                      className={styles.groupTabDot}
                      style={{ background: tab.color ?? '#6ea8ff' }}
                    />
                  )}
                  <span className={styles.groupTabName}>{tab.label}</span>
                  <span className={styles.groupTabCount}>{count}</span>
                </button>
                <button
                  type="button"
                  className={styles.groupTabClose}
                  onClick={(event) => {
                    event.stopPropagation()
                    closeSavedWorkspaceTab(tab.id)
                  }}
                  title={t('ui.titlebar.removeFromTopbar')}
                  aria-label={t('ui.titlebar.removeNameFromTopbar', { name: tab.label })}
                >
                  <X size={11} />
                </button>
              </div>
            )
          })}
          {agentCanvasSession ? (
            <div
              className={`${styles.groupTab} ${activeView === 'agentCanvas' ? styles.groupTabActive : ''}`}
              title={agentCanvasSession.folder}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeView === 'agentCanvas'}
                className={styles.groupTabMain}
                onClick={() => setActiveView('agentCanvas')}
                title={agentCanvasSession.folder}
              >
                <Workflow size={14} className={styles.groupTabIconSvg} />
                <span className={styles.groupTabName}>Agent Planning</span>
              </button>
              <button
                type="button"
                className={styles.groupTabClose}
                onClick={(event) => {
                  event.stopPropagation()
                  closeAgentPlanning()
                }}
                title={t('ui.titlebar.closeAgentPlanning')}
                aria-label={t('ui.titlebar.closeAgentPlanning')}
              >
                <X size={11} />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={styles.spacer} data-tauri-drag-region />
      <div className={styles.barEnd}>
        <div className={styles.widgets}>
          <div className={styles.utilityGroup}>
            {!threeAreas ? <button
              type="button"
              className={`${styles.iconBtn} ${updateInfo ? styles.whatsNewPending : ''}`}
              onClick={() => openModal('whatsNew')}
              title={t('whatsNew.button')}
              aria-label={t('whatsNew.button')}
            >
              <Newspaper size={13} />
              {updateInfo ? <span className={styles.whatsNewDot} /> : null}
            </button> : null}
            {!threeAreas && preferences.topbarShowSync ? (
              <button
                type="button"
                className={styles.syncPill}
                title={t('sync.title')}
                aria-label={t('sync.title')}
                onClick={() => openModal('sync')}
              >
                <RefreshCw size={12} />
              </button>
            ) : null}
            {!threeAreas && preferences.topbarShowProfile ? (
              <button
                type="button"
                className={styles.profilePill}
                title={t('profile.manageAccounts')}
                onClick={() => openModal('profiles')}
              >
                <Users size={12} />
                <span className={styles.profilePillLabel}>
                  {activeProfile?.name ?? t('profile.localAccount')}
                </span>
              </button>
            ) : null}
          </div>
          <div className={styles.statusGroup}>
            {remoteConnectedDevices > 0 ? (
              <button
                type="button"
                className={styles.remoteDevicePill}
                onClick={() => openModal('remoteControl')}
                title={remoteConnectedLabel}
                aria-label={remoteConnectedLabel}
              >
                <Smartphone size={12} />
                <span>{remoteConnectedLabel}</span>
              </button>
            ) : null}
            {preferences.topbarShowClaudeUsage && claudeUsage !== null ? (
              <div className={styles.usageWidget}>
                <button
                  type="button"
                  className={`${styles.usagePill} ${styles.claudeUsage}`}
                  style={
                    {
                      '--pill-color': usagePillColor(claudeUsage.five_hour.utilization),
                    } as React.CSSProperties
                  }
                  onClick={() => openModal('aiUsage')}
                  title={t('ui.titlebar.openUsageDetails')}
                  aria-label={t('ui.titlebar.openUsageDetails')}
                >
                  <ClaudeIcon size={13} />
                  <span>{claudeUsage.five_hour.utilization.toFixed(0)}%</span>
                </button>
                <div
                  className={styles.usagePopover}
                  role="tooltip"
                  aria-label={t('ui.titlebar.itemClaude')}
                >
                  <div className={styles.usagePopoverTitle}>{t('ui.titlebar.itemClaude')}</div>
                  <div className={styles.usagePopoverMain}>
                    <span>{t('widget.usage5h')}</span>
                    <strong>{formatPct(claudeUsage.five_hour.utilization)}</strong>
                  </div>
                  <div className={styles.usagePopoverLine}>
                    <span>{t('widget.week')}</span>
                    <strong>{formatPct(claudeUsage.seven_day.utilization)}</strong>
                  </div>
                  <div className={styles.usagePopoverLine}>
                    <span>{t('ws.usageOpusLabel')}</span>
                    <strong>{formatPct(claudeUsage.seven_day_opus.utilization)}</strong>
                  </div>
                  <div className={styles.usagePopoverFooter}>
                    {t('widget.resetLabel', { w: '5h' })} ·{' '}
                    {formatResetTime(claudeUsage.five_hour.resets_at)}
                  </div>
                </div>
              </div>
            ) : null}
            {preferences.topbarShowCodexUsage && codexUsage !== null ? (
              <div className={styles.usageWidget}>
                <button
                  type="button"
                  className={`${styles.usagePill} ${styles.codexUsage}`}
                  style={
                    {
                      '--pill-color': usagePillColor(codexUsage.primary.used_percent),
                    } as React.CSSProperties
                  }
                  onClick={() => openModal('aiUsage')}
                  title={t('ui.titlebar.openUsageDetails')}
                  aria-label={t('ui.titlebar.openUsageDetails')}
                >
                  <CodexIcon size={13} />
                  <span>{codexUsage.primary.used_percent.toFixed(0)}%</span>
                </button>
                <div
                  className={styles.usagePopover}
                  role="tooltip"
                  aria-label={t('ui.titlebar.itemCodex')}
                >
                  <div className={styles.usagePopoverTitle}>{t('ui.titlebar.itemCodex')}</div>
                  <div className={styles.usagePopoverMain}>
                    <span>{t('widget.usage5h')}</span>
                    <strong>{formatPct(codexUsage.primary.used_percent)}</strong>
                  </div>
                  <div className={styles.usagePopoverLine}>
                    <span>{t('widget.week')}</span>
                    <strong>{formatPct(codexUsage.secondary.used_percent)}</strong>
                  </div>
                  <div className={styles.usagePopoverLine}>
                    <span>{t('widget.statusLabel')}</span>
                    <strong>
                      {codexUsage.rate_limited ? t('widget.statusLimited') : t('widget.statusOk')}
                    </strong>
                  </div>
                  <div className={styles.usagePopoverFooter}>
                    {t('widget.creditsLabel')} · {codexUsage.reset_credits}
                  </div>
                </div>
              </div>
            ) : null}
            {preferences.topbarShowAntigravityUsage && antigravityUsage !== null ? (
              <div className={styles.usageWidget}>
                <button
                  type="button"
                  className={`${styles.usagePill} ${styles.antigravityUsage}`}
                  style={
                    {
                      '--pill-color': antigravityReady
                        ? usagePillColor(antigravityUsage.used_percent)
                        : 'var(--fg-faint)',
                    } as React.CSSProperties
                  }
                  onClick={() => openModal('aiUsage')}
                  title={t('ui.titlebar.openUsageDetails')}
                  aria-label={t('ui.titlebar.openUsageDetails')}
                >
                  <AntigravityIcon size={13} />
                  <span>{antigravityReady ? formatPct(antigravityUsage.used_percent) : '—'}</span>
                </button>
                <div
                  className={styles.usagePopover}
                  role="tooltip"
                  aria-label={t('ui.titlebar.itemAntigravity')}
                >
                  <div className={styles.usagePopoverTitle}>{t('ui.titlebar.itemAntigravity')}</div>
                  {antigravityReady ? (
                    <>
                      <div className={styles.usagePopoverMain}>
                        <span>{t('widget.mostUsed')}</span>
                        <strong>{formatPct(antigravityUsage.used_percent)}</strong>
                      </div>
                      {antigravityUsage.buckets.map((bucket) => (
                        <div
                          className={styles.usagePopoverLine}
                          key={`${bucket.label}:${bucket.resets_at}`}
                        >
                          <span title={bucket.models.join(', ')}>{bucket.label}</span>
                          <strong>
                            {formatPct(bucket.used_percent)} · {formatResetTime(bucket.resets_at)}
                          </strong>
                        </div>
                      ))}
                    </>
                  ) : (
                    <div className={styles.usagePopoverMain}>
                      <span>{t('widget.statusLabel')}</span>
                      <strong>
                        {antigravityUsage.status === 'no_cli'
                          ? t('widget.antigravityNotInstalled')
                          : antigravityUsage.status === 'no_auth'
                            ? t('widget.antigravityNotSignedIn')
                            : t('widget.usageUnavailable')}
                      </strong>
                    </div>
                  )}
                  {antigravityUsage.cli_path ? (
                    <div className={styles.usagePopoverFooter} title={antigravityUsage.cli_path}>
                      {antigravityUsage.cli_path.split(/[\\/]/).pop()}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
            {preferences.topbarShowMemory && ramMb !== null ? (
              <MemoryPillButton ramMb={ramMb} />
            ) : null}
            <button
              type="button"
              className={styles.editWidgets}
              title={t('ui.titlebar.customize')}
              aria-label={t('ui.titlebar.customize')}
              onClick={() => openModal('topbarSettings')}
            >
              <Pencil size={12} />
            </button>
          </div>
        </div>
        {rightPanelEnabled ? (
          <button
            type="button"
            className={`${styles.iconBtn} ${styles.rightSidebarBtn} ${preferences.rightSidebarVisible ? styles.iconBtnActive : ''}`}
            onClick={() =>
              setPreferences({ rightSidebarVisible: !preferences.rightSidebarVisible })
            }
            title={
              preferences.rightSidebarVisible
                ? t('ui.titlebar.closeRightSidebar')
                : t('ui.titlebar.openRightSidebar')
            }
            aria-label={
              preferences.rightSidebarVisible
                ? t('ui.titlebar.closeRightSidebar')
                : t('ui.titlebar.openRightSidebar')
            }
            aria-pressed={preferences.rightSidebarVisible}
          >
            {preferences.rightSidebarVisible ? (
              <PanelRightClose size={14} />
            ) : (
              <PanelRightOpen size={14} />
            )}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.windowBtn}
          onClick={() => void win.minimize()}
          title={t('ui.titlebar.minimize')}
          aria-label={t('ui.titlebar.minimize')}
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          className={styles.windowBtn}
          onClick={() => void win.toggleMaximize()}
          title={t('ui.titlebar.maximize')}
          aria-label={t('ui.titlebar.maximize')}
        >
          <Maximize2 size={12} />
        </button>
        <button
          type="button"
          className={`${styles.windowBtn} ${styles.close}`}
          onClick={() => void requestAppClose()}
          title={t('ui.titlebar.close')}
          aria-label={t('ui.titlebar.close')}
        >
          <X size={14} />
        </button>
      </div>
      {tabMenu ? (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={tabMenu.items}
          onClose={() => setTabMenu(null)}
        />
      ) : null}
    </div>
  )
}
