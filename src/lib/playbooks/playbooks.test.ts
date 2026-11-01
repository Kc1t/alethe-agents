import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { translate } from '../i18n'
import { buildGraph, fitView, type RoleNode } from './graph'
import { condLabel } from './labels'
import { claudeLiveUsage, codexLiveUsage } from './liveUsage'
import {
  applyLiveUsage,
  context,
  createPlaybooksState,
  exportData,
  presetUsage,
  resolvePhase,
  toYaml,
  usageKey,
  workflowNow,
} from './state'
import { parsePlaybooksYaml, PlaybooksYamlError } from './yaml'

const BUNDLED = readFileSync(
  resolve(__dirname, '../../../src-tauri/assets/skills/alethe/playbooks.yaml'),
  'utf8',
)
const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate('en', key, params)

const phase = (state: ReturnType<typeof createPlaybooksState>, playbook: string, id: string) => {
  const wf = state.workflows[`playbook:${playbook}`]
  if (wf.kind !== 'playbook') throw new Error('not a playbook')
  const found = wf.pb.phases.find((p) => p.id === id)
  if (!found) throw new Error(`no phase ${id}`)
  return found
}

describe('playbooks yaml', () => {
  it('reads the bundled playbooks', () => {
    const data = parsePlaybooksYaml(BUNDLED) as Record<string, unknown>
    expect(Object.keys(data.playbooks as object)).toContain('complete')
    expect(data.providers).toEqual(['claude', 'codex'])
  })

  it('names the line of an error', () => {
    expect(() => parsePlaybooksYaml('a: 1\n\tb: 2')).toThrow(PlaybooksYamlError)
    expect(() => parsePlaybooksYaml('a: 1\na: 2')).toThrow("line 2: duplicate mapping key 'a'")
    expect(() => parsePlaybooksYaml('a: yes')).toThrow('quote this scalar')
  })

  it('writes what it reads back unchanged', () => {
    const state = createPlaybooksState(BUNDLED)
    const once = toYaml(state)
    expect(parsePlaybooksYaml(once)).toEqual(exportData(state))
    expect(toYaml(createPlaybooksState(once))).toBe(once)
  })

  it('refuses a file without playbooks', () => {
    expect(() => createPlaybooksState('version: 1\n')).toThrow('the file has no playbooks mapping')
    expect(() => createPlaybooksState('playbooks:\n  a: { phases: [x] }\n')).toThrow(
      'playbook a needs a phases list',
    )
  })
})

describe('playbooks state', () => {
  it('opens on complete, then the pick order, then the routing presets', () => {
    const state = createPlaybooksState(BUNDLED)
    const ids = Object.keys(state.workflows)
    expect(ids[0]).toBe('playbook:complete')
    expect(ids[1]).toBe('playbook:direct')
    expect(ids.slice(-3)).toEqual(['routing:economy', 'routing:balanced', 'routing:performance'])
  })

  it('moves a role to the next provider when its own runs low', () => {
    const state = createPlaybooksState(BUNDLED)
    state.task = 'code'
    const build = phase(state, 'complete', 'build')
    expect(resolvePhase(state, build, context(state)).final.provider).toBe('claude')

    state.usage = presetUsage(state, 'claude-5h')
    const resolved = resolvePhase(state, build, context(state))
    expect(resolved.switched).toBe(true)
    expect(resolved.final.provider).toBe('codex')
  })

  it('takes the first matching rule and the tier of the active profile', () => {
    const state = createPlaybooksState(BUNDLED)
    state.task = 'deep'
    const build = phase(state, 'complete', 'build')
    expect(resolvePhase(state, build, context(state)).final).toMatchObject({
      provider: 'claude',
      tier: 'strong',
      model: 'opus',
    })
    state.profile = 'savings'
    expect(resolvePhase(state, build, context(state)).final.model).toBe('sonnet')
  })

  it('keeps routing edits the file already holds', () => {
    const state = createPlaybooksState(BUNDLED)
    const routing = state.workflows['routing:economy']
    if (routing.kind !== 'routing') throw new Error('not routing')
    routing.roles[0].effort = 'high'
    state.routingWf = routing.id
    const reloaded = createPlaybooksState(toYaml(state))
    const kept = reloaded.workflows['routing:economy']
    expect(reloaded.routingWf).toBe('routing:economy')
    expect(kept.kind === 'routing' && kept.roles[0].effort).toBe('high')
  })

  it('switches to the live reading only while usage is untouched', () => {
    const state = createPlaybooksState(BUNDLED)
    applyLiveUsage(state, { claude: { short: 50, week: 60, opus: 10, reset: 30, expires: null } })
    expect(usageKey(state)).toBe('now')
    expect(state.usage.claude.short).toBe(50)

    const edited = createPlaybooksState(BUNDLED)
    edited.usage = presetUsage(edited, 'codex-out')
    applyLiveUsage(edited, { claude: { short: 50 } })
    expect(usageKey(edited)).toBe('codex-out')
  })
})

describe('playbooks graph', () => {
  it('lights the path a narrow task takes', () => {
    const state = createPlaybooksState(BUNDLED)
    state.task = 'narrow'
    const graph = buildGraph(state, t, workflowNow(state))
    expect(graph.sim.reached.has('phase:quick')).toBe(true)
    expect(graph.sim.reached.has('phase:build')).toBe(false)
    const decision = graph.nodes.find((n) => n.id === 'dec:quick')
    expect(decision?.type === 'decision' && decision.text).toBe('Narrow task?')
  })

  it('opens the escalation chain only when checks fail', () => {
    const state = createPlaybooksState(BUNDLED)
    state.task = 'code'
    const passing = buildGraph(state, t, workflowNow(state))
    const fixer = passing.nodes.find((n): n is RoleNode => n.type === 'role' && n.title === 'fixer')
    expect(fixer).toBeDefined()
    expect(passing.sim.reached.has(fixer!.id)).toBe(false)
    state.checks = 'fail'
    expect(buildGraph(state, t, workflowNow(state)).sim.reached.has(fixer!.id)).toBe(true)
  })

  it('blocks every worker when all providers are low and the rule says block', () => {
    const state = createPlaybooksState(BUNDLED)
    state.usage = presetUsage(state, 'all-out')
    state.quota.onBothCritical = 'block'
    expect(buildGraph(state, t, workflowNow(state)).sim.blocked).toBe(true)
  })

  it('draws a routing preset from the planner down to the result', () => {
    const state = createPlaybooksState(BUNDLED)
    state.wf = 'routing:balanced'
    const graph = buildGraph(state, t, workflowNow(state))
    expect(graph.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining(['entry', 'role:scout', 'role:builder', 'role:expert', 'end']),
    )
    expect(graph.sim.reached.has('end')).toBe(true)
  })

  it('fits the whole flow into the view', () => {
    const state = createPlaybooksState(BUNDLED)
    const view = fitView(buildGraph(state, t, workflowNow(state)), 800, 600)
    expect(view.k).toBeGreaterThan(0.2)
    expect(view.k).toBeLessThanOrEqual(1.25)
  })

  it('labels conditions in words', () => {
    const state = createPlaybooksState(BUNDLED)
    expect(condLabel(state, t, 'claude-opus-above:50')).toBe('Claude opus wk over 50%')
    expect(condLabel(state, t, 'not kind:research')).toBe('not research task')
    expect(condLabel(state, t, 'codex-spare')).toBe('Codex quota would be lost')
  })
})

describe('playbooks live usage', () => {
  it('turns the app readings into quota windows', () => {
    const now = Date.parse('2026-10-31T12:00:00Z')
    expect(
      claudeLiveUsage(
        {
          five_hour: { utilization: 12.4, resets_at: '2026-10-31T14:00:00Z' },
          seven_day: { utilization: 70.6, resets_at: '2026-11-02T12:30:00Z' },
          seven_day_opus: { utilization: 3, resets_at: '' },
        },
        now,
      ),
    ).toEqual({ short: 12, week: 71, opus: 3, reset: 49, expires: null })
    expect(
      codexLiveUsage(
        {
          primary: { used_percent: 40, window_minutes: 300, resets_at_ms: 0 },
          secondary: {
            used_percent: 9.5,
            window_minutes: 10080,
            resets_at_ms: now + 3 * 3_600_000,
          },
          plan: 'plus',
          rate_limited: false,
          reset_credits: 0,
        },
        now,
      ),
    ).toEqual({ short: 40, week: 10, reset: 3, expires: null })
  })
})
