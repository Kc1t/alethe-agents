import { useEffect, useRef } from 'react'

import { SESSION_PERMANENT } from '../components/modals/RemoteControlSettingsFields'
import { translate } from '../lib/i18n'
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
import { flushProjectsState, useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

// The backend treats the highest id it has seen as the authoritative
// enable/disable request, so ids must keep growing across remounts and HMR.
let remoteControlRequestId = Date.now() * 1_000

function nextRemoteControlRequestId(): number {
  remoteControlRequestId += 1
  return remoteControlRequestId
}

export function useRemoteControlService() {
  const startupSyncedRef = useRef(false)
  const syncSequence = useRef(0)
  const syncQueue = useRef(Promise.resolve())
  const hydrated = useProjectsStore((store) => store.hydrated)
  const enabled = useProjectsStore((store) => store.preferences.remoteEnabled)
  const maxDevices = useProjectsStore((store) => store.preferences.remoteMaxDevices)
  const expiry = useProjectsStore((store) => store.preferences.remoteSessionExpirySecs)
  const readOnly = useProjectsStore((store) => store.preferences.remoteReadOnly)
  const allowShellInput = useProjectsStore((store) => store.preferences.remoteAllowShellInput)
  const useTailscale = useProjectsStore((store) => store.preferences.remoteUseTailscale)

  useEffect(() => {
    if (!hydrated) return
    const sequence = ++syncSequence.current
    const requestId = nextRemoteControlRequestId()

    // Remote Control is session-scoped: a saved "on" does not reopen the
    // listener after a restart. The one exception is the opt-in permanent
    // session, which only exists behind a PIN and whose whole point is that the
    // phone reconnects after a restart.
    let wanted = enabled
    if (!startupSyncedRef.current) {
      startupSyncedRef.current = true
      if (enabled && expiry !== SESSION_PERMANENT) {
        useProjectsStore.getState().setPreferences({ remoteEnabled: false })
        wanted = false
      }
    }

    if (!wanted) {
      // Disabling bypasses the queue: it must not wait behind a pending enable.
      void setRemoteControlEnabled(false, requestId).catch((error: unknown) => {
        if (useProjectsStore.getState().preferences.remoteEnabled) return
        const locale = useProjectsStore.getState().preferences.language
        useUiStore.getState().pushToast({
          title: translate(locale, 'remote.disableFailedTitle'),
          body: translate(locale, 'remote.disableFailedBody', { error: String(error) }),
        })
      })
      return
    }

    const sync = async () => {
      if (sequence !== syncSequence.current) return

      try {
        // Fail closed: every policy must be applied before a listener opens.
        await Promise.all([
          setRemoteControlMaxDevices(maxDevices),
          setRemoteControlSessionExpiry(expiry),
          setRemoteControlReadOnly(readOnly),
          setRemoteControlShellInput(allowShellInput),
        ])
        if (sequence !== syncSequence.current) return
        await setRemoteControlReachMode(useTailscale)
        if (sequence !== syncSequence.current) return

        const status = await setRemoteControlEnabled(true, requestId)
        if (sequence !== syncSequence.current) return
        if (!status.enabled) {
          throw new Error('Remote control did not report active listeners.')
        }
      } catch (error) {
        if (sequence !== syncSequence.current) return
        const store = useProjectsStore.getState()
        if (!store.preferences.remoteEnabled) return

        const stopError = await setRemoteControlEnabled(false, requestId).then(
          () => null,
          (stopFailure: unknown) => stopFailure,
        )
        if (sequence !== syncSequence.current) return

        const locale = store.preferences.language
        store.setPreferences({ remoteEnabled: false })
        const persistenceError = await flushProjectsState().then(
          () => null,
          (saveFailure: unknown) => saveFailure,
        )
        if (stopError || persistenceError) {
          useUiStore.getState().pushToast({
            title: translate(locale, 'remote.rollbackFailedTitle'),
            body: translate(locale, 'remote.rollbackFailedBody', {
              error: String(error),
              rollbackError: String(stopError ?? persistenceError),
            }),
          })
          return
        }
        useUiStore.getState().pushToast({
          title: translate(locale, 'remote.enableFailedTitle'),
          body: translate(locale, 'remote.enableFailedBody', { error: String(error) }),
        })
      }
    }

    syncQueue.current = syncQueue.current.catch(() => undefined).then(sync)
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
