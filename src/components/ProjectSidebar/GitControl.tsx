import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderSearch,
  GitBranch,
  LayoutGrid,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { readableError } from '../../lib/errors'
import { type MessageKey, useT } from '../../lib/i18n'
import {
  getPtyCwd,
  gitCommit,
  gitDiscard,
  type GitFileChange,
  gitInit,
  gitPull,
  gitPush,
  type GitRepositoryStatus,
  gitStage,
  gitStatus,
  gitUnstage,
  openInFileExplorer,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './GitControl.module.css'
import { GitGraph } from './GitGraph'
import { IncomingOutgoing } from './IncomingOutgoing'

type GitControlProps = {
  projectId: string
  cwd: string
  ptyId: string | null
  terminalName: string
}

type GroupKind = 'staged' | 'changes' | 'untracked' | 'conflicts'

const ERROR_KEYS: Record<string, MessageKey> = {
  git_not_found: 'git.error.notFound',
  not_a_git_repository: 'git.error.notRepository',
  directory_not_found: 'git.error.directory',
}

export function GitControl({ projectId, cwd, ptyId, terminalName }: GitControlProps) {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const [liveCwd, setLiveCwd] = useState(cwd)
  const [status, setStatus] = useState<GitRepositoryStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const requestId = useRef(0)

  // rajadas de eventos de foco que poderiam disparar git em loop. Refresh manual
  // (quiet=false) ignora o throttle.
  const lastAutoRefreshRef = useRef(0)

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

  const refresh = useCallback(
    async (quiet = false) => {
      if (quiet) {
        const now = Date.now()
        if (now - lastAutoRefreshRef.current < 1500) return
        lastAutoRefreshRef.current = now
      }
      if (!liveCwd) {
        setStatus(null)
        setError('directory_not_found')
        setLoading(false)
        return
      }
      const id = ++requestId.current
      if (!quiet) setLoading(true)
      try {
        const next = await gitStatus(liveCwd)
        if (requestId.current !== id) return
        setStatus(next)
        setError(null)
      } catch (cause) {
        if (requestId.current !== id) return
        setStatus(null)
        setError(errorCode(cause))
      } finally {
        if (requestId.current === id) setLoading(false)
      }
    },
    [liveCwd],
  )

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(true)
    }, 3000)
    const onFocus = () => void refresh(true)
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      requestId.current += 1
    }
  }, [refresh])

  const run = async (action: () => Promise<unknown>, success?: string) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
      if (success) pushToast({ title: success, body: '' })
      await refresh(true)
    } catch (cause) {
      pushToast({ title: t('git.error.action'), body: readableError(cause) })
    } finally {
      setBusy(false)
    }
  }

  const allStageable = useMemo(
    () =>
      status ? uniquePaths([...status.changes, ...status.untracked, ...status.conflicts]) : [],
    [status],
  )

  const commit = async () => {
    if (!status || !message.trim() || busy) return
    if (status.conflicts.length > 0) {
      pushToast({ title: t('git.error.conflicts'), body: '' })
      return
    }
    if (status.staged.length === 0) {
      if (allStageable.length === 0) return
      if (!window.confirm(t('git.confirm.stageAllCommit'))) return
    }
    await run(async () => {
      if (status.staged.length === 0) await gitStage(status.repoRoot, allStageable)
      await gitCommit(status.repoRoot, message.trim())
      setMessage('')
    }, t('git.commit.done'))
  }

  const sync = async () => {
    if (!status || busy) return
    await run(async () => {
      if (status.behind > 0) await gitPull(status.repoRoot)
      await gitPush(status.repoRoot)
    }, t('git.sync.done'))
  }

  const handleInitGit = async () => {
    if (!liveCwd || busy) return
    setBusy(true)
    try {
      await gitInit(liveCwd)
      pushToast({ title: t('git.initOffer.successTitle'), body: t('git.initOffer.successBody') })
      await refresh()
    } catch (cause) {
      pushToast({ title: t('git.error.action'), body: readableError(cause) })
    } finally {
      setBusy(false)
    }
  }

  if (!liveCwd) {
    return <GitMessage title={t('git.empty.noFolder')} description={t('git.empty.noFolderDesc')} />
  }

  if (loading && !status) {
    return <GitMessage title={t('git.loading')} />
  }

  if (error && !status) {
    const isNotRepo = error === 'not_a_git_repository'
    return (
      <GitMessage
        title={t(ERROR_KEYS[error] ?? 'git.error.generic')}
        description={
          isNotRepo
            ? t('git.initOffer.body')
            : error.startsWith('git_command_failed:')
              ? error.slice(error.indexOf(':') + 1)
              : undefined
        }
        action={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
            {isNotRepo ? (
              <button
                type="button"
                className={`${styles.retry} ${styles.retryPrimary}`}
                style={{ width: '100%' }}
                disabled={busy}
                onClick={() => void handleInitGit()}
              >
                <GitBranch size={13} />
                {busy ? t('git.initOffer.busy') : t('git.initOffer.button')}
              </button>
            ) : null}
            <button
              type="button"
              className={styles.retry}
              style={{ width: '100%' }}
              onClick={() => void refresh()}
            >
              <RefreshCw size={13} />
              {t('git.refresh')}
            </button>
          </div>
        }
      />
    )
  }

  if (!status) return null
  const total =
    status.staged.length + status.changes.length + status.untracked.length + status.conflicts.length
  const syncTitle = t('git.sync.title', { ahead: status.ahead, behind: status.behind })

  return (
    <div className={styles.panel} aria-busy={busy}>
      <div className={styles.repoHeader} title={status.repoRoot}>
        <div className={styles.repoContext}>
          <strong>{terminalName}</strong>
          <span>{status.repoRoot}</span>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => void openInFileExplorer(status.repoRoot)}
          title={t('files.revealFolder')}
          aria-label={t('files.revealFolder')}
        >
          <FolderSearch size={13} />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => void refresh()}
          disabled={loading || busy}
          title={t('git.refresh')}
          aria-label={t('git.refresh')}
        >
          <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
        </button>
      </div>

      <div className={styles.branchRow}>
        <GitBranch size={13} />
        <span>{status.branch}</span>
        {status.detached ? <small>{t('git.detached')}</small> : null}
        <button
          type="button"
          className={styles.syncButton}
          onClick={() => void sync()}
          disabled={busy || status.detached}
          title={syncTitle}
          aria-label={syncTitle}
        >
          <RefreshCw size={12} className={busy ? styles.spinning : undefined} />
          <span className={styles.syncCounts}>
            <span>
              <ArrowDown size={11} />
              {status.behind}
            </span>
            <span>
              <ArrowUp size={11} />
              {status.ahead}
            </span>
          </span>
        </button>
      </div>

      <div className={styles.commitBox}>
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void commit()
          }}
          placeholder={t('git.commit.placeholder')}
          aria-label={t('git.commit.placeholder')}
          rows={2}
        />
        <div className={styles.commitRow}>
          <button
            type="button"
            className={styles.commitButton}
            disabled={!message.trim() || busy || total === 0}
            onClick={() => void commit()}
          >
            <Check size={14} />
            {busy ? t('git.commit.busy') : t('git.commit.action')}
          </button>
          <button
            type="button"
            className={styles.syncWide}
            disabled={busy || status.detached}
            onClick={() => void sync()}
            title={syncTitle}
          >
            <RefreshCw size={13} className={busy ? styles.spinning : undefined} />
            {t('git.sync.action')}
          </button>
        </div>
      </div>

      <div className={styles.groups}>
        <ChangeGroup
          projectId={projectId}
          repoRoot={status.repoRoot}
          kind="staged"
          label={t('git.group.staged')}
          items={status.staged}
          disabled={busy}
          onPrimary={(paths) => run(() => gitUnstage(status.repoRoot, paths))}
        />
        <ChangeGroup
          projectId={projectId}
          repoRoot={status.repoRoot}
          kind="conflicts"
          label={t('git.group.conflicts')}
          items={status.conflicts}
          disabled={busy}
          onPrimary={(paths) => run(() => gitStage(status.repoRoot, paths))}
        />
        <ChangeGroup
          projectId={projectId}
          repoRoot={status.repoRoot}
          kind="changes"
          label={t('git.group.changes')}
          items={status.changes}
          disabled={busy}
          onPrimary={(paths) => run(() => gitStage(status.repoRoot, paths))}
          onDiscard={(paths) => run(() => gitDiscard(status.repoRoot, paths, false))}
        />
        <ChangeGroup
          projectId={projectId}
          repoRoot={status.repoRoot}
          kind="untracked"
          label={t('git.group.untracked')}
          items={status.untracked}
          disabled={busy}
          onPrimary={(paths) => run(() => gitStage(status.repoRoot, paths))}
          onDiscard={(paths) => run(() => gitDiscard(status.repoRoot, paths, true))}
        />
        {total === 0 ? (
          <div className={styles.clean}>
            <Check size={18} />
            <strong>{t('git.clean')}</strong>
            <span>{t('git.cleanDesc')}</span>
          </div>
        ) : null}
      </div>

      <IncomingOutgoing repoRoot={status.repoRoot} ahead={status.ahead} behind={status.behind} />
      <GitGraph repoRoot={status.repoRoot} onMutated={() => void refresh(true)} />
    </div>
  )
}

function ChangeGroup({
  projectId,
  repoRoot,
  kind,
  label,
  items,
  disabled,
  onPrimary,
  onDiscard,
}: {
  projectId: string
  repoRoot: string
  kind: GroupKind
  label: string
  items: GitFileChange[]
  disabled: boolean
  onPrimary: (paths: string[]) => void
  onDiscard?: (paths: string[]) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(true)
  const tree = useMemo(() => buildTree(items), [items])
  if (items.length === 0) return null
  const paths = uniquePaths(items)
  const primaryTitle = kind === 'staged' ? t('git.unstageAll') : t('git.stageAll')
  const confirmDiscard = (selected: string[]) => {
    if (onDiscard && window.confirm(t('git.confirm.discard', { count: selected.length })))
      onDiscard(selected)
  }
  return (
    <section className={styles.group}>
      <div className={styles.groupHeader}>
        <button
          type="button"
          className={styles.groupToggle}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <strong>{label}</strong>
          <span>{items.length}</span>
        </button>
        <div className={styles.groupActions}>
          {onDiscard ? (
            <button
              type="button"
              disabled={disabled}
              title={t('git.discardAll')}
              aria-label={t('git.discardAll')}
              onClick={() => confirmDiscard(paths)}
            >
              <RotateCcw size={13} />
            </button>
          ) : null}
          <button
            type="button"
            disabled={disabled}
            title={primaryTitle}
            aria-label={primaryTitle}
            onClick={() => onPrimary(paths)}
          >
            {kind === 'staged' ? <Minus size={14} /> : <Plus size={14} />}
          </button>
        </div>
      </div>
      {open ? (
        <div className={styles.tree}>
          {tree.map((node) => (
            <TreeNodeView
              key={node.type === 'dir' ? `d:${node.path}` : `f:${node.change.path}`}
              projectId={projectId}
              repoRoot={repoRoot}
              node={node}
              kind={kind}
              depth={0}
              disabled={disabled}
              onPrimary={onPrimary}
              onDiscard={onDiscard ? confirmDiscard : undefined}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

function TreeNodeView({
  projectId,
  repoRoot,
  node,
  kind,
  depth,
  disabled,
  onPrimary,
  onDiscard,
}: {
  projectId: string
  repoRoot: string
  node: TreeNode
  kind: GroupKind
  depth: number
  disabled: boolean
  onPrimary: (paths: string[]) => void
  onDiscard?: (paths: string[]) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(true)
  const indent = { paddingLeft: 8 + depth * 12 }

  const createDiffPane = useProjectsStore((s) => s.createDiffPane)
  const createFilePane = useProjectsStore((s) => s.createFilePane)
  const openPane = useProjectsStore((s) => s.openPane)
  const requestPaneFocus = useUiStore((s) => s.requestPaneFocus)

  const handleDoubleClick = (filePath: string) => {
    if (kind === 'untracked') {
      openFile(filePath)
      return
    }
    const isStaged = kind === 'staged'
    const pane = createDiffPane(projectId, { filePath, repoRoot, staged: isStaged })
    openPane(projectId, pane.id)
    requestPaneFocus(pane.id)
  }

  const openFile = (filePath: string) => {
    const pane = createFilePane(projectId, { filePath: absoluteRepoPath(repoRoot, filePath) })
    openPane(projectId, pane.id)
    requestPaneFocus(pane.id)
  }

  if (node.type === 'file') {
    const change = node.change
    const isStaged = kind === 'staged'
    return (
      <div
        className={styles.file}
        style={indent}
        title={change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}
        onDoubleClick={() => handleDoubleClick(change.path)}
      >
        <span className={styles.fileName}>{node.name}</span>
        <span className={`${styles.status} ${statusClass(kind, change.status)}`}>
          {statusChar(kind, change.status)}
        </span>
        <div className={styles.fileActions}>
          <button
            type="button"
            title={t('files.reveal')}
            aria-label={t('files.reveal')}
            onClick={() => void openInFileExplorer(absoluteRepoPath(repoRoot, change.path))}
          >
            <FolderSearch size={12} />
          </button>
          <button
            type="button"
            title={t('files.addToGrid')}
            aria-label={t('files.addToGrid')}
            onClick={() => openFile(change.path)}
          >
            <LayoutGrid size={12} />
          </button>
          {onDiscard ? (
            <button
              type="button"
              disabled={disabled}
              title={t('git.discard')}
              aria-label={t('git.discard')}
              onClick={() => onDiscard([change.path])}
            >
              <RotateCcw size={12} />
            </button>
          ) : null}
          <button
            type="button"
            disabled={disabled}
            title={isStaged ? t('git.unstage') : t('git.stage')}
            aria-label={isStaged ? t('git.unstage') : t('git.stage')}
            onClick={() => onPrimary([change.path])}
          >
            {isStaged ? <Minus size={13} /> : <Plus size={13} />}
          </button>
        </div>
      </div>
    )
  }

  const descendants = collectPaths(node)
  const isStaged = kind === 'staged'
  return (
    <>
      <div className={styles.dir} style={indent}>
        <button
          type="button"
          className={styles.dirToggle}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Folder size={13} className={styles.dirIcon} />
          <span className={styles.dirName}>{node.name}</span>
        </button>
        <div className={styles.fileActions}>
          {onDiscard ? (
            <button
              type="button"
              disabled={disabled}
              title={t('git.discardAll')}
              aria-label={t('git.discardAll')}
              onClick={() => onDiscard(descendants)}
            >
              <RotateCcw size={12} />
            </button>
          ) : null}
          <button
            type="button"
            disabled={disabled}
            title={isStaged ? t('git.unstageAll') : t('git.stageAll')}
            aria-label={isStaged ? t('git.unstageAll') : t('git.stageAll')}
            onClick={() => onPrimary(descendants)}
          >
            {isStaged ? <Minus size={13} /> : <Plus size={13} />}
          </button>
        </div>
      </div>
      {open
        ? node.children.map((child) => (
            <TreeNodeView
              key={child.type === 'dir' ? `d:${child.path}` : `f:${child.change.path}`}
              projectId={projectId}
              repoRoot={repoRoot}
              node={child}
              kind={kind}
              depth={depth + 1}
              disabled={disabled}
              onPrimary={onPrimary}
              onDiscard={onDiscard}
            />
          ))
        : null}
    </>
  )
}

function GitMessage({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div className={styles.message}>
      <GitBranch size={22} />
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
      {action}
    </div>
  )
}

type DirNode = { type: 'dir'; name: string; path: string; children: TreeNode[] }
type FileNode = { type: 'file'; name: string; change: GitFileChange }
type TreeNode = DirNode | FileNode

function buildTree(items: GitFileChange[]): TreeNode[] {
  const root: DirNode = { type: 'dir', name: '', path: '', children: [] }
  for (const change of items) {
    const parts = change.path.split('/')
    const fileName = parts.pop() ?? change.path
    let cursor = root
    let acc = ''
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      let next = cursor.children.find(
        (child): child is DirNode => child.type === 'dir' && child.name === part,
      )
      if (!next) {
        next = { type: 'dir', name: part, path: acc, children: [] }
        cursor.children.push(next)
      }
      cursor = next
    }
    cursor.children.push({ type: 'file', name: fileName, change })
  }
  return root.children.map(compress).sort(compareNodes)
}

function compress(node: TreeNode): TreeNode {
  if (node.type === 'file') return node
  let current = node
  while (current.children.length === 1 && current.children[0].type === 'dir') {
    const only = current.children[0]
    current = {
      type: 'dir',
      name: `${current.name}/${only.name}`,
      path: only.path,
      children: only.children,
    }
  }
  current.children = current.children.map(compress).sort(compareNodes)
  return current
}

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
  return a.name.localeCompare(b.name)
}

function collectPaths(node: TreeNode): string[] {
  if (node.type === 'file') return [node.change.path]
  return node.children.flatMap(collectPaths)
}

function statusClass(kind: GroupKind, status: string): string {
  if (kind === 'untracked') return styles.stAdded
  if (kind === 'conflicts') return styles.stConflict
  const code = (status.trim()[0] ?? '').toUpperCase()
  if (code === 'A') return styles.stAdded
  if (code === 'D') return styles.stDeleted
  if (code === 'R' || code === 'C') return styles.stRenamed
  if (code === 'M') return styles.stModified
  return styles.stOther
}

function statusChar(kind: GroupKind, status: string): string {
  if (kind === 'untracked') return 'U'
  if (kind === 'conflicts') return '!'
  return (status.trim()[0] ?? '•').toUpperCase()
}

function uniquePaths(items: GitFileChange[]): string[] {
  return [...new Set(items.map((item) => item.path))]
}

function errorCode(error: unknown): string {
  const value = String(error)
  return Object.keys(ERROR_KEYS).find((key) => value.includes(key)) ?? value
}

function absoluteRepoPath(repoRoot: string, relativePath: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(relativePath)) return relativePath
  const separator = repoRoot.includes('\\') ? '\\' : '/'
  return `${repoRoot.replace(/[\\/]+$/, '')}${separator}${relativePath.replace(/^[\\/]+/, '').replace(/[\\/]/g, separator)}`
}
