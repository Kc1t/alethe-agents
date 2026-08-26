import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  colorFor,
  costAtRate,
  durationLabel,
  estimateRoutingSavings,
  execArgsFor,
  formatReset,
  tailSummary,
} from './agentCanvasUtils'
import type { ModelRate, SessionCost } from './tauri'
import type { AgentType } from './types'

function sessionCost(
  partial: Partial<SessionCost> & Pick<SessionCost, 'model' | 'cost_usd'>,
): SessionCost {
  return {
    session_id: 's1',
    agent: 'claude',
    input: 1_000_000,
    output: 0,
    cache_read: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    total_tokens: 1_000_000,
    by_model: [],
    ...partial,
  }
}

const rates: ModelRate[] = [
  {
    family: 'opus',
    input: 15,
    output: 75,
    cache_read: 1.5,
    cache_write_5m: 18.75,
    cache_write_1h: 30,
  },
  {
    family: 'sonnet',
    input: 3,
    output: 15,
    cache_read: 0.3,
    cache_write_5m: 3.75,
    cache_write_1h: 6,
  },
  {
    family: 'haiku',
    input: 1,
    output: 5,
    cache_read: 0.1,
    cache_write_5m: 1.25,
    cache_write_1h: 2,
  },
]

describe('formatReset', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns em dash for empty or unparseable dates', () => {
    expect(formatReset('')).toBe('—')
    expect(formatReset('not-a-date')).toBe('—')
  })

  it('returns nowLabel for past timestamps', () => {
    expect(formatReset('2026-01-01T11:00:00.000Z')).toBe('agora')
    expect(formatReset('2026-01-01T11:00:00.000Z', 'now')).toBe('now')
  })

  it('formats future durations with and without hours', () => {
    // ~2h30m ahead
    expect(formatReset('2026-01-01T14:30:00.000Z')).toBe('2h30m')
    // ~45m ahead
    expect(formatReset('2026-01-01T12:45:00.000Z')).toBe('45m')
  })
})

describe('durationLabel', () => {
  it('returns null while still running', () => {
    expect(durationLabel({ startedAt: 0, endedAt: null })).toBeNull()
  })

  it('formats seconds and minutes', () => {
    expect(durationLabel({ startedAt: 0, endedAt: 42_000 })).toBe('42s')
    expect(durationLabel({ startedAt: 0, endedAt: 125_000 })).toBe('2m5s')
    expect(durationLabel({ startedAt: 0, endedAt: 60_000 })).toBe('1m0s')
  })
})

describe('tailSummary', () => {
  it('strips CSI, OSC, and stray control bytes while collapsing other whitespace', () => {
    // Tabs and runs of spaces become a single space; newlines are preserved (blank runs collapse).
    const raw = '\x1b[31mred\x1b[0m\tline\x1b]0;title\x07\n\nnext\x07'
    expect(tailSummary(raw)).toBe('red line\nnext')
  })

  it('truncates from the start with an ellipsis when over max', () => {
    expect(tailSummary('abcdefghij', 4)).toBe('…ghij')
  })

  it('returns short output unprefixed', () => {
    expect(tailSummary('ok', 10)).toBe('ok')
  })
})

describe('execArgsFor', () => {
  it('returns documented argv per agent', () => {
    expect(execArgsFor('codex', 'do it')).toEqual(['exec', '--skip-git-repo-check', 'do it'])
    expect(execArgsFor('claude', 'do it')).toEqual([
      '-p',
      'do it',
      '--dangerously-skip-permissions',
    ])
    expect(execArgsFor('opencode', 'do it')).toEqual(['run', 'do it'])
  })

  it('returns undefined for unsupported agent types', () => {
    expect(execArgsFor('shell' as AgentType, 'x')).toBeUndefined()
  })
})

describe('colorFor', () => {
  it('returns fixed colors case-insensitively for known types', () => {
    expect(colorFor('explore')).toBe('var(--agent-codex)')
    expect(colorFor('EXPLORE')).toBe('var(--agent-codex)')
  })

  it('returns a stable hsl color for unknown types', () => {
    const a = colorFor('custom-teammate-alpha')
    const b = colorFor('custom-teammate-alpha')
    expect(a).toMatch(/^hsl\(\d+ 55% 62%\)$/)
    expect(a).toBe(b)
  })
})

describe('costAtRate / estimateRoutingSavings', () => {
  it('costAtRate divides token costs by 1_000_000', () => {
    // 1M input tokens at $15/M = $15
    const cost = costAtRate(
      sessionCost({
        model: 'claude-haiku-4-5',
        cost_usd: 1,
        input: 1_000_000,
        output: 0,
        cache_read: 0,
        cache_write_5m: 0,
        cache_write_1h: 0,
      }),
      rates.find((r) => r.family === 'opus')!,
    )
    expect(cost).toBe(15)
  })

  it('returns 0 when lead is missing or unpriced', () => {
    const nodes = {
      a: sessionCost({ model: 'claude-haiku-4-5', cost_usd: 1 }),
    }
    expect(estimateRoutingSavings(nodes, null, rates)).toBe(0)
    expect(estimateRoutingSavings(nodes, 'unknown-model-xyz', rates)).toBe(0)
  })

  it('returns 0 when every node is at or above the lead rank', () => {
    const nodes = {
      a: sessionCost({ model: 'claude-opus-4-8', cost_usd: 10 }),
      b: sessionCost({ model: 'claude-3-5-sonnet', cost_usd: 3 }),
    }
    // lead is haiku (cheapest) — nothing ranks cheaper
    expect(estimateRoutingSavings(nodes, 'claude-haiku-4-5', rates)).toBe(0)
  })

  it('sums positive deltas for cheaper-family nodes and skips null costs', () => {
    const haikuNode = sessionCost({
      model: 'claude-haiku-4-5',
      cost_usd: 1,
      input: 1_000_000,
      output: 0,
    })
    const codexNode = sessionCost({
      model: 'gpt-5',
      cost_usd: null,
      input: 1_000_000,
      output: 0,
    })
    const leadRate = rates.find((r) => r.family === 'opus')!
    const expected = costAtRate(haikuNode, leadRate) - 1
    const saved = estimateRoutingSavings(
      { cheap: haikuNode, unpriced: codexNode },
      'claude-opus-4-8',
      rates,
    )
    expect(saved).toBe(expected)
    expect(saved).toBeGreaterThan(0)
  })
})
