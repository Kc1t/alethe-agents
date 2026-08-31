import {
  ArrowUp,
  Check,
  ChevronRight,
  CornerDownLeft,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Home,
  Search,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { resolvePendingFsBrowser } from '../../lib/dialog'
import { useT } from '../../lib/i18n'
import { browseDirectory, type BrowseDirectoryEntry, type DirectoryListing } from '../../lib/tauri'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from './Modal'
import styles from './FsBrowserModal.module.css'

function formatBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function highlightMatch(name: string, query: string) {
  if (!query.trim()) return name
  const q = query.trim()
  const idx = name.toLowerCase().indexOf(q.toLowerCase())
  if (idx === -1) return name

  const before = name.slice(0, idx)
  const match = name.slice(idx, idx + q.length)
  const after = name.slice(idx + q.length)

  return (
    <>
      {before}
      <mark className={styles.searchHighlight}>{match}</mark>
      {after}
    </>
  )
}

export function FsBrowserModal() {
  const t = useT()
  const request = useUiStore((s) => s.fsBrowser)
  const parentModalOpen = useUiStore((s) => s.openModal !== null)
  const closeFsBrowser = useUiStore((s) => s.closeFsBrowser)

  const open = request !== null
  const mode = request?.mode || 'folder'
  const customTitle = request?.title
  const initialDefaultPath = request?.defaultPath || ''

  const [currentPath, setCurrentPath] = useState('')
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [homePath, setHomePath] = useState('')
  const [systemRoots, setSystemRoots] = useState<string[]>([])
  const [entries, setEntries] = useState<BrowseDirectoryEntry[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState<number>(-1)
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [editingPath, setEditingPath] = useState(false)
  const [rawPathInput, setRawPathInput] = useState('')

  const listContainerRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])

  const fetchDirectory = useCallback(
    async (targetPath: string) => {
      setLoading(true)
      setSearchQuery('')
      setSelectedIndex(-1)
      itemRefs.current = []
      try {
        const listing: DirectoryListing = await browseDirectory(targetPath)
        setCurrentPath(listing.currentPath)
        setParentPath(listing.parentPath)
        setHomePath(listing.homePath)
        setSystemRoots(listing.systemRoots || [])
        setEntries(listing.entries || [])
        setRawPathInput(listing.currentPath)
        setSelectedPath(mode === 'folder' ? listing.currentPath : null)
      } catch {
        if (homePath && targetPath !== homePath) {
          void fetchDirectory(homePath)
        }
      } finally {
        setLoading(false)
      }
    },
    [homePath, mode],
  )

  useEffect(() => {
    if (open) {
      void fetchDirectory(initialDefaultPath)
    } else {
      setSelectedPath(null)
      setSelectedIndex(-1)
    }
  }, [open, initialDefaultPath, fetchDirectory])

  useEffect(() => {
    if (selectedIndex >= 0 && itemRefs.current[selectedIndex]) {
      itemRefs.current[selectedIndex]?.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      })
    }
  }, [selectedIndex])

  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return entries
    const q = searchQuery.toLowerCase().trim()
    return entries.filter((e) => e.name.toLowerCase().includes(q))
  }, [entries, searchQuery])

  const breadcrumbs = useMemo(() => {
    if (!currentPath) return []
    const isWindows = currentPath.includes('\\')
    const sep = isWindows ? '\\' : '/'
    const parts = currentPath.split(sep).filter(Boolean)

    const crumbs: { label: string; path: string }[] = []
    let acc = ''

    if (isWindows && parts.length > 0) {
      const drive = parts[0].endsWith(':') ? `${parts[0]}\\` : `${parts[0]}`
      acc = drive
      crumbs.push({ label: drive, path: drive })
      for (let i = 1; i < parts.length; i++) {
        acc = `${acc.endsWith('\\') ? acc : `${acc}\\`}${parts[i]}`
        crumbs.push({ label: parts[i], path: acc })
      }
    } else {
      crumbs.push({ label: '/', path: '/' })
      for (const part of parts) {
        acc = `${acc}/${part}`
        crumbs.push({ label: part, path: acc })
      }
    }
    return crumbs
  }, [currentPath])

  const handleClose = () => {
    resolvePendingFsBrowser(null)
    closeFsBrowser()
  }

  const handleConfirm = () => {
    const finalChoice = selectedPath || currentPath
    resolvePendingFsBrowser(finalChoice)
    closeFsBrowser()
  }

  const handleEntryClick = (entry: BrowseDirectoryEntry, index: number) => {
    setSelectedPath(entry.path)
    setSelectedIndex(index)
  }

  const handleEntryDoubleClick = (entry: BrowseDirectoryEntry) => {
    if (entry.isDir) {
      void fetchDirectory(entry.path)
    } else {
      handleConfirm()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (editingPath) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const nextIndex = Math.min(filteredEntries.length - 1, selectedIndex + 1)
      setSelectedIndex(nextIndex)
      if (filteredEntries[nextIndex]) {
        setSelectedPath(filteredEntries[nextIndex].path)
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prevIndex = Math.max(0, selectedIndex - 1)
      setSelectedIndex(prevIndex)
      if (filteredEntries[prevIndex]) {
        setSelectedPath(filteredEntries[prevIndex].path)
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (selectedIndex >= 0 && filteredEntries[selectedIndex]) {
        const item = filteredEntries[selectedIndex]
        if (item.isDir) {
          void fetchDirectory(item.path)
        } else {
          handleConfirm()
        }
      } else {
        handleConfirm()
      }
    } else if (e.key === 'Backspace' && parentPath) {
      e.preventDefault()
      void fetchDirectory(parentPath)
    }
  }

  const handleRawPathSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setEditingPath(false)
    if (rawPathInput.trim()) {
      void fetchDirectory(rawPathInput.trim())
    }
  }

  if (!open) return null

  const titleText =
    customTitle || (mode === 'folder' ? t('fsBrowser.titleFolder') : t('fsBrowser.titleFile'))

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={titleText}
      width={640}
      nested={parentModalOpen}
      footer={
        <div className={styles.footerInner}>
          <span className={styles.selectedPathText} title={selectedPath || currentPath}>
            {selectedPath || currentPath}
          </span>
          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={handleClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={styles.confirmBtn}
              onClick={handleConfirm}
              disabled={loading || (mode === 'file' && !selectedPath)}
            >
              <Check size={16} />
              <span>
                {mode === 'folder' ? t('fsBrowser.selectCurrentFolder') : t('fsBrowser.selectFile')}
              </span>
            </button>
          </div>
        </div>
      }
    >
      <div className={styles.container} onKeyDown={handleKeyDown}>
        <div className={styles.quickBar}>
          {homePath && (
            <button
              type="button"
              className={`${styles.quickBtn} ${currentPath === homePath ? styles.activeQuickBtn : ''}`}
              onClick={() => fetchDirectory(homePath)}
            >
              <Home size={14} />
              <span>{t('fsBrowser.home')}</span>
            </button>
          )}

          {systemRoots.map((root) => (
            <button
              type="button"
              key={root}
              className={`${styles.quickBtn} ${currentPath === root ? styles.activeQuickBtn : ''}`}
              onClick={() => fetchDirectory(root)}
            >
              <HardDrive size={14} />
              <span>{root}</span>
            </button>
          ))}
        </div>

        <div className={styles.pathBar}>
          <button
            type="button"
            className={styles.upBtn}
            disabled={!parentPath}
            onClick={() => parentPath && fetchDirectory(parentPath)}
            title={t('fsBrowser.up')}
          >
            <ArrowUp size={16} />
          </button>

          {editingPath ? (
            <form onSubmit={handleRawPathSubmit} style={{ flex: 1 }}>
              <input
                type="text"
                className={styles.editPathInput}
                value={rawPathInput}
                onChange={(e) => setRawPathInput(e.target.value)}
                onBlur={() => setEditingPath(false)}
                autoFocus
              />
            </form>
          ) : (
            <div
              className={styles.breadcrumbs}
              onClick={() => setEditingPath(true)}
              title={t('fsBrowser.pathInputPlaceholder')}
            >
              {breadcrumbs.map((crumb, idx) => (
                <span key={crumb.path} style={{ display: 'flex', alignItems: 'center' }}>
                  <button
                    type="button"
                    className={styles.crumb}
                    onClick={(e) => {
                      e.stopPropagation()
                      fetchDirectory(crumb.path)
                    }}
                  >
                    {crumb.label}
                  </button>
                  {idx < breadcrumbs.length - 1 && (
                    <ChevronRight size={12} className={styles.separator} />
                  )}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className={styles.searchBar}>
          <Search size={14} className={styles.searchIcon} />
          <input
            type="text"
            className={styles.searchInput}
            placeholder={t('fsBrowser.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery.trim() && (
            <>
              <span className={styles.searchResultBadge}>
                {t('fsBrowser.itemsCount', { count: filteredEntries.length })}
              </span>
              <button
                type="button"
                className={styles.clearSearchBtn}
                onClick={() => setSearchQuery('')}
                title={t('fsBrowser.clearSearch')}
              >
                <X size={14} />
              </button>
            </>
          )}
        </div>

        <div className={styles.listContainer} ref={listContainerRef} tabIndex={0} autoFocus>
          {loading ? (
            <div className={styles.skeletonContainer}>
              <div className={styles.skeletonRow} />
              <div className={styles.skeletonRow} />
              <div className={styles.skeletonRow} />
              <div className={styles.skeletonRow} />
              <div className={styles.skeletonRow} />
            </div>
          ) : filteredEntries.length === 0 ? (
            <div className={styles.emptyBox}>
              <FolderOpen size={28} />
              <span>{t('fsBrowser.empty')}</span>
            </div>
          ) : (
            <div key={`${currentPath}-${searchQuery}`} className={styles.listContentAnimated}>
              {filteredEntries.map((entry, index) => {
                const isSelected = selectedPath === entry.path || selectedIndex === index
                const delayMs = Math.min(index * 18, 180)
                return (
                  <div
                    key={entry.path}
                    ref={(el) => {
                      itemRefs.current[index] = el
                    }}
                    style={{ animationDelay: `${delayMs}ms` }}
                    className={`${styles.entryRow} ${styles.entryRowAnimated} ${isSelected ? styles.selectedRow : ''}`}
                    onClick={() => handleEntryClick(entry, index)}
                    onDoubleClick={() => handleEntryDoubleClick(entry)}
                  >
                    <span
                      className={`${styles.entryIcon} ${entry.isDir ? styles.folderIcon : styles.fileIcon}`}
                    >
                      {entry.isDir ? <Folder size={18} /> : <FileText size={18} />}
                    </span>
                    <span className={styles.entryName}>
                      {highlightMatch(entry.name, searchQuery)}
                    </span>
                    {!entry.isDir && (
                      <span className={styles.entrySize}>{formatBytes(entry.sizeBytes)}</span>
                    )}
                    <span className={styles.navHint}>
                      <CornerDownLeft size={12} />
                      <span>{entry.isDir ? t('fsBrowser.enter') : t('fsBrowser.select')}</span>
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
