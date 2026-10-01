import { describe, expect, it } from 'vitest'

import { claudeFitness, codexFitness } from './agentFitness'

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
})
