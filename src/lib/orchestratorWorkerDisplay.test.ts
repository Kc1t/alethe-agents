import { describe, expect, it } from 'vitest'

import { workerSettingDisplay } from './orchestratorWorkerDisplay'
import type { OrchestratorJob } from './tauri/orchestrator'

const job = (overrides: Partial<OrchestratorJob>): OrchestratorJob =>
  ({ role: null, model: null, effort: null, routing: null, ...overrides }) as OrchestratorJob

describe('workerSettingDisplay', () => {
  it('marks explicit planner values', () => {
    expect(workerSettingDisplay(job({ model: 'opus', effort: 'high' })).model.source).toBe(
      'planner',
    )
  })
  it('marks role values and rule-picked role values', () => {
    expect(workerSettingDisplay(job({ role: 'expert', model: 'opus' })).model).toEqual({
      value: 'opus',
      source: 'role',
      role: 'expert',
    })
    expect(
      workerSettingDisplay(
        job({
          role: 'expert',
          model: 'opus',
          routing: {
            verdict: 'rule',
            agent: 'claude',
            window: 'week',
            used: 10,
            role: 'expert',
            rule: 'r1',
          },
        }),
      ).model.source,
    ).toBe('role')
  })
  it('marks fallback values with the effective role and nulls as CLI defaults', () => {
    expect(
      workerSettingDisplay(
        job({
          role: 'asked',
          model: 'opus',
          effort: 'high',
          routing: {
            verdict: 'fallback',
            agent: 'claude',
            window: 'week',
            used: 90,
            from: 'asked',
            to: 'fallback-role',
          },
        }),
      ).model,
    ).toEqual({ value: 'opus', source: 'fallback', role: 'fallback-role' })
    expect(workerSettingDisplay(job({}))).toEqual({
      model: { value: null, source: 'cli' },
      effort: { value: null, source: 'cli' },
    })
  })
})
