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
import { AgentIcon } from './components/icons/AgentIcons'
import { LinkViewerOverlay } from './components/LinkViewerOverlay'
import { MainMenu } from './components/MainMenu'
import { AddBrowserModal } from './components/modals/AddBrowserModal'
import { AddContentModal } from './components/modals/AddContentModal'
import { AiUsageModal } from './components/modals/AiUsageModal'
import { EditGroupModal } from './components/modals/EditGroupModal'
import { EditProjectModal } from './components/modals/EditProjectModal'
import { FindJumpModal } from './components/modals/FindJumpModal'
import { NewGroupModal } from './components/modals/NewGroupModal'
import { NewProjectModal } from './components/modals/NewProjectModal'
import { NewSubTabModal } from './components/modals/NewSubTabModal'
import { NewTerminalModal } from './components/modals/NewTerminalModal'
import { OnboardingModal } from './components/modals/OnboardingModal'
import { PreferencesModal } from './components/modals/PreferencesModal'
import { ProfilesModal } from './components/modals/ProfilesModal'
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
import { useCliOpenRequests } from './hooks/useCliOpenRequests'
import { useCloseConfirmation } from './hooks/useCloseConfirmation'
import { useDiscordPresence } from './hooks/useDiscordPresence'
import { useKeybindings } from './hooks/useKeybindings'
import { useResourceSupervisor } from './hooks/useResourceSupervisor'
import { startActivityTracker } from './lib/activityTracker'
import { AGENT_SANDBOX_ENABLED } from './lib/featureFlags'
import { intlLocale, translate, useT } from './lib/i18n'
import { setMaxConcurrentSpawns } from './lib/spawnQueue'
import { ghosttyKillAll, setWindowOpacity } from './lib/tauri'
import { getLastCrashReport } from './lib/tauri'
import { getThemeIcon } from './lib/themeIcons'
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

function LoadingScreen() {
  const t = useT()
  return (
    <div className={styles.loadingScreen} role="status" aria-label={t('loading.initializing')}>
      <div className={styles.loadingBackdrop} aria-hidden="true">
        <AsciiEffect
          imageSrc={homeBackground}
          alt=""
          variant="flow"
          fontSize={8}
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
    const timer = window.setTimeout(() => dismissToast(toast.id), 6500)
    return () => window.clearTimeout(timer)
  }, [dismissToast, toast.id])

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
        <span>{toast.body}</span>
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
  const appIconTheme = useProjectsStore((s) => s.preferences.appIconTheme)
  const uiZoom = useProjectsStore((s) => s.preferences.uiZoom)
  const windowOpacity = useProjectsStore((s) => s.preferences.windowOpacity)
  const language = useProjectsStore((s) => s.preferences.language)
  const spawnConcurrency = useProjectsStore((s) => s.preferences.spawnConcurrency)
  const activeView = useUiStore((s) => s.activeView)
  const openModal = useUiStore((s) => s.openModal)
  const leftSidebarVisible = useProjectsStore((s) => s.preferences.leftSidebarVisible)
  const rightSidebarVisible = useProjectsStore((s) => s.preferences.rightSidebarVisible)
  const leftSidebarWidth = useProjectsStore((s) => s.preferences.leftSidebarWidth)
  const rightSidebarWidth = useProjectsStore((s) => s.preferences.rightSidebarWidth)
  const todoEnabled = useProjectsStore((s) => s.preferences.enabledFeatures.todos)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  // Keep panel defaults stable while dragging. Updating defaultSize on every
  // resize event can make react-resizable-panels rebuild the layout mid-drag.
  const leftSidebarDefaultRef = useRef(leftSidebarWidth)
  const rightSidebarDefaultRef = useRef(rightSidebarWidth)
  const leftPanelRef = usePanelRef()
  const rightPanelRef = usePanelRef()
  const leftSidebarSaveTimerRef = useRef<number | null>(null)
  const rightSidebarSaveTimerRef = useRef<number | null>(null)
  const leftPanelElementRef = useRef<HTMLDivElement>(null)
  const rightPanelElementRef = useRef<HTMLDivElement>(null)

  useKeybindings()
  useDiscordPresence()
  useCloseConfirmation()
  useResourceSupervisor(hydrated)
  useCliOpenRequests(hydrated)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    void ghosttyKillAll().catch(() => {
      /* No-op on unsupported platforms. */
    })
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = uiTheme
  }, [uiTheme])

  useEffect(() => {
    if (!hydrated) return
    void getCurrentWindow()
      .setIcon(getThemeIcon(appIconTheme))
      .catch(() => {
        // Browser/test environments do not expose the native window icon API.
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

  useEffect(() => {
    if (!hydrated) return
    const element = leftPanelElementRef.current
    if (element) element.style.transition = 'flex-grow 180ms ease, flex-basis 180ms ease'
    const frame = window.requestAnimationFrame(() => {
      if (leftSidebarVisible) leftPanelRef.current?.expand()
      else leftPanelRef.current?.collapse()
    })
    const timer = window.setTimeout(() => {
      if (element) element.style.transition = ''
    }, 220)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      if (element) element.style.transition = ''
    }
  }, [hydrated, leftPanelRef, leftSidebarVisible])

  useEffect(() => {
    if (!hydrated) return
    const element = rightPanelElementRef.current
    if (element) element.style.transition = 'flex-grow 180ms ease, flex-basis 180ms ease'
    const frame = window.requestAnimationFrame(() => {
      if (todoEnabled && rightSidebarVisible) rightPanelRef.current?.expand()
      else rightPanelRef.current?.collapse()
    })
    const timer = window.setTimeout(() => {
      if (element) element.style.transition = ''
    }, 220)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      if (element) element.style.transition = ''
    }
  }, [hydrated, rightPanelRef, rightSidebarVisible, todoEnabled])

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
        // Checagem de fundo no boot — silenciosa de propósito (não vale
        // interromper o usuário por causa de uma falha de rede aqui; a tela
        // "Sobre & Atualizações" já oferece checagem sob demanda com erro
        // visível). Só loga pra não ficar indistinguível de "sem update".
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
    return <LoadingScreen />
  }

  return (
    <>
      <div className={styles.appShell}>
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
            minSize="220px"
            maxSize="380px"
            collapsedSize="0px"
            collapsible
            groupResizeBehavior="preserve-pixel-size"
            onResize={(size, _id, previous) => {
              if (
                size.inPixels >= 220 &&
                previous &&
                Math.abs(size.inPixels - previous.inPixels) >= 1
              ) {
                const nextWidth = Math.max(220, Math.min(380, Math.round(size.inPixels)))
                if (leftSidebarSaveTimerRef.current !== null)
                  window.clearTimeout(leftSidebarSaveTimerRef.current)
                leftSidebarSaveTimerRef.current = window.setTimeout(() => {
                  leftSidebarSaveTimerRef.current = null
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
          />

          <Panel id="alethe-main" minSize="360px">
            <main className={styles.mainView}>
              <ErrorBoundary label="view">
                <Suspense fallback={<LoadingScreen />}>
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

          {todoEnabled ? (
            <>
              <Separator
                className={`${styles.shellSeparator} ${rightSidebarVisible ? '' : styles.shellSeparatorHidden}`}
              />
              <Panel
                id="alethe-todo-sidebar"
                panelRef={rightPanelRef}
                elementRef={rightPanelElementRef}
                defaultSize={rightSidebarVisible ? `${rightSidebarDefaultRef.current}px` : '0px'}
                minSize="260px"
                maxSize="420px"
                collapsedSize="0px"
                collapsible
                groupResizeBehavior="preserve-pixel-size"
                onResize={(size, _id, previous) => {
                  if (
                    size.inPixels >= 260 &&
                    previous &&
                    Math.abs(size.inPixels - previous.inPixels) >= 1
                  ) {
                    const nextWidth = Math.max(260, Math.min(420, Math.round(size.inPixels)))
                    if (rightSidebarSaveTimerRef.current !== null)
                      window.clearTimeout(rightSidebarSaveTimerRef.current)
                    rightSidebarSaveTimerRef.current = window.setTimeout(() => {
                      rightSidebarSaveTimerRef.current = null
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
        <RemoteControlModal />
      </ErrorBoundary>
      <InAppNotifications />
      {activeView === 'agentCanvas' ? <TokenHud /> : null}
    </>
  )
}
