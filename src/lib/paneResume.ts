import { useProjectsStore } from '../stores/projectsStore'
import { preparePtyRuntimeLaunch } from './agentRuntimeAdapter'
import { agentLabel, resolveAgentCliCommand } from './agentProviders'
import { terminalNameForPty } from './plannerLabel'
import { registerSessionClaim, releaseSessionClaim } from './sessionDiscovery'
import { buildAgentLaunch } from './sessionLaunch'
import { saveSession } from './sessionResume'
import { agentHooksSettingsPath, orchestratorMcpConfigPath, restartPty } from './tauri'
import type { AgentRuntimeProfile, AgentType } from './types'

export type ResumeSessionInPaneParams = {
  agent: AgentType
  projectId: string
  terminalId: string
  tabId: string
  ptyId: string
  sessionId: string
  cwd: string
  extraArgs?: string[]
  runtimeProfile?: AgentRuntimeProfile
}

/**
 * Points a live pane at another conversation. The restart itself is the easy half — the claim
 * handoff, the `active-sessions` record and the tab's own `sessionId` all have to move with it,
 * or the pane resumes one conversation while the sidebar and the next app start believe another.
 */
export async function resumeSessionInPane({
  agent,
  projectId,
  terminalId,
  tabId,
  ptyId,
  sessionId,
  cwd,
  extraArgs,
  runtimeProfile,
}: ResumeSessionInPaneParams): Promise<void> {
  releaseSessionClaim(tabId)
  releaseSessionClaim(ptyId)

  const prepared = preparePtyRuntimeLaunch(agent, runtimeProfile, extraArgs ?? [])

  let hooksSettingsPath: string | undefined
  const mcpConfigPaths: string[] = []
  if (agent === 'claude') {
    const orchestratorEnabled =
      useProjectsStore.getState().preferences.enabledFeatures.orchestrator
    hooksSettingsPath = await agentHooksSettingsPath(ptyId, orchestratorEnabled).catch(
      () => undefined,
    )
    // Mirrors the normal spawn path (see useXtermSession's orchestratorEnabled/command==='claude'
    // branch): without this, a session resumed from history starts without the orchestrator MCP
    // server and silently cannot delegate or open shells.
    if (orchestratorEnabled) {
      const label =
        terminalNameForPty(useProjectsStore.getState().projects, ptyId) ?? agentLabel(agent)
      const mcpConfigPath = await orchestratorMcpConfigPath(ptyId, label, agent).catch(
        () => undefined,
      )
      if (mcpConfigPath) mcpConfigPaths.push(mcpConfigPath)
    }
  }

  const launch = buildAgentLaunch(
    agent,
    prepared.args,
    sessionId,
    undefined,
    mcpConfigPaths,
    hooksSettingsPath,
  )

  await restartPty({
    id: ptyId,
    cols: 80,
    rows: 24,
    command: resolveAgentCliCommand(agent),
    cwd: cwd || undefined,
    extraArgs: launch.args,
    env: prepared.env,
  })

  if (cwd) {
    registerSessionClaim(agent, cwd, sessionId, tabId)
    registerSessionClaim(agent, cwd, sessionId, ptyId)
  }
  saveSession(tabId, {
    sessionId: ptyId,
    claudeSessionId: agent === 'claude' ? sessionId : undefined,
    codexSessionId: agent === 'codex' ? sessionId : undefined,
    opencodeSessionId: agent === 'opencode' ? sessionId : undefined,
    antigravitySessionId: agent === 'antigravity' ? sessionId : undefined,
    cwd,
    agent,
    timestamp: Date.now(),
  })
  useProjectsStore.getState().setSubTabSessionId(projectId, terminalId, tabId, sessionId)

  window.dispatchEvent(
    new CustomEvent('alethe:terminal-resize-request', { detail: { ptyId } }),
  )
}
