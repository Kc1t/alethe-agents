import { LANE_OF, type OrchestratorRun, type RunLane } from './orchestratorRuns'

export const NODE_WIDTH = 252
export const SIBLING_GAP = 24
export const TREE_GAP = 120
export const LEVEL_GAP = 56
export const CANVAS_PADDING = 40
export const DEFAULT_NODE_HEIGHT = 76
export const ELBOW_RADIUS = 8
export const DOT_SPACING = 22
export const MIN_SCALE = 0.35
export const MAX_SCALE = 1.6

const ROOT_PREFIX = 'run:'
const PLANNER_PREFIX = 'planner:'

export type GraphNodeKind = 'planner' | 'run' | 'worker'

export type GraphNode = {
  id: string
  kind: GraphNodeKind
  depth: number
  index: number
  x: number
  y: number
  width: number
  height: number
}

export type GraphEdge = {
  id: string
  from: string
  to: string
  lane: RunLane
  d: string
}

/**
 * The extent one run's tree occupies. Nothing is drawn around it: it exists to keep the trees apart
 * and to give the rail a box to bring into view.
 */
export type GraphTree = {
  id: string
  label: string
  lane: RunLane
  x: number
  y: number
  width: number
  height: number
}

/** A forest laid out top-down: the planner over its runs, each run over its own workers. */
export type BoardGraph = {
  planner: GraphNode | null
  trees: GraphTree[]
  roots: GraphNode[]
  workers: GraphNode[]
  edges: GraphEdge[]
  width: number
  height: number
}

export type NodeHeights = Readonly<Record<string, number>>

export type Viewport = { width: number; height: number }

export type ViewPoint = { x: number; y: number }

export type ViewTransform = { scale: number; x: number; y: number }

export type Box = { x: number; y: number; width: number; height: number }

export const EMPTY_BOARD: BoardGraph = {
  planner: null,
  trees: [],
  roots: [],
  workers: [],
  edges: [],
  width: 0,
  height: 0,
}

export function rootNodeId(runId: string): string {
  return `${ROOT_PREFIX}${runId}`
}

export function plannerNodeId(plannerId: string): string {
  return `${PLANNER_PREFIX}${plannerId}`
}

function heightOf(heights: NodeHeights | undefined, id: string): number {
  const measured = heights?.[id]
  return measured && measured > 0 ? Math.round(measured) : DEFAULT_NODE_HEIGHT
}

function centerX(node: { x: number; width: number }): number {
  return node.x + node.width / 2
}

/** Downward elbow with rounded corners: out of the parent's bottom, into the child's top. */
export function connectorPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1
  if (Math.abs(dx) < 1) return `M${x1} ${y1} V${y2}`
  const midY = y1 + (y2 - y1) / 2
  const radius = Math.min(ELBOW_RADIUS, Math.abs(dx) / 2, Math.abs(y2 - y1) / 2)
  const step = dx > 0 ? radius : -radius
  return [
    `M${x1} ${y1}`,
    `V${midY - radius}`,
    `Q${x1} ${midY} ${x1 + step} ${midY}`,
    `H${x2 - step}`,
    `Q${x2} ${midY} ${x2} ${midY + radius}`,
    `V${y2}`,
  ].join(' ')
}

/**
 * One tree per run, standing side by side across the canvas with `TREE_GAP` of empty board between
 * them. Inside a tree the run sits above a single row of its workers; the backend reports no
 * relation between workers, so the only edges are planner -> run and run -> worker.
 */
export function layoutPlannerBoard(
  runs: OrchestratorRun[],
  heights?: NodeHeights,
  plannerId?: string | null,
): BoardGraph {
  if (runs.length === 0) return EMPTY_BOARD

  const spans = runs.map((run) =>
    run.jobs.length > 0
      ? run.jobs.length * NODE_WIDTH + (run.jobs.length - 1) * SIBLING_GAP
      : NODE_WIDTH,
  )

  const lefts: number[] = []
  let cursor = CANVAS_PADDING
  for (const span of spans) {
    lefts.push(cursor)
    cursor += span + TREE_GAP
  }

  const plannerHeight = plannerId ? heightOf(heights, plannerNodeId(plannerId)) : 0
  const runTop = CANVAS_PADDING + (plannerId ? plannerHeight + LEVEL_GAP : 0)
  const runHeights = runs.map((run) => heightOf(heights, rootNodeId(run.id)))
  // Every worker in the forest shares one baseline, so the levels read as levels.
  const workerTop = runTop + Math.max(...runHeights) + LEVEL_GAP

  const roots: GraphNode[] = runs.map((run, index) => ({
    id: rootNodeId(run.id),
    kind: 'run',
    depth: plannerId ? 1 : 0,
    index,
    x: Math.round(lefts[index] + (spans[index] - NODE_WIDTH) / 2),
    y: runTop,
    width: NODE_WIDTH,
    height: runHeights[index],
  }))

  const workers: GraphNode[] = []
  const trees: GraphTree[] = []
  const runEdges: GraphEdge[] = []

  runs.forEach((run, index) => {
    const root = roots[index]
    let bottom = root.y + root.height

    run.jobs.forEach((job, column) => {
      const node: GraphNode = {
        id: job.id,
        kind: 'worker',
        depth: root.depth + 1,
        index: column,
        x: lefts[index] + column * (NODE_WIDTH + SIBLING_GAP),
        y: workerTop,
        width: NODE_WIDTH,
        height: heightOf(heights, job.id),
      }
      workers.push(node)
      bottom = Math.max(bottom, node.y + node.height)
      runEdges.push({
        id: `${root.id}->${node.id}`,
        from: root.id,
        to: node.id,
        lane: LANE_OF[job.status],
        d: connectorPath(centerX(root), root.y + root.height, centerX(node), node.y),
      })
    })

    trees.push({
      id: run.id,
      label: run.label,
      lane: run.state,
      x: lefts[index],
      y: root.y,
      width: spans[index],
      height: bottom - root.y,
    })
  })

  let planner: GraphNode | null = null
  const plannerEdges: GraphEdge[] = []
  if (plannerId) {
    const first = centerX(roots[0])
    const last = centerX(roots[roots.length - 1])
    planner = {
      id: plannerNodeId(plannerId),
      kind: 'planner',
      depth: 0,
      index: 0,
      x: Math.round((first + last) / 2 - NODE_WIDTH / 2),
      y: CANVAS_PADDING,
      width: NODE_WIDTH,
      height: plannerHeight,
    }
    roots.forEach((root, index) => {
      plannerEdges.push({
        id: `${planner!.id}->${root.id}`,
        from: planner!.id,
        to: root.id,
        lane: runs[index].state,
        d: connectorPath(centerX(planner!), planner!.y + planner!.height, centerX(root), root.y),
      })
    })
  }

  return {
    planner,
    trees,
    roots,
    workers,
    edges: [...plannerEdges, ...runEdges],
    width: cursor - TREE_GAP + CANVAS_PADDING,
    height: Math.max(...trees.map((tree) => tree.y + tree.height)) + CANVAS_PADDING,
  }
}

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

export function fitView(graph: Viewport, viewport: Viewport): ViewTransform {
  if (graph.width <= 0 || graph.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { scale: 1, x: 0, y: 0 }
  }
  const scale = clampScale(
    Math.min(1, viewport.width / graph.width, viewport.height / graph.height),
  )
  return {
    scale,
    x: Math.round((viewport.width - graph.width * scale) / 2),
    y: Math.round((viewport.height - graph.height * scale) / 2),
  }
}

/** Keeps the canvas point under `point` (viewport coordinates) fixed while scaling. */
export function zoomAt(view: ViewTransform, factor: number, point: ViewPoint): ViewTransform {
  const scale = clampScale(view.scale * factor)
  if (scale === view.scale) return view
  const ratio = scale / view.scale
  return {
    scale,
    x: Math.round(point.x - (point.x - view.x) * ratio),
    y: Math.round(point.y - (point.y - view.y) * ratio),
  }
}

/** Centres any box on the board — a node or a whole run tree — without changing the scale. */
export function focusView(box: Box, view: ViewTransform, viewport: Viewport): ViewTransform {
  return {
    scale: view.scale,
    x: Math.round(viewport.width / 2 - (box.x + box.width / 2) * view.scale),
    y: Math.round(viewport.height / 2 - (box.y + box.height / 2) * view.scale),
  }
}
