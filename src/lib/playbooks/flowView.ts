import type { TFunction } from '../i18n'
import { readScopedStorage, writeScopedStorage } from '../storageNamespace'
import {
  blankPlaybook,
  compileDoc,
  type DocEdge,
  docFromPlaybook,
  type DocNode,
  type DocPort,
  type FlowDoc,
  nodeSize,
} from './flowDoc'
import {
  addGhosts,
  buildGraph,
  type DecisionNode,
  type FlowGraph,
  type FlowNode,
  phaseRoleNode,
  type Simulation,
} from './graph'
import { asQuestion, condText } from './labels'
import {
  condList,
  context,
  evalCond,
  isMap,
  phaseSubject,
  type PlaybooksState,
  type PlaybookWorkflow,
} from './state'

const LAYOUT_KEY = 'playbooks.layout'
type Layout = Record<string, Record<string, { x: number; y: number }>>

function readLayout(): Layout {
  try {
    const raw = readScopedStorage(LAYOUT_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return isMap(parsed) ? (parsed as Layout) : {}
  } catch {
    return {}
  }
}

export function saveLayout(wf: PlaybookWorkflow) {
  if (!wf.doc) return
  try {
    const layout = readLayout()
    layout[wf.key] = Object.fromEntries(
      wf.doc.nodes.map((n) => [layoutId(wf, n.id), { x: Math.round(n.x), y: Math.round(n.y) }]),
    )
    writeScopedStorage(LAYOUT_KEY, JSON.stringify(layout))
  } catch {
    return
  }
}

const noText = ((key: string) => key) as TFunction

const layoutId = (wf: PlaybookWorkflow, id: string) => {
  const skipped = wf.skips?.[id]
  return skipped ? `dec:${skipped.slice('phase:'.length)}` : (wf.alias?.[id] ?? id)
}

export function applyDoc(wf: PlaybookWorkflow) {
  if (!wf.doc) return
  const compiled = compileDoc(wf.doc)
  wf.problems = compiled.problems
  wf.alias = compiled.alias
  wf.skips = compiled.skips
  if (!compiled.problems.length) wf.pb.phases = compiled.phases
}

export function attachDocs(s: PlaybooksState) {
  const layout = readLayout()
  Object.values(s.workflows).forEach((wf) => {
    if (wf.kind !== 'playbook' || wf.doc) return
    wf.doc = docFromPlaybook(s, noText, wf.pb)
    const saved = layout[wf.key] ?? {}
    wf.doc.nodes.forEach((n) => {
      const position = saved[n.id]
      if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        n.x = position.x
        n.y = position.y
      }
    })
    applyDoc(wf)
  })
}

export function tidyDoc(s: PlaybooksState, wf: PlaybookWorkflow) {
  if (!wf.doc || wf.problems?.length) return
  const fresh = new Map(docFromPlaybook(s, noText, wf.pb).nodes.map((n) => [n.id, n]))
  wf.doc.nodes.forEach((n) => {
    const placed = fresh.get(layoutId(wf, n.id))
    if (placed) {
      n.x = placed.x
      n.y = placed.y
    }
  })
  saveLayout(wf)
}

export const hasProblems = (s: PlaybooksState) =>
  Object.values(s.workflows).some((wf) => wf.kind === 'playbook' && Boolean(wf.problems?.length))

function freshKey(s: PlaybooksState, base: string): string {
  let n = 1
  while (s.workflows[`playbook:${base}-${n}`]) n++
  return `${base}-${n}`
}

function insertWorkflow(s: PlaybooksState, wf: PlaybookWorkflow, afterId: string | null) {
  const entries = Object.entries(s.workflows)
  const index = afterId
    ? entries.findIndex(([id]) => id === afterId) + 1
    : entries.findIndex(([, w]) => w.kind === 'routing')
  entries.splice(index < 0 ? entries.length : index, 0, [wf.id, wf])
  s.workflows = Object.fromEntries(entries)
}

export function addPlaybook(s: PlaybooksState, name: string): PlaybookWorkflow {
  const key = freshKey(s, 'custom')
  const wf: PlaybookWorkflow = {
    id: `playbook:${key}`,
    kind: 'playbook',
    key,
    pb: blankPlaybook(name),
    positions: {},
    edited: true,
  }
  wf.doc = docFromPlaybook(s, noText, wf.pb)
  applyDoc(wf)
  insertWorkflow(s, wf, null)
  return wf
}

export function duplicatePlaybook(s: PlaybooksState, source: PlaybookWorkflow, name: string) {
  const key = freshKey(s, source.key)
  const pb = JSON.parse(JSON.stringify({ ...source.pb, name })) as PlaybookWorkflow['pb']
  const wf: PlaybookWorkflow = {
    id: `playbook:${key}`,
    kind: 'playbook',
    key,
    pb,
    positions: {},
    edited: true,
  }
  wf.doc = docFromPlaybook(s, noText, pb)
  source.doc?.nodes.forEach((n) => {
    const twin = wf.doc?.nodes.find((m) => m.id === layoutId(source, n.id))
    if (twin) {
      twin.x = n.x
      twin.y = n.y
    }
  })
  applyDoc(wf)
  insertWorkflow(s, wf, source.id)
  return wf
}

export function deletePlaybook(s: PlaybooksState, wf: PlaybookWorkflow) {
  const remaining = Object.entries(s.workflows).filter(([id]) => id !== wf.id)
  s.workflows = Object.fromEntries(remaining)
  if (Array.isArray(s.data.pickOrder))
    s.data.pickOrder = s.data.pickOrder.filter((pick) => !(isMap(pick) && pick.playbook === wf.key))
  s.wf = remaining[0]?.[0] ?? s.routingWf
  s.globalEdited = true
}

const PORT_OUT: Record<DocPort, number | undefined> = {
  out: undefined,
  yes: 1,
  no: 0,
  pass: 0,
  fail: 1,
}

export type DocView = FlowGraph & { edgeOn: (index: number) => boolean }

function viewNode(
  s: PlaybooksState,
  t: TFunction,
  wf: PlaybookWorkflow,
  n: DocNode,
  c: ReturnType<typeof context>,
): FlowNode {
  const { w, h } = nodeSize(n)
  const box = { id: n.id, x: n.x, y: n.y, w, h, cx: n.x + w / 2, cy: n.y + h / 2 }
  if (n.kind === 'phase' && n.phase) return phaseRoleNode(s, c, n.id, n.x, n.y, n.phase)
  if (n.kind === 'decision') {
    const text = condList(n.cond).length ? condText(s, t, n.cond) : t('playbooks.otherwise')
    const node: DecisionNode = {
      ...box,
      type: 'decision',
      text: asQuestion(t, text),
      labels: ['no', 'yes'],
      ref: { kind: 'route', ids: [] },
    }
    return node
  }
  if (n.kind === 'gate')
    return {
      ...box,
      type: 'decision',
      text: asQuestion(t, n.check?.trim() || t('playbooks.newCheck')),
      labels: ['yes', 'no'],
      ref: { kind: 'gate', id: n.id },
      gate: true,
    }
  if (n.kind === 'end') return { ...box, type: 'end', next: wf.pb.next ?? null }
  return { ...box, type: 'start' }
}

export function buildDocView(s: PlaybooksState, t: TFunction, wf: PlaybookWorkflow): DocView {
  const doc = wf.doc as FlowDoc
  const c = context(s)
  const nodes = doc.nodes.map((n) => viewNode(s, t, wf, n, c))
  addGhosts(s, nodes)
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]))
  const alias = (id: string) => wf.alias?.[id] ?? id
  let sim: Simulation
  let on: (index: number) => boolean
  if (wf.problems?.length) {
    sim = {
      reached: new Set(nodes.map((n) => n.id)),
      edgeOn: new Set(),
      openOf: {},
      bothLow: false,
      blocked: false,
      c,
      neutral: true,
    }
    on = () => false
  } else {
    const graph = buildGraph(s, t, wf)
    const reached = new Set(
      doc.nodes.filter((n) => graph.sim.reached.has(alias(n.id))).map((n) => n.id),
    )
    const openOf = Object.fromEntries(
      doc.nodes.map((n) => [n.id, graph.sim.openOf[alias(n.id)] ?? null]),
    )
    const lit = doc.edges.map((e: DocEdge) => {
      const index = graph.edges.findIndex(
        (g) => g.from === alias(e.from) && g.to === alias(e.to) && g.out === PORT_OUT[e.port],
      )
      return index >= 0 && graph.sim.edgeOn.has(index)
    })
    Object.entries(wf.skips ?? {}).forEach(([decisionId, phaseId]) => {
      const decision = doc.nodes.find((n) => n.id === decisionId)
      const phase = doc.nodes.find((n) => n.id === phaseId)?.phase
      if (!decision || !phase) return
      const passed = reached.has(decisionId)
      const value = evalCond(s, decision.cond, c, phaseSubject(s, phase))
      const open = c.all
        ? value === false
          ? [0]
          : value === true
            ? [1]
            : [0, 1]
        : value === true
          ? [1]
          : [0]
      openOf[decisionId] = new Set(open)
      if (!open.includes(1)) reached.delete(phaseId)
      doc.edges.forEach((e, i) => {
        if (e.from === decisionId) lit[i] = passed && open.includes(e.port === 'yes' ? 1 : 0)
        else if (e.from === phaseId) lit[i] = lit[i] && open.includes(1)
      })
    })
    sim = { ...graph.sim, reached, openOf }
    on = (index) => lit[index] ?? false
  }
  return { nodes, edges: [], byId, sim, edgeOn: on }
}
