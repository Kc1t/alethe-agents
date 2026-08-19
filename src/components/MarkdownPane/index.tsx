import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  FileCode,
  FileText,
  ClipboardCopy,
  FolderOpen,
  GripVertical,
  Maximize2,
  Minimize2,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'

import { pathSegments } from '../../lib/paths'
import { useT } from '../../lib/i18n'
import {
  listenFileChanged,
  openInFileExplorer,
  readTextFile,
  writeTextFile,
  writeClipboardText,
  unwatchFile,
  watchFile,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import type { Terminal as TerminalEntry } from '../../lib/types'
import { MarkdownRenderer } from './MarkdownRenderer'
import styles from './MarkdownPane.module.css'
import { isLightTheme } from '../../lib/themes'

const markdownPaneScrollPositions = new Map<string, number>()

export type MarkdownPaneProps = {
  projectId: string
  terminal: TerminalEntry
  inFocusOverlay?: boolean
  preview?: boolean
}

export const MarkdownPane = memo(function MarkdownPane({
  projectId,
  terminal,
  inFocusOverlay = false,
  preview = false,
}: MarkdownPaneProps) {
  const t = useT()
  const filePath = terminal.filePath ?? ''
  const [content, setContent] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const editingRef = useRef(false)

  const focusedTerminalId = useUiStore((s) => s.focusedTerminalId)
  const isFocusMode = inFocusOverlay || focusedTerminalId === terminal.id
  const dark = useProjectsStore((s) => !isLightTheme(s.preferences.uiTheme))

  const deleteTerminal = useProjectsStore((s) => s.deleteTerminal)
  const setFocusedTerminal = useUiStore((s) => s.setFocusedTerminal)
  const setActiveTerminal = useUiStore((s) => s.setActiveTerminal)
  const selectPane = useUiStore((s) => s.selectPane)
  const clearPaneSelection = useUiStore((s) => s.clearPaneSelection)
  const groupPanes = useProjectsStore((s) => s.groupPanes)
  const pushToast = useUiStore((s) => s.pushToast)

  const draggable = useDraggable({ id: `pane:${terminal.id}`, disabled: isFocusMode || preview })
  const droppable = useDroppable({ id: `pane:${terminal.id}`, disabled: isFocusMode || preview })
  const paneRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const setRefs = (node: HTMLDivElement | null) => {
    paneRef.current = node
    draggable.setNodeRef(node)
    droppable.setNodeRef(node)
  }

  const reload = useCallback(async () => {
    if (!filePath) {
      setError('no file')
      return
    }
    try {
      const text = await readTextFile(filePath)
      setContent(text)
      if (!editingRef.current) setDraft(text)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [filePath])

  const startEditing = () => {
    if (content === null) return
    setDraft(content)
    editingRef.current = true
    setEditing(true)
  }

  const cancelEditing = () => {
    editingRef.current = false
    setDraft(content ?? '')
    setEditing(false)
  }

  const saveEditing = async () => {
    if (!filePath || content === null || saving) return
    setSaving(true)
    try {
      await writeTextFile(filePath, draft)
      setContent(draft)
      editingRef.current = false
      setEditing(false)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!filePath) return
    editingRef.current = false
    setEditing(false)
    void reload()
    void watchFile(filePath).catch(() => {})
    const unlisten = listenFileChanged((changed) => {
      if (changed === filePath) void reload()
    })
    return () => {
      void unwatchFile(filePath).catch(() => {})
      void unlisten.then((fn) => fn()).catch(() => {})
    }
  }, [filePath, reload])

  useEffect(() => {
    if (!filePath || content === null) return
    const frame = window.requestAnimationFrame(() => {
      if (scrollRef.current)
        scrollRef.current.scrollTop = markdownPaneScrollPositions.get(filePath) ?? 0
    })
    return () => window.cancelAnimationFrame(frame)
  }, [content, filePath])

  // Foco vindo da sidebar — scroll into view.
  const focusReq = useUiStore((s) => s.focusRequest)
  useEffect(() => {
    if (!focusReq || focusReq.terminalId !== terminal.id) return
    paneRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [focusReq, terminal.id])

  const onDelete = () => {
    if (window.confirm(t('ui.markdown.confirmClose', { name: terminal.name }))) {
      deleteTerminal(projectId, terminal.id)
      if (isFocusMode) setFocusedTerminal(null)
    }
  }

  const copyMarkdown = async () => {
    if (content === null) return
    try {
      await writeClipboardText(content)
      setCopied(true)
      pushToast({ title: t('ui.markdown.copied'), body: '' })
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  const dropTarget = droppable.isOver && !isFocusMode
  const dragging = draggable.isDragging

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
      className={`${styles.pane} ${isFocusMode ? styles.paneFocus : ''} ${dragging ? styles.dragging : ''} ${dropTarget ? styles.dropTarget : ''}`}
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
            {terminal.kind === 'file' ? <FileCode size={16} /> : <FileText size={16} />}
          </span>
          <div className={styles.identity}>
            <span className={styles.name} title={terminal.name}>
              {terminal.name}
            </span>
            {filePath ? (
              <span className={styles.cwdPill} title={filePath}>
                {shortPath(filePath)}
              </span>
            ) : null}
          </div>
        </div>

        {!preview ? (
          <div className={styles.headRight}>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.action}
                onClick={() => void reload()}
                title={t('ui.markdown.refresh')}
                aria-label={t('ui.markdown.refresh')}
              >
                <RefreshCw size={12} />
              </button>
              <button
                type="button"
                className={styles.action}
                onClick={() => void copyMarkdown()}
                disabled={content === null}
                title={copied ? t('ui.markdown.copied') : t('ui.markdown.copySource')}
                aria-label={copied ? t('ui.markdown.copied') : t('ui.markdown.copySource')}
              >
                <ClipboardCopy size={12} />
              </button>
              {editing ? (
                <>
                  <button
                    type="button"
                    className={styles.action}
                    onClick={() => void saveEditing()}
                    disabled={saving || content === null}
                    title={saving ? t('ui.markdown.saving') : t('ui.markdown.save')}
                    aria-label={saving ? t('ui.markdown.saving') : t('ui.markdown.save')}
                  >
                    <Save size={12} />
                  </button>
                  <button
                    type="button"
                    className={styles.action}
                    onClick={cancelEditing}
                    disabled={saving}
                    title={t('ui.markdown.cancelEdit')}
                    aria-label={t('ui.markdown.cancelEdit')}
                  >
                    <X size={12} />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={styles.action}
                  onClick={startEditing}
                  disabled={content === null}
                  title={t('ui.markdown.edit')}
                  aria-label={t('ui.markdown.edit')}
                >
                  <Pencil size={12} />
                </button>
              )}
              <button
                type="button"
                className={styles.action}
                onClick={() => void openInFileExplorer(parentDir(filePath))}
                disabled={!filePath}
                title={t('ui.terminal.openInExplorer')}
                aria-label={t('ui.terminal.openInExplorer')}
              >
                <FolderOpen size={12} />
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
                title={t('ui.markdown.close')}
                aria-label={t('ui.markdown.close')}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ) : null}
      </header>

      <div className={styles.body}>
        {error ? (
          <div className={styles.empty}>
            <FileText size={20} />
            <span>{t('ui.markdown.loadError', { path: filePath })}</span>
            <button type="button" className={styles.retryBtn} onClick={() => void reload()}>
              {t('ui.markdown.refresh')}
            </button>
          </div>
        ) : content === null ? (
          <div className={styles.empty}>
            <span>{t('ui.markdown.loading')}</span>
          </div>
        ) : editing ? (
          <textarea
            className={styles.editor}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            autoFocus
            aria-label={t('ui.markdown.edit')}
          />
        ) : terminal.kind === 'file' ? (
          <div
            ref={scrollRef}
            className={styles.scroll}
            onScroll={(event) =>
              markdownPaneScrollPositions.set(filePath, event.currentTarget.scrollTop)
            }
          >
            <pre className={styles.textView}>{content}</pre>
          </div>
        ) : (
          <div
            ref={scrollRef}
            className={styles.scroll}
            onScroll={(event) =>
              markdownPaneScrollPositions.set(filePath, event.currentTarget.scrollTop)
            }
          >
            <MarkdownRenderer content={content} dark={dark} />
          </div>
        )}
      </div>
    </div>
  )
})

function shortPath(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const parts = pathSegments(cleaned)
  if (parts.length <= 2) return cleaned
  return `…/${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

function parentDir(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return idx > 0 ? cleaned.slice(0, idx) : cleaned
}
