import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Bell, X } from 'lucide-react'
import { type CSSProperties, lazy, Suspense, useEffect, useRef } from 'react'
import { Group as PanelGroup, Panel, Separator, usePanelRef } from 'react-resizable-panels'

import styles from './App.module.css'
import homeBackground from './assets/home-bg-right.png'
import { AgentSandbox } from './components/AgentSandbox'
import { DictationButton } from './components/DictationButton'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FocusOverlay } from './components/FocusOverlay'
import { GsdSyncActivityView } from './components/GsdSyncActivityView'
import { AgentIcon } from './components/icons/AgentIcons'
import { LinkViewerOverlay } from './components/LinkViewerOverlay'
import { MainMenu } from './components/MainMenu'
import { AddBrowserModal } from './components/modals/AddBrowserModal'
import { AddContentModal } from './components/modals/AddContentModal'
import { AiUsageModal } from './components/modals/AiUsageModal'
import { AuditModal } from './components/modals/AuditModal'
import { EditGroupModal } from './components/modals/EditGroupModal'
import { EditProjectModal } from './components/modals/EditProjectModal'
import { FindJumpModal } from './components/modals/FindJumpModal'
import { HandoffModal } from './components/modals/HandoffModal'
import { McpIntroModal } from './components/modals/McpIntroModal'
import { McpManagerModal } from './components/modals/McpManagerModal'
import { NewGroupModal } from './components/modals/NewGroupModal'
import { NewProjectModal } from './components/modals/NewProjectModal'
import { NewSubTabModal } from './components/modals/NewSubTabModal'
import { NewTerminalModal } from './components/modals/NewTerminalModal'
import { OnboardingModal } from './components/modals/OnboardingModal'
import { PreferencesModal } from './components/modals/PreferencesModal'
import { ProfilesModal } from './components/modals/ProfilesModal'
import { RecentChatsModal } from './components/modals/RecentChatsModal'
import { RemoteControlModal } from './components/modals/RemoteControlModal'
import { SuspendGroupModal } from './components/modals/SuspendGroupModal'
import { SyncModal } from './components/modals/SyncModal'
import { ThemePickerModal } from './components/modals/ThemePickerModal'
import { TodoSettingsModal } from './components/modals/TodoSettingsModal'
import { TopbarSettingsModal } from './components/modals/TopbarSettingsModal'
import { UpdateModal } from './components/modals/UpdateModal'
import { WelcomeModal } from './components/modals/WelcomeModal'
import { WhatsNewModal } from './components/modals/WhatsNewModal'
import { ProjectSidebar } from './components/ProjectSidebar'
import { RightSidebar } from './components/RightSidebar'
import { TitleBar } from './components/TitleBar'
import { TokenHud } from './components/TokenHud'
import { AsciiEffect } from './components/ui/ascii-effect'
import { WorkspaceView } from './components/WorkspaceView'
import { useAgentBrowserOffers } from './hooks/useAgentBrowserOffers'
import { useCliOpenRequests } from './hooks/useCliOpenRequests'
import { useCloseConfirmation } from './hooks/useCloseConfirmation'
import { useDiscordPresence } from './hooks/useDiscordPresence'
import { useKeybindings } from './hooks/useKeybindings'
import { useMcpIntroPrompt } from './hooks/useMcpIntroPrompt'
import { useRemoteControlService } from './hooks/useRemoteControlService'
import { useResourceSupervisor } from './hooks/useResourceSupervisor'
import { startActivityTracker } from './lib/activityTracker'
import { APP_SHELL_ID } from './lib/appShell'
import { AGENT_SANDBOX_ENABLED } from './lib/featureFlags'
import { intlLocale, translate, useT } from './lib/i18n'
import { visibilityFromPanelResize, widthFromPanelResize } from './lib/sidebarPanelState'
import { setMaxConcurrentSpawns } from './lib/spawnQueue'
import { ghosttyKillAll, setWindowOpacity } from './lib/tauri'
import { getLastCrashReport } from './lib/tauri'
import { loadThemeIconBytes } from './lib/themeIcons'
import { checkForUpdate } from './lib/updater'
import { useProjectsStore } from './stores/projectsStore'
import { type InAppToast, useUiStore } from './stores/uiStore'

const AgentCanvasPOC = lazy(() =>
  import('./components/AgentCanvasPOC').then((module) => ({ default: module.AgentCanvasPOC })),
)
const HomeView = lazy(() =>
  import('./components/HomeView').then((module) => ({ default: module.HomeView })),
)
const LayoutDesignerModal = lazy(() =>
  import('./components/modals/LayoutDesignerModal').then((module) => ({
    default: module.LayoutDesignerModal,
  })),
)
const MemoryAnalyticsModal = lazy(() =>
  import('./components/modals/MemoryAnalyticsModal').then((module) => ({
    default: module.MemoryAnalyticsModal,
  })),
)

const LEFT_SIDEBAR_MIN_PX = 220
const LEFT_SIDEBAR_MAX_PX = 380
const RIGHT_SIDEBAR_MIN_PX = 260
const RIGHT_SIDEBAR_MAX_PX = 420
const WORKSPACE_MIN_PX = 240

function LoadingScreen({ reducedMotion = false }: { reducedMotion?: boolean }) {
  const t = useT()
  return (
    <div className={styles.loadingScreen} role="status" aria-label={t('loading.initializing')}>
      <div className={styles.loadingBackdrop} aria-hidden="true">
        <AsciiEffect
          imageSrc={homeBackground}
          alt=""
          variant="flow"
          fontSize={8}
          reducedMotion={reducedMotion}
          brightnessBoost={2.25}
          contrast={1.15}
          threshold={0.02}
          flowSpeed={0.16}
          flowStrength={9}
          mouseRadius={260}
          mouseStrength={16}
          scale={1}
          fit="cover"
          colors={['var(--fg-muted)', 'var(--fg)']}
          backgroundColor="transparent"
        />
      </div>
      <div className={styles.loadingInner}>
        <div className={styles.loadingWordmark}>Alethe</div>
        <div className={styles.loadingConsole}>
          <span className={styles.loadingPrompt} aria-hidden="true">
            ›
          </span>
          <span>{t('loading.initializing')}</span>
          <span className={styles.loadingCursor} aria-hidden="true" />
        </div>
        <div className={styles.loadingRail} aria-hidden="true">
          {Array.from({ length: 12 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
      </div>
    </div>
  )
}

function ToastItem({ toast }: { toast: InAppToast }) {
  const dismissToast = useUiStore((s) => s.dismissToast)
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)

  useEffect(() => {
    // A toast that asks something has to outlive a glance, or the offer is gone before it is read.
    const timer = window.setTimeout(
      () => dismissToast(toast.id),
      toast.actions?.length ? 20000 : 6500,
    )
    return () => window.clearTimeout(timer)
  }, [dismissToast, toast.id, toast.actions])

  const accentStyle = {
    '--toast-accent': toast.agent ? `var(--agent-${toast.agent})` : 'var(--accent)',
  } as CSSProperties

  return (
    <div className={styles.toast} role="status" style={accentStyle}>
      <div className={styles.toastIcon} aria-hidden>
        {toast.agent ? (
          <AgentIcon type={toast.agent} size={16} theme={uiTheme} />
        ) : (
          <Bell size={14} />
        )}
      </div>
      <div className={styles.toastText}>
        <strong>{toast.title}</strong>
        <span title={toast.body}>{toast.body}</span>
        {toast.actions?.length ? (
          <div className={styles.toastActions}>
            {toast.actions.map((action, index) => (
              <button
                key={action.label}
                type="button"
                className={
                  action.quiet
                    ? styles.toastActionQuiet
                    : index === 0
                      ? styles.toastAction
                      : styles.toastActionSecondary
                }
                onClick={() => {
                  action.run()
                  dismissToast(toast.id)
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className={styles.toastClose}
        onClick={() => dismissToast(toast.id)}
        aria-label="Close notification"
        title="Close"
      >
        <X size={14} />
      </button>
    </div>
  )
}

function InAppNotifications() {
  const toasts = useUiStore((s) => s.toasts)
  if (toasts.length === 0) return null

  return (
    <div className={styles.toastStack} aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}

export default function App() {
  const hydrate = useProjectsStore((s) => s.hydrate)
  const hydrated = useProjectsStore((s) => s.hydrated)
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)
  const visualStyle = useProjectsStore((s) => s.preferences.visualStyle ?? 'normal')
  const motionPreference = useProjectsStore((s) => s.preferences.motionPreference)
  const appIconTheme = useProjectsStore((s) => s.preferences.appIconTheme)
  const uiZoom = useProjectsStore((s) => s.preferences.uiZoom)
  const windowOpacity = useProjectsStore((s) => s.preferences.windowOpacity)
  const language = useProjectsStore((s) => s.preferences.language)
  const spawnConcurrency = useProjectsStore((s) => s.preferences.spawnConcurrency)
  const activeView = useUiStore((s) => s.activeView)
  const openModal = useUiStore((s) => s.openModal)
  const restoreMarkdownSidebarHistory = useUiStore((s) => s.restoreMarkdownSidebarHistory)
  const activeProfileId = useProjectsStore((s) => s.activeProfileId)
  const leftSidebarVisible = useProjectsStore((s) => s.preferences.leftSidebarVisible)
  const rightSidebarVisible = useProjectsStore((s) => s.preferences.rightSidebarVisible)
  const leftSidebarWidth = useProjectsStore((s) => s.preferences.leftSidebarWidth)
  const rightSidebarWidth = useProjectsStore((s) => s.preferences.rightSidebarWidth)
  const todosEnabled = useProjectsStore((s) => s.preferences.enabledFeatures.todos)
  const playwrightEnabled = useProjectsStore((s) => s.preferences.enabledFeatures.playwright)
  const gitEnabled = useProjectsStore((s) => s.preferences.enabledFeatures.git)
  const mcpEnabled = useProjectsStore((s) => s.preferences.enabledFeatures.mcp)
  const gitControlPlacement = useProjectsStore((s) => s.preferences.gitControlPlacement)
  const rightPanelEnabled =
    todosEnabled || mcpEnabled || (gitEnabled && gitControlPlacement === 'right')
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  // Keep panel defaults stable while dragging. Updating defaultSize on every
  // resize event can make react-resizable-panels rebuild the layout mid-drag.
  const leftSidebarDefaultRef = useRef(leftSidebarWidth)
  const rightSidebarDefaultRef = useRef(rightSidebarWidth)
  const sidebarDefaultsHydratedRef = useRef(false)
  const leftPanelRef = usePanelRef()
  const rightPanelRef = usePanelRef()
  const leftSidebarSaveTimerRef = useRef<number | null>(null)
  const rightSidebarSaveTimerRef = useRef<number | null>(null)
  const leftSidebarLayoutReadyRef = useRef(false)
  const rightSidebarLayoutReadyRef = useRef(false)
  const leftSidebarResizeActiveRef = useRef(false)
  const rightSidebarResizeActiveRef = useRef(false)
  const windowHiddenRef = useRef(false)
  const leftPanelElementRef = useRef<HTMLDivElement>(null)
  const rightPanelElementRef = useRef<HTMLDivElement>(null)

  // Hydration completes before the panels mount. Capture the persisted widths
  // on that render so their first layout does not fall back to store defaults.
  if (hydrated && !sidebarDefaultsHydratedRef.current) {
    leftSidebarDefaultRef.current = leftSidebarWidth
    rightSidebarDefaultRef.current = rightSidebarWidth
    sidebarDefaultsHydratedRef.current = true
  }

  useKeybindings()
  useDiscordPresence()
  useMcpIntroPrompt()
  useRemoteControlService()
  useCloseConfirmation()
  useResourceSupervisor(hydrated)
  useAgentBrowserOffers(playwrightEnabled)
  useCliOpenRequests(hydrated)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    if (hydrated) restoreMarkdownSidebarHistory()
  }, [activeProfileId, hydrated, restoreMarkdownSidebarHistory])

  useEffect(() => {
    void ghosttyKillAll().catch(() => {
      /* No-op on unsupported platforms. */
    })
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = uiTheme
  }, [uiTheme])

  useEffect(() => {
    document.documentElement.dataset.visualStyle = visualStyle
  }, [visualStyle])

  useEffect(() => {
    if (!hydrated) return
    void loadThemeIconBytes(appIconTheme)
      .then((bytes) => getCurrentWindow().setIcon(bytes))
      .catch((error) => {
        console.error('[app-icon] failed to apply window icon', error)
      })
  }, [appIconTheme, hydrated])

  useEffect(() => {
    document.documentElement.lang = language === 'pt-BR' ? 'pt-BR' : 'en'
  }, [language])

  useEffect(() => {
    setMaxConcurrentSpawns(spawnConcurrency)
  }, [spawnConcurrency])

  useEffect(() => {
    if (!hydrated) return
    document.documentElement.dataset.zoom = String(uiZoom)
    void getCurrentWebview()
      .setZoom(uiZoom)
      .catch(() => {
        /* Browser tests may not expose the Tauri permission. */
      })
      .finally(() => {
        window.dispatchEvent(new CustomEvent('alethe:zoom-changed', { detail: { zoom: uiZoom } }))
      })
  }, [hydrated, uiZoom])

  useEffect(() => {
    if (!hydrated) return
    void setWindowOpacity(windowOpacity).catch(() => {
      /* Keep the window opaque where native opacity is unavailable. */
    })
  }, [hydrated, windowOpacity])

  // Dragging a separator until the sidebar collapses gives it `pointer-events: none`, so
  // its own pointerup never fires and the flag would stay on for the rest of the session —
  // after which any reflow that momentarily reports 0px is persisted as "user closed it".
  useEffect(() => {
    const clearResizeFlags = () => {
      leftSidebarResizeActiveRef.current = false
      rightSidebarResizeActiveRef.current = false
    }
    const markHidden = () => {
      windowHiddenRef.current = true
      clearResizeFlags()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') markHidden()
      else windowHiddenRef.current = false
    }
    window.addEventListener('pointerup', clearResizeFlags)
    window.addEventListener('pointercancel', clearResizeFlags)
    window.addEventListener('blur', clearResizeFlags)
    window.addEventListener('beforeunload', markHidden)
    window.addEventListener('pagehide', markHidden)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('pointerup', clearResizeFlags)
      window.removeEventListener('pointercancel', clearResizeFlags)
      window.removeEventListener('blur', clearResizeFlags)
      window.removeEventListener('beforeunload', markHidden)
      window.removeEventListener('pagehide', markHidden)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  // A collapsible panel auto-collapses whenever the group squeezes it below `minSize`,
  // which is what a minimize or a narrow window does to both sidebars at once. Nothing
  // brought them back, because the effects below only run when the preference changes —
  // so the panels stayed shut while the stored preference still said "visible".
  useEffect(() => {
    if (!hydrated) return
    let timer: number | null = null
    const reconcile = () => {
      if (windowHiddenRef.current) return
      if (leftSidebarResizeActiveRef.current || rightSidebarResizeActiveRef.current) return
      const wantLeft = leftSidebarVisible
      const wantRight = rightPanelEnabled && rightSidebarVisible
      const required =
        (wantLeft ? LEFT_SIDEBAR_MIN_PX : 0) +
        (wantRight ? RIGHT_SIDEBAR_MIN_PX : 0) +
        WORKSPACE_MIN_PX
      if (window.innerWidth < required) return
      if (wantLeft && leftPanelRef.current?.isCollapsed()) leftPanelRef.current.expand()
      if (wantRight && rightPanelRef.current?.isCollapsed()) rightPanelRef.current.expand()
    }
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(reconcile, 240)
    }
    window.addEventListener('resize', schedule)
    document.addEventListener('visibilitychange', schedule)
    schedule()
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [
    hydrated,
    leftPanelRef,
    rightPanelRef,
    leftSidebarVisible,
    rightSidebarVisible,
    rightPanelEnabled,
  ])

  useEffect(() => {
    if (!hydrated) return
    leftSidebarLayoutReadyRef.current = false
    const element = leftPanelElementRef.current
    if (element) element.style.transition = 'flex-grow 180ms ease, flex-basis 180ms ease'
    const frame = window.requestAnimationFrame(() => {
      if (leftSidebarVisible) leftPanelRef.current?.expand()
      else leftPanelRef.current?.collapse()
    })
    const timer = window.setTimeout(() => {
      if (element) element.style.transition = ''
      leftSidebarLayoutReadyRef.current = true
    }, 220)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      if (element) element.style.transition = ''
    }
  }, [hydrated, leftPanelRef, leftSidebarVisible])

  useEffect(() => {
    if (!hydrated) return
    rightSidebarLayoutReadyRef.current = false
    const element = rightPanelElementRef.current
    if (element) element.style.transition = 'flex-grow 180ms ease, flex-basis 180ms ease'
    const frame = window.requestAnimationFrame(() => {
      if (rightPanelEnabled && rightSidebarVisible) rightPanelRef.current?.expand()
      else rightPanelRef.current?.collapse()
    })
    const timer = window.setTimeout(() => {
      if (element) element.style.transition = ''
      rightSidebarLayoutReadyRef.current = true
    }, 220)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      if (element) element.style.transition = ''
    }
  }, [hydrated, rightPanelRef, rightSidebarVisible, rightPanelEnabled])

  useEffect(() => {
    if (!hydrated) return
    const { preferences, setPreferences } = useProjectsStore.getState()
    if (preferences.firstLaunchAt === null) {
      setPreferences({ firstLaunchAt: Date.now() })
    }
    if (preferences.accountCreated && preferences.onboardingDone) {
      useUiStore.getState().openModal_('welcome')
    }
    useUiStore.getState().setActiveView(preferences.alwaysStartOnHome ? 'home' : 'workspace')
  }, [hydrated])

  useEffect(() => {
    if (!hydrated) return
    return startActivityTracker()
  }, [hydrated])

  useEffect(
    () => () => {
      if (leftSidebarSaveTimerRef.current !== null)
        window.clearTimeout(leftSidebarSaveTimerRef.current)
      if (rightSidebarSaveTimerRef.current !== null)
        window.clearTimeout(rightSidebarSaveTimerRef.current)
    },
    [],
  )

  useEffect(() => {
    if (!hydrated) return
    let cancelled = false
    void checkForUpdate()
      .then((info) => {
        if (!cancelled) useUiStore.getState().setUpdateInfo(info)
      })
      .catch((error) => {
        console.error('[update] checagem de fundo falhou:', error)
      })
    return () => {
      cancelled = true
    }
  }, [hydrated])

  useEffect(() => {
    if (!hydrated) return
    void getLastCrashReport()
      .then((report) => {
        if (!report) return
        const { session, orphans_reaped: orphansReaped } = report
        const lang = useProjectsStore.getState().preferences.language
        const when = new Date(session.last_heartbeat_ms || session.started_at_ms)
        const bodyKey = orphansReaped > 0 ? 'crash.uncleanBodyWithOrphans' : 'crash.uncleanBody'
        useUiStore.getState().pushToast({
          title: translate(lang, 'crash.uncleanTitle'),
          body: translate(lang, bodyKey, {
            total: Math.round(session.total_mb),
            procs: session.process_count,
            time: when.toLocaleTimeString(intlLocale(lang)),
            orphans: orphansReaped,
          }),
        })
      })
      .catch(() => {})
  }, [hydrated])

  if (!hydrated) {
    // Persisted preferences are not known yet, so keep startup decorative motion static.
    return <LoadingScreen reducedMotion />
  }

  return (
    <>
      <div className={styles.appShell} id={APP_SHELL_ID} tabIndex={-1}>
        <TitleBar />
        <PanelGroup
          orientation="horizontal"
          className={styles.shellBody}
          resizeTargetMinimumSize={{ coarse: 28, fine: 18 }}
        >
          <Panel
            id="alethe-left-sidebar"
            panelRef={leftPanelRef}
            elementRef={leftPanelElementRef}
            defaultSize={leftSidebarVisible ? `${leftSidebarDefaultRef.current}px` : '0px'}
            minSize={`${LEFT_SIDEBAR_MIN_PX}px`}
            maxSize={`${LEFT_SIDEBAR_MAX_PX}px`}
            collapsedSize="0px"
            collapsible
            groupResizeBehavior="preserve-pixel-size"
            onResize={(size, _id, previous) => {
              const currentVisible = useProjectsStore.getState().preferences.leftSidebarVisible
              const nextVisible = visibilityFromPanelResize(
                leftSidebarLayoutReadyRef.current,
                leftSidebarResizeActiveRef.current,
                windowHiddenRef.current,
                size,
                previous,
                currentVisible,
              )
              if (nextVisible !== null) setPreferences({ leftSidebarVisible: nextVisible })
              const nextWidth = widthFromPanelResize(
                leftSidebarLayoutReadyRef.current,
                leftSidebarResizeActiveRef.current,
                windowHiddenRef.current,
                size,
                previous,
                LEFT_SIDEBAR_MIN_PX,
                LEFT_SIDEBAR_MAX_PX,
              )
              if (nextWidth !== null) {
                if (leftSidebarSaveTimerRef.current !== null)
                  window.clearTimeout(leftSidebarSaveTimerRef.current)
                leftSidebarSaveTimerRef.current = window.setTimeout(() => {
                  leftSidebarSaveTimerRef.current = null
                  leftSidebarDefaultRef.current = nextWidth
                  setPreferences({ leftSidebarWidth: nextWidth })
                }, 180)
              }
            }}
          >
            <div className={styles.sidebarContent} data-hidden={!leftSidebarVisible}>
              <ProjectSidebar />
            </div>
          </Panel>
          <Separator
            className={`${styles.shellSeparator} ${leftSidebarVisible ? '' : styles.shellSeparatorHidden}`}
            onPointerDown={() => {
              leftSidebarResizeActiveRef.current = true
            }}
            onPointerUp={() => {
              leftSidebarResizeActiveRef.current = false
            }}
            onPointerCancel={() => {
              leftSidebarResizeActiveRef.current = false
            }}
            onLostPointerCapture={() => {
              leftSidebarResizeActiveRef.current = false
            }}
            onKeyDown={() => {
              leftSidebarResizeActiveRef.current = true
            }}
            onKeyUp={() => {
              leftSidebarResizeActiveRef.current = false
            }}
            onBlur={() => {
              leftSidebarResizeActiveRef.current = false
            }}
          />

          <Panel id="alethe-main" minSize="360px">
            <main className={styles.mainView}>
              <ErrorBoundary label="view">
                <Suspense
                  fallback={<LoadingScreen reducedMotion={motionPreference === 'reduced'} />}
                >
                  {activeView === 'home' ? (
                    <HomeView />
                  ) : activeView === 'agentSandbox' && AGENT_SANDBOX_ENABLED ? (
                    <AgentSandbox />
                  ) : activeView === 'agentCanvas' ? (
                    <AgentCanvasPOC />
                  ) : (
                    <WorkspaceView />
                  )}
                </Suspense>
              </ErrorBoundary>
            </main>
          </Panel>

          {rightPanelEnabled ? (
            <>
              <Separator
                className={`${styles.shellSeparator} ${rightSidebarVisible ? '' : styles.shellSeparatorHidden}`}
                onPointerDown={() => {
                  rightSidebarResizeActiveRef.current = true
                }}
                onPointerUp={() => {
                  rightSidebarResizeActiveRef.current = false
                }}
                onPointerCancel={() => {
                  rightSidebarResizeActiveRef.current = false
                }}
                onLostPointerCapture={() => {
                  rightSidebarResizeActiveRef.current = false
                }}
                onKeyDown={() => {
                  rightSidebarResizeActiveRef.current = true
                }}
                onKeyUp={() => {
                  rightSidebarResizeActiveRef.current = false
                }}
                onBlur={() => {
                  rightSidebarResizeActiveRef.current = false
                }}
              />
              <Panel
                id="alethe-todo-sidebar"
                panelRef={rightPanelRef}
                elementRef={rightPanelElementRef}
                defaultSize={rightSidebarVisible ? `${rightSidebarDefaultRef.current}px` : '0px'}
                minSize={`${RIGHT_SIDEBAR_MIN_PX}px`}
                maxSize={`${RIGHT_SIDEBAR_MAX_PX}px`}
                collapsedSize="0px"
                collapsible
                groupResizeBehavior="preserve-pixel-size"
                onResize={(size, _id, previous) => {
                  const currentVisible = useProjectsStore.getState().preferences.rightSidebarVisible
                  const nextVisible = visibilityFromPanelResize(
                    rightSidebarLayoutReadyRef.current,
                    rightSidebarResizeActiveRef.current,
                    windowHiddenRef.current,
                    size,
                    previous,
                    currentVisible,
                  )
                  if (nextVisible !== null) setPreferences({ rightSidebarVisible: nextVisible })
                  const nextWidth = widthFromPanelResize(
                    rightSidebarLayoutReadyRef.current,
                    rightSidebarResizeActiveRef.current,
                    windowHiddenRef.current,
                    size,
                    previous,
                    RIGHT_SIDEBAR_MIN_PX,
                    RIGHT_SIDEBAR_MAX_PX,
                  )
                  if (nextWidth !== null) {
                    if (rightSidebarSaveTimerRef.current !== null)
                      window.clearTimeout(rightSidebarSaveTimerRef.current)
                    rightSidebarSaveTimerRef.current = window.setTimeout(() => {
                      rightSidebarSaveTimerRef.current = null
                      rightSidebarDefaultRef.current = nextWidth
                      setPreferences({ rightSidebarWidth: nextWidth })
                    }, 180)
                  }
                }}
              >
                <div className={styles.sidebarContent} data-hidden={!rightSidebarVisible}>
                  <RightSidebar />
                </div>
              </Panel>
            </>
          ) : null}
        </PanelGroup>
      </div>
      <FocusOverlay />
      <GsdSyncActivityView />
      <LinkViewerOverlay />
      <DictationButton />
      <MainMenu />
      <ErrorBoundary label="modals">
        <NewProjectModal />
        <NewGroupModal />
        <EditGroupModal />
        <EditProjectModal />
        <NewTerminalModal />
        <AddContentModal />
        <AddBrowserModal />
        <NewSubTabModal />
        <PreferencesModal />
        <ProfilesModal />
        <SyncModal />
        <FindJumpModal />
        <OnboardingModal />
        <WelcomeModal />
        {openModal === 'layoutDesigner' ? (
          <Suspense fallback={null}>
            <LayoutDesignerModal />
          </Suspense>
        ) : null}
        <SuspendGroupModal />
        {openModal === 'memoryAnalytics' ? (
          <Suspense fallback={null}>
            <MemoryAnalyticsModal />
          </Suspense>
        ) : null}
        <ThemePickerModal />
        <TodoSettingsModal />
        <TopbarSettingsModal />
        <AiUsageModal />
        <UpdateModal />
        <WhatsNewModal />
        <RecentChatsModal />
        <HandoffModal />
        <McpManagerModal />
        <McpIntroModal />
        <RemoteControlModal />
        <AuditModal />
      </ErrorBoundary>
      <InAppNotifications />
      {activeView === 'agentCanvas' ? <TokenHud /> : null}
    </>
  )
}
