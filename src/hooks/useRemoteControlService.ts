import { useEffect } from 'react'

import {
  listenRemoteAutoDisabled,
  listenRemoteMessages,
  listenRemoteStartFailed,
  setRemoteControlEnabled,
  setRemoteControlMaxDevices,
  setRemoteControlReachMode,
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
  const useTailscale = useProjectsStore((store) => store.preferences.remoteUseTailscale)

  useEffect(() => {
    if (!hydrated) return
    const sync = async () => {
      await setRemoteControlMaxDevices(maxDevices)
      await setRemoteControlSessionExpiry(expiry)
      await setRemoteControlReadOnly(readOnly)
      await setRemoteControlShellInput(allowShellInput)
      await setRemoteControlReachMode(useTailscale)
      await setRemoteControlEnabled(enabled)
    }
    void sync().catch(() => undefined)
  }, [allowShellInput, enabled, expiry, hydrated, maxDevices, readOnly, useTailscale])

  useEffect(() => {
    if (!hydrated) return
    let unlistenStartFailed: (() => void) | undefined
    void listenRemoteStartFailed(() => {
      const locale = useProjectsStore.getState().preferences.language
      useProjectsStore.getState().setPreferences({ remoteEnabled: false })
      useUiStore.getState().pushToast({
        title: translate(locale, 'remote.startFailedToastTitle'),
        body: translate(locale, 'remote.startFailedToastBody'),
      })
    })
      .then((stop) => {
        unlistenStartFailed = stop
      })
      .catch(() => undefined)
    return () => {
      unlistenStartFailed?.()
    }
  }, [hydrated])

  useEffect(() => {
    if (!enabled) return
    let unlistenMessages: (() => void) | undefined
    let unlistenAutoDisabled: (() => void) | undefined
    void listenRemoteMessages((event) => {
      const locale = useProjectsStore.getState().preferences.language
      useUiStore.getState().pushToast({
        title: translate(locale, 'remote.toastTitle', { device: event.deviceName }),
        body: event.preview,
      })
    })
      .then((stop) => {
        unlistenMessages = stop
      })
      .catch(() => undefined)
    void listenRemoteAutoDisabled(() => {
      const locale = useProjectsStore.getState().preferences.language
      useProjectsStore.getState().setPreferences({ remoteEnabled: false })
      useUiStore.getState().pushToast({
        title: translate(locale, 'remote.autoDisabledToastTitle'),
        body: translate(locale, 'remote.autoDisabledToastBody'),
      })
    })
      .then((stop) => {
        unlistenAutoDisabled = stop
      })
      .catch(() => undefined)
    return () => {
      unlistenMessages?.()
      unlistenAutoDisabled?.()
    }
  }, [enabled])
}
