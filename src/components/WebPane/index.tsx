import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
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

import { browserHiddenEvictionDelay } from '../../lib/browserResourcePolicy'
import { useT } from '../../lib/i18n'
import { suspendNativeSurfaces } from '../../lib/overlayPresence'
import { openInBrowser } from '../../lib/tauri'
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
  const engine = terminal.browserConfig?.engine ?? 'native'
  const setBrowserEngine = useProjectsStore((state) => state.setBrowserEngine)
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

  const draggable = useDraggable({ id: `pane:${terminal.id}`, disabled: isFocusMode || preview })
  const droppable = useDroppable({ id: `pane:${terminal.id}`, disabled: isFocusMode || preview })
  // A native surface does not move with a dnd-kit transform, so it has to step aside mid-drag.
  useEffect(() => {
    if (!draggable.isDragging) return
    return suspendNativeSurfaces()
  }, [draggable.isDragging])

  const paneRef = useRef<HTMLDivElement | null>(null)
  const setRefs = (node: HTMLDivElement | null) => {
    paneRef.current = node
    draggable.setNodeRef(node)
    droppable.setNodeRef(node)
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
          <span className={styles.iconWrap}>
            <Favicon url={url} size={15} />
          </span>
          <span className={styles.name} title={terminal.name}>
            {terminal.name}
          </span>
          <span className={styles.url} title={url}>
            {url}
          </span>
          <span className={styles.privateBadge} title={t('browser.privateTitle')}>
            <ShieldCheck size={10} />
            {t('browser.privateBadge')}
          </span>
        </div>
        {!preview ? (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.action}
              onClick={() => setReloadKey((key) => key + 1)}
              title={t('webPane.reload')}
              aria-label={t('webPane.reload')}
            >
              <RefreshCw size={12} />
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
