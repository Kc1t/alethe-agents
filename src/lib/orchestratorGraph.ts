import type { MediaItem } from './orchestratorMedia'
import { LANE_OF, type OrchestratorRun, type RunLane } from './orchestratorRuns'
import type { ShellAttachment } from './orchestratorShells'
import type { OrchestratorShellStatus } from './tauri/orchestrator'

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
const SHELL_GROUP_PREFIX = 'shells:'

export type GraphNodeKind = 'planner' | 'run' | 'worker' | 'media' | 'shellGroup' | 'shell'

/** What the layout needs of a shell: identity, where it hangs, and whether it is running. */
export type LayoutShell = {
  id: string
  attachment: ShellAttachment
  status: OrchestratorShellStatus
}

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
  /** Only present when one agent was running out when this worker was spawned. */
  note: GraphEdgeNote | null
}

export type GraphEdgeNote = {
  verdict: 'chosen' | 'ignored'
  agent: string
  window: string
  used: number
  x: number
  y: number
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
  media: GraphNode[]
  shellGroups: GraphNode[]
  shells: GraphNode[]
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
  media: [],
  shellGroups: [],
  shells: [],
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

/** A worker's promoted image gets one card, directly below it. */
export function mediaNodeId(jobId: string): string {
  return `${jobId}:media`
}

export function shellGroupNodeId(attachment: ShellAttachment): string {
  return `${SHELL_GROUP_PREFIX}${attachment}`
}

function heightOf(heights: NodeHeights | undefined, id: string): number {
  const measured = heights?.[id]
  return measured && measured > 0 ? Math.round(measured) : DEFAULT_NODE_HEIGHT
}

function centerX(node: { x: number; width: number }): number {
  return node.x + node.width / 2
}

/** Downward elbow with rounded corners: out of the parent's bottom, into the child's top. */
/** The midpoint of a connector's horizontal run — the only stretch with room for a label. */
export function connectorLabelPoint(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { x: number; y: number } {
  return { x: (x1 + x2) / 2, y: y1 + (y2 - y1) / 2 }
}

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
  mediaByJobId?: ReadonlyMap<string, MediaItem>,
  shells: readonly LayoutShell[] = [],
): BoardGraph {
  if (runs.length === 0 && shells.length === 0) return EMPTY_BOARD

  const groupsByAttachment: ShellAttachment[] = (['attached', 'detached'] as const).filter(
    (attachment) => shells.some((shell) => shell.attachment === attachment),
  )

  const shellSpan = (attachment: ShellAttachment): number => {
    const count = shells.filter((shell) => shell.attachment === attachment).length
    return count * NODE_WIDTH + (count - 1) * SIBLING_GAP
  }

  const spans = [
    ...runs.map((run) =>
      run.jobs.length > 0
        ? run.jobs.length * NODE_WIDTH + (run.jobs.length - 1) * SIBLING_GAP
        : NODE_WIDTH,
    ),
    ...groupsByAttachment.map(shellSpan),
  ]

  const lefts: number[] = []
  let cursor = CANVAS_PADDING
  for (const span of spans) {
    lefts.push(cursor)
    cursor += span + TREE_GAP
  }

  const plannerHeight = plannerId ? heightOf(heights, plannerNodeId(plannerId)) : 0
  const runTop = CANVAS_PADDING + (plannerId ? plannerHeight + LEVEL_GAP : 0)
  const runHeights = runs.map((run) => heightOf(heights, rootNodeId(run.id)))
  const groupHeights = groupsByAttachment.map((attachment) =>
    heightOf(heights, shellGroupNodeId(attachment)),
  )
  const rowHeights = [...runHeights, ...groupHeights]
  // Every worker and shell in the forest shares one baseline, so the levels read as levels.
  const workerTop = runTop + Math.max(...rowHeights) + LEVEL_GAP

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
  const media: GraphNode[] = []
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
      const edgeFrom: [number, number, number, number] = [
        centerX(root),
        root.y + root.height,
        centerX(node),
        node.y,
      ]
      const label = connectorLabelPoint(...edgeFrom)
      runEdges.push({
        id: `${root.id}->${node.id}`,
        from: root.id,
        to: node.id,
        lane: LANE_OF[job.status],
        d: connectorPath(...edgeFrom),
        note: job.routing ? { ...job.routing, x: label.x, y: label.y } : null,
      })

      if (mediaByJobId?.has(job.id)) {
        const mediaId = mediaNodeId(job.id)
        const mediaNode: GraphNode = {
          id: mediaId,
          kind: 'media',
          depth: node.depth + 1,
          index: column,
          x: node.x,
          y: node.y + node.height + LEVEL_GAP,
          width: NODE_WIDTH,
          height: heightOf(heights, mediaId),
        }
        media.push(mediaNode)
        bottom = Math.max(bottom, mediaNode.y + mediaNode.height)
        runEdges.push({
          id: `${node.id}->${mediaNode.id}`,
          from: node.id,
          to: mediaNode.id,
          lane: LANE_OF[job.status],
          d: connectorPath(centerX(node), node.y + node.height, centerX(mediaNode), mediaNode.y),
          note: null,
        })
      }
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

  const shellGroups: GraphNode[] = []
  const shellNodes: GraphNode[] = []

  groupsByAttachment.forEach((attachment, groupIndex) => {
    const index = runs.length + groupIndex
    const groupId = shellGroupNodeId(attachment)
    const members = shells.filter((shell) => shell.attachment === attachment)
    const group: GraphNode = {
      id: groupId,
      kind: 'shellGroup',
      depth: plannerId ? 1 : 0,
      index,
      x: Math.round(lefts[index] + (spans[index] - NODE_WIDTH) / 2),
      y: runTop,
      width: NODE_WIDTH,
      height: groupHeights[groupIndex],
    }
    shellGroups.push(group)
    let bottom = group.y + group.height

    members.forEach((shell, column) => {
      const node: GraphNode = {
        id: shell.id,
        kind: 'shell',
        depth: group.depth + 1,
        index: column,
        x: lefts[index] + column * (NODE_WIDTH + SIBLING_GAP),
        y: workerTop,
        width: NODE_WIDTH,
        height: heightOf(heights, shell.id),
      }
      shellNodes.push(node)
      bottom = Math.max(bottom, node.y + node.height)
      runEdges.push({
        id: `${groupId}->${node.id}`,
        from: groupId,
        to: node.id,
        lane: shell.status === 'running' ? 'running' : 'finished',
        d: connectorPath(centerX(group), group.y + group.height, centerX(node), node.y),
        note: null,
      })
    })

    trees.push({
      id: groupId,
      label: attachment,
      lane: members.some((shell) => shell.status === 'running') ? 'running' : 'finished',
      x: lefts[index],
      y: group.y,
      width: spans[index],
      height: bottom - group.y,
    })
  })

  let planner: GraphNode | null = null
  const plannerEdges: GraphEdge[] = []
  if (plannerId) {
    const attached = shellGroups.find((group) => group.id === shellGroupNodeId('attached')) ?? null
    // The tab is open because someone is looking at this planner, so it always gets a node: centre
    // it over the runs and attached group when there are any, else over whatever shell groups exist
    // (the detached group), else park it at the corner of an otherwise empty board.
    const heads = [...roots, ...(attached ? [attached] : [])]
    const centeringNodes = heads.length > 0 ? heads : shellGroups
    const x =
      centeringNodes.length > 0
        ? Math.round(
            (centerX(centeringNodes[0]) + centerX(centeringNodes[centeringNodes.length - 1])) / 2 -
              NODE_WIDTH / 2,
          )
        : CANVAS_PADDING
    planner = {
      id: plannerNodeId(plannerId),
      kind: 'planner',
      depth: 0,
      index: 0,
      x,
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
        note: null,
      })
    })
    if (attached) {
      plannerEdges.push({
        id: `${planner.id}->${attached.id}`,
        from: planner.id,
        to: attached.id,
        lane: 'running',
        d: connectorPath(
          centerX(planner),
          planner.y + planner.height,
          centerX(attached),
          attached.y,
        ),
        note: null,
      })
    }
  }

  return {
    planner,
    trees,
    roots,
    workers,
    media,
    shellGroups,
    shells: shellNodes,
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
