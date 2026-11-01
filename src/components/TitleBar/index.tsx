import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  ArrowLeft,
  ArrowRight,
  Coffee,
  Maximize2,
  Menu,
  Minus,
  Newspaper,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Pencil,
  Pin,
  Play,
  RefreshCw,
  Smartphone,
  Timer,
  Users,
  Workflow,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { requestAppClose } from '../../hooks/useCloseConfirmation'
import { useRouter9Runtime } from '../../hooks/useRouter9Runtime'
import { usePolling } from '../../hooks/usePolling'
import { getCachedAntigravityUsage } from '../../lib/antigravityUsageCache'
import { loadClaudeUsage } from '../../lib/claudeUsageCache'
import { getCachedCodexUsage } from '../../lib/codexUsageCache'
import { getCachedKimiUsage } from '../../lib/kimiUsageCache'
import { useT } from '../../lib/i18n'
import { useSidebarViews } from '../../lib/viewPlacement'
import { observeClaudeReset, observeCodexReset } from '../../lib/limitResetWatch'
import { formatShortcut, isMacOS } from '../../lib/platform'
import { codexHeadlineWindow, hasCodexWindow, killPty, remoteControlInfo } from '../../lib/tauri'
import { usePomodoroStore } from '../../stores/pomodoroStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AntigravityIcon, ClaudeIcon, CodexIcon, KimiIcon } from '../icons/AgentIcons'
import { ContextMenu, type MenuItem } from '../ProjectSidebar/ContextMenu'
import styles from './TitleBar.module.css'

const CLAUDE_POLL_INTERVAL_MS = 5 * 60_000
const REMOTE_CONTROL_POLL_INTERVAL_MS = 2_000
const APP_TITLE = import.meta.env.DEV ? '(DEV) Alethe' : 'Alethe'
// macOS draws its own close/minimize/zoom buttons (`tauri.macos.conf.json`): the bar leaves
// room for them on the left instead of drawing a second set on the right.
const NATIVE_WINDOW_CONTROLS = isMacOS()
const TRAFFIC_LIGHTS_INSET = 72

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

function Router9PillButton() {
  const t = useT()
  const { config, status, hasInstall, busy, start, stop } = useRouter9Runtime()
  if (!config.enabled || !hasInstall) return null
  return (
    <button
      type="button"
      className={`${styles.ramPill} ${status?.running ? '' : styles.ramPressureMedium}`}
      title={status?.running ? t('router9.pillStop') : t('router9.pillStart')}
      disabled={busy}
      onClick={() => void (status?.running ? stop() : start()).catch(() => undefined)}
    >
      9router {status?.running ? t('router9.pillOn') : t('router9.pillOff')}
    </button>
  )
}

/** Small circular progress ring (SVG) showing how much of the current phase has
 *  elapsed. `progress` is 0..1; the icon sits centered on top of it. */
function PomodoroRing({
  progress,
  color,
  children,
}: {
  progress: number
  color: string
  children: React.ReactNode
}) {
  const size = 18
  const strokeWidth = 2
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - Math.min(1, Math.max(0, progress)))
  return (
    <span className={styles.pomodoroRing}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className={styles.pomodoroRingSvg}
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.22}
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <span className={styles.pomodoroRingIcon} style={{ color }}>
        {children}
      </span>
    </span>
  )
}

function PomodoroTitleBarPill() {
  const t = useT()
  const phase = usePomodoroStore((s) => s.phase)
  const status = usePomodoroStore((s) => s.status)
  const endsAt = usePomodoroStore((s) => s.endsAt)
  const remainingMsAtPause = usePomodoroStore((s) => s.remainingMsAtPause)
  const start = usePomodoroStore((s) => s.start)
  const pause = usePomodoroStore((s) => s.pause)
  const resume = usePomodoroStore((s) => s.resume)
  const showTodoSidebar = useUiStore((s) => s.showTodoSidebar)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const workMinutes = useProjectsStore((s) => s.preferences.pomodoroWorkMinutes)
  const shortBreakMinutes = useProjectsStore((s) => s.preferences.pomodoroShortBreakMinutes)
  const longBreakMinutes = useProjectsStore((s) => s.preferences.pomodoroLongBreakMinutes)
  const [, forceTick] = useState(0)

  useEffect(() => {
    if (status !== 'running') return
    const id = window.setInterval(() => forceTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [status])

  if (status === 'idle') return null

  const isBreak = phase === 'shortBreak' || phase === 'longBreak'
  const totalMinutes =
    phase === 'work' ? workMinutes : phase === 'longBreak' ? longBreakMinutes : shortBreakMinutes
  const totalMs = Math.max(1, totalMinutes) * 60_000
  const remainingMs =
    status === 'paused'
      ? (remainingMsAtPause ?? 0)
      : status === 'running' && endsAt !== null
        ? Math.max(0, endsAt - Date.now())
        : 0
  const progress = status === 'finished' ? 1 : 1 - remainingMs / totalMs
  const totalSeconds = Math.ceil(remainingMs / 1000)
  const countdownLabel = `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, '0')}`
  const phaseLabel =
    phase === 'work'
      ? t('pomodoro.phaseWork')
      : phase === 'shortBreak'
        ? t('pomodoro.phaseShortBreak')
        : t('pomodoro.phaseLongBreak')
  const ringColor = isBreak ? 'var(--status-waiting)' : 'var(--status-working)'
  const PhaseIcon = isBreak ? Coffee : Timer

  const handleToggle = () => {
    if (status === 'running') pause()
    else if (status === 'paused') resume()
    else start()
  }

  return (
    <div className={styles.pomodoroPill} data-status={status}>
      <button
        type="button"
        className={styles.pomodoroPillMain}
        onClick={() => {
          setPreferences({ rightSidebarVisible: true })
          showTodoSidebar()
        }}
        title={t('pomodoro.titlebarOpen')}
        aria-label={`${phaseLabel} ${countdownLabel}`}
      >
        <PomodoroRing progress={progress} color={ringColor}>
          <PhaseIcon size={10} />
        </PomodoroRing>
        <span className={styles.pomodoroCountdown}>{countdownLabel}</span>
      </button>
      <span className={styles.pomodoroDivider} />
      <button
        type="button"
        className={styles.pomodoroToggle}
        onClick={handleToggle}
        title={t(status === 'running' ? 'pomodoro.pause' : 'pomodoro.resume')}
        aria-label={t(status === 'running' ? 'pomodoro.pause' : 'pomodoro.resume')}
      >
        {status === 'running' ? <Pause size={11} /> : <Play size={11} />}
      </button>
    </div>
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
  const claudeUsageStale = useUiStore((s) => s.claudeUsageError !== null)
  const codexUsage = useUiStore((s) => s.codexUsage)
  const antigravityUsage = useUiStore((s) => s.antigravityUsage)
  const updateInfo = useUiStore((s) => s.updateInfo)
  const setCodexUsage = useUiStore((s) => s.setCodexUsage)
  const setAntigravityUsage = useUiStore((s) => s.setAntigravityUsage)
  const kimiUsage = useUiStore((s) => s.kimiUsage)
  const setKimiUsage = useUiStore((s) => s.setKimiUsage)
  const openModal = useUiStore((s) => s.openModal_)
  const workspaceTabs = useProjectsStore((s) => s.workspace.tabs)
  const activeWorkspaceTabId = useProjectsStore((s) => s.workspace.activeTabId)
  const historyIndex = useProjectsStore((s) => s.workspace.historyIndex)
  const historyLength = useProjectsStore((s) => s.workspace.history.length)
  const profiles = useProjectsStore((s) => s.profiles)
  const activeProfileId = useProjectsStore((s) => s.activeProfileId)
  const preferences = useProjectsStore((s) => s.preferences)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const usageAccess = preferences.usageAccess
  const rightSidebarTabs = useSidebarViews('right')
  const rightPanelEnabled = preferences.enabledFeatures.mcp || rightSidebarTabs.length > 0
  const toggleWorkspaceTabPinned = useProjectsStore((s) => s.toggleWorkspaceTabPinned)
  const closeSavedWorkspaceTab = useProjectsStore((s) => s.closeSavedWorkspaceTab)
  const addWorkspaceTabToCurrent = useProjectsStore((s) => s.addWorkspaceTabToCurrent)
  const activateWorkspaceTab = useProjectsStore((s) => s.activateWorkspaceTab)
  const navigateWorkspaceHistory = useProjectsStore((s) => s.navigateWorkspaceHistory)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [remoteConnectedDevices, setRemoteConnectedDevices] = useState(0)
  const [remoteBackendEnabled, setRemoteBackendEnabled] = useState(false)
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null
  const threeAreas = preferences.topbarStyle === 'three-areas'
  const antigravityReady =
    antigravityUsage?.status === 'ready' && antigravityUsage.buckets.length > 0
  const remoteConnectedLabel =
    remoteConnectedDevices > 0
      ? t(
          remoteConnectedDevices === 1
            ? 'remote.topbarDeviceConnected'
            : 'remote.topbarDevicesConnected',
          { count: remoteConnectedDevices },
        )
      : t('remote.topbarEnabledIdle')

  const closeAgentPlanning = () => {
    if (!agentCanvasSession) return
    if (activeView === 'agentCanvas') {
      window.dispatchEvent(new CustomEvent('alethe:agent-canvas-exit'))
      return
    }
    void killPty(agentCanvasSession.ptyId).catch(() => {})
    setAgentCanvasSession(null)
  }

  const activeRef = useRef(true)

  usePolling(async (isCancelled) => {
    if (!activeRef.current) return
    try {
      const info = await remoteControlInfo()
      if (!isCancelled()) {
        setRemoteConnectedDevices(info.connected_devices)
        setRemoteBackendEnabled(info.enabled)
      }
    } catch {
      if (!isCancelled()) {
        setRemoteConnectedDevices(0)
        setRemoteBackendEnabled(false)
      }
    }
  }, REMOTE_CONTROL_POLL_INTERVAL_MS)

  // Each provider polls only while its usage reading is on: off schedules no timer at all.
  usePolling(
    async (isCancelled) => {
      if (!activeRef.current) return
      const usage = await loadClaudeUsage()
      if (usage && !isCancelled()) observeClaudeReset(usage)
    },
    CLAUDE_POLL_INTERVAL_MS,
    usageAccess.claude,
    1500,
  )

  const codexFailuresRef = useRef(0)
  usePolling(
    async (isCancelled) => {
      if (!activeRef.current) return
      try {
        const usage = await getCachedCodexUsage()
        if (!isCancelled()) {
          setCodexUsage(usage)
          observeCodexReset(usage)
          codexFailuresRef.current = 0
        }
      } catch {
        codexFailuresRef.current += 1
        if (codexFailuresRef.current >= 3 && !isCancelled()) setCodexUsage(null)
      }
    },
    CLAUDE_POLL_INTERVAL_MS,
    usageAccess.codex,
    2500,
  )

  usePolling(
    async (isCancelled) => {
      if (!activeRef.current) return
      try {
        const usage = await getCachedAntigravityUsage()
        if (!isCancelled()) setAntigravityUsage(usage)
      } catch {
        if (!isCancelled()) setAntigravityUsage(null)
      }
    },
    CLAUDE_POLL_INTERVAL_MS,
    usageAccess.antigravity,
    3000,
  )

  usePolling(
    async (isCancelled) => {
      if (!activeRef.current) return
      try {
        const usage = await getCachedKimiUsage()
        if (!isCancelled()) setKimiUsage(usage)
      } catch {
        if (!isCancelled()) setKimiUsage(null)
      }
    },
    60_000,
    usageAccess.kimi,
  )

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

  // The traffic lights hide in native full screen, so their gap goes with them.
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    if (!NATIVE_WINDOW_CONTROLS) return
    const appWindow = getCurrentWindow()
    let cancelled = false
    let unlisten: (() => void) | undefined
    const sync = () => {
      void appWindow
        .isFullscreen()
        .then((value) => {
          if (!cancelled) setFullscreen(value)
        })
        .catch(() => {})
    }
    sync()
    void appWindow.onResized(sync).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
  const trafficLightsInset = NATIVE_WINDOW_CONTROLS && !fullscreen ? TRAFFIC_LIGHTS_INSET : 0

  return (
    <div
      className={styles.bar}
      data-style={preferences.topbarStyle}
      data-tauri-drag-region
      style={
        {
          '--topbar-left-width': preferences.leftSidebarVisible
            ? `${Math.max(preferences.leftSidebarWidth, 38 + trafficLightsInset)}px`
            : `${38 + trafficLightsInset}px`,
          '--traffic-lights-inset': `${trafficLightsInset}px`,
          '--topbar-right-width': preferences.rightSidebarVisible
            ? `${preferences.rightSidebarWidth}px`
            : '38px',
        } as React.CSSProperties
      }
    >
      <div className={styles.barStart} data-tauri-drag-region>
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
                onAuxClick={(event) => {
                  // Middle-click closes the tab, matching browser tab-strip convention.
                  if (event.button === 1) closeSavedWorkspaceTab(tab.id)
                }}
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
      <div className={styles.barEnd} data-tauri-drag-region>
        <div className={styles.widgets} data-tauri-drag-region>
          <div className={styles.utilityGroup}>
            {!threeAreas ? (
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
            <PomodoroTitleBarPill />
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
            {remoteBackendEnabled ? (
              <button
                type="button"
                className={
                  remoteConnectedDevices > 0
                    ? styles.remoteDevicePill
                    : `${styles.remoteDevicePill} ${styles.remoteDevicePillIdle}`
                }
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
                  // Kept from before a refresh the usage service refused, so not current.
                  data-stale={claudeUsageStale ? 'true' : undefined}
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
                  {(claudeUsage.model_limits ?? []).map((limit) => (
                    <div key={limit.model} className={styles.usagePopoverLine}>
                      <span>{t('ws.usageModelLabel', { model: limit.model.toLowerCase() })}</span>
                      <strong>{formatPct(limit.utilization)}</strong>
                    </div>
                  ))}
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
                      '--pill-color': usagePillColor(codexHeadlineWindow(codexUsage).used_percent),
                    } as React.CSSProperties
                  }
                  onClick={() => openModal('aiUsage')}
                  title={t('ui.titlebar.openUsageDetails')}
                  aria-label={t('ui.titlebar.openUsageDetails')}
                >
                  <CodexIcon size={13} />
                  <span>{codexHeadlineWindow(codexUsage).used_percent.toFixed(0)}%</span>
                </button>
                <div
                  className={styles.usagePopover}
                  role="tooltip"
                  aria-label={t('ui.titlebar.itemCodex')}
                >
                  <div className={styles.usagePopoverTitle}>{t('ui.titlebar.itemCodex')}</div>
                  {hasCodexWindow(codexUsage.primary) ? (
                    <>
                      <div className={styles.usagePopoverMain}>
                        <span>{t('widget.usage5h')}</span>
                        <strong>{formatPct(codexUsage.primary.used_percent)}</strong>
                      </div>
                      <div className={styles.usagePopoverLine}>
                        <span>{t('widget.week')}</span>
                        <strong>{formatPct(codexUsage.secondary.used_percent)}</strong>
                      </div>
                    </>
                  ) : (
                    <div className={styles.usagePopoverMain}>
                      <span>{t('widget.week')}</span>
                      <strong>{formatPct(codexUsage.secondary.used_percent)}</strong>
                    </div>
                  )}
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
            {preferences.topbarShowKimiUsage && usageAccess.kimi ? (
              <div className={styles.usageWidget}>
                <button
                  type="button"
                  className={styles.usagePill}
                  style={{ '--pill-color': 'var(--agent-kimi)' } as React.CSSProperties}
                  onClick={() => openModal('aiUsage')}
                  title={t('ui.titlebar.itemKimi')}
                  aria-label={t('ui.titlebar.itemKimi')}
                >
                  <KimiIcon size={13} />
                  <span>
                    {kimiUsage?.status === 'ready' && kimiUsage.windows.length
                      ? formatPct(kimiUsage.windows[0].used_percent)
                      : '—'}
                  </span>
                </button>
                <div className={styles.usagePopover} role="tooltip">
                  <div className={styles.usagePopoverTitle}>{t('ui.titlebar.itemKimi')}</div>
                  {kimiUsage?.status === 'ready' ? (
                    kimiUsage.windows.map((window) => (
                      <div className={styles.usagePopoverLine} key={window.label}>
                        <span>
                          {window.label === 'limit_5h'
                            ? '5h'
                            : window.label === 'limit_7d'
                              ? t('widget.week')
                              : window.label === 'limit_month_code'
                                ? t('widget.kimiMonthlyCode')
                                : t('widget.kimiMonthlyTotal')}
                        </span>
                        <strong>
                          {formatPct(window.used_percent)} · {formatResetTime(window.resets_at)}
                        </strong>
                      </div>
                    ))
                  ) : (
                    <div className={styles.usagePopoverMain}>{t('widget.kimiUsageHint')}</div>
                  )}
                </div>
              </div>
            ) : null}
            {preferences.topbarShowMemory && ramMb !== null ? (
              <MemoryPillButton ramMb={ramMb} />
            ) : null}
            {preferences.topbarShowRouter9 ? <Router9PillButton /> : null}
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
        {NATIVE_WINDOW_CONTROLS ? null : (
          <>
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
          </>
        )}
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
