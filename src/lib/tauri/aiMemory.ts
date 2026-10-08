import { invoke } from '@tauri-apps/api/core'

export type AiMemoryStatus = {
  installed: boolean
  /** Something answers on the loopback endpoint — not necessarily a server Alethe started. */
  running: boolean
  command: string
  endpoint: string
  version: string | null
  /** The binary is the copy Alethe installed, not one found on PATH. */
  managed: boolean
  /** Upstream publishes a build for this machine. False on Windows ARM64. */
  supported: boolean
  /** The server behind `endpoint`, if any, is the child process Alethe itself started. */
  ours: boolean
}

export async function aiMemoryDetect(command?: string): Promise<AiMemoryStatus> {
  return invoke<AiMemoryStatus>('ai_memory_detect', { command })
}

// These three no longer take a `command`: they register ai-memory's MCP server as a loopback HTTP
// endpoint, which needs a port, not a binary to spawn — see `mcp_server_spec` in `ai_memory.rs`.
export async function aiMemoryMcpConfigPath(repo: string): Promise<string> {
  return invoke<string>('ai_memory_mcp_config_path', { repo })
}

export async function aiMemoryOpenCodeConfigWrite(repo: string): Promise<void> {
  await invoke('ai_memory_opencode_config_write', { repo })
}

export async function aiMemoryCodexConfigWrite(repo: string): Promise<void> {
  await invoke('ai_memory_codex_config_write', { repo })
}

export type AiMemoryCounts = { sessions: number; observations: number; pages: number }

export async function aiMemoryInstall(): Promise<string> {
  return invoke<string>('ai_memory_install')
}

export async function aiMemoryStart(port?: number): Promise<void> {
  await invoke('ai_memory_start', { port })
}

export async function aiMemoryStop(): Promise<void> {
  await invoke('ai_memory_stop')
}

/**
 * `null` means ai-memory could not be asked — the server is unreachable, `status` exited non-zero —
 * which is not the same thing as a store that has nothing in it yet. Callers must tell the two apart
 * rather than falling back to zeros for both.
 */
export async function aiMemoryCounts(): Promise<AiMemoryCounts | null> {
  return invoke<AiMemoryCounts | null>('ai_memory_counts', {})
}
