import { useCallback, useEffect, useState } from 'react'

import { type RemoteControlInfo, remoteControlInfo } from '../lib/tauri'

export function useRemoteControl(active = true) {
  const [info, setInfo] = useState<RemoteControlInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setInfo(await remoteControlInfo())
      setError(null)
    } catch (value) {
      setError(String(value))
    }
  }, [])

  useEffect(() => {
    if (!active) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1000)
    return () => window.clearInterval(timer)
  }, [active, refresh])

  const run = useCallback(async (operation: () => Promise<RemoteControlInfo>) => {
    setBusy(true)
    try {
      const next = await operation()
      setInfo(next)
      setError(null)
      return next
    } catch (value) {
      setError(String(value))
      return null
    } finally {
      setBusy(false)
    }
  }, [])

  return {
    busy,
    enabled: info?.enabled === true,
    error,
    info,
    pairingOpen: info?.pairing_open === true,
    refresh,
    run,
  }
}
