import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv, webApiFetch } from './transport'

export type AiMemoryStatus = {
  installed: boolean
  running: boolean
  command: string
  endpoint: string
  version?: string
}

export async function aiMemoryDetect(command?: string): Promise<AiMemoryStatus> {
  if (isTauriEnv()) return invoke<AiMemoryStatus>('ai_memory_detect', { command })
  return webApiFetch<AiMemoryStatus>(
    `/api/ai_memory/detect${command ? `?command=${encodeURIComponent(command)}` : ''}`,
  )
}

export async function aiMemoryMcpConfigPath(repo: string, command?: string): Promise<string> {
  if (isTauriEnv()) return invoke<string>('ai_memory_mcp_config_path', { repo, command })
  return webApiFetch<string>(
    `/api/ai_memory/mcp_config_path?repo=${encodeURIComponent(repo)}${command ? `&command=${encodeURIComponent(command)}` : ''}`,
  )
}

export async function aiMemoryOpenCodeConfigWrite(repo: string, command?: string): Promise<void> {
  if (isTauriEnv()) return invoke('ai_memory_opencode_config_write', { repo, command })
  await webApiFetch('/api/ai_memory/opencode_config_write', {
    method: 'POST',
    body: JSON.stringify({ repo, command }),
  })
}

export async function aiMemoryCodexConfigWrite(repo: string, command?: string): Promise<void> {
  if (isTauriEnv()) return invoke('ai_memory_codex_config_write', { repo, command })
  await webApiFetch('/api/ai_memory/codex_config_write', {
    method: 'POST',
    body: JSON.stringify({ repo, command }),
  })
}
