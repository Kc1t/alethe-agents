import { describe, expect, it } from 'vitest'

import {
  CANVAS_PADDING,
  clampScale,
  connectorPath,
  DEFAULT_NODE_HEIGHT,
  EMPTY_BOARD,
  fitView,
  focusView,
  layoutPlannerBoard,
  LEVEL_GAP,
  MAX_SCALE,
  MIN_SCALE,
  NODE_WIDTH,
  plannerNodeId,
  rootNodeId,
  SIBLING_GAP,
  TREE_GAP,
  zoomAt,
} from './orchestratorGraph'
import { groupRuns } from './orchestratorRuns'
import type { OrchestratorJob } from './tauri'

function job(
  partial: Partial<OrchestratorJob> & Pick<OrchestratorJob, 'id' | 'runId'>,
): OrchestratorJob {
  return {
    plannerId: null,
    agent: 'codex',
    runLabel: null,
    spec: 'spec',
    cwd: 'C:/repo',
    status: 'running',
    threadId: null,
    outcome: null,
    seconds: null,
    plan: [],
    tokens: null,
    worktree: null,
    hasDiff: false,
    summary: '',
    ...partial,
  }
}

const RUN_TOP = CANVAS_PADDING
const WORKER_TOP = RUN_TOP + DEFAULT_NODE_HEIGHT + LEVEL_GAP

function centreOf(node: { x: number; width: number }): number {
  return node.x + node.width / 2
}

describe('layoutPlannerBoard', () => {
  it('returns the empty board when the planner has no runs', () => {
    expect(layoutPlannerBoard([])).toBe(EMPTY_BOARD)
  })

  it('draws every run of the planner at once, one tree each, in run order', () => {
    const board = layoutPlannerBoard(
      groupRuns([
        job({ id: 'job-01', runId: 'run-a', runLabel: 'refactor pty' }),
        job({ id: 'job-02', runId: 'run-b', runLabel: 'migrate CI' }),
        job({ id: 'job-03', runId: 'run-a' }),
      ]),
    )

    expect(board.trees.map((tree) => tree.id)).toEqual(['run-a', 'run-b'])
    expect(board.trees.map((tree) => tree.label)).toEqual(['refactor pty', 'migrate CI'])
    expect(board.roots.map((node) => node.id)).toEqual([rootNodeId('run-a'), rootNodeId('run-b')])
    expect(board.workers.map((node) => node.id)).toEqual(['job-01', 'job-03', 'job-02'])
  })

  it('puts every worker below the run it belongs to', () => {
    const board = layoutPlannerBoard(
      groupRuns([
        job({ id: 'job-01', runId: 'run-a' }),
        job({ id: 'job-02', runId: 'run-a' }),
        job({ id: 'job-03', runId: 'run-b' }),
      ]),
    )

    for (const root of board.roots) {
      for (const worker of board.workers) {
        expect(worker.y).toBeGreaterThanOrEqual(root.y + root.height)
      }
    }
    expect(board.workers.every((worker) => worker.y === WORKER_TOP)).toBe(true)
    expect(board.roots.every((root) => root.y === RUN_TOP)).toBe(true)
  })

  it('spreads the workers of a run in one row and centres the run over it', () => {
    const board = layoutPlannerBoard(
      groupRuns([
        job({ id: 'job-01', runId: 'run-a' }),
        job({ id: 'job-02', runId: 'run-a' }),
        job({ id: 'job-03', runId: 'run-a' }),
      ]),
    )

    expect(board.workers.map((node) => node.x)).toEqual([
      CANVAS_PADDING,
      CANVAS_PADDING + NODE_WIDTH + SIBLING_GAP,
      CANVAS_PADDING + (NODE_WIDTH + SIBLING_GAP) * 2,
    ])
    expect(centreOf(board.roots[0])).toBe(centreOf(board.workers[1]))
  })

  it('stands the trees side by side with a gap and never lets them overlap horizontally', () => {
    const board = layoutPlannerBoard(
      groupRuns([
        job({ id: 'job-01', runId: 'run-a' }),
        job({ id: 'job-02', runId: 'run-a' }),
        job({ id: 'job-03', runId: 'run-b' }),
        job({ id: 'job-04', runId: 'run-c' }),
      ]),
    )

    expect(board.trees[0].width).toBe(NODE_WIDTH * 2 + SIBLING_GAP)
    for (let index = 1; index < board.trees.length; index += 1) {
      const previous = board.trees[index - 1]
      expect(board.trees[index].x).toBe(previous.x + previous.width + TREE_GAP)
    }
  })

  it('keeps every node of a run inside that run tree', () => {
    const board = layoutPlannerBoard(
      groupRuns([
        job({ id: 'job-01', runId: 'run-a' }),
        job({ id: 'job-02', runId: 'run-a' }),
        job({ id: 'job-03', runId: 'run-b' }),
      ]),
      { 'job-01': 130 },
    )

    const inside = (treeIndex: number, ids: string[]) => {
      const tree = board.trees[treeIndex]
      for (const id of ids) {
        const node = [...board.roots, ...board.workers].find((entry) => entry.id === id)
        expect(node).toBeDefined()
        expect(node!.x).toBeGreaterThanOrEqual(tree.x)
        expect(node!.y).toBeGreaterThanOrEqual(tree.y)
        expect(node!.x + node!.width).toBeLessThanOrEqual(tree.x + tree.width)
        expect(node!.y + node!.height).toBeLessThanOrEqual(tree.y + tree.height)
      }
    }

    inside(0, [rootNodeId('run-a'), 'job-01', 'job-02'])
    inside(1, [rootNodeId('run-b'), 'job-03'])
  })

  it('pushes the worker row down by the tallest measured run card', () => {
    const board = layoutPlannerBoard(
      groupRuns([job({ id: 'job-01', runId: 'run-a' }), job({ id: 'job-02', runId: 'run-b' })]),
      { [rootNodeId('run-b')]: 120 },
    )

    expect(board.workers.every((worker) => worker.y === RUN_TOP + 120 + LEVEL_GAP)).toBe(true)
  })

  it('sizes a tree around its own tallest worker', () => {
    const board = layoutPlannerBoard(
      groupRuns([job({ id: 'job-01', runId: 'run-a' }), job({ id: 'job-02', runId: 'run-b' })]),
      { 'job-01': 200 },
    )

    expect(board.trees[0].height).toBe(WORKER_TOP + 200 - RUN_TOP)
    expect(board.trees[1].height).toBe(WORKER_TOP + DEFAULT_NODE_HEIGHT - RUN_TOP)
  })

  it('draws no planner node when the jobs carry no planner', () => {
    const board = layoutPlannerBoard(groupRuns([job({ id: 'job-01', runId: 'run-a' })]))

    expect(board.planner).toBeNull()
    expect(board.edges.every((edge) => edge.from === rootNodeId('run-a'))).toBe(true)
  })

  it('roots the forest on the planner, above every run and centred over them', () => {
    const board = layoutPlannerBoard(
      groupRuns([
        job({ id: 'job-01', runId: 'run-a' }),
        job({ id: 'job-02', runId: 'run-b' }),
        job({ id: 'job-03', runId: 'run-b' }),
      ]),
      undefined,
      'pty-1',
    )

    const planner = board.planner!
    expect(planner.id).toBe(plannerNodeId('pty-1'))
    expect(planner.y).toBe(CANVAS_PADDING)
    for (const root of board.roots) {
      expect(planner.y + planner.height).toBeLessThanOrEqual(root.y)
      expect(root.depth).toBe(1)
    }
    expect(centreOf(planner)).toBe(
      (centreOf(board.roots[0]) + centreOf(board.roots[board.roots.length - 1])) / 2,
    )
  })

  it('draws one edge per run from the planner, then one per worker from its own run', () => {
    const board = layoutPlannerBoard(
      groupRuns([
        job({ id: 'job-01', runId: 'run-a' }),
        job({ id: 'job-02', runId: 'run-b' }),
        job({ id: 'job-03', runId: 'run-a' }),
      ]),
      undefined,
      'pty-1',
    )

    const planner = plannerNodeId('pty-1')
    expect(board.edges.map((edge) => [edge.from, edge.to])).toEqual([
      [planner, rootNodeId('run-a')],
      [planner, rootNodeId('run-b')],
      [rootNodeId('run-a'), 'job-01'],
      [rootNodeId('run-a'), 'job-03'],
      [rootNodeId('run-b'), 'job-02'],
    ])
    expect(board.edges.some((edge) => board.workers.some((node) => node.id === edge.from))).toBe(
      false,
    )
  })

  it('tags a worker edge with the lane of the worker and a planner edge with the run state', () => {
    const board = layoutPlannerBoard(
      groupRuns([
        job({ id: 'job-01', runId: 'run-a', status: 'done' }),
        job({ id: 'job-02', runId: 'run-a', status: 'failed' }),
        job({ id: 'job-03', runId: 'run-b', status: 'queued' }),
      ]),
      undefined,
      'pty-1',
    )

    expect(board.edges.slice(0, 2).map((edge) => edge.lane)).toEqual(['failed', 'queued'])
    expect(board.edges.slice(2).map((edge) => edge.lane)).toEqual(['finished', 'failed', 'queued'])
  })

  it('carries the worst state of a run onto its tree', () => {
    const board = layoutPlannerBoard(
      groupRuns([
        job({ id: 'job-01', runId: 'run-a', status: 'done' }),
        job({ id: 'job-02', runId: 'run-a', status: 'failed' }),
        job({ id: 'job-03', runId: 'run-b', status: 'queued' }),
      ]),
    )

    expect(board.trees.map((tree) => tree.lane)).toEqual(['failed', 'queued'])
  })

  it('leaves every edge on the bottom of the parent and the top of the child', () => {
    const board = layoutPlannerBoard(groupRuns([job({ id: 'job-01', runId: 'run-a' })]), {
      'job-01': 200,
    })

    const [root] = board.roots
    const [worker] = board.workers
    const [edge] = board.edges
    expect(edge.d.startsWith(`M${centreOf(root)} ${root.y + root.height}`)).toBe(true)
    expect(edge.d.endsWith(`V${worker.y}`)).toBe(true)
  })

  it('sizes the board around every tree', () => {
    const board = layoutPlannerBoard(
      groupRuns([job({ id: 'job-01', runId: 'run-a' }), job({ id: 'job-02', runId: 'run-b' })]),
    )

    expect(board.width).toBe(CANVAS_PADDING * 2 + NODE_WIDTH * 2 + TREE_GAP)
    expect(board.height).toBe(WORKER_TOP + DEFAULT_NODE_HEIGHT + CANVAS_PADDING)
  })
})

describe('connectorPath', () => {
  it('drops straight down when both anchors share a column', () => {
    expect(connectorPath(142, 270, 142, 296)).toBe('M142 270 V296')
  })

  it('elbows right through the midpoint', () => {
    expect(connectorPath(100, 270, 200, 370)).toBe(
      'M100 270 V312 Q100 320 108 320 H192 Q200 320 200 328 V370',
    )
  })

  it('elbows left through the midpoint', () => {
    expect(connectorPath(200, 270, 100, 370)).toBe(
      'M200 270 V312 Q200 320 192 320 H108 Q100 320 100 328 V370',
    )
  })

  it('shrinks the corner radius on narrow hops', () => {
    expect(connectorPath(0, 0, 6, 100)).toBe('M0 0 V47 Q0 50 3 50 H3 Q6 50 6 53 V100')
  })
})

describe('view maths', () => {
  it('clamps the scale to the supported range', () => {
    expect(clampScale(10)).toBe(MAX_SCALE)
    expect(clampScale(0.01)).toBe(MIN_SCALE)
    expect(clampScale(0.8)).toBe(0.8)
  })

  it('fits the graph inside the viewport and centres it', () => {
    const graph = { ...EMPTY_BOARD, width: 800, height: 400 }
    expect(fitView(graph, { width: 400, height: 400 })).toEqual({ scale: 0.5, x: 0, y: 100 })
  })

  it('never zooms past 1:1 when fitting a small graph', () => {
    const graph = { ...EMPTY_BOARD, width: 200, height: 100 }
    expect(fitView(graph, { width: 800, height: 600 }).scale).toBe(1)
  })

  it('falls back to the identity transform without a graph or a viewport', () => {
    expect(fitView(EMPTY_BOARD, { width: 800, height: 600 })).toEqual({ scale: 1, x: 0, y: 0 })
    expect(fitView({ ...EMPTY_BOARD, width: 10, height: 10 }, { width: 0, height: 0 })).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    })
  })

  it('keeps the point under the cursor fixed while zooming', () => {
    const view = zoomAt({ scale: 0.5, x: 0, y: 0 }, 2, { x: 100, y: 50 })
    expect(view).toEqual({ scale: 1, x: -100, y: -50 })
  })

  it('returns the same transform when the scale is already clamped', () => {
    const view = { scale: MAX_SCALE, x: 12, y: 8 }
    expect(zoomAt(view, 2, { x: 0, y: 0 })).toBe(view)
  })

  it('centres a node in the viewport without changing the scale', () => {
    const node = {
      id: 'a',
      kind: 'worker' as const,
      depth: 1,
      index: 0,
      x: 100,
      y: 100,
      width: 200,
      height: 40,
    }
    expect(focusView(node, { scale: 1, x: 0, y: 0 }, { width: 600, height: 400 })).toEqual({
      scale: 1,
      x: 100,
      y: 80,
    })
  })

  it('centres a whole run tree the same way', () => {
    const tree = { x: 40, y: 40, width: 252, height: 208 }
    expect(focusView(tree, { scale: 1, x: 0, y: 0 }, { width: 600, height: 400 })).toEqual({
      scale: 1,
      x: 134,
      y: 56,
    })
  })
})
