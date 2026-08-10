import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  ExternalLink,
  GripVertical,
  Maximize2,
  Minimize2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { memo, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import { openInBrowser } from '../../lib/tauri'
import type { Terminal } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { Favicon } from '../Favicon'
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
  const focusedTerminalId = useUiStore((state) => state.focusedTerminalId)
  const activeView = useUiStore((state) => state.activeView)
  const openModal = useUiStore((state) => state.openModal)
  const showMainMenu = useUiStore((state) => state.showMainMenu)
  const linkViewerUrl = useUiStore((state) => state.linkViewerUrl)
  const isFocusMode = inFocusOverlay || focusedTerminalId === terminal.id
  const browserVisible =
    !preview &&
    activeView === 'workspace' &&
    !openModal &&
    !showMainMenu &&
    !linkViewerUrl &&
    (!focusedTerminalId || focusedTerminalId === terminal.id)
  const setFocusedTerminal = useUiStore((state) => state.setFocusedTerminal)
  const setActiveTerminal = useUiStore((state) => state.setActiveTerminal)
  const deleteTerminal = useProjectsStore((state) => state.deleteTerminal)

  const draggable = useDraggable({ id: `pane:${terminal.id}`, disabled: isFocusMode || preview })
  const droppable = useDroppable({ id: `pane:${terminal.id}`, disabled: isFocusMode || preview })
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
          <PrivateBrowserSurface
            paneId={terminal.id}
            url={url}
            title={terminal.name}
            reloadKey={reloadKey}
            javascriptEnabled={terminal.browserConfig?.javascriptEnabled ?? true}
            zoom={terminal.browserConfig?.zoom ?? 1}
            visible={browserVisible}
          />
        ) : (
          <div className={styles.empty}>{t('webPane.invalidUrl')}</div>
        )}
      </div>
      <div className={styles.hint}>{t('webPane.privateHint')}</div>
    </div>
  )
})
