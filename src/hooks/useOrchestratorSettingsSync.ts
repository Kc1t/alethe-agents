import { useEffect, useRef } from 'react'

import { cliPathMatchesAgent } from '../lib/agentCliPath'
import { clampOrchestratorMaxWorkers, resolveLaunchDefaults } from '../lib/agentLaunchDefaults'
import { normalizeOrchestratorPolicy } from '../lib/orchestratorPolicy'
import { acquireQuotaPolling } from '../lib/orchestratorQuota'
import {
  orchestratorSetCliPath,
  orchestratorSetConcurrency,
  orchestratorSetPlannerRouting,
  orchestratorSetPolicy,
  orchestratorSetWorkerDefaults,
} from '../lib/tauri'
import {
  ORCHESTRATOR_DEFAULT_MAX_WORKERS,
  ORCHESTRATOR_ROUTING_PRESETS,
  ORCHESTRATOR_WORKER_AGENTS,
} from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'

/**
 * Workers are started by the backend, which cannot read preferences, so the worker model, effort,
 * CLI paths, rules and concurrency limit are pushed to it at startup and on every change. Mounted
 * at the app root rather than on the board: a planner delegates whether or not its board is open.
 */
export function useOrchestratorSettingsSync(hydrated: boolean): void {
  const agentDefaults = useProjectsStore((s) => s.preferences.agentDefaults)
  const maxWorkers = useProjectsStore((s) => s.preferences.orchestratorMaxWorkers)
  const cliPaths = useProjectsStore((s) => s.cliPaths)
  const orchestratorEnabled = useProjectsStore((s) => s.preferences.enabledFeatures.orchestrator)
  const policy = useProjectsStore((s) => s.preferences.orchestratorPolicy)
  const projects = useProjectsStore((s) => s.projects)
  // The profile each planner was last given, so only a change is sent again.
  const plannerProfiles = useRef(new Map<string, string>())

  useEffect(() => {
    if (!hydrated) return
    for (const agent of ORCHESTRATOR_WORKER_AGENTS) {
      void orchestratorSetWorkerDefaults(
        agent,
        resolveLaunchDefaults(agentDefaults, agent, 'worker'),
      ).catch(() => undefined)
    }
  }, [hydrated, agentDefaults])

  useEffect(() => {
    if (!hydrated) return
    for (const agent of ORCHESTRATOR_WORKER_AGENTS) {
      const path = cliPaths[agent]
      // A path pointing at another binary is ignored here exactly as the terminal launcher does.
      const usable = path && cliPathMatchesAgent(agent, path) ? path : null
      void orchestratorSetCliPath(agent, usable).catch(() => undefined)
    }
  }, [hydrated, cliPaths])

  useEffect(() => {
    if (!hydrated || !orchestratorEnabled) return
    return acquireQuotaPolling()
  }, [hydrated, orchestratorEnabled])

  useEffect(() => {
    if (!hydrated) return
    void orchestratorSetPolicy(normalizeOrchestratorPolicy(policy)).catch(() => undefined)
  }, [hydrated, policy])

  // A project with a routing profile of its own gives it to each of its planners; a planner that
  // lost one, or whose project went back to the shared routing, is returned to it.
  useEffect(() => {
    if (!hydrated) return
    const wanted = new Map<string, string>()
    for (const project of projects) {
      const preset = project.orchestratorRoutingPreset
      if (!preset || !ORCHESTRATOR_ROUTING_PRESETS[preset]) continue
      for (const terminal of project.terminals) {
        for (const tab of terminal.tabs) {
          if (tab.orchestrationRole === 'planner' && tab.ptyId) wanted.set(tab.ptyId, preset)
        }
      }
    }
    const sent = plannerProfiles.current
    for (const [plannerId, preset] of wanted) {
      if (sent.get(plannerId) === preset) continue
      sent.set(plannerId, preset)
      void orchestratorSetPlannerRouting(plannerId, {
        preset: preset as keyof typeof ORCHESTRATOR_ROUTING_PRESETS,
        ...ORCHESTRATOR_ROUTING_PRESETS[preset as keyof typeof ORCHESTRATOR_ROUTING_PRESETS],
      }).catch(() => undefined)
    }
    for (const plannerId of [...sent.keys()]) {
      if (wanted.has(plannerId)) continue
      sent.delete(plannerId)
      void orchestratorSetPlannerRouting(plannerId, null).catch(() => undefined)
    }
  }, [hydrated, projects])

  useEffect(() => {
    if (!hydrated) return
    void orchestratorSetConcurrency(
      clampOrchestratorMaxWorkers(maxWorkers ?? ORCHESTRATOR_DEFAULT_MAX_WORKERS),
    ).catch(() => undefined)
  }, [hydrated, maxWorkers])
}
