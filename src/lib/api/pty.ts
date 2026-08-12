import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { log } from '../logger'
import { createWebSocketStream, isTauriEnv, webApiFetch } from './transport'

export type SpawnPtyArgs = {
  cols: number
  rows: number
  id?: string
  command?: string
  cwd?: string
  extraArgs?: string[]
  launcherOverride?: string
  env?: Record<string, string>
}

export type PtyTreeInfo = {
  pty_id: string
  root_pid: number | null
  descendants: number[]
  alive: boolean
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

export type PtyExitReason = 'exited' | 'killed' | 'suspended' | 'restarted'

export type PtyExitPayload = {
  code: number | null
  reason: PtyExitReason
}

// Websockets de terminais em modo Web
const webSocketsMap = new Map<string, WebSocket>()
const webDataListeners = new Map<string, Set<(chunk: string) => void>>()
const webExitListeners = new Map<string, Set<(payload: PtyExitPayload) => void>>()

function getOrCreatePtyWs(id: string): WebSocket {
  let ws = webSocketsMap.get(id)
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    ws = createWebSocketStream(`/api/pty/ws/${id}`)
    webSocketsMap.set(id, ws)

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'data' && msg.chunk) {
          const listeners = webDataListeners.get(id)
          listeners?.forEach((fn) => fn(msg.chunk))
        } else if (msg.type === 'exit') {
          const listeners = webExitListeners.get(id)
          listeners?.forEach((fn) => fn({ code: msg.code ?? 0, reason: msg.reason || 'exited' }))
        }
      } catch {
        // Raw string payload fallback
        const listeners = webDataListeners.get(id)
        listeners?.forEach((fn) => fn(event.data))
      }
    }

    ws.onerror = (err) => {
      log('error', 'PTY WS', `Erro no WebSocket do terminal ${id}`, err)
    }

    ws.onclose = () => {
      log('info', 'PTY WS', `WebSocket do terminal ${id} fechado`)
      webSocketsMap.delete(id)
    }
  }
  return ws
}

export async function spawnPty(args: SpawnPtyArgs): Promise<{ id: string }> {
  if (isTauriEnv()) {
    return invoke<{ id: string }>('spawn_pty', args)
  }
  return webApiFetch<{ id: string }>('/api/pty/spawn', {
    method: 'POST',
    body: JSON.stringify(args),
  })
}

export async function ptyExists(id: string): Promise<boolean> {
  if (isTauriEnv()) {
    return invoke<boolean>('pty_exists', { id })
  }
  return webApiFetch<boolean>(`/api/pty/exists/${id}`)
}

export async function attachPty(id: string, maxBytes = 512 * 1024): Promise<string> {
  if (isTauriEnv()) {
    return invoke<string>('attach_pty', { id, maxBytes })
  }
  return webApiFetch<string>(`/api/pty/attach/${id}?maxBytes=${maxBytes}`)
}

export async function writePty(id: string, data: string): Promise<void> {
  if (isTauriEnv()) {
    await invoke('write_pty', { id, data })
    return
  }
  const ws = webSocketsMap.get(id)
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data }))
  } else {
    await webApiFetch(`/api/pty/write`, {
      method: 'POST',
      body: JSON.stringify({ id, data }),
    })
  }
}

export async function resizePty(id: string, cols: number, rows: number): Promise<void> {
  if (isTauriEnv()) {
    await invoke('resize_pty', { id, cols, rows })
    return
  }
  const ws = webSocketsMap.get(id)
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols, rows }))
  }
  await webApiFetch('/api/pty/resize', {
    method: 'POST',
    body: JSON.stringify({ id, cols, rows }),
  })
}

export async function killPty(id: string): Promise<void> {
  if (isTauriEnv()) {
    await invoke('kill_pty', { id })
    return
  }
  await webApiFetch(`/api/pty/kill`, {
    method: 'POST',
    body: JSON.stringify({ id }),
  })
  const ws = webSocketsMap.get(id)
  if (ws) {
    ws.close()
    webSocketsMap.delete(id)
  }
}

export async function setPtyReadState(id: string, active: boolean): Promise<void> {
  if (isTauriEnv()) {
    await invoke('set_pty_read_state', { id, active })
    return
  }
  await webApiFetch('/api/pty/read_state', {
    method: 'POST',
    body: JSON.stringify({ id, active }),
  })
}

export async function setPtyVisible(id: string, visible: boolean): Promise<void> {
  if (isTauriEnv()) {
    await invoke('set_pty_visible', { id, visible })
    return
  }
  await webApiFetch('/api/pty/visible', {
    method: 'POST',
    body: JSON.stringify({ id, visible }),
  })
}

export async function setPtyPriority(id: string, active: boolean): Promise<void> {
  if (isTauriEnv()) {
    await invoke('set_pty_priority', { id, active })
    return
  }
  await webApiFetch('/api/pty/priority', {
    method: 'POST',
    body: JSON.stringify({ id, active }),
  })
}

export async function getPtyTreeInfo(ptyId: string): Promise<PtyTreeInfo> {
  if (isTauriEnv()) {
    return invoke<PtyTreeInfo>('get_pty_tree_info', { ptyId })
  }
  return webApiFetch<PtyTreeInfo>(`/api/pty/tree/${ptyId}`)
}

export async function killPtyTree(ptyId: string): Promise<number[]> {
  if (isTauriEnv()) {
    return invoke<number[]>('kill_pty_tree_cmd', { ptyId })
  }
  return webApiFetch<number[]>(`/api/pty/tree/${ptyId}/kill`, { method: 'POST' })
}

export async function restartPty(args: SpawnPtyArgs & { id: string }): Promise<{ id: string }> {
  if (isTauriEnv()) {
    return invoke<{ id: string }>('restart_pty', args)
  }
  return webApiFetch<{ id: string }>('/api/pty/restart', {
    method: 'POST',
    body: JSON.stringify(args),
  })
}

export async function getPtyCwd(id: string): Promise<string | null> {
  if (isTauriEnv()) {
    return invoke<string | null>('get_pty_cwd', { id })
  }
  return webApiFetch<string | null>(`/api/pty/cwd/${id}`)
}

// Ghostty surface support (desktop macOS fallback)
export type GhosttySurfaceResponse = { id: string; attached: boolean }
export type WebRect = { x: number; y: number; width: number; height: number }
export type GhosttySpawnArgs = { id: string; cwd?: string; command?: string }

export async function ghosttySpawn(args: GhosttySpawnArgs): Promise<GhosttySurfaceResponse> {
  if (isTauriEnv()) return invoke<GhosttySurfaceResponse>('ghostty_spawn', args)
  return { id: args.id, attached: false }
}

export async function ghosttySyncFrame(id: string, rect: WebRect, scale: number): Promise<void> {
  if (isTauriEnv()) await invoke('ghostty_sync_frame', { id, rect, scale })
}

export async function ghosttySetHidden(id: string, hidden: boolean): Promise<void> {
  if (isTauriEnv()) await invoke('ghostty_set_hidden', { id, hidden })
}

export async function ghosttySetFocus(id: string, focused: boolean): Promise<void> {
  if (isTauriEnv()) await invoke('ghostty_set_focus', { id, focused })
}

export async function ghosttySurfaceExited(id: string): Promise<boolean> {
  if (isTauriEnv()) return invoke<boolean>('ghostty_surface_exited', { id })
  return true
}

export async function ghosttyKill(id: string): Promise<void> {
  if (isTauriEnv()) await invoke('ghostty_kill', { id })
}

export async function ghosttyKillAll(): Promise<void> {
  if (isTauriEnv()) await invoke('ghostty_kill_all')
}

export async function listPtyProcesses(): Promise<PtyProcessSnapshot[]> {
  if (isTauriEnv()) {
    return invoke<PtyProcessSnapshot[]>('list_pty_processes')
  }
  return webApiFetch<PtyProcessSnapshot[]>('/api/pty/processes')
}

export function listenPtyData(id: string, handler: (chunk: string) => void): Promise<UnlistenFn> {
  if (isTauriEnv()) {
    return listen<string>(`pty://data/${id}`, (event) => handler(event.payload))
  }
  getOrCreatePtyWs(id)
  let set = webDataListeners.get(id)
  if (!set) {
    set = new Set()
    webDataListeners.set(id, set)
  }
  set.add(handler)
  return Promise.resolve(() => {
    set?.delete(handler)
  })
}

export function listenPtyActivity(
  id: string,
  handler: (chunk: string) => void,
): Promise<UnlistenFn> {
  if (isTauriEnv()) {
    return listen<string>(`pty://activity/${id}`, (event) => handler(event.payload))
  }
  return listenPtyData(id, handler)
}

export function listenPtyExit(
  id: string,
  handler: (payload: PtyExitPayload) => void,
): Promise<UnlistenFn> {
  if (isTauriEnv()) {
    return listen<PtyExitPayload>(`pty://exit/${id}`, (event) => handler(event.payload))
  }
  getOrCreatePtyWs(id)
  let set = webExitListeners.get(id)
  if (!set) {
    set = new Set()
    webExitListeners.set(id, set)
  }
  set.add(handler)
  return Promise.resolve(() => {
    set?.delete(handler)
  })
}
