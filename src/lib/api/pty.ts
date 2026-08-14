import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { log } from '../logger'
import { getStorageNamespace } from '../storageNamespace'
import {
  canUseSharedCoreTransport,
  createWebSocketStream,
  invalidateCoreSessionToken,
  isTauriEnv,
  webApiFetch,
} from './transport'

export type SpawnPtyArgs = {
  cols: number
  rows: number
  id?: string
  command?: string
  cwd?: string
  extraArgs?: string[]
  launcherOverride?: string
  env?: Record<string, string>
  profileId?: string
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

export type PtyResyncReason = 'initial' | 'reconnect' | 'gap' | 'missing'

type WebPtySocketState = {
  id: string
  profileId: string
  ws: WebSocket | null
  opening: Promise<WebSocket> | null
  reconnectTimer: number | null
  reconnectAttempt: number
  hasOpened: boolean
  resyncOnNextOpen: boolean
  intentionallyClosed: boolean
}

const webSocketStates = new Map<string, WebPtySocketState>()
const webDataListeners = new Map<string, Set<(chunk: string, cursor?: number) => void>>()
const webActivityListeners = new Map<string, Set<(chunk: string, cursor?: number) => void>>()
const webExitListeners = new Map<string, Set<(payload: PtyExitPayload) => void>>()
const webResyncListeners = new Map<string, Set<(reason: PtyResyncReason) => void>>()
const ptyProfileOwners = new Map<string, string>()

function resolvePtyProfileId(id: string | undefined, profileId?: string): string {
  const resolved = profileId ?? (id ? ptyProfileOwners.get(id) : undefined) ?? getStorageNamespace()
  if (!resolved) throw new Error('A profileId is required for PTY operations')
  return resolved
}

function rememberPtyOwner(id: string, profileId: string): void {
  ptyProfileOwners.set(id, profileId)
}

function forgetPtyOwner(id: string, profileId: string): void {
  if (ptyProfileOwners.get(id) === profileId) ptyProfileOwners.delete(id)
}

function webPtyKey(id: string, profileId: string): string {
  return `${profileId}\u0000${id}`
}

function profileQuery(profileId: string): string {
  return `profileId=${encodeURIComponent(profileId)}`
}

function listenerCount<T>(listeners: Map<string, Set<T>>, id: string): number {
  return listeners.get(id)?.size ?? 0
}

function hasWebListeners(id: string): boolean {
  return (
    listenerCount(webDataListeners, id) +
      listenerCount(webActivityListeners, id) +
      listenerCount(webExitListeners, id) +
      listenerCount(webResyncListeners, id) >
    0
  )
}

function notifyWebResync(id: string, reason: PtyResyncReason): void {
  webResyncListeners.get(id)?.forEach((listener) => listener(reason))
}

function closeWebPtySocket(key: string): void {
  const state = webSocketStates.get(key)
  if (!state) return
  state.intentionallyClosed = true
  if (state.reconnectTimer !== null) window.clearTimeout(state.reconnectTimer)
  state.reconnectTimer = null
  state.ws?.close()
  webSocketStates.delete(key)
}

function scheduleWebSocketReconnect(key: string, state: WebPtySocketState): void {
  if (state.intentionallyClosed || state.reconnectTimer !== null || !hasWebListeners(key)) return
  const delay = Math.min(5_000, 250 * 2 ** Math.min(state.reconnectAttempt, 5))
  state.reconnectAttempt += 1
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null
    if (state.intentionallyClosed || !hasWebListeners(key)) return
    void openWebPtySocket(key, state).catch(() => {
      // onclose schedules the next bounded retry.
    })
  }, delay)
}

function dispatchWebSocketMessage(key: string, data: unknown): void {
  if (typeof data !== 'string') return
  try {
    const msg = JSON.parse(data)
    if (msg.type === 'data' && typeof msg.chunk === 'string') {
      const cursor = typeof msg.cursor === 'number' ? msg.cursor : undefined
      webDataListeners.get(key)?.forEach((listener) => listener(msg.chunk, cursor))
    } else if (msg.type === 'activity' && typeof msg.chunk === 'string') {
      const cursor = typeof msg.cursor === 'number' ? msg.cursor : undefined
      webActivityListeners.get(key)?.forEach((listener) => listener(msg.chunk, cursor))
    } else if (msg.type === 'exit') {
      webExitListeners
        .get(key)
        ?.forEach((listener) =>
          listener({ code: msg.code ?? null, reason: msg.reason || 'exited' }),
        )
    } else if (msg.type === 'gap') {
      // The server broadcast buffer overflowed. A scrollback replay is the
      // only safe recovery because the missing byte range is unavailable.
      notifyWebResync(key, 'gap')
    } else if (msg.type === 'missing') {
      notifyWebResync(key, 'missing')
    }
  } catch {
    webDataListeners.get(key)?.forEach((listener) => listener(data))
  }
}

function openWebPtySocket(key: string, state: WebPtySocketState): Promise<WebSocket> {
  if (state.ws?.readyState === WebSocket.OPEN) return Promise.resolve(state.ws)
  if (state.ws?.readyState === WebSocket.CONNECTING && state.opening) return state.opening

  if (state.reconnectTimer !== null) window.clearTimeout(state.reconnectTimer)
  state.reconnectTimer = null
  state.intentionallyClosed = false

  state.opening = createWebSocketStream(
    `/api/pty/ws/${encodeURIComponent(state.id)}?${profileQuery(state.profileId)}`,
  )
    .then(
      (ws) =>
        new Promise<WebSocket>((resolve, reject) => {
          state.ws = ws
          let settled = false
          const timeout = window.setTimeout(() => {
            if (settled) return
            settled = true
            reject(new Error(`PTY WebSocket open timed out: ${state.id}`))
            ws.close()
          }, 5_000)

          ws.onopen = () => {
            if (state.ws !== ws) return
            window.clearTimeout(timeout)
            const shouldResync = state.hasOpened || state.resyncOnNextOpen
            state.hasOpened = true
            state.resyncOnNextOpen = false
            state.reconnectAttempt = 0
            state.opening = null
            if (!settled) {
              settled = true
              resolve(ws)
            }
            if (shouldResync) notifyWebResync(key, 'reconnect')
          }

          ws.onmessage = (event) => dispatchWebSocketMessage(key, event.data)

          ws.onerror = (error) => {
            log('error', 'PTY WS', `WebSocket error for terminal ${state.id}`, error)
          }

          ws.onclose = () => {
            window.clearTimeout(timeout)
            if (state.ws !== ws) return
            state.ws = null
            state.opening = null
            if (!settled) {
              settled = true
              reject(new Error(`PTY WebSocket closed before opening: ${state.id}`))
            }
            invalidateCoreSessionToken()
            log('info', 'PTY WS', `WebSocket closed for terminal ${state.id}`)
            scheduleWebSocketReconnect(key, state)
          }
        }),
    )
    .catch((error) => {
      state.ws = null
      state.opening = null
      scheduleWebSocketReconnect(key, state)
      throw error
    })
  return state.opening
}

function getOrCreatePtyWs(id: string, profileId: string): Promise<WebSocket> {
  const key = webPtyKey(id, profileId)
  let state = webSocketStates.get(key)
  if (!state) {
    state = {
      id,
      profileId,
      ws: null,
      opening: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
      hasOpened: false,
      resyncOnNextOpen: false,
      intentionallyClosed: false,
    }
    webSocketStates.set(key, state)
  }
  return openWebPtySocket(key, state)
}

async function addWebListener<T>(
  id: string,
  profileId: string,
  listeners: Map<string, Set<T>>,
  listener: T,
): Promise<UnlistenFn> {
  const key = webPtyKey(id, profileId)
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(listener)

  try {
    await getOrCreatePtyWs(id, profileId)
  } catch (error) {
    const state = webSocketStates.get(key)
    if (state) state.resyncOnNextOpen = true
    log('error', 'PTY WS', `Failed to subscribe to terminal ${id}; reconnect scheduled`, error)
  }

  return () => {
    set?.delete(listener)
    if (set?.size === 0) listeners.delete(key)
    if (!hasWebListeners(key)) closeWebPtySocket(key)
  }
}

export async function spawnPty(args: SpawnPtyArgs): Promise<{ id: string }> {
  const owner = resolvePtyProfileId(args.id, args.profileId)
  const ownedArgs = { ...args, profileId: owner }
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    const response = await invoke<{ id: string }>('spawn_pty', ownedArgs)
    rememberPtyOwner(response.id, owner)
    return response
  }
  const response = await webApiFetch<{ id: string }>('/api/pty/spawn', {
    method: 'POST',
    body: JSON.stringify(ownedArgs),
  })
  rememberPtyOwner(response.id, owner)
  return response
}

export async function ptyExists(id: string, profileId?: string): Promise<boolean> {
  const owner = resolvePtyProfileId(id, profileId)
  let exists: boolean
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    exists = await invoke<boolean>('pty_exists', { id, profileId: owner })
  } else {
    exists = await webApiFetch<boolean>(
      `/api/pty/exists/${encodeURIComponent(id)}?${profileQuery(owner)}`,
    )
  }
  if (exists) rememberPtyOwner(id, owner)
  return exists
}

export async function attachPty(
  id: string,
  maxBytes = 512 * 1024,
  profileId?: string,
): Promise<string> {
  const owner = resolvePtyProfileId(id, profileId)
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    const content = await invoke<string>('attach_pty', { id, maxBytes, profileId: owner })
    rememberPtyOwner(id, owner)
    return content
  }
  const content = await webApiFetch<string>(
    `/api/pty/attach/${encodeURIComponent(id)}?maxBytes=${maxBytes}&${profileQuery(owner)}`,
  )
  rememberPtyOwner(id, owner)
  return content
}

export type PtyScrollbackSnapshot = {
  content: string
  cursor: number
}

export type PtyCursorChunk = { chunk: string; cursor?: number }

export function chunksAfterPtySnapshot(snapshotCursor: number, events: PtyCursorChunk[]): string[] {
  return events
    .filter((event) => event.cursor === undefined || event.cursor > snapshotCursor)
    .map((event) => event.chunk)
}

export async function attachPtySnapshot(
  id: string,
  maxBytes = 512 * 1024,
  profileId?: string,
): Promise<PtyScrollbackSnapshot> {
  const owner = resolvePtyProfileId(id, profileId)
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    const snapshot = {
      content: await invoke<string>('attach_pty', { id, maxBytes, profileId: owner }),
      cursor: 0,
    }
    rememberPtyOwner(id, owner)
    return snapshot
  }
  const snapshot = await webApiFetch<PtyScrollbackSnapshot>(
    `/api/pty/snapshot/${encodeURIComponent(id)}?maxBytes=${maxBytes}&${profileQuery(owner)}`,
  )
  rememberPtyOwner(id, owner)
  return snapshot
}

export async function writePty(id: string, data: string, profileId?: string): Promise<void> {
  const owner = resolvePtyProfileId(id, profileId)
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    await invoke('write_pty', { id, data, profileId: owner })
    return
  }
  const ws = webSocketStates.get(webPtyKey(id, owner))?.ws
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data }))
  } else {
    await webApiFetch(`/api/pty/write`, {
      method: 'POST',
      body: JSON.stringify({ id, data, profileId: owner }),
    })
  }
}

export async function resizePty(
  id: string,
  cols: number,
  rows: number,
  profileId?: string,
): Promise<void> {
  const owner = resolvePtyProfileId(id, profileId)
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    await invoke('resize_pty', { id, cols, rows, profileId: owner })
    return
  }
  const ws = webSocketStates.get(webPtyKey(id, owner))?.ws
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    return
  }
  await webApiFetch('/api/pty/resize', {
    method: 'POST',
    body: JSON.stringify({ id, cols, rows, profileId: owner }),
  })
}

export async function killPty(id: string, profileId?: string): Promise<void> {
  const owner = resolvePtyProfileId(id, profileId)
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    await invoke('kill_pty', { id, profileId: owner })
    forgetPtyOwner(id, owner)
    return
  }
  await webApiFetch(`/api/pty/kill`, {
    method: 'POST',
    body: JSON.stringify({ id, profileId: owner }),
  })
  closeWebPtySocket(webPtyKey(id, owner))
  forgetPtyOwner(id, owner)
}

export async function setPtyReadState(
  id: string,
  active: boolean,
  profileId?: string,
): Promise<void> {
  const owner = resolvePtyProfileId(id, profileId)
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    await invoke('set_pty_read_state', { id, active, profileId: owner })
    return
  }
  await webApiFetch('/api/pty/read_state', {
    method: 'POST',
    body: JSON.stringify({ id, active, profileId: owner }),
  })
}

export async function setPtyVisible(
  id: string,
  visible: boolean,
  profileId?: string,
): Promise<void> {
  const owner = resolvePtyProfileId(id, profileId)
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    await invoke('set_pty_visible', { id, visible, profileId: owner })
    return
  }
  await webApiFetch('/api/pty/visible', {
    method: 'POST',
    body: JSON.stringify({ id, visible, profileId: owner }),
  })
}

export async function setPtyPriority(
  id: string,
  active: boolean,
  profileId?: string,
): Promise<void> {
  const owner = resolvePtyProfileId(id, profileId)
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    await invoke('set_pty_priority', { id, active, profileId: owner })
    return
  }
  await webApiFetch('/api/pty/priority', {
    method: 'POST',
    body: JSON.stringify({ id, active, profileId: owner }),
  })
}

export async function getPtyTreeInfo(ptyId: string, profileId?: string): Promise<PtyTreeInfo> {
  const owner = resolvePtyProfileId(ptyId, profileId)
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return invoke<PtyTreeInfo>('get_pty_tree_info', { ptyId, profileId: owner })
  }
  return webApiFetch<PtyTreeInfo>(
    `/api/pty/tree/${encodeURIComponent(ptyId)}?${profileQuery(owner)}`,
  )
}

export async function killPtyTree(ptyId: string, profileId?: string): Promise<number[]> {
  const owner = resolvePtyProfileId(ptyId, profileId)
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return invoke<number[]>('kill_pty_tree_cmd', { ptyId, profileId: owner })
  }
  return webApiFetch<number[]>(
    `/api/pty/tree/${encodeURIComponent(ptyId)}/kill?${profileQuery(owner)}`,
    { method: 'POST' },
  )
}

export async function restartPty(args: SpawnPtyArgs & { id: string }): Promise<{ id: string }> {
  const owner = resolvePtyProfileId(args.id, args.profileId)
  const ownedArgs = { ...args, profileId: owner }
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    const response = await invoke<{ id: string }>('restart_pty', ownedArgs)
    rememberPtyOwner(response.id, owner)
    return response
  }
  const response = await webApiFetch<{ id: string }>('/api/pty/restart', {
    method: 'POST',
    body: JSON.stringify(ownedArgs),
  })
  rememberPtyOwner(response.id, owner)
  return response
}

export async function getPtyCwd(id: string, profileId?: string): Promise<string | null> {
  const owner = resolvePtyProfileId(id, profileId)
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return invoke<string | null>('get_pty_cwd', { id, profileId: owner })
  }
  return webApiFetch<string | null>(`/api/pty/cwd/${encodeURIComponent(id)}?${profileQuery(owner)}`)
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

export async function listPtyProcesses(profileId?: string): Promise<PtyProcessSnapshot[]> {
  const owner = resolvePtyProfileId(undefined, profileId)
  let processes: PtyProcessSnapshot[]
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    processes = await invoke<PtyProcessSnapshot[]>('list_pty_processes', { profileId: owner })
  } else {
    processes = await webApiFetch<PtyProcessSnapshot[]>(`/api/pty/processes?${profileQuery(owner)}`)
  }
  processes.forEach((process) => rememberPtyOwner(process.id, owner))
  return processes
}

export async function listenPtyData(
  id: string,
  handler: (chunk: string, cursor?: number) => void,
  profileId?: string,
): Promise<UnlistenFn> {
  const owner = resolvePtyProfileId(id, profileId)
  rememberPtyOwner(id, owner)
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return listen<string>(`pty://data/${id}`, (event) => handler(event.payload))
  }
  return addWebListener(id, owner, webDataListeners, handler)
}

export async function listenPtyActivity(
  id: string,
  handler: (chunk: string, cursor?: number) => void,
  profileId?: string,
): Promise<UnlistenFn> {
  const owner = resolvePtyProfileId(id, profileId)
  rememberPtyOwner(id, owner)
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return listen<string>(`pty://activity/${id}`, (event) => handler(event.payload))
  }
  return addWebListener(id, owner, webActivityListeners, handler)
}

export async function listenPtyExit(
  id: string,
  handler: (payload: PtyExitPayload) => void,
  profileId?: string,
): Promise<UnlistenFn> {
  const owner = resolvePtyProfileId(id, profileId)
  rememberPtyOwner(id, owner)
  const ownedHandler = (payload: PtyExitPayload) => {
    if (payload.reason === 'exited' || payload.reason === 'killed') {
      forgetPtyOwner(id, owner)
    }
    handler(payload)
  }
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) {
    return listen<PtyExitPayload>(`pty://exit/${id}`, (event) => ownedHandler(event.payload))
  }
  return addWebListener(id, owner, webExitListeners, ownedHandler)
}

/** Requests a scrollback replay after stream setup, reconnect, or a broadcast gap. */
export async function listenPtyResync(
  id: string,
  handler: (reason: PtyResyncReason) => void,
  profileId?: string,
): Promise<UnlistenFn> {
  const owner = resolvePtyProfileId(id, profileId)
  rememberPtyOwner(id, owner)
  if (isTauriEnv() && !(await canUseSharedCoreTransport())) return () => {}
  const unlisten = await addWebListener(id, owner, webResyncListeners, handler)
  handler('initial')
  return unlisten
}
