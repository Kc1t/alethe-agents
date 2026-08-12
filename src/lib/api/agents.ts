import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { isTauriEnv, webApiFetch } from './transport'

export async function agentHooksEndpoint(): Promise<string> {
  if (isTauriEnv()) return invoke('agent_hooks_endpoint')
  return webApiFetch<string>('/api/agents/hooks_endpoint')
}

export async function agentHooksToken(): Promise<string> {
  if (isTauriEnv()) return invoke<string>('agent_hooks_token')
  return webApiFetch<string>('/api/agents/hooks_token')
}

export type CodexAppServerEvent = Record<string, unknown>

export async function codexAppServerStart(id: string, cwd: string): Promise<void> {
  if (isTauriEnv()) return invoke('codex_app_server_start', { id, cwd })
  await webApiFetch('/api/agents/codex_app_server/start', {
    method: 'POST',
    body: JSON.stringify({ id, cwd }),
  })
}

export async function codexAppServerSend(id: string, request: CodexAppServerEvent): Promise<void> {
  if (isTauriEnv()) return invoke('codex_app_server_send', { id, request })
  await webApiFetch('/api/agents/codex_app_server/send', {
    method: 'POST',
    body: JSON.stringify({ id, request }),
  })
}

export async function codexAppServerStop(id: string): Promise<void> {
  if (isTauriEnv()) return invoke('codex_app_server_stop', { id })
  await webApiFetch('/api/agents/codex_app_server/stop', {
    method: 'POST',
    body: JSON.stringify({ id }),
  })
}

export function listenCodexAppServer(
  id: string,
  handler: (event: CodexAppServerEvent) => void,
): Promise<UnlistenFn> {
  if (isTauriEnv()) {
    return listen<CodexAppServerEvent>(`agent-sandbox-app-server://event/${id}`, (event) =>
      handler(event.payload),
    )
  }
  return Promise.resolve(() => {})
}

export async function agentHooksSettingsPath(): Promise<string> {
  if (isTauriEnv()) return invoke<string>('agent_hooks_settings_path')
  return webApiFetch<string>('/api/agents/hooks_settings_path')
}

export type InstalledAgent = { name: string; from_alethe: boolean }

export async function listInstalledAgents(folder: string): Promise<InstalledAgent[]> {
  if (isTauriEnv()) return invoke<InstalledAgent[]>('list_installed_agents', { folder })
  return webApiFetch<InstalledAgent[]>(`/api/agents/installed?folder=${encodeURIComponent(folder)}`)
}

export async function economyAgentsEnabled(folder: string): Promise<boolean> {
  if (isTauriEnv()) return invoke<boolean>('economy_agents_enabled', { folder })
  return webApiFetch<boolean>(`/api/agents/economy_enabled?folder=${encodeURIComponent(folder)}`)
}

export async function setEconomyAgents(folder: string, enabled: boolean): Promise<string[]> {
  if (isTauriEnv()) return invoke<string[]>('set_economy_agents', { folder, enabled })
  return webApiFetch<string[]>('/api/agents/set_economy', {
    method: 'POST',
    body: JSON.stringify({ folder, enabled }),
  })
}

export async function installAgent(args: {
  folder: string
  name: string
  content: string
  force: boolean
}): Promise<string> {
  if (isTauriEnv()) return invoke<string>('install_agent', args)
  return webApiFetch<string>('/api/agents/install', { method: 'POST', body: JSON.stringify(args) })
}

export async function uninstallAgent(folder: string, name: string, force = true): Promise<void> {
  if (isTauriEnv()) return invoke('uninstall_agent', { folder, name, force })
  await webApiFetch('/api/agents/uninstall', {
    method: 'POST',
    body: JSON.stringify({ folder, name, force }),
  })
}

export type DiscoveredModel = { id: string; label: string }

export async function discoverProviderModels(provider: string): Promise<DiscoveredModel[]> {
  if (isTauriEnv()) return invoke<DiscoveredModel[]>('discover_provider_models', { provider })
  return webApiFetch<DiscoveredModel[]>(
    `/api/agents/models?provider=${encodeURIComponent(provider)}`,
  )
}

export type OpenCodeBridgeStatus = {
  directory: string
  state: 'working' | 'idle'
}

export function listenOpenCodeBridgeStatus(
  handler: (payload: OpenCodeBridgeStatus) => void,
): Promise<UnlistenFn> {
  if (isTauriEnv()) {
    return listen<OpenCodeBridgeStatus>('opencode-bridge-status', (event) => handler(event.payload))
  }
  return Promise.resolve(() => {})
}

export type PluginKind = 'agentType' | 'skill' | 'validationPipeline'

export type PluginManifest = {
  name: string
  version: string
  kind: PluginKind
  description: string
  spec: Record<string, unknown>
}

export async function pluginsList(kind?: PluginKind): Promise<PluginManifest[]> {
  if (isTauriEnv()) return invoke<PluginManifest[]>('plugins_list', { kind })
  return webApiFetch<PluginManifest[]>(`/api/plugins/list${kind ? `?kind=${kind}` : ''}`)
}

export async function pluginInstall(manifest: PluginManifest): Promise<void> {
  if (isTauriEnv()) return invoke('plugin_install', { manifest })
  await webApiFetch('/api/plugins/install', { method: 'POST', body: JSON.stringify({ manifest }) })
}

export async function pluginUninstall(id: string): Promise<void> {
  if (isTauriEnv()) return invoke('plugin_uninstall', { id })
  await webApiFetch('/api/plugins/uninstall', { method: 'POST', body: JSON.stringify({ id }) })
}
