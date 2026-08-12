import { ChevronDown, ChevronRight, GitCommitHorizontal } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useT } from '../../lib/i18n'
import { type GitCommitEntry,gitLogGraph } from '../../lib/tauri'
import styles from './GitGraph.module.css'

const MAX_COMMITS = 60
const ROW_HEIGHT = 28
const LANE_WIDTH = 16
const DOT_RADIUS = 4

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

export function GitGraph({ repoRoot }: { repoRoot: string }) {
  const t = useT()
  const [open, setOpen] = useState(true)
  const [commits, setCommits] = useState<GitCommitEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const rows = useMemo(() => (commits ? assignLanes(commits) : []), [commits])
  const laneCount = useMemo(
    () =>
      rows.reduce((max, row) => Math.max(max, row.lanesBefore.length, row.lanesAfter.length), 1),
    [rows],
  )

  return (
    <section className={styles.group}>
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
            <GraphRowView key={row.commit.hash} row={row} laneCount={laneCount} t={t} />
          ))}
        </div>
      ) : null}
    </section>
  )
}

function GraphRowView({
  row,
  laneCount,
  t,
}: {
  row: GraphRow
  laneCount: number
  t: ReturnType<typeof useT>
}) {
  const width = laneCount * LANE_WIDTH
  const cx = row.lane * LANE_WIDTH + LANE_WIDTH / 2
  const cy = ROW_HEIGHT / 2

  const segments: { x: number; color: string }[] = []
  for (let lane = 0; lane < laneCount; lane++) {
    const before = row.lanesBefore[lane]
    const after = row.lanesAfter[lane]
    if (before != null || after != null) {
      segments.push({ x: lane * LANE_WIDTH + LANE_WIDTH / 2, color: laneColor(lane) })
    }
  }

  return (
    <div className={styles.row} title={`${row.commit.hash.slice(0, 10)} — ${row.commit.subject}`}>
      <svg
        className={styles.svg}
        width={Math.max(width, LANE_WIDTH)}
        height={ROW_HEIGHT}
        aria-hidden="true"
      >
        {segments.map((segment) => (
          <line
            key={segment.x}
            x1={segment.x}
            y1={0}
            x2={segment.x}
            y2={ROW_HEIGHT}
            stroke={segment.color}
            strokeWidth={2}
          />
        ))}
        {row.mergeLanes.map((mergeLane) => (
          <line
            key={mergeLane}
            x1={cx}
            y1={cy}
            x2={mergeLane * LANE_WIDTH + LANE_WIDTH / 2}
            y2={ROW_HEIGHT}
            stroke={laneColor(mergeLane)}
            strokeWidth={2}
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
