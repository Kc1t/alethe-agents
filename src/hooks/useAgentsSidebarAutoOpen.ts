import { useEffect, useMemo, useRef } from 'react'

import { hasOrchestratorTools } from '../lib/claudeMcpConfigs'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

/**
 * The ptyId of the focused terminal when its active tab runs an agent launched with the
 * orchestrator tools — that is what a job's `plannerId` points at. Null for any other focus.
 */
export function useFocusedPlannerPtyId(): string | null {
  const focusedTerminalId = useUiStore((s) => s.focusedTerminalId)
  const projects = useProjectsStore((s) => s.projects)
  return useMemo(() => {
    if (!focusedTerminalId) return null
    for (const project of projects) {
      const terminal = project.terminals.find((entry) => entry.id === focusedTerminalId)
      if (!terminal) continue
      const tab = terminal.tabs.find((entry) => entry.id === terminal.activeTabId) ?? terminal.tabs[0]
      const ptyId = tab?.ptyId ?? null
      return ptyId && hasOrchestratorTools(ptyId) ? ptyId : null
    }
    return null
  }, [focusedTerminalId, projects])
}

/**
 * Focusing a planner terminal in focus mode swaps the right sidebar to the Agents tab; focusing
 * anything else puts back the exact tab and visibility from before. Only focus transitions act —
 * the ref plus the stashed state keep this from fighting manual sidebar use or looping on the
 * store writes it makes itself.
 */
export function useAgentsSidebarAutoOpen(): void {
  const plannerPtyId = useFocusedPlannerPtyId()
  const onPlannerRef = useRef(false)

  useEffect(() => {
    const onPlanner = plannerPtyId !== null
    if (onPlanner === onPlannerRef.current) return
    onPlannerRef.current = onPlanner

    if (!useProjectsStore.getState().preferences.enabledFeatures.agentsPanel) return

    const ui = useUiStore.getState()
    const projects = useProjectsStore.getState()
    if (onPlanner) {
      ui.setAgentsSidebarPrev({
        mode: ui.rightSidebarMode,
        visible: projects.preferences.rightSidebarVisible,
      })
      if (!projects.preferences.rightSidebarVisible)
        projects.setPreferences({ rightSidebarVisible: true })
      ui.showAgentsSidebar()
      return
    }
    const prev = ui.agentsSidebarPrev
    if (!prev) return
    ui.setRightSidebarMode(prev.mode)
    if (projects.preferences.rightSidebarVisible !== prev.visible)
      projects.setPreferences({ rightSidebarVisible: prev.visible })
    ui.setAgentsSidebarPrev(null)
  }, [plannerPtyId])
}
