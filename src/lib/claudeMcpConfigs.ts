import { useProjectsStore } from '../stores/projectsStore'
import { agentLabel } from './agentProviders'
import {
  agentHooksSettingsPath,
  aiMemoryDetect,
  aiMemoryMcpConfigPath,
  graphifyEnsureGraph,
  graphifyMcpConfigPath,
  orchestratorMcpConfigPath,
  playwrightMcpConfigPath,
} from './tauri'
import type { AgentType, Project } from './types'
import { toWslGuestPath, wslTargetFor } from './wsl'

/**
 * The terminal a pty belongs to, which is how the orchestration board names its planner. The label
 * is taken before the first spawn, when the tab has no ptyId yet and the pane spawns under its tab
 * id, so a tab is matched by the same `ptyId ?? id` the pane uses. When none matches, the agent's
 * name is still more readable than the raw id.
 */
export function plannerLabelFor(ptyId: string, agent?: AgentType): string {
  for (const project of useProjectsStore.getState().projects) {
    for (const terminal of project.terminals) {
      if (terminal.tabs.some((tab) => (tab.ptyId ?? tab.id) === ptyId)) return terminal.name
    }
  }
  return agent ? agentLabel(agent) : ptyId
}

/** The repository Graphify serves a terminal from, or null when the project has it off. */
export function graphifyRepoOf(project: Project | undefined, terminalCwd?: string): string | null {
  if (!project?.graphifyEnabled) return null
  return terminalCwd || project.terminals[0]?.cwd || null
}

export type ClaudeLaunchExtras = {
  mcpConfigPaths: string[]
  hooksSettingsPath: string | undefined
  /** Whether the MCP servers include the orchestrator's `alethe_*` tools. */
  orchestrator: boolean
}

/**
 * What a Claude launch in a pane needs beyond its own arguments: the `--mcp-config` files for
 * Graphify, AI memory, Playwright and the orchestrator (each when it is on) and the hooks settings.
 * Claude only reads them at launch, so every launch of a pane (first spawn, restart, resume) has
 * to pass them again (#248). None of this starts a browser: the Playwright config points at the
 * shared one when it runs and otherwise leaves Playwright to open one only when it is needed.
 *
 * A Claude inside a WSL distro reads every path in guest form. Graphify and AI memory stay off
 * there: they run Windows-side binaries over Windows paths and would fail at every call.
 */
export async function claudeLaunchExtras({
  ptyId,
  cwd,
  graphifyRepo,
  onAiMemoryMissing,
}: {
  ptyId: string
  cwd?: string | null
  graphifyRepo?: string | null
  onAiMemoryMissing?: () => void
}): Promise<ClaudeLaunchExtras> {
  const { enabledFeatures, playwrightBrowserMode, playwrightDedicatedHeadless } =
    useProjectsStore.getState().preferences
  const wslTarget = wslTargetFor(cwd, enabledFeatures.wsl)
  const mcpConfigPaths: string[] = []

  if (graphifyRepo && !wslTarget) {
    void graphifyEnsureGraph(graphifyRepo).catch(() => undefined)
    const path = await graphifyMcpConfigPath(graphifyRepo).catch(() => undefined)
    if (path) mcpConfigPaths.push(path)
  }

  if (enabledFeatures.aiMemory && cwd && !wslTarget) {
    const status = await aiMemoryDetect().catch(() => undefined)
    if (status?.installed) {
      const path = await aiMemoryMcpConfigPath(cwd).catch(() => undefined)
      if (path) mcpConfigPaths.push(path)
    } else {
      onAiMemoryMissing?.()
    }
  }

  if (enabledFeatures.playwright) {
    const path = await playwrightMcpConfigPath({
      dedicated: playwrightBrowserMode === 'dedicated',
      headless: playwrightDedicatedHeadless,
    }).catch(() => undefined)
    if (path) mcpConfigPaths.push(path)
  }

  const orchestratorPath = enabledFeatures.orchestrator
    ? await orchestratorMcpConfigPath(ptyId, plannerLabelFor(ptyId, 'claude'), 'claude').catch(
        () => undefined,
      )
    : undefined
  if (orchestratorPath) mcpConfigPaths.push(orchestratorPath)

  // Tags the pane's hooks with its pty, so SessionStart/UserPromptSubmit keep it on the right
  // conversation; with the orchestrator on, the same file carries the subagent and tool hooks.
  const hooksSettingsPath = await agentHooksSettingsPath(ptyId, enabledFeatures.orchestrator).catch(
    () => undefined,
  )

  if (wslTarget) {
    return {
      mcpConfigPaths: mcpConfigPaths.map(toWslGuestPath).filter((p): p is string => p !== null),
      hooksSettingsPath: hooksSettingsPath
        ? (toWslGuestPath(hooksSettingsPath) ?? undefined)
        : undefined,
      orchestrator: Boolean(orchestratorPath),
    }
  }
  return { mcpConfigPaths, hooksSettingsPath, orchestrator: Boolean(orchestratorPath) }
}

/** Ptys whose running Claude was launched with the orchestrator tools. */
const orchestratorLaunches = new Set<string>()
const launchWaiters = new Map<string, Set<() => void>>()

/**
 * Records what a Claude process that just started in this pty was given. Call it only once the
 * launch went through: a launch that failed, or a spawn that reattached to the process already
 * running, says nothing about the tools that process has.
 */
export function recordClaudeLaunch(ptyId: string, orchestrator: boolean): void {
  if (orchestrator) orchestratorLaunches.add(ptyId)
  else orchestratorLaunches.delete(ptyId)
  for (const wake of launchWaiters.get(ptyId) ?? []) wake()
}

/** Whether the Claude running in this pty was launched with the orchestrator tools. */
export function hasOrchestratorTools(ptyId: string): boolean {
  return orchestratorLaunches.has(ptyId)
}

/**
 * Resolves once the Claude in this pty runs with the orchestrator tools, or false after
 * `timeoutMs`. A parked pane only relaunches once it is resumed, so the tools may come later.
 */
export function waitForOrchestratorTools(ptyId: string, timeoutMs: number): Promise<boolean> {
  if (hasOrchestratorTools(ptyId)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const waiters = launchWaiters.get(ptyId) ?? new Set<() => void>()
    launchWaiters.set(ptyId, waiters)
    const finish = (value: boolean) => {
      clearTimeout(timer)
      waiters.delete(wake)
      if (waiters.size === 0) launchWaiters.delete(ptyId)
      resolve(value)
    }
    const wake = () => {
      if (hasOrchestratorTools(ptyId)) finish(true)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    waiters.add(wake)
  })
}
