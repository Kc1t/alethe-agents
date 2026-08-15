import { FolderOpen, GripVertical, Maximize2, Minimize2, Trash2 } from 'lucide-react'
import { memo, useRef } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'

import { useT } from '../../lib/i18n'
import { openInFileExplorer } from '../../lib/tauri'
import { pathSegments } from '../../lib/paths'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import type { Terminal as TerminalEntry } from '../../lib/types'
import { VideoPreview } from '../VideoPreview'
import styles from './VideoPane.module.css'

export const VideoPane = memo(function VideoPane({
  projectId,
  terminal,
  inFocusOverlay = false,
  preview = false,
}: {
  projectId: string
  terminal: TerminalEntry
  inFocusOverlay?: boolean
  preview?: boolean
}) {
  const t = useT()
  const filePath = terminal.filePath ?? ''
  const focusedTerminalId = useUiStore((state) => state.focusedTerminalId)
  const isFocusMode = inFocusOverlay || focusedTerminalId === terminal.id
  const setFocusedTerminal = useUiStore((state) => state.setFocusedTerminal)
  const setActiveTerminal = useUiStore((state) => state.setActiveTerminal)
  const selectPane = useUiStore((state) => state.selectPane)
  const clearPaneSelection = useUiStore((state) => state.clearPaneSelection)
  const groupPanes = useProjectsStore((state) => state.groupPanes)
  const deleteTerminal = useProjectsStore((state) => state.deleteTerminal)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const draggable = useDraggable({ id: `pane:${terminal.id}`, disabled: isFocusMode || preview })
  const droppable = useDroppable({ id: `pane:${terminal.id}`, disabled: isFocusMode || preview })
  const setRefs = (node: HTMLDivElement | null) => {
    paneRef.current = node
    draggable.setNodeRef(node)
    droppable.setNodeRef(node)
  }
  const onDelete = () => {
    if (window.confirm(t('ui.markdown.confirmClose', { name: terminal.name }))) {
      deleteTerminal(projectId, terminal.id)
      if (isFocusMode) setFocusedTerminal(null)
    }
  }

  return (
    <div
      ref={setRefs}
      data-pane-box="1"
      onPointerDown={(event) => {
        setActiveTerminal(projectId, terminal.id)
        const existing = useUiStore.getState().selectedPanes
        const extend = event.shiftKey && existing.every((pane) => pane.projectId === projectId)
        selectPane(projectId, terminal.id, extend)
        if (extend) {
          const selected = useUiStore.getState().selectedPanes
          if (selected.length >= 2) {
            groupPanes(
              projectId,
              selected.map((pane) => pane.terminalId),
            )
            clearPaneSelection()
          }
        }
      }}
      className={`${styles.pane} ${isFocusMode ? styles.paneFocus : ''} ${draggable.isDragging ? styles.dragging : ''} ${droppable.isOver && !isFocusMode ? styles.dropTarget : ''}`}
    >
      <header className={styles.header}>
        <div className={styles.identity}>
          {!isFocusMode && !preview ? (
            <button
              type="button"
              className={styles.action}
              {...draggable.attributes}
              {...draggable.listeners}
              title={t('ui.terminal.dragToReorder')}
              aria-label={t('ui.terminal.dragToReorder')}
            >
              <GripVertical size={12} />
            </button>
          ) : null}
          <strong title={terminal.name}>{terminal.name}</strong>
          <span title={filePath}>{shortPath(filePath)}</span>
        </div>
        {!preview ? (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.action}
              onClick={() => void openInFileExplorer(parentDir(filePath))}
              title={t('ui.terminal.openInExplorer')}
              aria-label={t('ui.terminal.openInExplorer')}
            >
              <FolderOpen size={12} />
            </button>
            <button
              type="button"
              className={styles.action}
              onClick={() => setFocusedTerminal(isFocusMode ? null : terminal.id)}
              title={
                isFocusMode
                  ? t('ui.terminal.exitFocusModeEsc')
                  : t('ui.terminal.focusModeFullscreen')
              }
              aria-label={isFocusMode ? t('ui.terminal.exitFocusMode') : t('ui.terminal.focusMode')}
            >
              {isFocusMode ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            </button>
            <button
              type="button"
              className={`${styles.action} ${styles.danger}`}
              onClick={onDelete}
              title={t('ui.markdown.close')}
              aria-label={t('ui.markdown.close')}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ) : null}
      </header>
      <div className={styles.body}>
        <VideoPreview path={filePath} />
      </div>
    </div>
  )
})

function shortPath(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const parts = pathSegments(cleaned)
  return parts.length <= 2 ? cleaned : `…/${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

function parentDir(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const index = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return index > 0 ? cleaned.slice(0, index) : cleaned
}
