import { invoke } from '@tauri-apps/api/core'

                                                                         

export type AiMemoryStatus = {
                                                                      
  installed: boolean
  /** Servidor respondendo no endpoint loopback. */
  running: boolean
  command: string
  endpoint: string
  version?: string
}

export async function aiMemoryDetect(command?: string): Promise<AiMemoryStatus> {
  return invoke<AiMemoryStatus>('ai_memory_detect', { command })
}

export async function aiMemoryMcpConfigPath(repo: string, command?: string): Promise<string> {
  return invoke<string>('ai_memory_mcp_config_path', { repo, command })
}

                                                                                                                                  
export async function aiMemoryOpenCodeConfigWrite(repo: string, command?: string): Promise<void> {
  await invoke('ai_memory_opencode_config_write', { repo, command })
}

                                                                                                                                                               
export async function aiMemoryCodexConfigWrite(repo: string, command?: string): Promise<void> {
  await invoke('ai_memory_codex_config_write', { repo, command })
}
