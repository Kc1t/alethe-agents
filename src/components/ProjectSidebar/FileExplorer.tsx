import { convertFileSrc } from '@tauri-apps/api/core'
import {
  ChevronDown,
  ChevronRight,
  Eye,
  File,
  Folder,
  FolderOpen,
  FolderSearch,
  LayoutGrid,
  PanelRightOpen,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { readableError } from '../../lib/errors'
import { writeFileDragPayload } from '../../lib/fileDrag'
import { useT } from '../../lib/i18n'
import { basename } from '../../lib/paths'
import {
  deleteFilesystemEntry,
  type DirectoryEntry,
  getPtyCwd,
  listDirectory,
  openInFileExplorer,
  readTextFile,
  renameFilesystemEntry,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from '../modals/Modal'
import styles from './FileExplorer.module.css'

type FileExplorerProps = {
  projectId: string
  cwd: string
  ptyId: string | null
  terminalName: string
}

type Preview = DirectoryEntry & { content: string | null; error: string | null }
type ContextMenu = { entry: DirectoryEntry; x: number; y: number }

const IMAGE_PATTERN = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i
const VIDEO_PATTERN = /\.(mp4|m4v|mov|webm|ogv)$/i
const PDF_PATTERN = /\.pdf$/i
const MARKDOWN_PATTERN = /\.(md|markdown|mdx)$/i
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024

export function FileExplorer({ projectId, cwd, ptyId, terminalName }: FileExplorerProps) {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const createFilePane = useProjectsStore((state) => state.createFilePane)
  const openPane = useProjectsStore((state) => state.openPane)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const requestPaneFocus = useUiStore((state) => state.requestPaneFocus)
  const openMarkdownSidebar = useUiStore((state) => state.openMarkdownSidebar)
  const [reloadKey, setReloadKey] = useState(0)
  const [liveCwd, setLiveCwd] = useState(cwd)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [menu, setMenu] = useState<ContextMenu | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setLiveCwd(cwd)
    if (cwd || !ptyId) return
    let cancelled = false
    getPtyCwd(ptyId)
      .then((value) => {
        if (!cancelled && value) setLiveCwd(value)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [cwd, ptyId])

  useEffect(() => {
    if (!menu) return
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu])

  const addToGrid = (entry: DirectoryEntry) => {
    if (entry.is_dir) return
    const pane = createFilePane(projectId, { filePath: entry.path })
    openPane(projectId, pane.id)
    requestPaneFocus(pane.id)
    setMenu(null)
  }

  const openMarkdownInSidebar = (entry: DirectoryEntry) => {
    if (entry.is_dir || !MARKDOWN_PATTERN.test(entry.path)) return
    openMarkdownSidebar(entry.path, entry.name)
    setPreferences({ rightSidebarVisible: true })
    setPreview(null)
    setMenu(null)
  }

  const showPreview = async (entry: DirectoryEntry) => {
    if (entry.is_dir) return
    setMenu(null)
    if (
      IMAGE_PATTERN.test(entry.path) ||
      VIDEO_PATTERN.test(entry.path) ||
      PDF_PATTERN.test(entry.path)
    ) {
      setPreview({ ...entry, content: null, error: null })
      return
    }
    if ((entry.size ?? 0) > MAX_TEXT_PREVIEW_BYTES) {
      setPreview({ ...entry, content: null, error: t('files.previewTooLarge') })
      return
    }
    setPreview({ ...entry, content: null, error: null })
    try {
      const content = await readTextFile(entry.path)
      setPreview((current) => (current?.path === entry.path ? { ...current, content } : current))
    } catch (error) {
      setPreview((current) =>
        current?.path === entry.path ? { ...current, error: readableError(error) } : current,
      )
    }
  }

  const renameEntry = async (entry: DirectoryEntry) => {
    setMenu(null)
    const nextName = window
      .prompt(t('files.renamePrompt', { name: entry.name }), entry.name)
      ?.trim()
    if (!nextName || nextName === entry.name) return
    try {
      await renameFilesystemEntry(entry.path, nextName)
      setReloadKey((value) => value + 1)
      pushToast({ title: t('files.renameDone'), body: nextName })
    } catch (error) {
      pushToast({ title: t('files.actionFailed'), body: readableError(error) })
    }
  }

  const deleteEntry = async (entry: DirectoryEntry) => {
    setMenu(null)
    if (
      !window.confirm(
        t(entry.is_dir ? 'files.deleteFolderConfirm' : 'files.deleteFileConfirm', {
          name: entry.name,
        }),
      )
    )
      return
    try {
      await deleteFilesystemEntry(entry.path)
      setReloadKey((value) => value + 1)
      pushToast({ title: t('files.deleteDone'), body: entry.name })
    } catch (error) {
      pushToast({ title: t('files.actionFailed'), body: readableError(error) })
    }
  }

  if (!liveCwd) {
    return <div className={styles.message}>{t('files.noActiveFolder')}</div>
  }

  return (
    <div className={styles.explorer} onContextMenu={(event) => event.preventDefault()}>
      <div className={styles.context} title={liveCwd}>
        <span className={styles.contextName}>{terminalName}</span>
        <span className={styles.contextPath}>{liveCwd}</span>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => void openInFileExplorer(liveCwd)}
          title={t('files.revealFolder')}
          aria-label={t('files.revealFolder')}
        >
          <FolderSearch size={13} />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => setReloadKey((value) => value + 1)}
          title={t('files.refresh')}
          aria-label={t('files.refresh')}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <DirectoryNode
        projectId={projectId}
        path={liveCwd}
        name={rootName(liveCwd)}
        depth={0}
        initialOpen
        reloadKey={reloadKey}
        onOpen={addToGrid}
        onPreview={showPreview}
        onOpenMarkdownSidebar={openMarkdownInSidebar}
        onContextMenu={(event, entry) => {
          event.preventDefault()
          event.stopPropagation()
          setMenu({ entry, x: event.clientX, y: event.clientY })
        }}
      />

      {menu ? (
        <div
          ref={menuRef}
          className={styles.contextMenu}
          style={{ left: menu.x, top: menu.y }}
          role="menu"
        >
          {!menu.entry.is_dir ? (
            <>
              <MenuAction
                icon={<LayoutGrid size={13} />}
                label={t('files.addToGrid')}
                onClick={() => addToGrid(menu.entry)}
              />
              <MenuAction
                icon={<Eye size={13} />}
                label={t('files.preview')}
                onClick={() => void showPreview(menu.entry)}
              />
              {MARKDOWN_PATTERN.test(menu.entry.path) ? (
                <MenuAction
                  icon={<PanelRightOpen size={13} />}
                  label={t('files.openMarkdownSidebar')}
                  onClick={() => openMarkdownInSidebar(menu.entry)}
                />
              ) : null}
            </>
          ) : null}
          <MenuAction
            icon={<FolderSearch size={13} />}
            label={t('files.reveal')}
            onClick={() => {
              setMenu(null)
              void openInFileExplorer(menu.entry.path)
            }}
          />
          <MenuAction
            icon={<Pencil size={13} />}
            label={t('files.rename')}
            onClick={() => void renameEntry(menu.entry)}
          />
          <MenuAction
            danger
            icon={<Trash2 size={13} />}
            label={t('files.delete')}
            onClick={() => void deleteEntry(menu.entry)}
          />
        </div>
      ) : null}

      <FilePreviewModal
        preview={preview}
        onClose={() => setPreview(null)}
        onAdd={() => preview && addToGrid(preview)}
        onOpenMarkdownSidebar={() => preview && openMarkdownInSidebar(preview)}
      />
    </div>
  )
}

function DirectoryNode({
  projectId,
  path,
  name,
  depth,
  initialOpen = false,
  reloadKey,
  onOpen,
  onPreview,
  onOpenMarkdownSidebar,
  onContextMenu,
}: {
  projectId: string
  path: string
  name: string
  depth: number
  initialOpen?: boolean
  reloadKey: number
  onOpen: (entry: DirectoryEntry) => void
  onPreview: (entry: DirectoryEntry) => void
  onOpenMarkdownSidebar: (entry: DirectoryEntry) => void
  onContextMenu: (event: React.MouseEvent, entry: DirectoryEntry) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(initialOpen)
  const [entries, setEntries] = useState<DirectoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(false)
    listDirectory(path)
      .then((result) => {
        if (!cancelled) setEntries(result)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, path, reloadKey])

  return (
    <div>
      <button
        type="button"
        className={`${styles.row} ${depth === 0 ? styles.rootRow : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => setOpen((value) => !value)}
        onContextMenu={
          depth === 0
            ? undefined
            : (event) => onContextMenu(event, { name, path, is_dir: true, size: null })
        }
        title={path}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {open ? <FolderOpen size={14} /> : <Folder size={14} />}
        <span>{name}</span>
      </button>
      {open ? (
        <div>
          {loading ? <div className={styles.message}>{t('files.loading')}</div> : null}
          {error ? <div className={styles.message}>{t('files.readError')}</div> : null}
          {!loading && !error
            ? entries.map((entry) =>
                entry.is_dir ? (
                  <DirectoryNode
                    key={entry.path}
                    projectId={projectId}
                    path={entry.path}
                    name={entry.name}
                    depth={depth + 1}
                    reloadKey={reloadKey}
                    onOpen={onOpen}
                    onPreview={onPreview}
                    onOpenMarkdownSidebar={onOpenMarkdownSidebar}
                    onContextMenu={onContextMenu}
                  />
                ) : (
                  <div
                    key={entry.path}
                    className={styles.row}
                    style={{ paddingLeft: 22 + depth * 14 }}
                    title={t('files.dragHint', { path: entry.path })}
                    draggable
                    onDragStart={(event) => {
                      writeFileDragPayload(event.dataTransfer, { projectId, path: entry.path })
                    }}
                    onClick={() => void onPreview(entry)}
                    onDoubleClick={() => onOpen(entry)}
                    onContextMenu={(event) => onContextMenu(event, entry)}
                  >
                    <File size={13} />
                    <span>{entry.name}</span>
                    <span className={styles.rowActions}>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          onOpen(entry)
                        }}
                        title={t('files.addToGrid')}
                        aria-label={t('files.addToGrid')}
                      >
                        <LayoutGrid size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          void onPreview(entry)
                        }}
                        title={t('files.preview')}
                        aria-label={t('files.preview')}
                      >
                        <Eye size={12} />
                      </button>
                      {MARKDOWN_PATTERN.test(entry.path) ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            onOpenMarkdownSidebar(entry)
                          }}
                          title={t('files.openMarkdownSidebar')}
                          aria-label={t('files.openMarkdownSidebar')}
                        >
                          <PanelRightOpen size={12} />
                        </button>
                      ) : null}
                    </span>
                  </div>
                ),
              )
            : null}
        </div>
      ) : null}
    </div>
  )
}

function MenuAction({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? styles.dangerAction : undefined}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function FilePreviewModal({
  preview,
  onClose,
  onAdd,
  onOpenMarkdownSidebar,
}: {
  preview: Preview | null
  onClose: () => void
  onAdd: () => void
  onOpenMarkdownSidebar: () => void
}) {
  const t = useT()
  const source = preview ? convertFileSrc(preview.path) : ''
  return (
    <Modal
      open={Boolean(preview)}
      onClose={onClose}
      title={preview?.name ?? t('files.preview')}
      width={760}
      footer={
        preview ? (
          <>
            <button type="button" className={styles.modalAction} onClick={onAdd}>
              <LayoutGrid size={14} />
              {t('files.addToGrid')}
            </button>
            {MARKDOWN_PATTERN.test(preview.path) ? (
              <button type="button" className={styles.modalAction} onClick={onOpenMarkdownSidebar}>
                <PanelRightOpen size={14} />
                {t('files.openMarkdownSidebar')}
              </button>
            ) : null}
          </>
        ) : undefined
      }
    >
      {preview ? (
        <div className={styles.previewBody}>
          <div className={styles.previewPath} title={preview.path}>
            {preview.path}
          </div>
          {IMAGE_PATTERN.test(preview.path) ? <img src={source} alt={preview.name} /> : null}
          {VIDEO_PATTERN.test(preview.path) ? <video src={source} controls /> : null}
          {PDF_PATTERN.test(preview.path) ? <iframe src={source} title={preview.name} /> : null}
          {!IMAGE_PATTERN.test(preview.path) &&
          !VIDEO_PATTERN.test(preview.path) &&
          !PDF_PATTERN.test(preview.path) ? (
            preview.error ? (
              <div className={styles.previewMessage}>{preview.error}</div>
            ) : preview.content === null ? (
              <div className={styles.previewMessage}>{t('files.loadingPreview')}</div>
            ) : (
              <pre>{preview.content}</pre>
            )
          ) : null}
        </div>
      ) : null}
    </Modal>
  )
}

function rootName(path: string): string {
  return basename(path) || path
}
