import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type SpawnPtyArgs = {
  cols: number
  rows: number
  id?: string
  command?: string
  cwd?: string
  extraArgs?: string[]
  /** Path absoluto pro launcher (override do auto-detect). */
  launcherOverride?: string
                                                                
  env?: Record<string, string>
}

export async function spawnPty(args: SpawnPtyArgs): Promise<{ id: string }> {
  return invoke<{ id: string }>('spawn_pty', {
    cols: args.cols,
    rows: args.rows,
    id: args.id,
    command: args.command,
    cwd: args.cwd,
    extraArgs: args.extraArgs,
    launcherOverride: args.launcherOverride,
    env: args.env,
  })
}

export async function ptyExists(id: string): Promise<boolean> {
  return invoke<boolean>('pty_exists', { id })
}

export async function attachPty(id: string, maxBytes = 512 * 1024): Promise<string> {
  return invoke<string>('attach_pty', { id, maxBytes })
}

export async function clearPtyScrollback(id: string): Promise<void> {
  await invoke('clear_pty_scrollback', { id })
}

export async function writePty(id: string, data: string): Promise<void> {
  await invoke('write_pty', { id, data })
}

export async function resizePty(id: string, cols: number, rows: number): Promise<void> {
  await invoke('resize_pty', { id, cols, rows })
}

export async function killPty(id: string): Promise<void> {
  await invoke('kill_pty', { id })
}

export async function setPtyReadState(id: string, active: boolean): Promise<void> {
  await invoke('set_pty_read_state', { id, active })
}

                                                                        
                                                                            
                                                                             
                                                              
/** Resolves false when the PTY was not registered yet, so the output gate kept its old value. */
export async function setPtyVisible(id: string, visible: boolean): Promise<boolean> {
  return invoke<boolean>('set_pty_visible', { id, visible })
}

export async function setPtyPriority(id: string, active: boolean): Promise<void> {
  await invoke('set_pty_priority', { id, active })
}

export type PtyTreeInfo = {
  pty_id: string
  root_pid: number | null
  descendants: number[]
  alive: boolean
}

export async function getPtyTreeInfo(ptyId: string): Promise<PtyTreeInfo> {
  return invoke<PtyTreeInfo>('get_pty_tree_info', { ptyId })
}

export async function killPtyTree(ptyId: string): Promise<number[]> {
  return invoke<number[]>('kill_pty_tree_cmd', { ptyId })
}

export async function restartPty(args: SpawnPtyArgs & { id: string }): Promise<{ id: string }> {
  return invoke<{ id: string }>('restart_pty', {
    id: args.id,
    command: args.command,
    cwd: args.cwd,
    extraArgs: args.extraArgs,
    launcherOverride: args.launcherOverride,
    env: args.env,
  })
}

export async function getPtyCwd(id: string): Promise<string | null> {
  return invoke<string | null>('get_pty_cwd', { id })
}

// --- Ghostty native terminal (macOS only) ---

export type GhosttySurfaceResponse = {
  id: string
  attached: boolean
}

                                                                          
export type WebRect = { x: number; y: number; width: number; height: number }

export type GhosttySpawnArgs = {
  id: string
                                                                    
  cwd?: string
                                                                                        
  command?: string
}

export async function ghosttySpawn(args: GhosttySpawnArgs): Promise<GhosttySurfaceResponse> {
  return invoke<GhosttySurfaceResponse>('ghostty_spawn', {
    id: args.id,
    cwd: args.cwd,
    command: args.command,
  })
}

export async function ghosttySyncFrame(id: string, rect: WebRect, scale: number): Promise<void> {
  await invoke('ghostty_sync_frame', { id, rect, scale })
}

export async function ghosttySetHidden(id: string, hidden: boolean): Promise<void> {
  await invoke('ghostty_set_hidden', { id, hidden })
}

export async function ghosttySetFocus(id: string, focused: boolean): Promise<void> {
  await invoke('ghostty_set_focus', { id, focused })
}

                                                                                  
export async function ghosttySurfaceExited(id: string): Promise<boolean> {
  return invoke<boolean>('ghostty_surface_exited', { id })
}

export async function ghosttyKill(id: string): Promise<void> {
  await invoke('ghostty_kill', { id })
}

                                                                              
export async function ghosttyKillAll(): Promise<void> {
  await invoke('ghostty_kill_all')
}

export type PtyProcessSnapshot = {
  id: string
  pid: number | null
  command: string | null
  cwd: string | null
  process_name: string | null
  cmdline: string | null
  memory_mb: number
  alive: boolean
}

export async function listPtyProcesses(): Promise<PtyProcessSnapshot[]> {
  return invoke<PtyProcessSnapshot[]>('list_pty_processes')
}

export function listenPtyData(id: string, handler: (chunk: string) => void): Promise<UnlistenFn> {
  return listen<string>(`pty://data/${id}`, (event) => handler(event.payload))
}

                                                                           
                                                                       
                                                                          
                               
export function listenPtyActivity(
  id: string,
  handler: (chunk: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(`pty://activity/${id}`, (event) => handler(event.payload))
}

export function listenPtyExit(
  id: string,
  handler: (payload: PtyExitPayload) => void,
): Promise<UnlistenFn> {
  return listen<PtyExitPayload>(`pty://exit/${id}`, (event) => handler(event.payload))
}

export type PtyExitReason = 'exited' | 'killed' | 'suspended' | 'restarted'

export type PtyExitPayload = {
  code: number | null
  reason: PtyExitReason
}
