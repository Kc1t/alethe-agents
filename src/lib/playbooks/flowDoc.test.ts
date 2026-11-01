import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { translate } from '../i18n'
import { compileDoc, connect, docFromPlaybook, type FlowDoc, removeNode } from './flowDoc'
import { context, createPlaybooksState, evalToken, type Phase } from './state'

const BUNDLED = readFileSync(
  resolve(__dirname, '../../../src-tauri/assets/skills/alethe/playbooks.yaml'),
  'utf8',
)
const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate('en', key, params)

const structure = (phases: Phase[]) =>
  Object.fromEntries(
    phases.map((p) => [
      p.id,
      {
        with: p.with,
        after: p.after,
        if: p.if,
        then: p.then === 'done' ? 'done' : undefined,
        gate: p.gate,
      },
    ]),
  )

const playbooks = () => {
  const state = createPlaybooksState(BUNDLED)
  return { state, books: Object.values(state.workflows).filter((w) => w.kind === 'playbook') }
}

describe('flow document', () => {
  it('turns every bundled playbook into a graph and back without changing it', () => {
    const { state, books } = playbooks()
    expect(books.length).toBeGreaterThan(5)
    books.forEach((wf) => {
      if (wf.kind !== 'playbook') return
      const compiled = compileDoc(docFromPlaybook(state, t, wf.pb))
      expect(compiled.problems, wf.key).toEqual([])
      expect(structure(compiled.phases), wf.key).toEqual(structure(wf.pb.phases))
    })
  })

  it('adds a worker between two steps', () => {
    const { state } = playbooks()
    const wf = state.workflows['playbook:direct']
    if (wf.kind !== 'playbook') throw new Error('not a playbook')
    const doc = docFromPlaybook(state, t, wf.pb)
    const last = doc.edges.find((e) => e.to === 'end') as FlowDoc['edges'][number]
    doc.nodes.push({
      id: 'phase:audit',
      kind: 'phase',
      x: 0,
      y: 0,
      phase: { id: 'audit', role: 'auditor' },
    })
    doc.edges = doc.edges.filter((e) => e !== last)
    connect(doc, last.from, last.port, 'phase:audit')
    connect(doc, 'phase:audit', 'out', 'end')
    const compiled = compileDoc(doc)
    expect(compiled.problems).toEqual([])
    expect(compiled.phases.at(-1)).toEqual({ id: 'audit', role: 'auditor' })
  })

  it('turns a new decision into alternative paths', () => {
    const doc: FlowDoc = {
      nodes: [
        { id: 'start', kind: 'start', x: 0, y: 0 },
        { id: 'dec:new-1', kind: 'decision', x: 0, y: 0, cond: 'price-above:5' },
        {
          id: 'phase:cheap',
          kind: 'phase',
          x: 0,
          y: 0,
          phase: { id: 'cheap', role: 'cheap', tier: 'cheap' },
        },
        { id: 'phase:build', kind: 'phase', x: 0, y: 0, phase: { id: 'build', role: 'builder' } },
        { id: 'end', kind: 'end', x: 0, y: 0 },
      ],
      edges: [],
    }
    connect(doc, 'start', 'out', 'dec:new-1')
    connect(doc, 'dec:new-1', 'yes', 'phase:cheap')
    connect(doc, 'dec:new-1', 'no', 'phase:build')
    connect(doc, 'phase:cheap', 'out', 'end')
    connect(doc, 'phase:build', 'out', 'end')
    const compiled = compileDoc(doc)
    expect(compiled.problems).toEqual([])
    expect(compiled.phases).toEqual([
      { id: 'cheap', role: 'cheap', tier: 'cheap', if: 'price-above:5' },
      { id: 'build', role: 'builder', with: 'cheap' },
    ])
    expect(compiled.alias['dec:new-1']).toBe('dec:cheap')
  })

  it('names what is wrong with a shape the skill cannot run', () => {
    const { state } = playbooks()
    const wf = state.workflows['playbook:complete']
    if (wf.kind !== 'playbook') throw new Error('not a playbook')
    const doc = docFromPlaybook(state, t, wf.pb)
    const decision = doc.nodes.find((n) => n.kind === 'decision') as FlowDoc['nodes'][number]
    doc.edges = doc.edges.filter((e) => !(e.from === decision.id && e.port === 'no'))
    doc.nodes.push({ id: 'phase:orphan', kind: 'phase', x: 0, y: 0, phase: { id: 'orphan' } })
    const codes = compileDoc(doc).problems.map((p) => p.code)
    expect(codes).toContain('decisionNeedsNo')
    expect(codes).toContain('unreachable')

    const removed = docFromPlaybook(state, t, wf.pb)
    removeNode(removed, 'end')
    expect(compileDoc(removed).problems[0].code).toBe('startUnconnected')
  })

  it('judges price against the phase model and spend against the scenario', () => {
    const { state } = playbooks()
    const c = context(state)
    expect(evalToken(state, 'price-above:3', c, { provider: 'claude', model: 'opus' })).toBe(true)
    expect(evalToken(state, 'price-above:3', c, { provider: 'claude', model: 'sonnet' })).toBe(
      false,
    )
    expect(evalToken(state, 'price-above:3', c, { provider: 'codex', model: null })).toBe(false)
    expect(evalToken(state, 'spent-above:5', c)).toBe(false)
    state.spent = 10
    expect(evalToken(state, 'spent-above:5', context(state))).toBe(true)
    expect(evalToken(state, 'not spent-above:5', context(state))).toBe(false)
  })
})

describe('skipping a step', () => {
  const doc = (): FlowDoc => ({
    nodes: [
      { id: 'start', kind: 'start', x: 0, y: 0 },
      { id: 'phase:build', kind: 'phase', x: 0, y: 0, phase: { id: 'build', role: 'builder' } },
      { id: 'dec:new-1', kind: 'decision', x: 0, y: 0, cond: 'spent-above:10' },
      {
        id: 'phase:wrap',
        kind: 'phase',
        x: 0,
        y: 0,
        phase: { id: 'wrap', role: 'wrap up', tier: 'cheap' },
      },
      { id: 'end', kind: 'end', x: 0, y: 0 },
    ],
    edges: [
      { from: 'start', port: 'out', to: 'phase:build' },
      { from: 'phase:build', port: 'out', to: 'dec:new-1' },
      { from: 'dec:new-1', port: 'yes', to: 'phase:wrap' },
      { from: 'dec:new-1', port: 'no', to: 'end' },
      { from: 'phase:wrap', port: 'out', to: 'end' },
    ],
  })

  it('turns a decision whose no skips ahead into a step that runs only if', () => {
    const compiled = compileDoc(doc())
    expect(compiled.problems).toEqual([])
    expect(compiled.phases).toEqual([
      { id: 'build', role: 'builder' },
      { id: 'wrap', role: 'wrap up', tier: 'cheap', if: 'spent-above:10' },
    ])
    expect(compiled.skips).toEqual({ 'dec:new-1': 'phase:wrap' })
  })

  it('draws that step as a decision again when the file is read back', () => {
    const { state } = playbooks()
    const back = docFromPlaybook(state, t, { name: 'x', phases: compileDoc(doc()).phases })
    const decision = back.nodes.find((n) => n.kind === 'decision')
    expect(decision).toMatchObject({ id: 'dec:wrap', cond: 'spent-above:10' })
    expect(back.edges).toEqual(
      expect.arrayContaining([
        { from: 'phase:build', port: 'out', to: 'dec:wrap' },
        { from: 'dec:wrap', port: 'yes', to: 'phase:wrap' },
        { from: 'dec:wrap', port: 'no', to: 'end' },
      ]),
    )
    expect(compileDoc(back).phases).toEqual(compileDoc(doc()).phases)
  })

  it('refuses a no that goes somewhere the step does not', () => {
    const broken = doc()
    broken.nodes.push({ id: 'phase:other', kind: 'phase', x: 0, y: 0, phase: { id: 'other' } })
    broken.edges = broken.edges.filter((e) => !(e.from === 'phase:wrap'))
    broken.edges.push(
      { from: 'phase:wrap', port: 'out', to: 'phase:other' },
      { from: 'phase:other', port: 'out', to: 'end' },
    )
    expect(compileDoc(broken).problems.map((p) => p.code)).toContain('skipMustMeet')
  })
})
