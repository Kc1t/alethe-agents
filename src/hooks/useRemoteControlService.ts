import { useEffect } from 'react'

import {
  listenRemoteMessages,
  setRemoteControlEnabled,
  setRemoteControlMaxDevices,
  setRemoteControlReadOnly,
  setRemoteControlSessionExpiry,
  setRemoteControlShellInput,
} from '../lib/tauri'
import { translate } from '../lib/i18n'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

export function useRemoteControlService() {
  const hydrated = useProjectsStore((store) => store.hydrated)
  const enabled = useProjectsStore((store) => store.preferences.remoteEnabled)
  const maxDevices = useProjectsStore((store) => store.preferences.remoteMaxDevices)
  const expiry = useProjectsStore((store) => store.preferences.remoteSessionExpirySecs)
  const readOnly = useProjectsStore((store) => store.preferences.remoteReadOnly)
  const allowShellInput = useProjectsStore((store) => store.preferences.remoteAllowShellInput)

  useEffect(() => {
    if (!hydrated) return
    const sync = async () => {
      await setRemoteControlMaxDevices(maxDevices)
      await setRemoteControlSessionExpiry(expiry)
      await setRemoteControlReadOnly(readOnly)
      await setRemoteControlShellInput(allowShellInput)
      await setRemoteControlEnabled(enabled)
    }
    void sync().catch(() => undefined)
  }, [allowShellInput, enabled, expiry, hydrated, maxDevices, readOnly])

  useEffect(() => {
    if (!enabled) return
    let unlisten: (() => void) | undefined
    void listenRemoteMessages((event) => {
      const locale = useProjectsStore.getState().preferences.language
      useUiStore.getState().pushToast({
        title: translate(locale, 'remote.toastTitle', { device: event.deviceName }),
        body: event.preview,
      })
    })
      .then((stop) => {
        unlisten = stop
      })
      .catch(() => undefined)
    return () => unlisten?.()
  }, [enabled])
}
