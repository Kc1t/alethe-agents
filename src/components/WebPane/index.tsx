import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  GripVertical,
  Maximize2,
  Minimize2,
  MonitorPlay,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'

import { normalizeBrowserUrl } from '../../lib/browserUrl'
import { browserHiddenEvictionDelay } from '../../lib/browserResourcePolicy'
import { useT } from '../../lib/i18n'
import { suspendNativeSurfaces } from '../../lib/overlayPresence'
import { browserPaneHistory, browserPaneNavigate, openInBrowser } from '../../lib/tauri'
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
  const engine = terminal.browserConfig?.engine ?? 'native'
  const setBrowserEngine = useProjectsStore((state) => state.setBrowserEngine)
  const setBrowserPaneUrl = useProjectsStore((state) => state.setBrowserPaneUrl)
  const focusedTerminalId = useUiStore((state) => state.focusedTerminalId)
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
      <div className={styles.hint}>{t('webPane.privateHint')}</div>
    </div>
  )
})
