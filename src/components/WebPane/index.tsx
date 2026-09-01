import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Crosshair,
  ExternalLink,
  GripVertical,
  Maximize2,
  Minimize2,
  MonitorPlay,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'

import {
  formatBrowserGrabMarkdown,
  formatBrowserPageCaptureMarkdown,
  resolveBrowserGrabTarget,
  sendBrowserGrabToAgent,
} from '../../lib/browserGrab'
import { normalizeBrowserUrl } from '../../lib/browserUrl'
import { browserHiddenEvictionDelay } from '../../lib/browserResourcePolicy'
import { useT } from '../../lib/i18n'
import { suspendNativeSurfaces } from '../../lib/overlayPresence'
import {
  type BrowserInspectResult,
  browserPaneCapture,
  browserPaneHistory,
  browserPaneNavigate,
  openInBrowser,
  writeClipboardText,
} from '../../lib/tauri'
import type { Terminal } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { Favicon } from '../Favicon'
import { useWorkspaceSurface } from '../WorkspaceView/workspaceSurface'
import { CdpBrowserSurface } from './CdpBrowserSurface'
import { PrivateBrowserSurface } from './PrivateBrowserSurface'
import styles from './WebPane.module.css'

type WebPaneProps = {
  projectId: string
  terminal: Terminal
  preview?: boolean
  inFocusOverlay?: boolean
}

export const WebPane = memo(function WebPane({
  projectId,
  terminal,
  preview = false,
  inFocusOverlay = false,
}: WebPaneProps) {
  const t = useT()
  const url = terminal.url ?? ''
  const [reloadKey, setReloadKey] = useState(0)
  const [addressDraft, setAddressDraft] = useState(url)
  const historyRef = useRef<{ entries: string[]; index: number }>({
    entries: url ? [url] : [],
    index: 0,
  })
  const [navState, setNavState] = useState({ canGoBack: false, canGoForward: false })
  const [grabMode, setGrabMode] = useState(false)
  const [grab, setGrab] = useState<BrowserInspectResult | null>(null)
  const [grabBusy, setGrabBusy] = useState(false)
  const engine = terminal.browserConfig?.engine ?? 'native'
  const setBrowserEngine = useProjectsStore((state) => state.setBrowserEngine)
  const setBrowserPaneUrl = useProjectsStore((state) => state.setBrowserPaneUrl)
  const projects = useProjectsStore((state) => state.projects)
  const focusedTerminalId = useUiStore((state) => state.focusedTerminalId)
  const activeTerminal = useUiStore((state) => state.activeTerminal)
  const pushToast = useUiStore((state) => state.pushToast)
  const activeView = useUiStore((state) => state.activeView)
  const openModal = useUiStore((state) => state.openModal)
  const showMainMenu = useUiStore((state) => state.showMainMenu)
  const linkViewerUrl = useUiStore((state) => state.linkViewerUrl)
  const memoryPressure = useUiStore((state) => state.runtimeSnapshot?.pressure.level ?? 'normal')
  // An inactive workspace tab stays mounted at full size with only `visibility: hidden`, which
  // an IntersectionObserver still reports as on screen — the native surface has to be told.
  const surface = useWorkspaceSurface()
  const isFocusMode = inFocusOverlay || focusedTerminalId === terminal.id
  const browserVisible =
    !preview &&
    surface?.active !== false &&
    activeView === 'workspace' &&
    !openModal &&
    !showMainMenu &&
    !linkViewerUrl &&
    (!focusedTerminalId || focusedTerminalId === terminal.id)
  const hiddenEvictionDelayMs = browserHiddenEvictionDelay(
    terminal.browserConfig?.resourceMode ?? 'app-first',
    memoryPressure,
  )
  const setFocusedTerminal = useUiStore((state) => state.setFocusedTerminal)
  const setActiveTerminal = useUiStore((state) => state.setActiveTerminal)
  const deleteTerminal = useProjectsStore((state) => state.deleteTerminal)
  const { canGoBack, canGoForward } = navState

  const syncNavState = () => {
    const hist = historyRef.current
    setNavState({
      canGoBack: hist.index > 0,
      canGoForward: hist.index < hist.entries.length - 1,
    })
  }

  const draggable = useDraggable({ id: `pane:${terminal.id}`, disabled: isFocusMode || preview })
  const droppable = useDroppable({ id: `pane:${terminal.id}`, disabled: isFocusMode || preview })
  // A native surface does not move with a dnd-kit transform, so it has to step aside mid-drag.
  useEffect(() => {
    if (!draggable.isDragging) return
    return suspendNativeSurfaces()
  }, [draggable.isDragging])

  useEffect(() => {
    setAddressDraft(url)
    const hist = historyRef.current
    if (!url) return
    if (hist.entries[hist.index] === url) return
    const existing = hist.entries.indexOf(url)
    if (existing >= 0) {
      hist.index = existing
    } else {
      hist.entries = [...hist.entries.slice(0, hist.index + 1), url]
      hist.index = hist.entries.length - 1
    }
    syncNavState()
  }, [url])

  const paneRef = useRef<HTMLDivElement | null>(null)
  const setRefs = (node: HTMLDivElement | null) => {
    paneRef.current = node
    draggable.setNodeRef(node)
    droppable.setNodeRef(node)
  }

  const applyUrl = async (nextUrl: string) => {
    if (!nextUrl || nextUrl === url) return
    const hist = historyRef.current
    hist.entries = [...hist.entries.slice(0, hist.index + 1), nextUrl]
    hist.index = hist.entries.length - 1
    syncNavState()
    setBrowserPaneUrl(projectId, terminal.id, nextUrl)
    if (engine === 'cdp') {
      try {
        await browserPaneNavigate(terminal.id, nextUrl)
      } catch {
        setReloadKey((key) => key + 1)
      }
    } else {
      setReloadKey((key) => key + 1)
    }
  }

  const submitAddress = () => {
    const normalized = normalizeBrowserUrl(addressDraft)
    if (!normalized) {
      setAddressDraft(url)
      return
    }
    void applyUrl(normalized)
  }

  const goHistory = async (delta: -1 | 1) => {
    const hist = historyRef.current
    const nextIndex = hist.index + delta
    if (nextIndex < 0 || nextIndex >= hist.entries.length) return

    if (engine === 'cdp') {
      try {
        const moved = await browserPaneHistory(terminal.id, delta)
        if (!moved) return
        hist.index = nextIndex
        syncNavState()
        const nextUrl = hist.entries[nextIndex]
        setAddressDraft(nextUrl)
        setBrowserPaneUrl(projectId, terminal.id, nextUrl)
        return
      } catch {
        /* fall through to local history */
      }
    }

    hist.index = nextIndex
    syncNavState()
    const nextUrl = hist.entries[nextIndex]
    setAddressDraft(nextUrl)
    setBrowserPaneUrl(projectId, terminal.id, nextUrl)
    setReloadKey((key) => key + 1)
  }

  const onDelete = () => {
    if (!window.confirm(t('webPane.confirmClose', { name: terminal.name }))) return
    deleteTerminal(projectId, terminal.id)
    if (isFocusMode) setFocusedTerminal(null)
  }

  const toggleGrabMode = () => {
    if (preview) return
    if (engine !== 'cdp') {
      setBrowserEngine(projectId, terminal.id, 'cdp')
      pushToast({
        title: t('webPane.grabNeedsCdpTitle'),
        body: t('webPane.grabNeedsCdpBody'),
      })
    }
    setGrab(null)
    setGrabMode((value) => !value)
  }

  const onGrabInspect = useCallback((result: BrowserInspectResult) => {
    setGrab(result)
    setGrabMode(false)
  }, [])

  const cancelGrabUi = useCallback(() => {
    setGrabMode(false)
    setGrab(null)
  }, [])

  useEffect(() => {
    if (!grabMode && !grab) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      cancelGrabUi()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cancelGrabUi, grab, grabMode])

  const clearGrab = () => setGrab(null)

  const copyGrab = async () => {
    if (!grab) return
    setGrabBusy(true)
    try {
      let screenshotPath: string | null = null
      if (grab.rect.width > 0 && grab.rect.height > 0) {
        const shot = await browserPaneCapture(terminal.id, grab.rect).catch(() => null)
        screenshotPath = shot?.path ?? null
      }
      const markdown = formatBrowserGrabMarkdown(grab, screenshotPath)
      await writeClipboardText(markdown)
      pushToast({ title: t('webPane.grabCopied'), body: grab.selector || grab.tagName })
    } catch (error) {
      pushToast({
        title: t('webPane.grabFailed'),
        body: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setGrabBusy(false)
    }
  }

  const sendGrab = async () => {
    if (!grab) return
    const target = resolveBrowserGrabTarget({
      projects,
      preferredTerminalId: focusedTerminalId,
      activeTerminal,
    })
    if (!target) {
      pushToast({
        title: t('webPane.grabNoAgentTitle'),
        body: t('webPane.grabNoAgentBody'),
      })
      return
    }
    setGrabBusy(true)
    try {
      let screenshotPath: string | null = null
      if (grab.rect.width > 0 && grab.rect.height > 0) {
        const shot = await browserPaneCapture(terminal.id, grab.rect).catch(() => null)
        screenshotPath = shot?.path ?? null
      }
      const markdown = formatBrowserGrabMarkdown(grab, screenshotPath)
      await sendBrowserGrabToAgent(target, markdown)
      pushToast({
        title: t('webPane.grabSentTitle'),
        body: t('webPane.grabSentBody', { agent: target.label }),
      })
      setGrab(null)
    } catch (error) {
      pushToast({
        title: t('webPane.grabFailed'),
        body: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setGrabBusy(false)
    }
  }

  const sendPageScreenshot = async () => {
    if (preview || !url) return
    if (engine !== 'cdp') {
      setBrowserEngine(projectId, terminal.id, 'cdp')
      pushToast({
        title: t('webPane.grabNeedsCdpTitle'),
        body: t('webPane.pageShotNeedsCdpBody'),
      })
      return
    }
    const target = resolveBrowserGrabTarget({
      projects,
      preferredTerminalId: focusedTerminalId,
      activeTerminal,
    })
    if (!target) {
      pushToast({
        title: t('webPane.grabNoAgentTitle'),
        body: t('webPane.grabNoAgentBody'),
      })
      return
    }
    setGrabBusy(true)
    try {
      const shot = await browserPaneCapture(terminal.id, null)
      const markdown = formatBrowserPageCaptureMarkdown({
        pageUrl: url,
        pageTitle: terminal.name,
        screenshotPath: shot.path,
      })
      await sendBrowserGrabToAgent(target, markdown)
      pushToast({
        title: t('webPane.pageShotSentTitle'),
        body: t('webPane.grabSentBody', { agent: target.label }),
      })
    } catch (error) {
      pushToast({
        title: t('webPane.pageShotFailed'),
        body: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setGrabBusy(false)
    }
  }

  return (
    <div
      ref={setRefs}
      data-pane-box="1"
      onPointerDown={() => setActiveTerminal(projectId, terminal.id)}
      className={`${styles.pane} ${isFocusMode ? styles.paneFocus : ''} ${draggable.isDragging ? styles.dragging : ''} ${droppable.isOver && !isFocusMode ? styles.dropTarget : ''}`}
    >
      <header className={styles.header}>
        <div className={styles.headLeft}>
          {!isFocusMode && !preview ? (
            <button
              type="button"
              className={`${styles.action} ${styles.gripBtn}`}
              {...draggable.attributes}
              {...draggable.listeners}
              title={t('ui.terminal.dragToReorder')}
              aria-label={t('ui.terminal.dragToReorder')}
            >
              <GripVertical size={12} />
            </button>
          ) : null}
          <button
            type="button"
            className={styles.action}
            onClick={() => void goHistory(-1)}
            disabled={!canGoBack || preview}
            title={t('webPane.back')}
            aria-label={t('webPane.back')}
          >
            <ArrowLeft size={12} />
          </button>
          <button
            type="button"
            className={styles.action}
            onClick={() => void goHistory(1)}
            disabled={!canGoForward || preview}
            title={t('webPane.forward')}
            aria-label={t('webPane.forward')}
          >
            <ArrowRight size={12} />
          </button>
          <button
            type="button"
            className={styles.action}
            onClick={() => setReloadKey((key) => key + 1)}
            disabled={preview}
            title={t('webPane.reload')}
            aria-label={t('webPane.reload')}
          >
            <RefreshCw size={12} />
          </button>
          <span className={styles.iconWrap}>
            <Favicon url={url} size={15} />
          </span>
          {!preview ? (
            <input
              className={styles.address}
              value={addressDraft}
              onChange={(event) => setAddressDraft(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitAddress()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setAddressDraft(url)
                  event.currentTarget.blur()
                }
              }}
              onBlur={() => {
                if (!normalizeBrowserUrl(addressDraft)) setAddressDraft(url)
              }}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              inputMode="url"
              title={url}
              aria-label={t('webPane.addressBar')}
              placeholder={t('browser.urlPlaceholder')}
            />
          ) : (
            <span className={styles.url} title={url}>
              {url}
            </span>
          )}
          <span className={styles.privateBadge} title={t('browser.privateTitle')}>
            <ShieldCheck size={10} />
            {t('browser.privateBadge')}
          </span>
        </div>
        {!preview ? (
          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.action} ${grabMode ? styles.actionOn : ''}`}
              onClick={toggleGrabMode}
              title={t(grabMode ? 'webPane.grabCancel' : 'webPane.grabMark')}
              aria-label={t(grabMode ? 'webPane.grabCancel' : 'webPane.grabMark')}
              aria-pressed={grabMode}
            >
              <Crosshair size={12} />
            </button>
            <button
              type="button"
              className={styles.action}
              onClick={() => void sendPageScreenshot()}
              disabled={grabBusy || !url}
              title={t('webPane.pageShot')}
              aria-label={t('webPane.pageShot')}
            >
              <Camera size={12} />
            </button>
            <button
              type="button"
              className={`${styles.action} ${engine === 'cdp' ? styles.actionOn : ''}`}
              onClick={() =>
                setBrowserEngine(projectId, terminal.id, engine === 'cdp' ? 'native' : 'cdp')
              }
              title={t(engine === 'cdp' ? 'webPane.engineCdpOn' : 'webPane.engineCdpOff')}
              aria-label={t(engine === 'cdp' ? 'webPane.engineCdpOn' : 'webPane.engineCdpOff')}
              aria-pressed={engine === 'cdp'}
            >
              <MonitorPlay size={12} />
            </button>
            <button
              type="button"
              className={styles.action}
              onClick={() => void openInBrowser(url)}
              disabled={!url}
              title={t('xterm.openInBrowser')}
              aria-label={t('xterm.openInBrowser')}
            >
              <ExternalLink size={12} />
            </button>
            {isFocusMode ? (
              <button
                type="button"
                className={styles.action}
                onClick={() => setFocusedTerminal(null)}
                title={t('ui.terminal.exitFocusModeEsc')}
                aria-label={t('ui.terminal.exitFocusMode')}
              >
                <Minimize2 size={12} />
              </button>
            ) : (
              <button
                type="button"
                className={styles.action}
                onClick={() => setFocusedTerminal(terminal.id)}
                title={t('ui.terminal.focusModeFullscreen')}
                aria-label={t('ui.terminal.focusMode')}
              >
                <Maximize2 size={12} />
              </button>
            )}
            <button
              type="button"
              className={`${styles.action} ${styles.danger}`}
              onClick={onDelete}
              title={t('webPane.close')}
              aria-label={t('webPane.close')}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ) : null}
      </header>
      <div className={styles.body}>
        {url ? (
          engine === 'cdp' ? (
            <CdpBrowserSurface
              paneId={terminal.id}
              url={url}
              reloadKey={reloadKey}
              visible={browserVisible}
              watchTargetId={terminal.browserConfig?.watchTargetId}
              grabMode={grabMode}
              highlightRect={grab?.rect ?? null}
              onGrabInspect={onGrabInspect}
              onGrabCancel={cancelGrabUi}
            />
          ) : (
            <PrivateBrowserSurface
              paneId={terminal.id}
              url={url}
              title={terminal.name}
              reloadKey={reloadKey}
              javascriptEnabled={terminal.browserConfig?.javascriptEnabled ?? true}
              hiddenEvictionDelayMs={hiddenEvictionDelayMs}
              zoom={terminal.browserConfig?.zoom ?? 1}
              visible={browserVisible}
            />
          )
        ) : (
          <div className={styles.empty}>{t('webPane.invalidUrl')}</div>
        )}
      </div>
      {grabMode ? (
        <div className={styles.grabTray}>
          <span className={styles.grabTrayHint}>{t('webPane.grabHint')}</span>
          <div className={styles.grabTrayActions}>
            <button type="button" className={styles.grabTrayBtn} onClick={() => setGrabMode(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : null}
      {grab ? (
        <div className={styles.grabTray}>
          <span className={styles.grabTrayMeta} title={grab.selector}>
            {`<${grab.tagName}>`} {grab.ariaLabel || grab.textSnippet || grab.selector}
          </span>
          <div className={styles.grabTrayActions}>
            <button
              type="button"
              className={styles.grabTrayBtn}
              disabled={grabBusy}
              onClick={() => void copyGrab()}
            >
              {t('webPane.grabCopy')}
            </button>
            <button
              type="button"
              className={`${styles.grabTrayBtn} ${styles.grabTrayBtnPrimary}`}
              disabled={grabBusy}
              onClick={() => void sendGrab()}
            >
              {t('webPane.grabSend')}
            </button>
            <button type="button" className={styles.grabTrayBtn} onClick={clearGrab}>
              {t('common.close')}
            </button>
          </div>
        </div>
      ) : null}
      <div className={styles.hint}>{t('webPane.privateHint')}</div>
    </div>
  )
})
