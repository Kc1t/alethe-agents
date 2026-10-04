import { describe, expect, it } from 'vitest'

import fixture from '../../src-tauri/tests/fixtures/routing_cases.json'
import type { AgentFitness } from './agentFitness'
import { type MessageKey, translate } from './i18n'
import {
  pickRoute,
  routePressure,
  routingNoteText,
  ruleOverrideLabels,
} from './orchestratorRouting'

const t = (key: MessageKey, params?: Record<string, string | number>) =>
  translate('en', key, params)

describe('routingNoteText', () => {
  it('names the tier of a task that stayed on its primary route', () => {
    expect(
      routingNoteText(
        { verdict: 'routed', agent: 'claude', tier: 'light', route: 'primary', used: 12 },
        t,
      ),
    ).toBe('Light task')
  })

  it('says which route a task was moved off, and how used it was', () => {
    expect(
      routingNoteText(
        {
          verdict: 'routed',
          agent: 'codex',
          tier: 'deep',
          route: 'fallback',
          used: 20,
          avoided: { agent: 'claude', used: 85, rateLimited: false },
        },
        t,
      ),
    ).toBe('Deep task · moved off Claude Code at 85%')
  })

  it('does not print a percentage for a rate-limited route', () => {
    expect(
      routingNoteText(
        {
          verdict: 'routed',
          agent: 'codex',
          tier: 'standard',
          route: 'fallback',
          used: 20,
          avoided: { agent: 'claude', used: 100, rateLimited: true },
        },
        t,
      ),
    ).toBe('Standard task · moved off Claude Code, rate-limited')
  })

  it('marks a fallback taken because the primary CLI is not installed', () => {
    expect(
      routingNoteText(
        { verdict: 'routed', agent: 'codex', tier: 'light', route: 'fallback', used: 0 },
        t,
      ),
    ).toBe('Light task · fallback route')
  })

  it('keeps the reading of a delegation that named its own agent', () => {
    expect(
      routingNoteText({ verdict: 'ignored', agent: 'codex', window: 'week', used: 91 }, t),
    ).toBe('ignored hint · codex week 91%')
  })
})

const claude: AgentFitness = {
  worst: 'opus',
  used: 97,
  resetsAt: null,
  rateLimited: false,
  windows: {
    '5h': { used: 20, resetsAt: null },
    week: { used: 35, resetsAt: null },
    opus: { used: 97, resetsAt: null },
  },
}

describe('routePressure', () => {
  it('counts the Opus window only against an Opus route', () => {
    expect(routePressure(claude, { agent: 'claude', model: 'opus' })).toBe(97)
    expect(routePressure(claude, { agent: 'claude', model: 'sonnet' })).toBe(35)
  })

  it('reads a provider that is refusing requests as full, and no reading as unknown', () => {
    expect(routePressure({ ...claude, rateLimited: true }, { agent: 'claude' })).toBe(Infinity)
    expect(routePressure(undefined, { agent: 'codex' })).toBeNull()
  })
})

describe('pickRoute', () => {
  const bands = { watchPercent: 60, protectPercent: 80 }
  const routes = (...pressures: (number | null)[]) =>
    pressures.map((pressure) => ({ installed: true, pressure }))

  it('follows the order while a route has room', () => {
    expect(pickRoute(routes(10, 5), bands)).toBe(0)
    expect(pickRoute(routes(70, 30, 10), bands)).toBe(1)
    expect(pickRoute(routes(70, 65), bands)).toBe(0)
  })

  it('falls to the route with the most room once every one is past the protect band', () => {
    expect(pickRoute(routes(92, 85, 99), bands)).toBe(1)
    expect(pickRoute(routes(90, 90), bands)).toBe(0)
  })

  it('skips a route whose CLI is not installed, and reads an unknown usage as none', () => {
    expect(
      pickRoute(
        [
          { installed: false, pressure: 0 },
          { installed: true, pressure: null },
        ],
        bands,
      ),
    ).toBe(1)
    expect(pickRoute([{ installed: false, pressure: 0 }], bands)).toBeNull()
  })
})

// The orchestrator core runs the same cases against the rule it actually routes by, so the preview
// in Preferences cannot drift from what a delegation does.
describe('pickRoute against the fixture shared with the core', () => {
  it.each(fixture.cases)('$name', ({ watch, protect, pressures, expected }) => {
    const candidates = pressures.map((pressure) => ({ installed: true, pressure }))
    expect(pickRoute(candidates, { watchPercent: watch, protectPercent: protect })).toBe(expected)
  })
})

describe('ruleOverrideLabels', () => {
  it('puts the rules that won into words and leaves out one it does not know', () => {
    expect(ruleOverrideLabels(['approvalsOn', 'webSearchOff', 'somethingNewer'], t)).toEqual([
      'asks first',
      'no web search',
    ])
    expect(ruleOverrideLabels(undefined, t)).toEqual([])
  })
})
