import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { readScopedStorage, writeScopedStorage } from '../lib/storageNamespace'
import {
  type NowPlaying,
  type SpotifyCredentials,
  spotifyGetCurrent,
  spotifyLogin,
  spotifyLogout,
  spotifyStatus,
} from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'

const POLL_MS = 8000
const LAST_TRACK_KEY = 'home.nowPlaying.last'

let statusRequest: Promise<boolean> | null = null
let currentRequest: { key: string; promise: Promise<NowPlaying | null> } | null = null

function getSpotifyStatus(): Promise<boolean> {
  if (!statusRequest) {
    const promise = spotifyStatus().finally(() => {
      if (statusRequest === promise) statusRequest = null
    })
    statusRequest = promise
  }
  return statusRequest
}

function getCurrentTrack(credentials: SpotifyCredentials): Promise<NowPlaying | null> {
  const key = `${credentials.clientId ?? ''}\u0000${credentials.clientSecret ?? ''}`
  if (currentRequest?.key === key) return currentRequest.promise

  const request = spotifyGetCurrent(credentials)
  const promise = request.finally(() => {
    if (currentRequest?.promise === promise) currentRequest = null
  })
  currentRequest = { key, promise }
  return promise
}

                                                                     
function loadLastTrack(): NowPlaying | null {
  try {
    const raw = readScopedStorage(LAST_TRACK_KEY, true)
    if (!raw) return null
    const parsed = JSON.parse(raw) as NowPlaying
    if (!parsed || typeof parsed.track !== 'string' || !parsed.track) return null
    return { ...parsed, playing: false }
  } catch {
    return null
  }
}

                                                                    
function saveLastTrack(np: NowPlaying): void {
  try {
    writeScopedStorage(LAST_TRACK_KEY, JSON.stringify(np))
  } catch {
                                             
  }
}

export type NowPlayingState = {
  /** null means the connection status is still being checked. */
  connected: boolean | null
                                           
  current: NowPlaying | null
  error: string | null
  loading: boolean
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  refresh: () => Promise<void>
}

   
                                                          
                                                              
                                                                       
   
export function useNowPlaying(enabled: boolean): NowPlayingState {
  const spotifyClientId = useProjectsStore((s) => s.preferences.spotifyClientId)
  const spotifyClientSecret = useProjectsStore((s) => s.preferences.spotifyClientSecret)
  const [connected, setConnected] = useState<boolean | null>(null)
                                                                       
  const [current, setCurrent] = useState<NowPlaying | null>(() => loadLastTrack())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const cancelledRef = useRef(false)
  const credentials = useMemo(
    () => ({
      clientId: spotifyClientId.trim() || undefined,
      clientSecret: spotifyClientSecret.trim() || undefined,
    }),
    [spotifyClientId, spotifyClientSecret],
  )

  const fetchCurrent = useCallback(async () => {
    try {
      const np = await getCurrentTrack(credentials)
      if (cancelledRef.current) return
      if (np) {
        setCurrent(np)
        saveLastTrack(np)
      } else {
                                                                     
        setCurrent((previous) => (previous ? { ...previous, playing: false } : null))
      }
      setError(null)
    } catch (err) {
      if (cancelledRef.current) return
      setError(String(err))
    }
  }, [credentials])

  // Check the connection once on mount. Concurrent widgets share the same request.
  useEffect(() => {
    cancelledRef.current = false
    getSpotifyStatus()
      .then((ok) => {
        if (cancelledRef.current) return
        setConnected(ok)
      })
      .catch(() => {
        if (!cancelledRef.current) setConnected(false)
      })
    return () => {
      cancelledRef.current = true
    }
  }, [])

  // Poll while visible. Concurrent widgets share each in-flight backend request.
  useEffect(() => {
    if (!enabled || !connected) return
    void fetchCurrent()
    const id = setInterval(fetchCurrent, POLL_MS)
    return () => clearInterval(id)
  }, [enabled, connected, fetchCurrent])

  const connect = async () => {
    setLoading(true)
    setError(null)
    try {
      await spotifyLogin(credentials)
      setConnected(true)
      await fetchCurrent()
    } catch (err) {
      setConnected(false)
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  const disconnect = async () => {
    await spotifyLogout()
    setConnected(false)
    setCurrent(null)
  }

  return {
    connected,
    current,
    error,
    loading,
    connect,
    disconnect,
    refresh: fetchCurrent,
  }
}
