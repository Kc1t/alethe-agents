import type { TFunction } from '../i18n'
import { CARD_H, CARD_W, DIA_H, DIA_W, playbookGraph } from './graph'
import {
  type Cond,
  condList,
  context,
  type Phase,
  type Playbook,
  type PlaybooksState,
} from './state'

export type DocNodeKind = 'start' | 'phase' | 'decision' | 'gate' | 'end'
export type DocPort = 'out' | 'yes' | 'no' | 'pass' | 'fail'

export type DocNode = {
  id: string
  kind: DocNodeKind
  x: number
  y: number
  phase?: Phase
  cond?: Cond
  check?: string
}

export type DocEdge = { from: string; port: DocPort; to: string }

export type FlowDoc = { nodes: DocNode[]; edges: DocEdge[] }

export type DocProblemCode =
  | 'startUnconnected'
  | 'decisionNeedsYes'
  | 'decisionNeedsNo'
  | 'decisionNeedsCondition'
  | 'yesNeedsStep'
  | 'noNeedsStep'
  | 'stepNeedsNext'
  | 'stepsMustMeet'
  | 'mixedStep'
  | 'gateNeedsCheck'
  | 'gateNeedsPass'
  | 'failNeedsStep'
  | 'escalationOneNext'
  | 'escalationCheckEnds'
  | 'escalationReturn'
  | 'loop'
  | 'unreachable'
  | 'duplicateId'
  | 'skipMustMeet'

export type DocProblem = { node: string; code: DocProblemCode }

export type Compiled = {
  phases: Phase[]
  problems: DocProblem[]
  alias: Record<string, string>
  skips: Record<string, string>
}

export const SIZES: Record<DocNodeKind, { w: number; h: number }> = {
  start: { w: 96, h: 30 },
  phase: { w: CARD_W, h: CARD_H },
  decision: { w: DIA_W, h: DIA_H },
  gate: { w: DIA_W, h: DIA_H },
  end: { w: 124, h: 40 },
}

export const OUT_PORTS: Record<DocNodeKind, DocPort[]> = {
  start: ['out'],
  phase: ['out'],
  decision: ['yes', 'no'],
  gate: ['pass', 'fail'],
  end: [],
}

const SINGLE_PORTS = new Set<DocPort>(['yes', 'no', 'fail'])
const STRUCTURAL = ['with', 'after', 'then', 'if', 'gate'] as const

export const nodeSize = (node: Pick<DocNode, 'kind'>) => SIZES[node.kind]

export function portPoint(node: DocNode, port: DocPort | 'in'): [number, number] {
  const { w, h } = nodeSize(node)
  if (port === 'in') return [node.x + w / 2, node.y]
  if (port === 'yes' || port === 'fail') return [node.x + w, node.y + h / 2]
  return [node.x + w / 2, node.y + h]
}

export function docFromPlaybook(s: PlaybooksState, t: TFunction, pb: Playbook): FlowDoc {
  const graph = playbookGraph(s, t, { pb }, context(s))
  const phases = new Map(pb.phases.map((p) => [p.id, p]))
  const nodes: DocNode[] = []
  graph.nodes.forEach((n) => {
    if (n.type === 'start') {
      const { w, h } = SIZES.start
      nodes.push({ id: 'start', kind: 'start', x: -w / 2, y: -h - 26 })
    } else if (n.type === 'end') nodes.push({ id: 'end', kind: 'end', x: n.x, y: n.y })
    else if (n.type === 'role' && n.ref.kind === 'phase') {
      const id = n.ref.id
      nodes.push({ id: n.id, kind: 'phase', x: n.x, y: n.y, phase: phases.get(id) })
    } else if (n.type === 'decision' && n.gate && n.ref.kind === 'gate') {
      const id = n.ref.id
      nodes.push({ id: n.id, kind: 'gate', x: n.x, y: n.y, check: phases.get(id)?.gate ?? '' })
    } else if (n.type === 'decision') {
      const branch = phases.get(n.id.slice(4))
      nodes.push({ id: n.id, kind: 'decision', x: n.x, y: n.y, cond: branch?.if })
    }
  })
  const kinds = new Map(nodes.map((n) => [n.id, n.kind]))
  const edges: DocEdge[] = []
  graph.edges.forEach((e) => {
    const kind = kinds.get(e.from)
    if (!kind || !kinds.has(e.to)) return
    const port: DocPort =
      kind === 'decision'
        ? e.out === 1
          ? 'yes'
          : 'no'
        : kind === 'gate'
          ? e.out === 1
            ? 'fail'
            : 'pass'
          : 'out'
    if (!edges.some((x) => x.from === e.from && x.port === port && x.to === e.to))
      edges.push({ from: e.from, port, to: e.to })
  })
  pb.phases.forEach((p) => {
    if (p.if === undefined || p.after || nodes.some((n) => n.id === `dec:${p.id}`)) return
    const shared = pb.phases.some(
      (q) =>
        q !== p &&
        !q.after &&
        (q.with === p.id || (p.with !== undefined && (q.id === p.with || q.with === p.with))),
    )
    const id = `phase:${p.id}`
    const card = nodes.find((n) => n.id === id)
    const exits = edges.filter((e) => e.from === id)
    if (shared || !card || exits.length !== 1) return
    nodes.push({
      id: `dec:${p.id}`,
      kind: 'decision',
      x: card.x + (CARD_W - DIA_W) / 2,
      y: card.y + (CARD_H - DIA_H) / 2,
      cond: p.if,
    })
    card.x += DIA_W / 2 + 64 + CARD_W / 2
    edges.forEach((e) => {
      if (e.to === id) e.to = `dec:${p.id}`
    })
    edges.push(
      { from: `dec:${p.id}`, port: 'yes', to: id },
      { from: `dec:${p.id}`, port: 'no', to: exits[0].to },
    )
  })
  return { nodes, edges }
}

const strip = (phase: Phase): Phase => {
  const copy = { ...phase }
  STRUCTURAL.forEach((key) => delete copy[key])
  return copy
}

export function compileDoc(doc: FlowDoc): Compiled {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const outs = (id: string, port?: DocPort) =>
    doc.edges.filter((e) => e.from === id && (!port || e.port === port)).map((e) => e.to)
  const problems: DocProblem[] = []
  const alias: Record<string, string> = {}
  const skips: Record<string, string> = {}
  const visited = new Set<string>()
  const phases: Phase[] = []
  const problem = (node: string, code: DocProblemCode) => {
    if (!problems.some((p) => p.node === node && p.code === code)) problems.push({ node, code })
  }
  const start = doc.nodes.find((n) => n.kind === 'start')
  const end = doc.nodes.find((n) => n.kind === 'end')
  if (!start || !end)
    return { phases, problems: [{ node: 'start', code: 'startUnconnected' }], alias, skips }
  visited.add(start.id)
  const isPhase = (id: string | undefined) => Boolean(id && byId.get(id)?.kind === 'phase')
  const emit = (node: DocNode, fields: Partial<Phase>): Phase => {
    const phase = { ...strip(node.phase as Phase), ...fields } as Phase
    ;(Object.keys(fields) as Array<keyof Phase>).forEach((key) => {
      if (phase[key] === undefined) delete phase[key]
    })
    phases.push(phase)
    visited.add(node.id)
    alias[node.id] = `phase:${phase.id}`
    return phase
  }
  const keptThen = (node: DocNode) =>
    node.phase?.then && node.phase.then !== 'done' ? node.phase.then : undefined

  let entry = outs(start.id)
  if (!entry.length) problem(start.id, 'startUnconnected')
  let guard = 0
  while (entry.length && guard++ < 500) {
    if (entry.length === 1 && entry[0] === end.id) {
      visited.add(end.id)
      break
    }
    const seen = entry.find((id) => visited.has(id))
    if (seen) {
      problem(seen, 'loop')
      break
    }
    type Item = {
      node: DocNode
      role: 'branch' | 'spine' | 'parallel'
      cond?: Cond
      decision?: string
      skipTo?: string
    }
    const step: Item[] = []
    let broken = false
    const head = byId.get(entry[0])
    if (entry.length === 1 && head?.kind === 'decision') {
      let d: DocNode | undefined = head
      while (d && d.kind === 'decision') {
        visited.add(d.id)
        if (!condList(d.cond).length) problem(d.id, 'decisionNeedsCondition')
        const yes = outs(d.id, 'yes')[0]
        const no = outs(d.id, 'no')[0]
        if (!yes) {
          problem(d.id, 'decisionNeedsYes')
          broken = true
        } else if (!isPhase(yes)) {
          problem(d.id, 'yesNeedsStep')
          broken = true
        } else if (visited.has(yes)) {
          problem(yes, 'loop')
          broken = true
        } else
          step.push({
            node: byId.get(yes) as DocNode,
            role: 'branch',
            cond: d.cond,
            decision: d.id,
          })
        if (!no) {
          problem(d.id, 'decisionNeedsNo')
          broken = true
          break
        }
        if (visited.has(no)) {
          problem(no, 'loop')
          broken = true
          break
        }
        const next = byId.get(no) as DocNode
        if (next.kind === 'decision') {
          d = next
          continue
        }
        if (next.kind !== 'phase') {
          const last = step[step.length - 1]
          if (last?.role === 'branch' && last.decision === d.id) {
            last.role = 'spine'
            last.skipTo = no
            break
          }
          problem(d.id, 'noNeedsStep')
          broken = true
          break
        }
        step.push({ node: next, role: 'spine' })
        d = undefined
      }
    } else {
      entry.forEach((id) => {
        const node = byId.get(id) as DocNode
        if (node.kind !== 'phase') {
          problem(id, 'mixedStep')
          broken = true
        } else step.push({ node, role: 'parallel' })
      })
    }
    if (broken || !step.length) break

    const first = step[0].node.phase as Phase
    const emitted = step.map((item, i) => {
      const fields: Partial<Phase> = { with: i ? first.id : undefined }
      if (item.role === 'branch') fields.if = item.cond
      else if (item.role === 'spine') fields.if = item.skipTo ? item.cond : item.node.phase?.if
      else fields.if = undefined
      const phase = emit(item.node, fields)
      if (item.decision && item.skipTo) {
        alias[item.decision] = `phase:${phase.id}`
        skips[item.decision] = item.node.id
      } else if (item.decision) alias[item.decision] = `dec:${phase.id}`
      return { item, phase }
    })

    const exits = emitted.map(({ item, phase }) => ({
      item,
      phase,
      targets: outs(item.node.id, 'out'),
    }))
    exits.forEach(({ item, targets }) => {
      if (!targets.length) {
        problem(item.node.id, 'stepNeedsNext')
        broken = true
      } else if (targets.length > 1 && targets.includes(end.id)) {
        problem(item.node.id, 'stepsMustMeet')
        broken = true
      }
    })
    const ending = (targets: string[]) => targets.length === 1 && targets[0] === end.id
    const continuing = exits.filter(({ targets }) => targets.length && !ending(targets))
    let next: string[] | null = null
    exits.forEach(({ item, phase, targets }) => {
      if (!ending(targets)) return
      if (continuing.length || item.node.phase?.then === 'done') phase.then = 'done'
    })
    continuing.forEach(({ item, phase, targets }) => {
      const then = keptThen(item.node)
      if (then) phase.then = then
      if (next === null) next = targets
      else if ([...next].sort().join('|') !== [...targets].sort().join('|')) {
        problem(item.node.id, 'stepsMustMeet')
        broken = true
      }
    })
    const skip = emitted.find(({ item }) => item.skipTo)?.item
    if (skip?.decision) {
      const expected: string[] = continuing.length ? (next ?? []) : [end.id]
      const own = outs(skip.node.id, 'out')
      if (
        expected.length !== 1 ||
        expected[0] !== skip.skipTo ||
        own.length !== 1 ||
        own[0] !== skip.skipTo
      ) {
        problem(skip.decision, 'skipMustMeet')
        broken = true
      }
    }
    if (broken) break
    if (!next) {
      visited.add(end.id)
      break
    }
    const targets: string[] = next
    const gate = targets.length === 1 ? byId.get(targets[0]) : undefined
    if (gate?.kind !== 'gate') {
      entry = targets
      continue
    }
    if (visited.has(gate.id)) {
      problem(gate.id, 'loop')
      break
    }
    visited.add(gate.id)
    const gated = continuing[0].phase
    if (!gate.check?.trim()) problem(gate.id, 'gateNeedsCheck')
    gated.gate = gate.check ?? ''
    alias[gate.id] = `gate:${gated.id}`

    let after = gated.id
    let q = outs(gate.id, 'fail')[0]
    while (q) {
      const qn = byId.get(q)
      if (!qn || qn.kind !== 'phase') {
        problem(gate.id, 'failNeedsStep')
        break
      }
      if (visited.has(q)) {
        problem(q, 'loop')
        break
      }
      const phase = emit(qn, { after, if: qn.phase?.if })
      const qOut = outs(q, 'out')
      if (qOut.length !== 1) {
        problem(q, qOut.length ? 'escalationOneNext' : 'stepNeedsNext')
        break
      }
      const nx = qOut[0]
      if (nx === end.id) {
        phase.then = 'done'
        visited.add(end.id)
        break
      }
      if (nx === gate.id) {
        const then = keptThen(qn)
        if (then) phase.then = then
        break
      }
      const nxNode = byId.get(nx) as DocNode
      if (nxNode.kind === 'gate' && !visited.has(nx)) {
        visited.add(nx)
        if (!nxNode.check?.trim()) problem(nx, 'gateNeedsCheck')
        phase.gate = nxNode.check ?? ''
        alias[nx] = `gate:${phase.id}`
        const pass = outs(nx, 'pass')
        if (pass.length !== 1 || pass[0] !== end.id) problem(nx, 'escalationCheckEnds')
        else visited.add(end.id)
        after = phase.id
        q = outs(nx, 'fail')[0]
        continue
      }
      if (nxNode.kind === 'phase') {
        after = phase.id
        q = nx
        continue
      }
      problem(q, 'escalationReturn')
      break
    }
    entry = outs(gate.id, 'pass')
    if (!entry.length) {
      problem(gate.id, 'gateNeedsPass')
      break
    }
  }

  doc.nodes.forEach((n) => {
    if (!visited.has(n.id) && n.kind !== 'end' && !problems.some((p) => p.node === n.id))
      problem(n.id, 'unreachable')
  })
  const ids = new Map<string, number>()
  phases.forEach((p) => ids.set(p.id, (ids.get(p.id) ?? 0) + 1))
  doc.nodes.forEach((n) => {
    if (n.phase && (ids.get(n.phase.id) ?? 0) > 1) problem(n.id, 'duplicateId')
  })
  return { phases, problems, alias, skips }
}

export function connect(doc: FlowDoc, from: string, port: DocPort, to: string): boolean {
  const source = doc.nodes.find((n) => n.id === from)
  const target = doc.nodes.find((n) => n.id === to)
  if (!source || !target || from === to || target.kind === 'start') return false
  if (!OUT_PORTS[source.kind].includes(port)) return false
  if (doc.edges.some((e) => e.from === from && e.port === port && e.to === to)) return false
  if (SINGLE_PORTS.has(port))
    doc.edges = doc.edges.filter((e) => !(e.from === from && e.port === port))
  doc.edges.push({ from, port, to })
  return true
}

export function removeNode(doc: FlowDoc, id: string) {
  doc.nodes = doc.nodes.filter((n) => n.id !== id)
  doc.edges = doc.edges.filter((e) => e.from !== id && e.to !== id)
}

export function removeEdge(doc: FlowDoc, edge: DocEdge) {
  doc.edges = doc.edges.filter(
    (e) => !(e.from === edge.from && e.port === edge.port && e.to === edge.to),
  )
}

export function freshPhaseId(doc: FlowDoc, base = 'step'): string {
  const taken = new Set(doc.nodes.map((n) => n.phase?.id).filter(Boolean))
  let n = 1
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

export function freshNodeId(doc: FlowDoc, prefix: 'dec' | 'gate'): string {
  const taken = new Set(doc.nodes.map((n) => n.id))
  let n = 1
  while (taken.has(`${prefix}:new-${n}`)) n++
  return `${prefix}:new-${n}`
}

export function nodeAt(doc: FlowDoc, x: number, y: number, skip?: string): DocNode | null {
  for (let i = doc.nodes.length - 1; i >= 0; i--) {
    const node = doc.nodes[i]
    const { w, h } = nodeSize(node)
    if (node.id !== skip && x >= node.x && x <= node.x + w && y >= node.y && y <= node.y + h)
      return node
  }
  return null
}

export function blankPlaybook(name: string): Playbook {
  return {
    name,
    phases: [{ id: 'plan', role: 'planner', who: 'lead', tier: 'strong', then: 'done' }],
  }
}
