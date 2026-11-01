import type { TFunction } from '../i18n'
import { asQuestion, condText, gateName, taskRuleName } from './labels'
import {
  activeOrder,
  type Alt,
  condList,
  type Context,
  context,
  type CostSubject,
  evalCond,
  isProblemCond,
  isSpareCond,
  type Phase,
  phaseAlts,
  phaseSubject,
  phaseTitle,
  type PlaybooksState,
  type PlaybookWorkflow,
  quotaNow,
  type Resolution,
  resolvePhase,
  resolveRoutingRole,
  type RoutingWorkflow,
  usageOf,
  type Workflow,
} from './state'

export const CARD_W = 214
export const CARD_H = 54
export const DIA_W = 156
export const DIA_H = 88
const V_GAP = 44
const SIDE_GAP = 64
const GHOST_W = 200
const GHOST_H = 40
const GHOST_GAP = 34

export type Side = 'top' | 'bottom' | 'left' | 'right'
type Box = { id: string; x: number; y: number; w: number; h: number; cx: number; cy: number }

export type NodeRef =
  | { kind: 'phase'; id: string }
  | { kind: 'role'; name: string }
  | { kind: 'route'; ids: string[] }
  | { kind: 'gate'; id: string }
  | { kind: 'routing-rules' }

export type RoleNode = Box & {
  type: 'role'
  title: string
  lead: boolean
  readOnly: boolean
  workers: number
  isolate: boolean
  runner: string | null
  tier: string | null
  resolved: Resolution
  alts: Alt[]
  ref: NodeRef
  chain?: boolean
}

export type DecisionLabel = 'yes' | 'no'

export type DecisionNode = Box & {
  type: 'decision'
  text: string
  labels: [DecisionLabel, DecisionLabel]
  ref: NodeRef
  evaluate?: (c: Context) => Set<number>
  gate?: boolean
  chain?: boolean
}

export type StartNode = Box & { type: 'start' }
export type EntryNode = Box & { type: 'entry' }
export type EndNode = Box & { type: 'end'; next: string | null }
export type GhostNode = Box & { type: 'ghost'; parent: string; side: 'left' | 'right'; alt: Alt }

export type FlowNode = RoleNode | DecisionNode | StartNode | EntryNode | EndNode | GhostNode

export type FlowEdge = {
  from: string
  out?: number
  fromSide: Side
  to: string
  toSide: Side
  label?: DecisionLabel | 'recheck'
  kind?: 'fail' | 'recheck'
  cond?: string[] | null
  subject?: CostSubject
  lane?: boolean
  climb?: boolean
}

export type Simulation = {
  reached: Set<string>
  edgeOn: Set<number>
  openOf: Record<string, Set<number> | null>
  bothLow: boolean
  blocked: boolean
  c: Context
  neutral?: boolean
}

export type FlowGraph = {
  nodes: FlowNode[]
  edges: FlowEdge[]
  byId: Record<string, FlowNode>
  sim: Simulation
}

type Exit = {
  id: string
  out?: number
  side: Side
  label?: DecisionLabel
  lane?: boolean
  kind?: 'fail'
  drop?: boolean
}

const box = (id: string, cx: number, cy: number, w: number, h: number): Box => ({
  id,
  x: cx - w / 2,
  y: cy - h / 2,
  w,
  h,
  cx,
  cy,
})

const start = (): StartNode => ({ ...box('start', 0, 0, 0, 0), type: 'start' })

function branchEval(s: PlaybooksState, cond: string[], subject: CostSubject) {
  return (c: Context) => {
    const value = evalCond(s, cond, c, subject)
    if (c.all) return new Set(value === false ? [0] : value === true ? [1] : [0, 1])
    return new Set(value === true ? [1] : [0])
  }
}

export function phaseRoleNode(
  s: PlaybooksState,
  c: Context,
  id: string,
  x: number,
  y: number,
  p: Phase,
): RoleNode {
  return {
    ...box(id, x + CARD_W / 2, y + CARD_H / 2, CARD_W, CARD_H),
    type: 'role',
    title: phaseTitle(p),
    lead: p.who === 'lead',
    readOnly: Boolean(p.readOnly),
    workers: p.workers ?? 1,
    isolate: Boolean(p.isolate),
    runner: p.runner ?? null,
    tier: p.tier ?? 'standard',
    resolved: resolvePhase(s, p, c),
    alts: phaseAlts(s, p),
    ref: { kind: 'phase', id: p.id },
  }
}

export function playbookGraph(
  s: PlaybooksState,
  t: TFunction,
  wf: Pick<PlaybookWorkflow, 'pb'>,
  c: Context,
) {
  const phases = wf.pb.phases ?? []
  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []
  const steps: Phase[][] = []
  phases
    .filter((p) => !p.after)
    .forEach((p) => {
      const host = p.with ? steps.find((step) => step.some((q) => q.id === p.with)) : undefined
      if (host) host.push(p)
      else steps.push([p])
    })
  const chainOf = (id: string) => {
    const out: Phase[] = []
    const seen = new Set([id])
    let current = phases.find((q) => q.after === id)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      out.push(current)
      const from = current.id
      current = phases.find((q) => q.after === from)
    }
    return out
  }
  const card = (id: string, cx: number, cy: number, p: Phase): RoleNode => ({
    ...box(id, cx, cy, CARD_W, CARD_H),
    type: 'role',
    title: phaseTitle(p),
    lead: p.who === 'lead',
    readOnly: Boolean(p.readOnly),
    workers: p.workers ?? 1,
    isolate: Boolean(p.isolate),
    runner: p.runner ?? null,
    tier: p.tier ?? 'standard',
    resolved: resolvePhase(s, p, c),
    alts: phaseAlts(s, p),
    ref: { kind: 'phase', id: p.id },
  })
  const diamond = (
    id: string,
    cx: number,
    cy: number,
    text: string,
    extra: Omit<DecisionNode, keyof Box | 'type' | 'text'>,
  ): DecisionNode => ({ ...box(id, cx, cy, DIA_W, DIA_H), type: 'decision', text, ...extra })
  const connect = (froms: Exit[], to: string, toSide: Side = 'top') =>
    froms.forEach((src) =>
      edges.push({
        from: src.id,
        out: src.out,
        fromSide: src.side,
        to,
        toSide,
        label: src.label,
      }),
    )
  const sideX = DIA_W / 2 + SIDE_GAP + CARD_W / 2
  nodes.push(start())
  let y = 0
  let prev: Exit[] = [{ id: 'start', side: 'bottom' }]
  const toEnd: Exit[] = []
  steps.forEach((step) => {
    const routed = step.some((p) => p.if !== undefined)
    const pending: Exit[] = []
    if (routed) {
      step.slice(0, -1).forEach((branch) => {
        const did = `dec:${branch.id}`
        const cy = y + DIA_H / 2
        const question =
          branch.if !== undefined ? condText(s, t, branch.if) : t('playbooks.otherwise')
        nodes.push(
          diamond(did, 0, cy, asQuestion(t, question), {
            ref: { kind: 'route', ids: step.map((p) => p.id) },
            labels: ['no', 'yes'],
            evaluate: branchEval(s, condList(branch.if), phaseSubject(s, branch)),
          }),
        )
        connect(prev, did)
        const rid = `phase:${branch.id}`
        nodes.push(card(rid, sideX, cy, branch))
        edges.push({ from: did, out: 1, fromSide: 'right', to: rid, toSide: 'left', label: 'yes' })
        if (branch.then === 'done') toEnd.push({ id: rid, side: 'right', lane: true })
        else pending.push({ id: rid, side: 'bottom' })
        prev = [{ id: did, out: 0, side: 'bottom', label: 'no' }]
        y = cy + DIA_H / 2 + V_GAP
      })
      const spine = step[step.length - 1]
      const sid = `phase:${spine.id}`
      const cy = y + CARD_H / 2
      nodes.push(card(sid, 0, cy, spine))
      connect(prev, sid)
      y = cy + CARD_H / 2 + V_GAP
      prev = spine.then === 'done' ? [] : [{ id: sid, side: 'bottom' }]
      if (spine.then === 'done') toEnd.push({ id: sid, side: 'bottom' })
      prev = prev.concat(pending)
    } else {
      const cy = y + CARD_H / 2
      const next: Exit[] = []
      step.forEach((p, k) => {
        const id = `phase:${p.id}`
        nodes.push(card(id, k * (CARD_W + 36), cy, p))
        connect(prev, id)
        if (p.then === 'done') toEnd.push({ id, side: k ? 'right' : 'bottom', lane: k > 0 })
        else next.push({ id, side: 'bottom' })
      })
      prev = next
      y = cy + CARD_H / 2 + V_GAP
    }
    const gated = step.find((p) => p.gate)
    if (gated && prev.length) {
      const gid = `gate:${gated.id}`
      const cy = y + DIA_H / 2
      nodes.push(
        diamond(gid, 0, cy, asQuestion(t, String(gated.gate)), {
          ref: { kind: 'gate', id: gated.id },
          labels: ['yes', 'no'],
          gate: true,
        }),
      )
      connect(prev, gid)
      const chain = chainOf(gated.id)
      let left = DIA_W / 2 + SIDE_GAP
      let from: Exit = { id: gid, out: 1, side: 'right', label: 'no' }
      chain.forEach((q) => {
        const qid = `phase:${q.id}`
        nodes.push({ ...card(qid, left + CARD_W / 2, cy, q), chain: true })
        edges.push({
          from: from.id,
          out: from.out,
          fromSide: from.side,
          to: qid,
          toSide: 'left',
          label: from.label,
          kind: 'fail',
          cond: q.if !== undefined ? condList(q.if) : null,
          subject: phaseSubject(s, q),
        })
        left += CARD_W + SIDE_GAP
        if (q.gate) {
          const qg = `gate:${q.id}`
          nodes.push(
            diamond(qg, left + DIA_W / 2, cy, asQuestion(t, String(q.gate)), {
              ref: { kind: 'gate', id: q.id },
              labels: ['yes', 'no'],
              gate: true,
              chain: true,
            }),
          )
          edges.push({ from: qid, fromSide: 'right', to: qg, toSide: 'left', kind: 'fail' })
          toEnd.push({ id: qg, out: 0, side: 'bottom', label: 'yes', kind: 'fail', drop: true })
          from = { id: qg, out: 1, side: 'right', label: 'no' }
          left += DIA_W + SIDE_GAP
        } else from = { id: qid, side: 'right' }
      })
      if (chain.length) {
        const last = chain[chain.length - 1]
        if (last.then === 'done')
          toEnd.push({ id: `phase:${last.id}`, side: 'right', lane: true, kind: 'fail' })
        else
          edges.push({
            from: `phase:${last.id}`,
            fromSide: 'top',
            to: gid,
            toSide: 'top',
            kind: 'recheck',
            label: 'recheck',
          })
      }
      prev = [{ id: gid, out: 0, side: 'bottom', label: 'yes' }]
      y = cy + DIA_H / 2 + V_GAP
    }
  })
  nodes.push({ ...box('end', 0, y + 20, 124, 40), type: 'end', next: wf.pb.next ?? null })
  connect(prev, 'end')
  toEnd.forEach((exit) =>
    edges.push({
      from: exit.id,
      out: exit.out,
      fromSide: exit.side,
      to: 'end',
      toSide: exit.lane || exit.drop ? 'right' : 'top',
      label: exit.label,
      kind: exit.kind,
      lane: exit.lane,
    }),
  )
  return { nodes, edges }
}

function routingGraph(s: PlaybooksState, t: TFunction, wf: RoutingWorkflow, c: Context) {
  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []
  const byName = Object.fromEntries(wf.roles.map((r) => [r.name, r]))
  const sideX = DIA_W / 2 + SIDE_GAP + CARD_W / 2
  const roleCard = (id: string, cx: number, cy: number, name: string): RoleNode => {
    const role = byName[name]
    const { resolved, alts } = resolveRoutingRole(wf, role, c)
    return {
      ...box(id, cx, cy, CARD_W, CARD_H),
      type: 'role',
      title: name,
      lead: false,
      readOnly: role.readOnly,
      workers: 1,
      isolate: false,
      runner: null,
      tier: null,
      resolved,
      alts,
      ref: { kind: 'role', name },
    }
  }
  nodes.push(start())
  nodes.push({ ...box('entry', 0, CARD_H / 2, CARD_W, CARD_H), type: 'entry' })
  let y = CARD_H + V_GAP
  edges.push({ from: 'start', fromSide: 'bottom', to: 'entry', toSide: 'top' })
  let prev: Exit[] = [{ id: 'entry', side: 'bottom' }]
  const placed: Record<string, 'spine' | 'side'> = {}
  const exits: string[] = []
  wf.rules.forEach((rule, i) => {
    if (!byName[rule.role]) return
    const isElse =
      i === wf.rules.length - 1 && !rule.kinds.length && !rule.efforts.length && !rule.gates.length
    const cardId = `role:${rule.role}`
    if (isElse) {
      if (!placed[rule.role]) {
        const cy = y + CARD_H / 2
        nodes.push(roleCard(cardId, 0, cy, rule.role))
        placed[rule.role] = 'spine'
        y = cy + CARD_H / 2 + V_GAP
      }
      prev.forEach((src) =>
        edges.push({
          from: src.id,
          out: src.out,
          fromSide: src.side,
          to: cardId,
          toSide: placed[rule.role] === 'spine' ? 'top' : 'bottom',
          label: src.label,
        }),
      )
      prev = placed[rule.role] === 'spine' ? [{ id: cardId, side: 'bottom' }] : []
      return
    }
    const did = `dec:${i}`
    const cy = y + DIA_H / 2
    const name = taskRuleName(t, rule)
    const question = rule.gates.length
      ? t('playbooks.ruleWhile', { rule: name, gate: gateName(s, t, rule.gates[0]) })
      : name
    nodes.push({
      ...box(did, 0, cy, DIA_W, DIA_H),
      type: 'decision',
      text: asQuestion(t, question),
      ref: { kind: 'routing-rules' },
      labels: ['no', 'yes'],
      evaluate: (ctx) => {
        const closed = rule.gates.some((g) => usageOf(s, g.agent, g.window) >= g.below)
        if (closed) return new Set([0])
        if (ctx.all) return new Set([0, 1])
        const matches =
          (!rule.kinds.length || rule.kinds.includes(ctx.task.kind ?? '')) &&
          (!rule.efforts.length || rule.efforts.includes(ctx.task.effort ?? ''))
        return new Set(matches ? [1] : [0])
      },
    })
    prev.forEach((src) =>
      edges.push({
        from: src.id,
        out: src.out,
        fromSide: src.side,
        to: did,
        toSide: 'top',
        label: src.label,
      }),
    )
    if (!placed[rule.role]) {
      nodes.push(roleCard(cardId, sideX, cy, rule.role))
      placed[rule.role] = 'side'
      exits.push(cardId)
      edges.push({ from: did, out: 1, fromSide: 'right', to: cardId, toSide: 'left', label: 'yes' })
    } else {
      edges.push({
        from: did,
        out: 1,
        fromSide: 'right',
        to: cardId,
        toSide: 'bottom',
        label: 'yes',
        climb: true,
      })
    }
    prev = [{ id: did, out: 0, side: 'bottom', label: 'no' }]
    y = cy + DIA_H / 2 + V_GAP
  })
  nodes.push({ ...box('end', 0, y + 20, 124, 40), type: 'end', next: null })
  prev.forEach((src) =>
    edges.push({
      from: src.id,
      out: src.out,
      fromSide: src.side,
      to: 'end',
      toSide: 'top',
      label: src.label,
    }),
  )
  exits.forEach((id) =>
    edges.push({ from: id, fromSide: 'right', to: 'end', toSide: 'right', lane: true }),
  )
  return { nodes, edges }
}

export function addGhosts(s: PlaybooksState, nodes: FlowNode[]) {
  const ghosts: GhostNode[] = []
  nodes.forEach((n) => {
    if (n.type !== 'role' || n.lead) return
    const spent = n.resolved.spent
    const alts = n.alts.filter((alt) =>
      alt.implicit ? !spent : alt.key === 'fallback' || isProblemCond(s, alt.cond),
    )
    if (spent)
      alts.push({ key: 'spare', spare: true, cond: [`${spent}-spare`], use: n.resolved.final })
    if (!alts.length) return
    const side = n.cx > 1 ? 'right' : 'left'
    const total = alts.length * GHOST_H + (alts.length - 1) * 8
    alts.forEach((alt, i) => {
      const x = side === 'left' ? n.x - GHOST_GAP - GHOST_W : n.x + n.w + GHOST_GAP
      const y = n.cy - total / 2 + i * (GHOST_H + 8)
      ghosts.push({
        id: `${n.id}~fallback${i}`,
        type: 'ghost',
        parent: n.id,
        side,
        alt,
        x,
        y,
        w: GHOST_W,
        h: GHOST_H,
        cx: x + GHOST_W / 2,
        cy: y + GHOST_H / 2,
      })
    })
  })
  nodes.push(...ghosts)
}

function simulate(
  s: PlaybooksState,
  edges: FlowEdge[],
  byId: Record<string, FlowNode>,
  c: Context,
): Simulation {
  const outgoing: Record<string, number[]> = {}
  edges.forEach((e, i) => (outgoing[e.from] ??= []).push(i))
  const reached = new Set(['start'])
  const edgeOn = new Set<number>()
  const queue = ['start']
  const openOf: Record<string, Set<number> | null> = {}
  while (queue.length) {
    const id = queue.shift() as string
    const n = byId[id]
    let open: Set<number> | null = null
    if (n?.type === 'decision')
      open = n.gate
        ? new Set((n.chain ? c.failedTwice : c.failed) ? [0, 1] : [0])
        : (n.evaluate?.(c) ?? new Set([0, 1]))
    openOf[id] = open
    for (const i of outgoing[id] ?? []) {
      const e = edges[i]
      if (open && e.out !== undefined && !open.has(e.out)) continue
      if (e.kind === 'recheck' && !c.failed) continue
      if (e.kind === 'fail' && e.cond && evalCond(s, e.cond, c, e.subject) === false) continue
      edgeOn.add(i)
      if (!reached.has(e.to)) {
        reached.add(e.to)
        queue.push(e.to)
      }
    }
  }
  const bothLow = activeOrder(s).every((p) => c.low.includes(p))
  return {
    reached,
    edgeOn,
    openOf,
    bothLow,
    blocked: bothLow && quotaNow(s).onBothCritical === 'block',
    c,
  }
}

export function buildGraph(s: PlaybooksState, t: TFunction, wf: Workflow): FlowGraph {
  const c = context(s)
  const { nodes, edges } =
    wf.kind === 'playbook' ? playbookGraph(s, t, wf, c) : routingGraph(s, t, wf, c)
  nodes.forEach((n) => {
    const p = wf.positions[n.id]
    if (!p) return
    n.x = p.x
    n.y = p.y
    n.cx = p.x + n.w / 2
    n.cy = p.y + n.h / 2
  })
  addGhosts(s, nodes)
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]))
  return { nodes, edges, byId, sim: simulate(s, edges, byId, c) }
}

export type RoleStatus = 'idle' | 'ok' | 'blocked' | 'warn' | 'spare'

export function roleStatus(n: RoleNode, sim: Simulation): RoleStatus {
  if (!sim.reached.has(n.id)) return 'idle'
  if (n.lead) return 'ok'
  if (sim.blocked) return 'blocked'
  if (n.resolved.stuck) return 'warn'
  if (n.resolved.spent || (n.resolved.chosen && isSpareCond(n.resolved.chosen.cond))) return 'spare'
  return n.resolved.switched ? 'warn' : 'ok'
}

export function ghostActive(n: GhostNode, parent: RoleNode, sim: Simulation): boolean {
  const r = parent.resolved
  if (!sim.reached.has(parent.id)) return false
  if (n.alt.spare) return Boolean(r.spent)
  if (n.alt.implicit || n.alt.key === 'fallback') return r.switched && !r.spent
  return Boolean(r.chosen && r.chosen.i === n.alt.ruleIndex)
}

export type Point2 = [number, number]

export function port(n: Box, side: Side): Point2 {
  if (side === 'top') return [n.cx, n.y]
  if (side === 'bottom') return [n.cx, n.y + n.h]
  if (side === 'left') return [n.x, n.cy]
  return [n.x + n.w, n.cy]
}

const f = (n: number) => Math.round(n * 10) / 10

export function rounded(points: Point2[], radius = 26): string {
  let d = `M${f(points[0][0])} ${f(points[0][1])}`
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1]
    const [x, y] = points[i]
    const [nx, ny] = points[i + 1]
    const inLen = Math.hypot(x - px, y - py)
    const outLen = Math.hypot(nx - x, ny - y)
    const r = Math.min(radius, inLen / 2, outLen / 2)
    const ax = x - ((x - px) / (inLen || 1)) * r
    const ay = y - ((y - py) / (inLen || 1)) * r
    const bx = x + ((nx - x) / (outLen || 1)) * r
    const by = y + ((ny - y) / (outLen || 1)) * r
    d += ` L${f(ax)} ${f(ay)} Q${f(x)} ${f(y)} ${f(bx)} ${f(by)}`
  }
  const [lx, ly] = points[points.length - 1]
  return `${d} L${f(lx)} ${f(ly)}`
}

export function route(e: FlowEdge, graph: FlowGraph, laneX: number): Point2[] {
  const a = graph.byId[e.from]
  const b = graph.byId[e.to]
  const p1 = port(a, e.fromSide)
  const p2 = port(b, e.toSide)
  if (e.lane) {
    const [bx, by] = port(a, 'bottom')
    const below = by + 26
    return [[bx, by], [bx, below], [laneX, below], [laneX, p2[1]], p2]
  }
  if (e.fromSide === 'bottom' && e.toSide === 'right') return [p1, [p1[0], p2[1]], p2]
  if (e.fromSide === 'right' && e.toSide === 'bottom') return [p1, [p2[0], p1[1]], p2]
  if (e.fromSide === 'top' && e.toSide === 'top') {
    const top = Math.min(p1[1], p2[1]) - 36
    return [p1, [p1[0], top], [p2[0], top], p2]
  }
  if (e.fromSide === 'right' && e.toSide === 'left') {
    if (Math.abs(p1[1] - p2[1]) < 1) return [p1, p2]
    const mid = (p1[0] + p2[0]) / 2
    return [p1, [mid, p1[1]], [mid, p2[1]], p2]
  }
  if (Math.abs(p1[0] - p2[0]) < 1) return [p1, p2]
  const turn = p2[1] - 34
  return [p1, [p1[0], turn], [p2[0], turn], p2]
}

export function arrowHead(points: Point2[]): string {
  const [x, y] = points[points.length - 1]
  const [px, py] = points[points.length - 2]
  const angle = Math.atan2(y - py, x - px)
  const size = 8
  const spread = 4.5
  const bx = x - size * Math.cos(angle)
  const by = y - size * Math.sin(angle)
  return `M${f(x)} ${f(y)} L${f(bx + spread * Math.sin(angle))} ${f(by - spread * Math.cos(angle))} L${f(bx - spread * Math.sin(angle))} ${f(by + spread * Math.cos(angle))} Z`
}

type Extent = {
  nodes: Array<{ x: number; y: number; w: number; h: number }>
  edges: Array<{ lane?: boolean }>
}

export function bounds(graph: Extent) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  graph.nodes.forEach((n) => {
    minX = Math.min(minX, n.x - 10)
    minY = Math.min(minY, n.y - 36)
    maxX = Math.max(maxX, n.x + n.w + 30)
    maxY = Math.max(maxY, n.y + n.h + 24)
  })
  const lanes = graph.edges.filter((e) => e.lane).length
  return { minX, minY, maxX: maxX + 24 + lanes * 12, maxY }
}

export type View = { k: number; x: number; y: number }

export function fitView(graph: Extent, width: number, height: number, reserved = 0): View {
  const b = bounds(graph)
  const pad = 30
  const k = Math.max(
    0.2,
    Math.min(
      1.25,
      (width - pad * 2) / (b.maxX - b.minX),
      (height - reserved - pad * 2) / (b.maxY - b.minY),
    ),
  )
  return {
    k,
    x: (width - (b.maxX - b.minX) * k) / 2 - b.minX * k,
    y: Math.max(pad, (height - reserved - (b.maxY - b.minY) * k) / 2) - b.minY * k,
  }
}

export function zoomAt(view: View, px: number, py: number, k: number): View {
  const next = Math.min(2, Math.max(0.2, k))
  return {
    k: next,
    x: px - ((px - view.x) / view.k) * next,
    y: py - ((py - view.y) / view.k) * next,
  }
}
