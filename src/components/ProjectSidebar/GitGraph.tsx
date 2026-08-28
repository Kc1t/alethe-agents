import {
  ChevronDown,
  ChevronRight,
  Copy,
  GitBranchPlus,
  GitCommitHorizontal,
  GitCommitVertical,
  RotateCcw,
  Search,
  Undo2,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { readableError } from '../../lib/errors'
import { type MessageKey, useT } from '../../lib/i18n'
import {
  gitCherryPickCommit,
  type GitCommitEntry,
  gitCreateBranchFromCommit,
  gitLogGraph,
  gitResetToCommit,
  gitRevertCommit,
  writeClipboardText,
} from '../../lib/tauri'
import { useUiStore } from '../../stores/uiStore'
import { ContextMenu, type MenuItem } from './ContextMenu'
import styles from './GitGraph.module.css'
import { GitGraphCommitDetail } from './GitGraphCommitDetail'
import { GitGraphList } from './GitGraphList'

const MAX_COMMITS = 0

type GitGraphView = { kind: 'list' } | { kind: 'detail'; hash: string }

export function GitGraph({ repoRoot, onMutated }: { repoRoot: string; onMutated?: () => void }) {
  const t = useT()
  const pushToast = useUiStore((s) => s.pushToast)
  const [open, setOpen] = useState(true)
  const [commits, setCommits] = useState<GitCommitEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; hash: string } | null>(null)
  const [view, setView] = useState<GitGraphView>({ kind: 'list' })
  const [listScrollTop, setListScrollTop] = useState(0)

  useEffect(() => {
    if (!open || !repoRoot) return
    let cancelled = false
    gitLogGraph(repoRoot, MAX_COMMITS)
      .then((result) => {
        if (!cancelled) {
          setCommits(result)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err))
      })
    return () => {
      cancelled = true
    }
  }, [open, repoRoot])

  const reload = () => {
    if (!repoRoot) return
    gitLogGraph(repoRoot, MAX_COMMITS)
      .then((result) => {
        setCommits(result)
        setError(null)
      })
      .catch((err) => setError(String(err)))
  }

  const runAction = async (action: () => Promise<unknown>, successKey?: MessageKey) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
      if (successKey) pushToast({ title: t(successKey), body: '' })
      reload()
      onMutated?.()
    } catch (cause) {
      pushToast({ title: t('git.error.action'), body: readableError(cause) })
    } finally {
      setBusy(false)
    }
  }

  const buildMenuItems = (hash: string): MenuItem[] => [
    {
      kind: 'item',
      label: t('git.graph.menu.copyHash'),
      icon: <Copy size={13} />,
      onClick: () => {
        void writeClipboardText(hash)
      },
    },
    {
      kind: 'item',
      label: t('git.graph.menu.createBranch'),
      icon: <GitBranchPlus size={13} />,
      onClick: () => {
        const name = window.prompt(t('git.graph.menu.createBranchPrompt'))
        if (name && name.trim()) {
          void runAction(
            () => gitCreateBranchFromCommit(repoRoot, hash, name.trim()),
            'git.graph.menu.branchCreated',
          )
        }
      },
    },
    {
      kind: 'item',
      label: t('git.graph.menu.cherryPick'),
      icon: <GitCommitVertical size={13} />,
      onClick: () => {
        void runAction(() => gitCherryPickCommit(repoRoot, hash), 'git.graph.menu.cherryPicked')
      },
    },
    {
      kind: 'item',
      label: t('git.graph.menu.revert'),
      icon: <Undo2 size={13} />,
      onClick: () => {
        void runAction(() => gitRevertCommit(repoRoot, hash), 'git.graph.menu.reverted')
      },
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: t('git.graph.menu.resetSoft'),
      icon: <RotateCcw size={13} />,
      onClick: () => {
        void runAction(() => gitResetToCommit(repoRoot, hash, 'soft'), 'git.graph.menu.resetDone')
      },
    },
    {
      kind: 'item',
      label: t('git.graph.menu.resetMixed'),
      icon: <RotateCcw size={13} />,
      onClick: () => {
        void runAction(() => gitResetToCommit(repoRoot, hash, 'mixed'), 'git.graph.menu.resetDone')
      },
    },
    {
      kind: 'item',
      label: t('git.graph.menu.resetHard'),
      icon: <RotateCcw size={13} />,
      onClick: () => {
        if (window.confirm(t('git.graph.menu.resetHardConfirm'))) {
          void runAction(() => gitResetToCommit(repoRoot, hash, 'hard'), 'git.graph.menu.resetDone')
        }
      },
    },
  ]

  return (
    <section className={styles.group}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingRight: '4px',
        }}
      >
        <button
          type="button"
          className={styles.groupHeader}
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <GitCommitHorizontal size={13} />
          <strong>{t('git.graph.title')}</strong>
          {commits ? (
            <span style={{ opacity: 0.6, fontSize: '11px' }}>({commits.length})</span>
          ) : null}
        </button>
        {open ? (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={reload}
            title={t('git.graph.refresh')}
            aria-label={t('git.graph.refresh')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--fg-muted)',
              cursor: 'pointer',
            }}
          >
            <RotateCcw size={12} />
          </button>
        ) : null}
      </div>

      {open && view.kind === 'list' ? (
        <>
          <div style={{ padding: '0 4px 6px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                background: 'var(--panel)',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                padding: '2px 6px',
              }}
            >
              <Search size={11} style={{ color: 'var(--fg-faint)', marginRight: '4px' }} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('git.graph.searchPlaceholder')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--fg)',
                  fontSize: '11px',
                  width: '100%',
                }}
              />
            </div>
          </div>

          {error ? <p className={styles.error}>{error}</p> : null}
          {!commits && !error ? <p className={styles.loading}>{t('git.graph.loading')}</p> : null}

          {commits ? (
            <GitGraphList
              commits={commits}
              searchQuery={searchQuery}
              initialScrollTop={listScrollTop}
              onSelectCommit={(hash, scrollTop) => {
                setListScrollTop(scrollTop)
                setView({ kind: 'detail', hash })
              }}
              onOpenMenu={(x, y, hash) => setMenu({ x, y, hash })}
            />
          ) : null}
        </>
      ) : null}

      {open && view.kind === 'detail' ? (
        <GitGraphCommitDetail
          repoRoot={repoRoot}
          commit={commits?.find((c) => c.hash === view.hash) ?? null}
          onBack={() => setView({ kind: 'list' })}
        />
      ) : null}

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.hash)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </section>
  )
}
