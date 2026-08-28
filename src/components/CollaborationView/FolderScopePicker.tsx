import { CheckSquare, ChevronDown, ChevronRight, Folder, Loader2, Square } from 'lucide-react'
import { useEffect, useState } from 'react'

import { type FolderTreeNode, scanProjectFolderTree } from '../../lib/tauri'
import { useT } from '../../lib/i18n'
import styles from './FolderScopePicker.module.css'

/**
 * Nested folder checkbox tree for choosing exactly which project folders a collaborator
 * gets access to. `selectedPaths` holds relative paths (same format `FolderTreeNode.path`
 * uses) the caller currently grants; toggling calls `onChange` with the next set — the
 * caller decides how an empty set is interpreted (see `wholeProject` usages).
 */
export function FolderScopePicker({
  projectPath,
  selectedPaths,
  onChange,
}: {
  projectPath: string
  selectedPaths: Set<string>
  onChange: (next: Set<string>) => void
}) {
  const t = useT()
  const [tree, setTree] = useState<FolderTreeNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(false)
    scanProjectFolderTree(projectPath)
      .then((nodes) => {
        if (active) setTree(nodes)
      })
      .catch(() => {
        if (active) setError(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [projectPath])

  const toggleExpand = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleSelect = (path: string) => {
    const next = new Set(selectedPaths)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    onChange(next)
  }

  const renderNodes = (nodes: FolderTreeNode[]) =>
    nodes
      .filter((node) => node.isDir)
      .map((node) => {
        const isSelected = selectedPaths.has(node.path)
        const isExpanded = expandedPaths.has(node.path)
        const childDirs = node.children.filter((child) => child.isDir)
        const hasChildren = childDirs.length > 0

        return (
          <div key={node.path} className={styles.row}>
            <div className={styles.item}>
              {hasChildren ? (
                <button
                  type="button"
                  className={styles.expandBtn}
                  onClick={() => toggleExpand(node.path)}
                >
                  {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
              ) : (
                <span className={styles.expandPlaceholder} />
              )}
              <button
                type="button"
                className={styles.checkboxBtn}
                onClick={() => toggleSelect(node.path)}
              >
                {isSelected ? (
                  <CheckSquare size={14} className={styles.checkActive} />
                ) : (
                  <Square size={14} className={styles.checkInactive} />
                )}
              </button>
              <Folder size={13} className={styles.folderIcon} />
              <span className={styles.name}>{node.name}</span>
            </div>
            {isExpanded && hasChildren ? (
              <div className={styles.children}>{renderNodes(childDirs)}</div>
            ) : null}
          </div>
        )
      })

  if (loading) {
    return (
      <div className={styles.loadingRow}>
        <Loader2 size={14} className={styles.spin} />
        <span>{t('vault.folderScopePicker.loading')}</span>
      </div>
    )
  }

  if (error) {
    return <p className={styles.error}>{t('vault.folderScopePicker.error')}</p>
  }

  const dirCount = tree.filter((node) => node.isDir).length
  if (dirCount === 0) {
    return <p className={styles.empty}>{t('vault.folderScopePicker.empty')}</p>
  }

  return <div className={styles.container}>{renderNodes(tree)}</div>
}
