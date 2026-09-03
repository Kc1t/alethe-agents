import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

                                                                        
                                                                        
                                                 
export async function agentHooksEndpoint(): Promise<string> {
  return invoke('agent_hooks_endpoint')
}

export async function agentHooksToken(): Promise<string> {
  return invoke<string>('agent_hooks_token')
}

export type CodexAppServerEvent = Record<string, unknown>

export async function codexAppServerStart(id: string, cwd: string): Promise<void> {
  await invoke('codex_app_server_start', { id, cwd })
}

export async function codexAppServerSend(id: string, request: CodexAppServerEvent): Promise<void> {
  await invoke('codex_app_server_send', { id, request })
}

export async function codexAppServerStop(id: string): Promise<void> {
  await invoke('codex_app_server_stop', { id })
}

export function listenCodexAppServer(
  id: string,
  handler: (event: CodexAppServerEvent) => void,
): Promise<UnlistenFn> {
  return listen<CodexAppServerEvent>(`agent-sandbox-app-server://event/${id}`, (event) => handler(event.payload))
}

/**
 * Caminho do settings.json de hooks gerado pro Claude Code (agent_events.rs).
 * `orchestrator: false` writes the session-tracking-only variant (SessionStart/UserPromptSubmit),
 * without the subagent and tool-call hooks the orchestrator canvas needs.
 */
export async function agentHooksSettingsPath(
  plannerId: string,
  orchestrator = true,
): Promise<string> {
  return invoke<string>('agent_hooks_settings_path', { plannerId, orchestrator })
}

/**
 * Writes the `[hooks]` block that reports this Codex terminal's own subagents back to Alethe,
 * tagged with `plannerId` (agent_events.rs). Codex has no http hook handler, so this points its
 * SubagentStart/Stop hooks at a small generated PowerShell forwarder instead.
 */
export async function codexHooksConfigWrite(repo: string, plannerId: string): Promise<void> {
  await invoke('codex_hooks_config_write', { repo, plannerId })
}

/** Registers this Codex terminal as an orchestrator planner via a generated stdio-to-http bridge. */
export async function codexMcpConfigWrite(
  repo: string,
  plannerId: string,
  plannerLabel: string,
  plannerAgent: string,
): Promise<void> {
  await invoke('codex_mcp_config_write', { repo, plannerId, plannerLabel, plannerAgent })
}

export type InstalledAgent = { name: string; from_alethe: boolean }

                                                                      
export async function listInstalledAgents(folder: string): Promise<InstalledAgent[]> {
  return invoke<InstalledAgent[]>('list_installed_agents', { folder })
}

                                                                          
export async function economyAgentsEnabled(folder: string): Promise<boolean> {
  return invoke<boolean>('economy_agents_enabled', { folder })
}

                                                                 
export async function setEconomyAgents(folder: string, enabled: boolean): Promise<string[]> {
  return invoke<string[]>('set_economy_agents', { folder, enabled })
}

                                                                        
                                                                    
export async function installAgent(args: {
  folder: string
  name: string
  content: string
  force: boolean
}): Promise<string> {
  return invoke<string>('install_agent', args)
}

                                      
export async function uninstallAgent(folder: string, name: string, force = true): Promise<void> {
  await invoke('uninstall_agent', { folder, name, force })
}

export type DiscoveredModel = { id: string; label: string }

export async function discoverProviderModels(provider: string): Promise<DiscoveredModel[]> {
  return invoke<DiscoveredModel[]>('discover_provider_models', { provider })
}

export type OpenCodeBridgeStatus = {
  directory: string
  state: 'working' | 'idle'
}

                                                                        
                                                                  
export function listenOpenCodeBridgeStatus(
  handler: (payload: OpenCodeBridgeStatus) => void,
): Promise<UnlistenFn> {
  return listen<OpenCodeBridgeStatus>('opencode-bridge-status', (event) => handler(event.payload))
}
