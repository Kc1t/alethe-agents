import {
  ChevronDown,
  ChevronRight,
  Copy,
  GitBranchPlus,
  GitCommitHorizontal,
  GitCommitVertical,
  RotateCcw,
  Undo2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { readableError } from '../../lib/errors'
import { type MessageKey, useT } from '../../lib/i18n'
import {
  gitCherryPickCommit,
  type GitCommitEntry,
  gitCreateBranchFromCommit,
  type GitFileChange,
  gitLogGraph,
  gitResetToCommit,
  gitRevertCommit,
  gitShowCommitFiles,
  writeClipboardText,
} from '../../lib/tauri'
import { useUiStore } from '../../stores/uiStore'
import { ContextMenu, type MenuItem } from './ContextMenu'
import styles from './GitGraph.module.css'

const MAX_COMMITS = 60
const ROW_HEIGHT = 22
const LANE_WIDTH = 14
const DOT_RADIUS = 3.5

/** Cores de raia — cicla pela paleta `--agent-*` já existente no tema (nunca
 *  hex novo hardcoded, regra do design system). */
const LANE_COLOR_VARS = [
  '--agent-shell',
  '--agent-claude',
  '--agent-codex',
  '--agent-opencode',
  '--agent-freebuff',
  '--agent-mimo',
  '--agent-antigravity',
]

type LaneState = (string | null)[]

type GraphRow = {
  commit: GitCommitEntry
  lane: number
  lanesBefore: LaneState
  lanesAfter: LaneState
  /** Lanes de merge abertas NESTE commit (pais além do primeiro) — usadas
   *  pra desenhar o conector diagonal do dot até a raia nova. */
  mergeLanes: number[]
}

/** Calcula raia/coluna de cada commit a partir de hash→pais — o próprio
 *  `git log` não devolve coordenadas de gráfico prontas (mesmo cálculo que
 *  VSCode/gitk fazem no cliente). Uma raia "aponta" pro hash do próximo
 *  commit que ela espera desenhar; o primeiro pai sempre continua na MESMA
 *  raia do commit atual, pais extras (merge) abrem raia nova (reaproveitando
 *  uma raia livre quando existir). */
function assignLanes(commits: GitCommitEntry[]): GraphRow[] {
  const lanes: LaneState = []
  const rows: GraphRow[] = []

  const findFreeLane = (): number => {
    const free = lanes.indexOf(null)
    if (free !== -1) return free
    lanes.push(null)
    return lanes.length - 1
  }

  for (const commit of commits) {
    const lanesBefore = [...lanes]
    let lane = lanes.indexOf(commit.hash)
    if (lane === -1) lane = findFreeLane()

    const mergeLanes: number[] = []
    if (commit.parents.length === 0) {
      lanes[lane] = null
    } else {
      lanes[lane] = commit.parents[0]
      for (const parent of commit.parents.slice(1)) {
        if (lanes.includes(parent)) continue
        const freeLane = findFreeLane()
        lanes[freeLane] = parent
        mergeLanes.push(freeLane)
      }
    }

    rows.push({ commit, lane, lanesBefore, lanesAfter: [...lanes], mergeLanes })
  }
  return rows
}

function laneColor(lane: number): string {
  return `var(${LANE_COLOR_VARS[lane % LANE_COLOR_VARS.length]})`
}

function relativeTime(timestampSeconds: number, t: ReturnType<typeof useT>): string {
  const diffMs = Date.now() - timestampSeconds * 1000
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 1) return t('git.graph.timeNow')
  if (diffMin < 60) return t('git.graph.timeMinutes', { count: diffMin })
  const diffHours = Math.round(diffMin / 60)
  if (diffHours < 24) return t('git.graph.timeHours', { count: diffHours })
  const diffDays = Math.round(diffHours / 24)
  if (diffDays < 30) return t('git.graph.timeDays', { count: diffDays })
  return new Date(timestampSeconds * 1000).toLocaleDateString()
}

export function GitGraph({ repoRoot, onMutated }: { repoRoot: string; onMutated?: () => void }) {
  const t = useT()
  const pushToast = useUiStore((s) => s.pushToast)
  const [open, setOpen] = useState(true)
  const [commits, setCommits] = useState<GitCommitEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; hash: string } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filesByHash, setFilesByHash] = useState<Record<string, GitFileChange[]>>({})
  const [filesError, setFilesError] = useState<Record<string, string>>({})

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

  const rows = useMemo(() => (commits ? assignLanes(commits) : []), [commits])

  const toggleExpand = (hash: string) => {
    setExpanded((cur) => (cur === hash ? null : hash))
    if (!filesByHash[hash] && !filesError[hash]) {
      gitShowCommitFiles(repoRoot, hash)
        .then((files) => setFilesByHash((prev) => ({ ...prev, [hash]: files })))
        .catch((err) => setFilesError((prev) => ({ ...prev, [hash]: String(err) })))
    }
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
      onClick: () =>
        void runAction(() => gitCherryPickCommit(repoRoot, hash), 'git.graph.menu.cherryPicked'),
    },
    {
      kind: 'item',
      label: t('git.graph.menu.revert'),
      icon: <Undo2 size={13} />,
      onClick: () =>
        void runAction(() => gitRevertCommit(repoRoot, hash), 'git.graph.menu.reverted'),
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: t('git.graph.menu.resetSoft'),
      icon: <RotateCcw size={13} />,
      onClick: () =>
        void runAction(() => gitResetToCommit(repoRoot, hash, 'soft'), 'git.graph.menu.resetDone'),
    },
    {
      kind: 'item',
      label: t('git.graph.menu.resetMixed'),
      icon: <RotateCcw size={13} />,
      onClick: () =>
        void runAction(() => gitResetToCommit(repoRoot, hash, 'mixed'), 'git.graph.menu.resetDone'),
    },
    {
      kind: 'item',
      label: t('git.graph.menu.resetHard'),
      icon: <RotateCcw size={13} />,
      danger: true,
      onClick: () => {
        if (window.confirm(t('git.graph.menu.resetHardConfirm'))) {
          void runAction(() => gitResetToCommit(repoRoot, hash, 'hard'), 'git.graph.menu.resetDone')
        }
      },
    },
  ]

  return (
    <section className={styles.group} aria-busy={busy}>
      <button type="button" className={styles.groupHeader} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <GitCommitHorizontal size={13} />
        <strong>{t('git.graph.title')}</strong>
      </button>
      {open ? (
        <div className={styles.body}>
          {error ? <p className={styles.error}>{error}</p> : null}
          {!commits && !error ? <p className={styles.loading}>{t('git.graph.loading')}</p> : null}
          {commits && commits.length === 0 ? (
            <p className={styles.empty}>{t('git.graph.empty')}</p>
          ) : null}
          {rows.map((row) => (
            <div key={row.commit.hash}>
              <GraphRowView
                row={row}
                t={t}
                expanded={expanded === row.commit.hash}
                onToggleExpand={() => toggleExpand(row.commit.hash)}
                onOpenMenu={(x, y) => setMenu({ x, y, hash: row.commit.hash })}
              />
              {expanded === row.commit.hash ? (
                <CommitFilesPanel
                  files={filesByHash[row.commit.hash]}
                  error={filesError[row.commit.hash]}
                />
              ) : null}
            </div>
          ))}
        </div>
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

function GraphRowView({
  row,
  t,
  expanded,
  onToggleExpand,
  onOpenMenu,
}: {
  row: GraphRow
  t: ReturnType<typeof useT>
  expanded: boolean
  onToggleExpand: () => void
  onOpenMenu: (x: number, y: number) => void
}) {
  // Largura por LINHA, não o máximo do gráfico inteiro — o VSCode faz isso
  // (confirmado numa captura real da feature): a régua de raias só ocupa o
  // espaço que aquela linha específica precisa, o texto começa logo depois.
  // Usar o máximo global pra todas as linhas deixava sobrando um espaço
  // vazio enorme em qualquer linha mais simples só porque em ALGUM ponto do
  // histórico o gráfico chegou a ter mais raias abertas.
  const laneCount = Math.max(
    row.lanesBefore.length,
    row.lanesAfter.length,
    row.lane + 1,
    ...row.mergeLanes.map((lane) => lane + 1),
  )
  const cx = row.lane * LANE_WIDTH + LANE_WIDTH / 2
  const cy = ROW_HEIGHT / 2

  const segments: { x: number; y1: number; y2: number; color: string }[] = []
  for (let lane = 0; lane < laneCount; lane++) {
    const before = row.lanesBefore[lane]
    const after = row.lanesAfter[lane]

    if (before != null || after != null) {
      const x = lane * LANE_WIDTH + LANE_WIDTH / 2
      let y1 = 0
      let y2 = ROW_HEIGHT

      if (before == null && after != null) {
        // A raia começa neste commit: desenha do centro (cy) para baixo
        y1 = cy
      } else if (before != null && after == null) {
        // A raia termina neste commit: desenha de cima até o centro (cy)
        y2 = cy
      }

      segments.push({ x, y1, y2, color: laneColor(lane) })
    }
  }

  // Curva em S (cúbica de Bezier) entre o dot e a raia nova de merge — os
  // pontos de controle ficam no meio vertical do trecho, o mesmo truque que
  // qualquer gráfico de commit estilo VSCode/gitk usa pra evitar diagonais
  // retas e blocudas.
  const mergeCurve = (mergeLane: number) => {
    const mx = mergeLane * LANE_WIDTH + LANE_WIDTH / 2
    const midY = (cy + ROW_HEIGHT) / 2
    return `M ${cx} ${cy} C ${cx} ${midY}, ${mx} ${midY}, ${mx} ${ROW_HEIGHT}`
  }

  return (
    <div
      className={`${styles.row} ${expanded ? styles.rowExpanded : ''}`}
      title={`${row.commit.hash.slice(0, 10)} — ${row.commit.subject}`}
      onClick={onToggleExpand}
      onContextMenu={(e) => {
        e.preventDefault()
        onOpenMenu(e.clientX, e.clientY)
      }}
    >
      <svg
        className={styles.svg}
        width={laneCount * LANE_WIDTH}
        height={ROW_HEIGHT}
        aria-hidden="true"
      >
        {segments.map((segment, idx) => (
          <line
            key={`${segment.x}-${idx}`}
            x1={segment.x}
            y1={segment.y1}
            x2={segment.x}
            y2={segment.y2}
            stroke={segment.color}
            strokeWidth={2}
            strokeLinecap="round"
          />
        ))}
        {row.mergeLanes.map((mergeLane) => (
          <path
            key={mergeLane}
            d={mergeCurve(mergeLane)}
            fill="none"
            stroke={laneColor(mergeLane)}
            strokeWidth={2}
            strokeLinecap="round"
          />
        ))}
        <circle cx={cx} cy={cy} r={DOT_RADIUS} fill={laneColor(row.lane)} />
      </svg>
      <div className={styles.info}>
        <span className={styles.subject}>{row.commit.subject}</span>
        <span className={styles.meta}>
          {row.commit.authorName} · {relativeTime(row.commit.timestamp, t)}
        </span>
        {row.commit.refs.length > 0 ? (
          <span className={styles.refs}>
            {row.commit.refs.map((ref) => (
              <span key={ref} className={styles.refBadge}>
                {ref}
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function CommitFilesPanel({
  files,
  error,
}: {
  files: GitFileChange[] | undefined
  error: string | undefined
}) {
  const t = useT()
  return (
    <div className={styles.filesPanel}>
      {error ? <p className={styles.filesError}>{error}</p> : null}
      {!files && !error ? (
        <p className={styles.filesLoading}>{t('git.graph.filesLoading')}</p>
      ) : null}
      {files && files.length === 0 ? (
        <p className={styles.filesLoading}>{t('git.graph.filesEmpty')}</p>
      ) : null}
      {files?.map((file) => (
        <div key={file.path} className={styles.fileRow} title={file.path}>
          <span className={styles.fileStatus}>{(file.status.trim()[0] ?? '•').toUpperCase()}</span>
          <span className={styles.fileName}>{file.path}</span>
        </div>
      ))}
    </div>
  )
}
