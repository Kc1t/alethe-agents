import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { AI_MEMORY_DEFAULT_PORT } from '../aiMemory'

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
  return listen<CodexAppServerEvent>(`agent-sandbox-app-server://event/${id}`, (event) =>
    handler(event.payload),
  )
}

/**
 * The live capture consent, read fresh (never from the debounced `projects.json` on disk) so a
 * terminal opened right after the person flips the preference gets their current choice. The store
 * is imported lazily: it imports these bindings itself, and a static cycle breaks module mocks.
 */
async function liveAiMemoryPrefs(): Promise<{ enabled: boolean; port: number }> {
  const { useProjectsStore } = await import('../../stores/projectsStore')
  const prefs = useProjectsStore.getState().preferences
  return { enabled: prefs.enabledFeatures.aiMemory, port: AI_MEMORY_DEFAULT_PORT }
}

/** Live voice-conversation preference; imported lazily for the same reason as `liveAiMemoryPrefs`. */
async function liveVoicePref(): Promise<boolean> {
  const { useProjectsStore } = await import('../../stores/projectsStore')
  return Boolean(useProjectsStore.getState().preferences.voiceConversationEnabled)
}

/**
 * Path of the hooks settings.json generated for Claude Code (agent_events.rs).
 * `orchestrator: false` writes the session-tracking-only variant (SessionStart/UserPromptSubmit),
 * without the subagent and tool-call hooks the orchestrator canvas needs.
 * `aiMemory` carries the live capture consent: when enabled, ai-memory's own hooks are merged into
 * this same file rather than into the person's own settings. It defaults to the live preference, so
 * a call site that forgets the argument still gets the person's actual choice; pass `null` explicitly
 * to opt a caller out of capture regardless of the preference (e.g. a demo sandbox).
 * `voice` adds the tool, stop and permission hooks voice conversation listens to; it defaults to the
 * live preference and applies to terminals launched afterwards.
 */
export async function agentHooksSettingsPath(
  plannerId: string,
  orchestrator = true,
  aiMemory?: { enabled: boolean; port: number } | null,
  voice?: boolean,
): Promise<string> {
  if (aiMemory === undefined) aiMemory = await liveAiMemoryPrefs()
  if (voice === undefined) voice = await liveVoicePref()
  return invoke<string>('agent_hooks_settings_path', {
    plannerId,
    orchestrator,
    aiMemoryEnabled: aiMemory?.enabled ?? false,
    aiMemoryPort: aiMemory?.port ?? null,
    voice,
  })
}

/** Publishes the main window's subagent canvas for detached orchestration boards. */
export async function setAgentCanvasMirror(snapshot: string): Promise<void> {
  await invoke('set_agent_canvas_mirror', { snapshot })
}

/** The subagent canvas the main window last published, if it has published one. */
export async function agentCanvasMirror(): Promise<string | null> {
  return invoke<string | null>('agent_canvas_mirror')
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

/** Copies a validated `.ico` into app data as the icon of the custom agent `agentId`. */
export async function importCustomAgentIcon(sourcePath: string, agentId: string): Promise<void> {
  await invoke('import_custom_agent_icon', { sourcePath, agentId })
}

/** A custom agent's stored icon as a data URL; rejects when it has none. */
export async function customAgentIconDataUrl(agentId: string): Promise<string> {
  return invoke<string>('custom_agent_icon_data_url', { agentId })
}

export async function removeCustomAgentIcon(agentId: string): Promise<void> {
  await invoke('remove_custom_agent_icon', { agentId })
}

export type PermissionBehavior = 'allow' | 'deny' | 'defer'

/** Answers a PermissionRequest Alethe is holding for a voice conversation (agent_events.rs). */
export async function agentPermissionDecide(
  requestId: string,
  behavior: PermissionBehavior,
  message?: string,
): Promise<void> {
  await invoke('agent_permission_decide', { requestId, behavior, message: message ?? null })
}

/** The PTYs whose permission requests Alethe holds for a voice answer; others get Claude's prompt. */
export async function voiceSetTargets(ptyIds: string[]): Promise<void> {
  await invoke('voice_set_targets', { ptyIds })
}

/** PTYs whose Claude was launched with the voice hooks; only these can be voice targets. */
export async function agentVoiceHookedPtys(): Promise<string[]> {
  return invoke<string[]>('agent_voice_hooked_ptys')
}

export type PermissionReleased = {
  requestId: string
  reason: 'timeout' | 'untargeted' | 'shutdown'
}

export function onAgentPermissionReleased(
  handler: (event: PermissionReleased) => void,
): Promise<UnlistenFn> {
  return listen<PermissionReleased>('agent-permission://released', (event) =>
    handler(event.payload),
  )
}
