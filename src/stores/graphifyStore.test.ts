import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  graphifyEnsureGraph: vi.fn(),
  graphifyReadGraph: vi.fn(),
}))

vi.mock('../lib/tauri', () => ({
  graphifyDetect: vi.fn(async () => null),
  graphifyEnsureGraph: mocks.graphifyEnsureGraph,
  graphifyReadGraph: mocks.graphifyReadGraph,
  graphifySnapshot: vi.fn(async () => ({})),
  graphifyListSnapshots: vi.fn(async () => []),
  graphifyRollback: vi.fn(async () => {}),
  graphifyPruneSnapshots: vi.fn(async () => {}),
}))

import { useGraphifyStore } from './graphifyStore'

const emptyGraph = { nodes: [], edges: [], nodeCount: 0, edgeCount: 0, truncated: false }
const nonEmptyGraph = {
  nodes: [{ id: 'a', label: 'A' }],
  edges: [],
  nodeCount: 1,
  edgeCount: 0,
  truncated: false,
}

describe('graphifyStore.generateGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    useGraphifyStore.setState({
      repo: '/repo',
      status: null,
      graph: null,
      snapshots: [],
      loading: false,
      error: null,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns an existing empty graph immediately instead of timing out', async () => {
    mocks.graphifyEnsureGraph.mockResolvedValue('exists')
    mocks.graphifyReadGraph.mockResolvedValue(emptyGraph)

    let settled = false
    const pending = useGraphifyStore
      .getState()
      .generateGraph()
      .then(() => {
        settled = true
      })
    await vi.advanceTimersByTimeAsync(1_000)
    await pending

    expect(settled).toBe(true)
    expect(useGraphifyStore.getState().graph).toEqual(emptyGraph)
    expect(useGraphifyStore.getState().error).toBeNull()
    expect(useGraphifyStore.getState().loading).toBe(false)
    expect(mocks.graphifyReadGraph).toHaveBeenCalledTimes(1)
  })

  it('polls while generating until nodes appear', async () => {
    mocks.graphifyEnsureGraph.mockResolvedValue('generating')
    mocks.graphifyReadGraph.mockResolvedValueOnce(emptyGraph).mockResolvedValueOnce(nonEmptyGraph)

    const pending = useGraphifyStore.getState().generateGraph()
    await vi.advanceTimersByTimeAsync(1_500)
    await pending

    expect(useGraphifyStore.getState().graph).toEqual(nonEmptyGraph)
    expect(useGraphifyStore.getState().error).toBeNull()
    expect(mocks.graphifyReadGraph).toHaveBeenCalledTimes(2)
  })
})
