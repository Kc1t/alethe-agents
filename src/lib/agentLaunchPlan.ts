import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { cliPathMatchesAgent } from './agentCliPath'
import { resolveLaunchDefaults } from './agentLaunchDefaults'
import { preparePtyRuntimeLaunch } from './agentRuntimeAdapter'
import { getLocale, translate } from './i18n'
import { router9EnvFor } from './router9'
import { type AgentLaunch, buildAgentLaunch } from './sessionLaunch'
import {
  agentHooksSettingsPath,
  aiMemoryCodexConfigWrite,
  aiMemoryDetect,
  aiMemoryMcpConfigPath,
  aiMemoryOpenCodeConfigWrite,
  codexHooksConfigWrite,
  codexMcpConfigWrite,
  graphifyCodexConfigWrite,
  graphifyEnsureGraph,
  graphifyMcpConfigPath,
  graphifyOpenCodeConfigWrite,
  gsdOpenCodePluginWrite,
  orchestratorMcpConfigPath,
  playwrightMcpConfigPath,
} from './tauri'
import type { AgentRuntimeProfile, AgentType, Project, SubTab, Terminal } from './types'

export type AgentLaunchRequest = {
  /** Absent for a plain shell with no agent command. */
  agent?: AgentType | null
  ptyId: string
  cwd?: string | null
  extraArgs?: readonly string[]
  runtimeProfile?: AgentRuntimeProfile
  env?: Record<string, string>
  resumeId?: string
  useRouter9?: boolean
  graphifyRepo?: string | null
  gsdWatcherEnabled?: boolean
  /** Lets a caller that can unmount mid-flight stop before the next integration is prepared. */
  isCancelled?: () => boolean
}

export type AgentLaunchPlan = AgentLaunch & { env: Record<string, string> }

/** What a launch needs that lives on the project or the tab rather than on the caller. */
export type AgentLaunchContext = Pick<
  AgentLaunchRequest,
  'useRouter9' | 'graphifyRepo' | 'gsdWatcherEnabled'
>

let aiMemoryMissingWarned = false

function reportPlannerSetupFailure(agent: AgentType, cwd: string, error: unknown): void {
  console.error(`[pty-launch] ${agent} planner setup failed for ${cwd}:`, error)
  useUiStore.getState().pushToast({
    title: translate(getLocale(), 'orchestrator.plannerSetupFailed'),
    body: translate(getLocale(), 'orchestrator.plannerSetupFailedBody', {
      agent,
      path: cwd,
      error: error instanceof Error ? error.message : String(error),
    }),
  })
}

/**
 * A tab that has never spawned has no pty id yet and launches under its own id, so both are
 * checked: the first spawn has to find its tab just as a restart does.
 */
function findTabForPty(
  ptyId: string,
): { project: Project; terminal: Terminal; tab: SubTab } | null {
  for (const project of useProjectsStore.getState().projects) {
    for (const terminal of project.terminals) {
      const tab = terminal.tabs.find(
        (candidate) => candidate.ptyId === ptyId || candidate.id === ptyId,
      )
      if (tab) return { project, terminal, tab }
    }
  }
  return null
}

/** The terminal's own name is what the person recognises a planner by, not its pty id. */
function plannerLabelFor(ptyId: string): string {
  return findTabForPty(ptyId)?.terminal.name ?? ptyId
}

/**
 * A restart only knows the pane it is restarting, so the project-level inputs the first spawn got
 * as props are looked up from the pty id instead.
 */
export function launchContextForPty(ptyId: string): AgentLaunchContext {
  const owner = findTabForPty(ptyId)
  if (!owner) return {}
  const { project, terminal, tab } = owner
  return {
    useRouter9: tab.useRouter9,
    graphifyRepo: project.graphifyEnabled
      ? terminal.cwd || project.terminals[0]?.cwd || null
      : null,
    gsdWatcherEnabled: Boolean(project.gsdWatcherEnabled),
  }
}

/** The person's CLI path for this agent, when it still points at that agent's binary. */
export function launcherOverrideFor(agent: AgentType): string | undefined {
  const override = useProjectsStore.getState().cliPaths[agent]
  return override && cliPathMatchesAgent(agent, override) ? override : undefined
}

/**
 * Builds the full launch for an agent pane: runtime profile, routing environment, every managed
 * MCP server, hooks and session arguments. The first spawn and every restart go through here, so
 * a restarted pane comes back with the same integrations it was started with.
 *
 * Returns null when the caller cancelled while an integration was being prepared.
 */
export async function prepareAgentLaunch(
  request: AgentLaunchRequest,
): Promise<AgentLaunchPlan | null> {
  const { agent, ptyId, runtimeProfile, resumeId, graphifyRepo } = request
  const cwd = request.cwd || undefined
  const extraArgs = request.extraArgs ?? []
  const cancelled = () => request.isCancelled?.() ?? false

  const preparedRuntime = agent
    ? preparePtyRuntimeLaunch(
        agent,
        runtimeProfile,
        extraArgs,
        request.env,
        resolveLaunchDefaults(
          useProjectsStore.getState().preferences.agentDefaults,
          agent,
          findTabForPty(ptyId)?.tab.orchestrationRole,
        ),
      )
    : { args: [...extraArgs], env: request.env }

  // Read at spawn time rather than through a selector: the PTY environment is fixed when the
  // process starts, so turning 9router off only ever affects terminals opened afterwards.
  const router9Env =
    request.useRouter9 && agent
      ? router9EnvFor(agent, useProjectsStore.getState().preferences.router9)
      : {}
  // The Codex hook forwarder and MCP bridge are shared per port, so they read the terminal
  // they belong to from here instead of from a path Codex would ask to trust again.
  const env = {
    ...(preparedRuntime.env ?? {}),
    ...router9Env,
    ALETHE_PLANNER: ptyId,
  }

  if (!agent) {
    return { args: preparedRuntime.args, sessionId: undefined, createdSession: false, env }
  }

  const mcpConfigPaths: string[] = []
  let hooksSettingsPath: string | undefined

  if (graphifyRepo && (agent === 'claude' || agent === 'codex' || agent === 'opencode')) {
    void graphifyEnsureGraph(graphifyRepo).catch(() => undefined)
    if (agent === 'claude') {
      const path = await graphifyMcpConfigPath(graphifyRepo).catch(() => undefined)
      if (path) mcpConfigPaths.push(path)
    } else if (agent === 'opencode') {
      await graphifyOpenCodeConfigWrite(graphifyRepo).catch(() => {})
    } else if (agent === 'codex') {
      await graphifyCodexConfigWrite(graphifyRepo).catch(() => {})
    }
    if (cancelled()) return null
  }

  const aiMemoryEnabled = useProjectsStore.getState().preferences.enabledFeatures.aiMemory
  if (aiMemoryEnabled && cwd && (agent === 'claude' || agent === 'codex' || agent === 'opencode')) {
    const status = await aiMemoryDetect().catch(() => undefined)
    if (status?.installed) {
      if (agent === 'claude') {
        const path = await aiMemoryMcpConfigPath(cwd).catch(() => undefined)
        if (path) mcpConfigPaths.push(path)
      } else if (agent === 'opencode') {
        await aiMemoryOpenCodeConfigWrite(cwd).catch(() => {})
      } else if (agent === 'codex') {
        await aiMemoryCodexConfigWrite(cwd).catch(() => {})
      }
    } else if (!aiMemoryMissingWarned) {
      aiMemoryMissingWarned = true
      useUiStore.getState().pushToast({
        title: translate(getLocale(), 'aiMemory.notInstalledTitle'),
        body: translate(getLocale(), 'aiMemory.notInstalledBody'),
      })
    }
    if (cancelled()) return null
  }

  // Claude only: it takes an ephemeral --mcp-config, so nothing is left behind pointing at a
  // dead endpoint. Codex and OpenCode need in-repo config writes.
  //
  // This must never start a browser. The config points at the shared browser when one is
  // already running and otherwise leaves Playwright on its default, which opens a browser
  // only once the agent reaches for one.
  const playwrightEnabled = useProjectsStore.getState().preferences.enabledFeatures.playwright
  if (playwrightEnabled && agent === 'claude') {
    const { playwrightBrowserMode, playwrightDedicatedHeadless } =
      useProjectsStore.getState().preferences
    const path = await playwrightMcpConfigPath({
      dedicated: playwrightBrowserMode === 'dedicated',
      headless: playwrightDedicatedHeadless,
    }).catch(() => undefined)
    if (path) mcpConfigPaths.push(path)
    if (cancelled()) return null
  }

  const orchestratorEnabled = useProjectsStore.getState().preferences.enabledFeatures.orchestrator
  if (orchestratorEnabled && agent === 'claude') {
    const path = await orchestratorMcpConfigPath(ptyId, plannerLabelFor(ptyId), agent, cwd).catch(
      (error) => {
        reportPlannerSetupFailure(agent, cwd ?? '', error)
        return undefined
      },
    )
    if (path) mcpConfigPaths.push(path)
    if (cancelled()) return null
  }

  // Tags every Claude pane's hooks with its ptyId. SessionStart/UserPromptSubmit report the
  // conversation the CLI is actually on, which is what keeps the pane in sync after an in-CLI
  // /clear or /resume; with the orchestrator on, the same file also carries its subagent and
  // tool-call hooks so the canvas can hang them off this planner.
  if (agent === 'claude') {
    hooksSettingsPath = await agentHooksSettingsPath(ptyId, orchestratorEnabled).catch(
      () => undefined,
    )
    if (cancelled()) return null
  }

  if (orchestratorEnabled && agent === 'codex' && cwd) {
    // Same idea for Codex: it has its own native subagents (SubagentStart/Stop), just no http
    // hook handler — codexHooksConfigWrite points them at a generated forwarder instead.
    await codexHooksConfigWrite(cwd, ptyId).catch(() => undefined)
    if (cancelled()) return null

    // Registers this Codex terminal as a planner too, so it can call alethe_delegate.
    await codexMcpConfigWrite(cwd, ptyId, plannerLabelFor(ptyId), agent).catch((error) => {
      reportPlannerSetupFailure(agent, cwd, error)
    })
    if (cancelled()) return null
  }

  const { preferences } = useProjectsStore.getState()
  if (
    agent === 'opencode' &&
    cwd &&
    request.gsdWatcherEnabled &&
    preferences.enabledFeatures.gsdSync
  ) {
    await gsdOpenCodePluginWrite(cwd, preferences.gsdSyncModelChain ?? []).catch((error) => {
      console.error(`[pty-launch] gsdOpenCodePluginWrite failed for ${cwd}:`, error)
    })
    if (cancelled()) return null
  }

  const launch = buildAgentLaunch(
    agent,
    preparedRuntime.args,
    resumeId,
    undefined,
    mcpConfigPaths,
    hooksSettingsPath,
  )
  return { ...launch, env }
}
