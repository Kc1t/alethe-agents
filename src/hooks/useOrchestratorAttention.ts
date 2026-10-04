import { useEffect, useRef } from 'react'

import { translate } from '../lib/i18n'
import { notifyOrchestrator } from '../lib/notifications'
import type { OrchestratorJobStatus } from '../lib/tauri'
import type { AgentType } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'
import { useOrchestratorSnapshot } from './useOrchestratorSnapshot'

const ACTIVE = new Set<OrchestratorJobStatus>(['queued', 'running', 'blocked'])

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  )
}

/**
 * Tells the person when delegated work needs them or has ended, so neither has to be watched for:
 * a worker that stops on a question, and a planner's workers all coming to rest. Mounted at the app
 * root, because a planner delegates whether or not its board or the Workers tab is open.
 */
export function useOrchestratorAttention(enabled: boolean): void {
  const { snapshot, receivedAt } = useOrchestratorSnapshot()
  const language = useProjectsStore((state) => state.preferences.language)
  const wanted = useProjectsStore((state) => state.preferences.orchestratorNotify ?? true)
  // Null until the first reading: what was already there when Alethe started is not news.
  const seen = useRef<Map<string, OrchestratorJobStatus> | null>(null)

  useEffect(() => {
    if (receivedAt === 0) return
    const previous = seen.current
    const current = new Map(snapshot.jobs.map((job) => [job.id, job.status]))
    seen.current = current
    if (!previous || !enabled || !wanted) return

    for (const job of snapshot.jobs) {
      if (job.status !== 'blocked' || previous.get(job.id) === 'blocked') continue
      void notifyOrchestrator(
        translate(language, 'orchestrator.notifyBlockedTitle'),
        firstLine(job.spec),
        { agent: job.agent as AgentType },
      )
    }

    // A planner whose last active worker just came to rest.
    const planners = new Set(snapshot.jobs.map((job) => job.plannerId))
    for (const planner of planners) {
      const jobs = snapshot.jobs.filter((job) => job.plannerId === planner)
      if (jobs.some((job) => ACTIVE.has(job.status))) continue
      const ended = jobs.filter((job) => {
        const before = previous.get(job.id)
        return before !== undefined && ACTIVE.has(before)
      })
      if (ended.length === 0) continue
      const failed = jobs.filter((job) => job.status === 'failed').length
      void notifyOrchestrator(
        translate(language, 'orchestrator.notifyDoneTitle'),
        translate(
          language,
          failed > 0 ? 'orchestrator.notifyDoneBodyFailed' : 'orchestrator.notifyDoneBody',
          { count: jobs.length, failed },
        ),
        { backgroundOnly: true },
      )
    }
  }, [enabled, language, receivedAt, snapshot.jobs, wanted])
}
