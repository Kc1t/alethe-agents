import { ChevronDown, ChevronRight, File, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import { basename } from '../../lib/paths'
import { type DirectoryEntry, getPtyCwd, listDirectory } from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './FileExplorer.module.css'

type FileExplorerProps = {
  projectId: string
  cwd: string
  ptyId: string | null
  terminalName: string
}

export function FileExplorer({ projectId, cwd, ptyId, terminalName }: FileExplorerProps) {
  const [reloadKey, setReloadKey] = useState(0)
  const [liveCwd, setLiveCwd] = useState(cwd)
  const t = useT()

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

  if (!liveCwd) {
    return <div className={styles.message}>{t('ui.fileExplorer.noActiveFolder')}</div>
  }

  return (
    <div className={styles.explorer}>
      <div className={styles.context} title={liveCwd}>
        <span className={styles.contextName}>{terminalName}</span>
        <span className={styles.contextPath}>{liveCwd}</span>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => setReloadKey((value) => value + 1)}
          title={t('ui.fileExplorer.refresh')}
          aria-label={t('ui.fileExplorer.refresh')}
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
}: {
  projectId: string
  path: string
  name: string
  depth: number
  initialOpen?: boolean
  reloadKey: number
}) {
  const [open, setOpen] = useState(initialOpen)
  const [entries, setEntries] = useState<DirectoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const createFilePane = useProjectsStore((s) => s.createFilePane)
  const openPane = useProjectsStore((s) => s.openPane)
  const requestPaneFocus = useUiStore((s) => s.requestPaneFocus)
  const t = useT()

  const handleFileDoubleClick = (filePath: string) => {
    const pane = createFilePane(projectId, { filePath })
    openPane(projectId, pane.id)
    requestPaneFocus(pane.id)
  }

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
        title={path}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {open ? <FolderOpen size={14} /> : <Folder size={14} />}
        <span>{name}</span>
      </button>
      {open ? (
        <div>
          {loading ? <div className={styles.message}>{t('ui.fileExplorer.loading')}</div> : null}
          {error ? <div className={styles.message}>{t('ui.fileExplorer.readError')}</div> : null}
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
                  />
                ) : (
                  <div
                    key={entry.path}
                    className={styles.row}
                    style={{ paddingLeft: 22 + depth * 14 }}
                    title={entry.path}
                    onDoubleClick={() => handleFileDoubleClick(entry.path)}
                  >
                    <File size={13} />
                    <span>{entry.name}</span>
                  </div>
                ),
              )
            : null}
        </div>
      ) : null}
    </div>
  )
}

function rootName(path: string): string {
  return basename(path) || path
}
