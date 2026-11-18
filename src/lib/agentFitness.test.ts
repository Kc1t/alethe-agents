import { describe, expect, it } from 'vitest'

import { antigravityFitness, claudeFitness, codexFitness } from './agentFitness'
import type { AntigravityUsage } from './tauri/usage'

const claudeWindow = (utilization: number, resets_at = '') => ({ utilization, resets_at })
const codexWindow = (used_percent: number, resets_at_ms = 0) => ({
  used_percent,
  window_minutes: 0,
  resets_at_ms,
})

describe('agent fitness', () => {
  it('reports the window closest to its ceiling, not the five-hour one', () => {
    const fitness = codexFitness({
      primary: codexWindow(22),
      secondary: codexWindow(60),
      plan: 'plus',
      rate_limited: false,
      reset_credits: 0,
    })
    expect(fitness.worst).toBe('week')
    expect(fitness.used).toBe(60)
  })

  it('keeps the two vendors comparable when their five-hour windows look tied', () => {
    const claude = claudeFitness({
      five_hour: claudeWindow(20),
      seven_day: claudeWindow(19),
      seven_day_opus: claudeWindow(0),
    })
    const codex = codexFitness({
      primary: codexWindow(22),
      secondary: codexWindow(60),
      plan: 'plus',
      rate_limited: false,
      reset_credits: 0,
    })
    expect(claude.used).toBeLessThan(codex.used)
  })

  it('carries the detected codex plan and drops it when absent', () => {
    const base = {
      primary: codexWindow(1),
      secondary: codexWindow(1),
      rate_limited: false,
      reset_credits: 0,
    }
    expect(codexFitness({ ...base, plan: 'plus' }).plan).toBe('plus')
    expect(codexFitness({ ...base, plan: '' }).plan).toBeUndefined()
  })

  it('carries the reset time of the worst window', () => {
    const fitness = claudeFitness({
      five_hour: claudeWindow(10, 'soon'),
      seven_day: claudeWindow(90, 'later'),
      seven_day_opus: claudeWindow(0),
    })
    expect(fitness.resetsAt).toBe('later')
  })

  it('counts model-scoped weekly limits such as Fable', () => {
    const fitness = claudeFitness({
      five_hour: claudeWindow(10),
      seven_day: claudeWindow(30),
      seven_day_opus: claudeWindow(0),
      model_limits: [{ model: 'Fable', utilization: 100, resets_at: 'monday' }],
    })
    expect(fitness.worst).toBe('fable')
    expect(fitness.used).toBe(100)
    expect(fitness.resetsAt).toBe('monday')
  })

  it('selects the model window when it exceeds the session window', () => {
    const fitness = claudeFitness({
      five_hour: claudeWindow(10),
      seven_day: claudeWindow(20),
      seven_day_opus: claudeWindow(0),
      model_limits: [{ model: 'Fable', utilization: 90 }],
    })
    expect(fitness.worst).toBe('fable')
  })

  it('selects the session window when it exceeds model limits', () => {
    const fitness = claudeFitness({
      five_hour: claudeWindow(90),
      seven_day: claudeWindow(20),
      seven_day_opus: claudeWindow(0),
      model_limits: [{ model: 'Fable', utilization: 10 }],
    })
    expect(fitness.worst).toBe('5h')
  })
})

const agyBucket = (label: string, used_percent: number, resets_at = '') => ({
  label,
  models: [],
  used_percent,
  remaining_percent: 100 - used_percent,
  resets_at,
})
const agyUsage = (
  buckets: AntigravityUsage['buckets'],
  used_percent: number,
  rate_limited = false,
): AntigravityUsage => ({ status: 'ready', cli_path: 'agy', used_percent, rate_limited, buckets })

// Antigravity meters model groups apart, and a worker role may run any of them (#218).
describe('antigravity fitness', () => {
  it('reports the tightest quota bucket, since the vendor reading is all the core gets', () => {
    const fitness = antigravityFitness(
      agyUsage([agyBucket('Gemini Flash', 20, 'soon'), agyBucket('Claude', 85.4, 'later')], 85.4),
    )
    expect(fitness).toEqual({
      worst: 'Claude',
      used: 85,
      resetsAt: 'later',
      rateLimited: false,
      windows: { 'Gemini Flash': 20, Claude: 85.4 },
    })
  })

  it('falls back to the overall usage when no bucket is reported', () => {
    const fitness = antigravityFitness(agyUsage([], 40, true))
    expect(fitness).toEqual({
      worst: 'quota',
      used: 40,
      resetsAt: null,
      rateLimited: true,
      windows: { quota: 40 },
    })
  })
})
