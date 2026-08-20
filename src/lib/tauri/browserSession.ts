import { invoke } from '@tauri-apps/api/core'

export type BrowserSessionInfo = {
  endpoint: string
  port: number
  executable: string
  profileDir: string
}

/** Starts the shared automation browser, or returns the one already running. */
export async function browserSessionStart(executable?: string): Promise<BrowserSessionInfo> {
  return invoke<BrowserSessionInfo>('browser_session_start', { executable })
}

export async function browserSessionStop(): Promise<void> {
  await invoke('browser_session_stop')
}

export async function browserSessionStatus(): Promise<BrowserSessionInfo | null> {
  return invoke<BrowserSessionInfo | null>('browser_session_status')
}

/** Writes an ephemeral MCP config pointing Playwright at the running browser. */
export async function playwrightMcpConfigPath(): Promise<string> {
  return invoke<string>('playwright_mcp_config_path')
}
