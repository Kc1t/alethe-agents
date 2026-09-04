import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import type { GitCommitEntry } from '../../lib/tauri'
import styles from './GitGraph.module.css'

// Row height covers two text lines — subject above, author/date and badges below (see `.info` in
// the stylesheet). On a narrow sidebar a single line forced the subject to share its width with
// the badges and the author/date and the subject lost, clipped to a few characters ("fix(u…",
// "Merg…") with the row's most important information off screen. Stacking gives it the full width.
//
// It also sets how smooth each divergence/convergence curve looks: a curve crosses one lane width
// horizontally in only HALF of ROW_HEIGHT vertically (see `GraphRowView`), so a short row against
// a wide lane turns the diagonal into an "elbow" rather than a curve.
//
// Must match `.row { height: ... }` in GitGraph.module.css — CSS can't import a TS constant, so
// the two have to be changed together.
export const ROW_HEIGHT = 40
const LANE_WIDTH_MAX = 14
/** Lanes never get narrower than this. Scaling the whole graph down to fit an arbitrary lane count
 *  (the previous approach) drove lanes to a few pixels and strokes below 1px, which sub-pixel
 *  rendering turns into a blur — a graph too small to actually read. */
const LANE_WIDTH_MIN = 10
const DOT_RADIUS = 4
const OVERSCAN = 8

/** Ceiling on the graph gutter's total width. The SVG is `flex-shrink: 0`, so whatever it takes
 *  comes out of the commit text's share — and the width used to be the GLOBAL maximum lane count
 *  across the whole history times a fixed lane width, so a repository with a dozen concurrent
 *  branches produced a gutter wider than the sidebar itself and pushed the subject, badges and
 *  author line off the panel.
 *
 *  Deep lanes are never MERGED onto a shared column: that stacked unrelated strands at one x and
 *  put commits on a line that wasn't theirs. Lanes are given as much width as fits, down to a
 *  legible floor (`LANE_WIDTH_MIN`); only past `MAX_DRAWN_LANES` — nine concurrent lanes — is
 *  anything left out, and what is drawn always sits in its own column at a readable size. */
const GRAPH_GUTTER_MAX = 96

/** How many lanes fit at the minimum legible width. Beyond this the extra lanes are left undrawn —
 *  the honest tradeoff for never rendering a blurred graph, and far enough out (nine concurrent
 *  lanes) that ordinary histories never reach it. Dots and strokes keep a fixed size at every lane
 *  count, since the minimum lane width already leaves room for them. */
const MAX_DRAWN_LANES = Math.floor(GRAPH_GUTTER_MAX / LANE_WIDTH_MIN)

function laneMetrics(laneCount: number) {
  const drawnLanes = Math.max(1, Math.min(laneCount, MAX_DRAWN_LANES))
  // Whole pixels: a fractional lane width puts every line on a fractional x, which is exactly what
  // makes vertical strokes render soft instead of crisp.
  const width = Math.max(
    LANE_WIDTH_MIN,
    Math.min(LANE_WIDTH_MAX, Math.floor(GRAPH_GUTTER_MAX / drawnLanes)),
  )
  return { width, drawnLanes }
}

type LaneMetrics = ReturnType<typeof laneMetrics>

function laneX(lane: number, laneWidth: number): number {
  return lane * laneWidth + laneWidth / 2
}

/** Lane colors — cycles through the `--agent-*` palette already defined in
 *  the theme (never a new hardcoded hex, per design-system rules). Excludes
 *  `--agent-shell`: in EVERY theme it has the exact same hex value as
 *  `--status-working` (the fixed color forced on the main lane, see
 *  `laneColorForId`) — a secondary lane that landed on that color index by
 *  hash would be indistinguishable from the main lane, creating a
 *  single-color "zigzag" that looked like one line writhing around instead
 *  of distinct lanes converging. */
const LANE_COLOR_VARS = [
  '--agent-claude',
  '--agent-codex',
  '--agent-opencode',
  '--agent-freebuff',
  '--agent-mimo',
  '--agent-antigravity',
]

/** Lane 0 is always the main lane (the first one allocated, in practice the
 *  current branch/HEAD) — drawn thicker and ALWAYS with the same fixed color
 *  (`--status-working`), regardless of which identity passes through it over
 *  the course of the history. */
const MAIN_LANE = 0
const MAIN_STROKE_WIDTH = 3
const SIDE_STROKE_WIDTH = 2
function laneStrokeWidth(lane: number): number {
  return lane === MAIN_LANE ? MAIN_STROKE_WIDTH : SIDE_STROKE_WIDTH
}

type LaneState = (string | null)[]
type LaneIdState = (string | null)[]

type GraphRow = {
  commit: GitCommitEntry
  lane: number
  /** Color var (e.g. `--agent-claude`) already resolved by the color
   *  round-robin for THIS commit's OWN lane — see `createColorAssigner`. */
  laneId: string | null
  lanesBefore: LaneState
  lanesAfter: LaneState
  laneIdsBefore: LaneIdState
  laneIdsAfter: LaneIdState
  isLastRow: boolean
}

/** Extracts a clean ref name from a decoration entry (`%D`) — ignores tags
 *  (`tag: ...`) and resolves `HEAD -> name` down to `name` itself. */
function normalizeRefName(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.startsWith('tag: ')) return null
  const arrow = trimmed.indexOf(' -> ')
  const name = arrow !== -1 ? trimmed.slice(arrow + 4).trim() : trimmed
  return name || null
}

/** Best branch name to decorate each tip commit — prioritizes the LOCAL
 *  branch over `origin/*`, and collapses `origin/main`/`main` into the same
 *  identity (local and remote of the same branch never diverge in color).
 *  Branch names only exist on the tip commit's decoration; commits in the
 *  middle of the history have no ref at all — hence the fallback in
 *  `identityFor`. */
function buildBranchByHash(commits: GitCommitEntry[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const c of commits) {
    let best: string | null = null
    let bestIsLocal = false
    for (const raw of c.refs) {
      const parsed = normalizeRefName(raw)
      if (!parsed) continue
      const isLocal = !parsed.startsWith('origin/')
      const name = isLocal ? parsed : parsed.slice('origin/'.length)
      if (best === null || (isLocal && !bestIsLocal)) {
        best = name
        bestIsLocal = isLocal
      }
    }
    if (best) map.set(c.hash, best)
  }
  return map
}

/** Stable identity for coloring a lane: branch name when available,
 *  otherwise the hash of the commit that originated the lane itself — the
 *  hash never changes, so the color never changes even without a branch
 *  name to use. */
function identityFor(hash: string, branchByHash: Map<string, string>): string {
  return branchByHash.get(hash) ?? hash
}

/** Assigns each identity's color by ROUND-ROBIN (not by hash) — every newly
 *  encountered identity gets the NEXT unused color in the palette, in the
 *  order lanes are born from top to bottom in the history. A pure hash
 *  (`id → index`) guarantees nothing about NEIGHBORING lanes — two different
 *  branches can land on the same index by coincidence, which is very
 *  noticeable in a history with several short branches in sequence (looked
 *  like a single color repeating/zigzagging). Round-robin guarantees that
 *  neighboring lanes never repeat a color (only after exhausting the whole
 *  palette), and an identity keeps the SAME color if it reappears further
 *  down the history (cached in the Map, never reassigned).
 */
function createColorAssigner(): (identity: string) => string {
  const assigned = new Map<string, string>()
  let next = 0
  return (identity: string) => {
    const cached = assigned.get(identity)
    if (cached) return cached
    const color = LANE_COLOR_VARS[next % LANE_COLOR_VARS.length]
    next += 1
    assigned.set(identity, color)
    return color
  }
}

function laneColorForId(lane: number, colorVar: string | null): string {
  if (lane === MAIN_LANE) return 'var(--status-working)'
  if (!colorVar) return 'var(--fg-faint)'
  return `var(${colorVar})`
}

/**
 * Computes the topological lane assignment of the commit graph (DAG), with
 * a stable per-lane identity (`laneId`) to always color the same branch with
 * the same color, even when the numeric column gets recycled. ALWAYS runs
 * over the FULL list of commits — never over a list already filtered by
 * search, otherwise the algorithm loses the real topology (a parent outside
 * the filter simply stops existing for the calculation) and lines "end in
 * nothing". Search (see `GitGraphList`) only decides which lines get
 * highlighted, it never feeds back into this calculation.
 */
function buildGraphRows(commits: GitCommitEntry[]): GraphRow[] {
  const branchByHash = buildBranchByHash(commits)
  const colorFor = createColorAssigner()
  const lanes: LaneState = []
  const laneIds: LaneIdState = []
  const rows: GraphRow[] = []
  const remainingHashes = new Set(commits.map((c) => c.hash))

  const findFreeLane = (): number => {
    const free = lanes.indexOf(null)
    if (free !== -1) return free
    lanes.push(null)
    laneIds.push(null)
    return lanes.length - 1
  }

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i]
    remainingHashes.delete(commit.hash)
    const lanesBefore = [...lanes]
    const laneIdsBefore = [...laneIds]

    // 1. Determine the current commit's lane — if it's a new lane, register
    //    its origin color now (round-robin, not hash — see createColorAssigner).
    let lane = lanes.indexOf(commit.hash)
    if (lane === -1) {
      lane = findFreeLane()
      laneIds[lane] = colorFor(identityFor(commit.hash, branchByHash))
    }
    const laneId = laneIds[lane] ?? colorFor(identityFor(commit.hash, branchByHash))

    // 2. Clear ALL occurrences of this hash in the lanes array
    for (let l = 0; l < lanes.length; l++) {
      if (lanes[l] === commit.hash) lanes[l] = null
    }

    // 3. Assign parents to lanes if they exist within the commit window
    if (commit.parents.length > 0) {
      const firstParent = commit.parents[0]
      // First parent CONTINUES in the same lane — doesn't touch
      // laneIds[lane], which is what preserves the color along the whole branch.
      lanes[lane] = remainingHashes.has(firstParent) ? firstParent : null

      for (const parent of commit.parents.slice(1)) {
        if (remainingHashes.has(parent) && !lanes.includes(parent)) {
          const freeLane = findFreeLane()
          lanes[freeLane] = parent
          laneIds[freeLane] = colorFor(identityFor(parent, branchByHash))
        }
      }
    } else {
      lanes[lane] = null
    }

    const isLastRow = i === commits.length - 1
    const lanesAfter = isLastRow ? lanes.map(() => null) : [...lanes]
    const laneIdsAfter = isLastRow ? laneIds.map(() => null) : [...laneIds]

    rows.push({
      commit,
      lane,
      laneId,
      lanesBefore,
      lanesAfter,
      laneIdsBefore,
      laneIdsAfter,
      isLastRow,
    })
  }
  return rows
}

export function relativeTime(timestampSeconds: number, t: ReturnType<typeof useT>): string {
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

/**
 * Renders at most 2 primary badges plus a +N counter when there are multiple refs.
 * Prevents multiple badges (e.g. 10 worktrees) from breaking the row layout.
 */
export function RefBadges({ refs }: { refs: string[] }) {
  if (!refs || refs.length === 0) return null

  const MAX_VISIBLE = 2
  const visibleRefs = refs.slice(0, MAX_VISIBLE)
  const remainingCount = refs.length - MAX_VISIBLE
  const fullTooltip = refs.join('\n')

  return (
    <span className={styles.refs} title={fullTooltip}>
      {visibleRefs.map((ref) => (
        <span
          key={ref}
          className={styles.refBadge}
          title={ref}
          style={{
            background: ref.includes('HEAD')
              ? 'var(--agent-shell)'
              : ref.includes('tag:')
                ? 'var(--status-waiting)'
                : 'var(--accent-soft)',
            color: ref.includes('HEAD') ? 'var(--bg)' : 'var(--fg-muted)',
          }}
        >
          {ref}
        </span>
      ))}
      {remainingCount > 0 ? (
        <span className={styles.refBadgeCount} title={fullTooltip}>
          +{remainingCount}
        </span>
      ) : null}
    </span>
  )
}

/**
 * Renders a Commit Graph row using a continuous-flow mathematical model.
 * - Top half (0 -> cy): straight lines entering the node, or pass-through lanes.
 * - Bottom half (cy -> ROW_HEIGHT): straight or curved lines leaving the commit node toward its parents.
 */
function GraphRowView({
  row,
  t,
  metrics,
  strandsHidden,
  onSelect,
  onOpenMenu,
}: {
  row: GraphRow
  t: ReturnType<typeof useT>
  metrics: LaneMetrics
  /** Set while a search is filtering the list: the commits between these results aren't on screen,
   *  so connecting strands would describe a history that isn't being shown. Only the dot is drawn,
   *  which still carries the branch color. */
  strandsHidden: boolean
  onSelect: () => void
  onOpenMenu: (x: number, y: number) => void
}) {
  const cx = laneX(row.lane, metrics.width)
  const cy = ROW_HEIGHT / 2
  // Two lines rather than one long one: the native tooltip cannot be repositioned, so a single
  // wide string gets clipped by the window edge on a right-docked sidebar.
  const rowTooltip = `${row.commit.hash.slice(0, 7)}\n${row.commit.subject}`
  const dotColor = laneColorForId(row.lane, row.laneId)
  const dotRadius = row.lane === MAIN_LANE ? DOT_RADIUS + 1.5 : DOT_RADIUS

  const elements: React.ReactNode[] = []

  // 1. Process the top half (0 -> cy)
  const laneLimit = metrics.drawnLanes
  for (let l = 0; l < Math.min(row.lanesBefore.length, laneLimit) && !strandsHidden; l++) {
    if (row.lanesBefore[l] != null) {
      const fromX = laneX(l, metrics.width)
      const color = laneColorForId(l, row.laneIdsBefore[l] ?? null)

      if (l === row.lane) {
        elements.push(
          <line
            key={`top-line-${l}`}
            x1={cx}
            y1={0}
            x2={cx}
            y2={cy}
            stroke={color}
            strokeWidth={laneStrokeWidth(l)}
            strokeLinecap="round"
          />,
        )
      } else if (row.lanesBefore[l] === row.commit.hash) {
        // Convergence point: another lane was also pointing at this commit
        // (e.g. a branch that originated from it) — instead of continuing
        // straight and disappearing into empty space, curve into the
        // commit's dot and merge there, just like the divergence curve
        // that already exists in the bottom half.
        const midY = cy / 2
        elements.push(
          <path
            key={`top-merge-${l}`}
            d={`M ${fromX} 0 C ${fromX} ${midY}, ${cx} ${midY}, ${cx} ${cy}`}
            fill="none"
            stroke={color}
            strokeWidth={laneStrokeWidth(l)}
            strokeLinecap="round"
          />,
        )
      } else {
        elements.push(
          <line
            key={`top-pass-${l}`}
            x1={fromX}
            y1={0}
            x2={fromX}
            y2={cy}
            stroke={color}
            strokeWidth={laneStrokeWidth(l)}
            strokeLinecap="round"
          />,
        )
      }
    }
  }

  // 2. Process the bottom half (cy -> ROW_HEIGHT) — only if this isn't the last row
  if (!row.isLastRow && !strandsHidden) {
    for (let l = 0; l < Math.min(row.lanesAfter.length, laneLimit); l++) {
      const parent = row.lanesAfter[l]
      if (parent != null) {
        const toX = laneX(l, metrics.width)
        const color = laneColorForId(l, row.laneIdsAfter[l] ?? null)

        if (l === row.lane) {
          elements.push(
            <line
              key={`bottom-line-${l}`}
              x1={cx}
              y1={cy}
              x2={cx}
              y2={ROW_HEIGHT}
              stroke={color}
              strokeWidth={laneStrokeWidth(l)}
              strokeLinecap="round"
            />,
          )
        } else if (row.lanesBefore[l] === parent) {
          elements.push(
            <line
              key={`bottom-pass-${l}`}
              x1={toX}
              y1={cy}
              x2={toX}
              y2={ROW_HEIGHT}
              stroke={color}
              strokeWidth={laneStrokeWidth(l)}
              strokeLinecap="round"
            />,
          )
        } else {
          const midY = (cy + ROW_HEIGHT) / 2
          elements.push(
            <path
              key={`bottom-curve-${l}`}
              d={`M ${cx} ${cy} C ${cx} ${midY}, ${toX} ${midY}, ${toX} ${ROW_HEIGHT}`}
              fill="none"
              stroke={color}
              strokeWidth={laneStrokeWidth(l)}
              strokeLinecap="round"
            />,
          )
        }
      }
    }
  }

  return (
    <div
      className={styles.row}
      title={rowTooltip}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault()
        onOpenMenu(e.clientX, e.clientY)
      }}
    >
      <svg
        className={styles.svg}
        width={metrics.drawnLanes * metrics.width}
        height={ROW_HEIGHT}
        aria-hidden="true"
      >
        {elements}
        {/* Commit's main dot/node — the main lane gets a bigger radius,
            same visual-hierarchy logic as the thicker stroke. The outline
            in the background color visually "cuts" the lines that pass
            behind the dot, GitLens/GitKraken style. */}
        <circle
          className={styles.dot}
          cx={cx}
          cy={cy}
          fill={dotColor}
          stroke="var(--bg)"
          strokeWidth={2}
          style={
            {
              // `color` feeds the hover glow's `drop-shadow(... currentColor)`, and the two radii
              // drive the grow-on-hover — both live in CSS so the transition is the compositor's
              // job rather than React's. Chromium resolves the SVG geometry property `r` from CSS.
              color: dotColor,
              '--dot-r': `${dotRadius}px`,
              '--dot-r-hover': `${dotRadius + 2}px`,
            } as React.CSSProperties
          }
        />
      </svg>

      <div className={styles.info}>
        <span className={styles.subject}>{row.commit.subject}</span>
        <span className={styles.infoBottom}>
          <span className={styles.meta}>
            {row.commit.authorName} · {relativeTime(row.commit.timestamp, t)}
          </span>
          <RefBadges refs={row.commit.refs} />
        </span>
      </div>
    </div>
  )
}

export type GitGraphListProps = {
  commits: GitCommitEntry[]
  searchQuery: string
  /** Scroll position to restore on mount (returning from the detail screen). */
  initialScrollTop: number
  onSelectCommit: (hash: string, scrollTop: number) => void
  onOpenMenu: (x: number, y: number, hash: string) => void
}

/** The actual commit list/graph — lane calculation, identity-stable color,
 *  and virtualization (manual windowing, no new dependency: every row has
 *  a fixed `ROW_HEIGHT`, the simplest possible case to virtualize). */
export function GitGraphList({
  commits,
  searchQuery,
  initialScrollTop,
  onSelectCommit,
  onOpenMenu,
}: GitGraphListProps) {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const [scrollTop, setScrollTop] = useState(initialScrollTop)
  const [viewportHeight, setViewportHeight] = useState(380)

  const rows = useMemo(() => buildGraphRows(commits), [commits])

  // GLOBAL lane width for the whole graph (not per row) — every row needs
  // to start its text at the SAME X position, otherwise a pass-through
  // lane from a row with more open lanes would visually invade the message
  // text of a narrower neighboring row. Manual loop (not spread+Math.max) —
  // with a large history, spreading thousands of numbers as arguments
  // blows the call stack.
  const laneCount = useMemo(() => {
    let max = 1
    for (const row of rows) {
      max = Math.max(max, row.lanesBefore.length, row.lanesAfter.length, row.lane + 1)
    }
    return max
  }, [rows])

  // Lane geometry is derived once for the whole list, never per row: every row has to place its
  // text at the same x, or a busier row's extra lanes would shove its message out of line with
  // its neighbours'.
  const metrics = useMemo(() => laneMetrics(laneCount), [laneCount])

  // Search FILTERS the list rather than dimming non-matches in place. Dimming kept the graph's
  // strands continuous, but it also kept every non-match on screen — the results were needles in
  // the same haystack, just faded, so searching barely narrowed anything down. The topology is
  // still computed over the FULL history (`buildGraphRows` above, never over a filtered list), so
  // filtering here only changes what is displayed, never how lanes were assigned.
  const filteredRows = useMemo(() => {
    const query = searchQuery.toLowerCase().trim()
    if (!query) return rows
    return rows.filter(({ commit }) => {
      return (
        commit.subject.toLowerCase().includes(query) ||
        commit.hash.toLowerCase().includes(query) ||
        commit.authorName.toLowerCase().includes(query) ||
        commit.refs.some((ref) => ref.toLowerCase().includes(query))
      )
    })
  }, [rows, searchQuery])

  const searching = searchQuery.trim().length > 0

  // Restores the saved scroll position when returning from the detail
  // screen — only on mount (the whole component unmounts/remounts when the view changes).
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = initialScrollTop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setViewportHeight(el.clientHeight)
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Back to the top whenever the query changes: now that searching actually shortens the list, a
  // scroll position kept from the unfiltered list can point past the end of the results and leave
  // the panel looking empty.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setScrollTop(0)
  }, [searchQuery])

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop
    // rAF-throttled — without this, `onScroll` fires on every pixel
    // scrolled and recalculates the visible window far more often than the
    // screen can paint.
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      setScrollTop(top)
    })
  }

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const endIndex = Math.min(
    filteredRows.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  )
  const visibleRows = filteredRows.slice(startIndex, endIndex)
  const noMatches = searching && filteredRows.length === 0

  return (
    <>
      {noMatches ? <p className={styles.empty}>{t('git.graph.noSearchResults')}</p> : null}
      <div className={styles.body} ref={scrollRef} onScroll={onScroll}>
        <div style={{ height: filteredRows.length * ROW_HEIGHT, position: 'relative' }}>
          <div style={{ position: 'absolute', top: startIndex * ROW_HEIGHT, left: 0, right: 0 }}>
            {visibleRows.map((row) => (
              <GraphRowView
                key={row.commit.hash}
                row={row}
                t={t}
                metrics={metrics}
                strandsHidden={searching}
                onSelect={() =>
                  onSelectCommit(row.commit.hash, scrollRef.current?.scrollTop ?? scrollTop)
                }
                onOpenMenu={(x, y) => onOpenMenu(x, y, row.commit.hash)}
              />
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
