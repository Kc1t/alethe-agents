import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import type { GitCommitEntry } from '../../lib/tauri'
import styles from './GitGraph.module.css'

// More spaced out (GitLens/GitKraken style) than the original value — more
// breathing room between lanes and between commit rows. `ROW_HEIGHT` has to
// match `.row { height: ... }` in GitGraph.module.css (CSS can't import a
// TS constant, so both need to be changed together).
// The ROW_HEIGHT×LANE_WIDTH ratio controls how "smooth" each divergence/
// convergence curve looks: the curve covers LANE_WIDTH horizontally in only
// HALF of ROW_HEIGHT vertically (see `GraphRowView`) — with the old ratio
// (20×28, curve using only 14px of vertical space) the diagonal ended up
// steep and looked like an "elbow" instead of a curve, especially in
// histories with several short branches stacked in sequence. Raising
// ROW_HEIGHT and lowering LANE_WIDTH a bit makes the curve noticeably
// smoother without changing the drawing logic.
// Two text lines per row (subject above, author/date below) — see `.info` in the stylesheet. On a
// narrow sidebar a single line forced the subject to share its width with the ref badges and the
// author/date, and the subject lost: it was clipped to a few characters ("fix(u…", "Merg…") while
// the row's most important information sat off screen. Stacking gives the subject the full width.
export const ROW_HEIGHT = 40
const LANE_WIDTH = 14
const DOT_RADIUS = 4
const OVERSCAN = 8

/** Hard ceiling on how many lanes are ever drawn, and therefore on how wide the graph gutter can
 *  get. The SVG is `flex-shrink: 0`, so its width is taken out of the row before the commit text
 *  gets any — and the width used to be the GLOBAL maximum lane count across the entire history.
 *  A repository with a dozen concurrent branches produced a gutter wider than the sidebar itself,
 *  pushing the subject, badges and author line clean off the panel (the row clips them), which
 *  read as "the graph throws everything off screen". Lanes past this limit are drawn collapsed
 *  onto the last column: overlapping strands in a deep history are a fair trade for a layout that
 *  always leaves room for the message. */
const MAX_RENDERED_LANES = 3

/** Lanes past the cap are omitted from the drawing entirely rather than collapsed onto the last
 *  column. Collapsing them (the first attempt at bounding the width) drew several unrelated
 *  strands at the exact same x, so they overlapped into what looked like one thick smeared line
 *  instead of distinct branches. The one exception is the row's own commit, which is clamped into
 *  the last column so that the commit itself always has a visible dot. */
function isRenderedLane(lane: number): boolean {
  return lane < MAX_RENDERED_LANES
}

function laneX(lane: number): number {
  return Math.min(lane, MAX_RENDERED_LANES - 1) * LANE_WIDTH + LANE_WIDTH / 2
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
  laneCount,
  dimmed,
  onSelect,
  onOpenMenu,
}: {
  row: GraphRow
  t: ReturnType<typeof useT>
  laneCount: number
  dimmed: boolean
  onSelect: () => void
  onOpenMenu: (x: number, y: number) => void
}) {
  const cx = laneX(row.lane)
  const cy = ROW_HEIGHT / 2
  // Two lines rather than one long one: the native tooltip cannot be repositioned, so a single
  // wide string gets clipped by the window edge on a right-docked sidebar.
  const rowTooltip = `${row.commit.hash.slice(0, 7)}\n${row.commit.subject}`
  const dotColor = laneColorForId(row.lane, row.laneId)
  const dotRadius = row.lane === MAIN_LANE ? DOT_RADIUS + 1.5 : DOT_RADIUS

  const elements: React.ReactNode[] = []

  // 1. Process the top half (0 -> cy)
  for (let l = 0; l < row.lanesBefore.length; l++) {
    if (row.lanesBefore[l] != null && (isRenderedLane(l) || l === row.lane)) {
      const fromX = laneX(l)
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
  if (!row.isLastRow) {
    for (let l = 0; l < row.lanesAfter.length; l++) {
      const parent = row.lanesAfter[l]
      if (parent != null && (isRenderedLane(l) || l === row.lane)) {
        const toX = laneX(l)
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
      className={`${styles.row} ${dimmed ? styles.rowDimmed : ''}`}
      title={rowTooltip}
      onClick={onSelect}
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
    // Capped so the gutter can never grow past what the sidebar can spare — see
    // `MAX_RENDERED_LANES`. Without this the width tracked the deepest point of the whole
    // history, so one busy stretch widened the gutter for every row in the list.
    return Math.min(max, MAX_RENDERED_LANES)
  }, [rows])

  // null = no active search (nothing gets dimmed). Never shrinks `rows` —
  // only marks which commits match, to never lose the graph's visual
  // continuity (see comment on `buildGraphRows`).
  const matchingHashes = useMemo(() => {
    const query = searchQuery.toLowerCase().trim()
    if (!query) return null
    const set = new Set<string>()
    for (const row of rows) {
      const c = row.commit
      if (
        c.subject.toLowerCase().includes(query) ||
        c.hash.toLowerCase().includes(query) ||
        c.authorName.toLowerCase().includes(query) ||
        c.refs.some((r) => r.toLowerCase().includes(query))
      ) {
        set.add(c.hash)
      }
    }
    return set
  }, [rows, searchQuery])

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
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  )
  const visibleRows = rows.slice(startIndex, endIndex)
  const noMatches = matchingHashes != null && matchingHashes.size === 0

  return (
    <>
      {noMatches ? <p className={styles.empty}>{t('git.graph.noSearchResults')}</p> : null}
      <div className={styles.body} ref={scrollRef} onScroll={onScroll}>
        <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          <div style={{ position: 'absolute', top: startIndex * ROW_HEIGHT, left: 0, right: 0 }}>
            {visibleRows.map((row) => (
              <GraphRowView
                key={row.commit.hash}
                row={row}
                t={t}
                laneCount={laneCount}
                dimmed={matchingHashes != null && !matchingHashes.has(row.commit.hash)}
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
