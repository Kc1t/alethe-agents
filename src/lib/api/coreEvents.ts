import type { ProfileMeta } from './profiles'
import { createWebSocketStream, invalidateCoreSessionToken } from './transport'

export type CoreSyncEvent = {
  sequence: number
  reason: string
  activeProfileId: string
  profiles: ProfileMeta[]
  activeProjectsRevision: string
  changedProfileId?: string
  changedProjectsRevision?: string
}

type CoreSyncListener = (event: CoreSyncEvent) => void | Promise<void>

/**
 * Subscribe to the single shared-core stream used by browser and Tauri clients.
 * Each reconnect starts with a complete snapshot before incremental events.
 */
export function subscribeCoreSyncEvents(listener: CoreSyncListener): () => void {
  let stopped = false
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectDelay = 500
  // Highest sequence applied on the *current* connection. Reset on every
  // reconnect (see `sawFirstFrameOnSocket` below) so a restarted core, whose
  // sequence counter starts over from a low number, doesn't get every one of
  // its events permanently ignored as "not newer than the previous instance".
  let lastAppliedSequence = -1
  let sawFirstFrameOnSocket = false

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000)
  }

  const connect = async () => {
    try {
      const nextSocket = await createWebSocketStream('/api/events/ws')
      if (stopped) {
        nextSocket.close()
        return
      }
      socket = nextSocket
      sawFirstFrameOnSocket = false
      nextSocket.onopen = () => {
        reconnectDelay = 500
      }
      nextSocket.onmessage = (message) => {
        if (typeof message.data !== 'string') return
        try {
          const event = JSON.parse(message.data) as CoreSyncEvent
          if (
            typeof event.sequence !== 'number' ||
            !event.activeProfileId ||
            !Array.isArray(event.profiles) ||
            !event.activeProjectsRevision
          ) {
            return
          }
          // The first frame on a freshly (re)opened connection is always the
          // server's authoritative "connected" snapshot. Accept it
          // unconditionally and use it to (re)establish the baseline for
          // this connection/instance, instead of comparing it against
          // whatever sequence the *previous* connection last saw.
          if (!sawFirstFrameOnSocket) {
            sawFirstFrameOnSocket = true
            lastAppliedSequence = event.sequence
            void listener(event)
            return
          }
          if (event.sequence <= lastAppliedSequence) return
          lastAppliedSequence = event.sequence
          void listener(event)
        } catch {
          // Ignore malformed frames and keep the stream alive for the next snapshot.
        }
      }
      nextSocket.onerror = () => nextSocket.close()
      nextSocket.onclose = () => {
        if (socket === nextSocket) socket = null
        if (stopped) return
        invalidateCoreSessionToken()
        scheduleReconnect()
      }
    } catch {
      if (!stopped) scheduleReconnect()
    }
  }

  void connect()

  return () => {
    stopped = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    socket?.close()
    socket = null
  }
}
