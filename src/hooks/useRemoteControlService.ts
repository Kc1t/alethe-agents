import { useEffect, useRef } from 'react'

import { translate } from '../lib/i18n'
import {
  listenRemoteMessages,
  setRemoteControlEnabled,
  setRemoteControlMaxDevices,
  setRemoteControlReadOnly,
  setRemoteControlSessionExpiry,
  setRemoteControlShellInput,
} from '../lib/tauri'
import { flushProjectsState, useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

let remoteControlRequestId = Date.now() * 1_000

function nextRemoteControlRequestId(): number {
  remoteControlRequestId += 1
  return remoteControlRequestId
}

export function useRemoteControlService() {
  const hydrated = useProjectsStore((store) => store.hydrated)
  const enabled = useProjectsStore((store) => store.preferences.remoteEnabled)
  const maxDevices = useProjectsStore((store) => store.preferences.remoteMaxDevices)
  const expiry = useProjectsStore((store) => store.preferences.remoteSessionExpirySecs)
  const readOnly = useProjectsStore((store) => store.preferences.remoteReadOnly)
  const allowShellInput = useProjectsStore((store) => store.preferences.remoteAllowShellInput)
  const syncSequence = useRef(0)
  const syncQueue = useRef(Promise.resolve())

  useEffect(() => {
    if (!hydrated) return
    const sequence = ++syncSequence.current
    const requestId = nextRemoteControlRequestId()

    if (!enabled) {
      void setRemoteControlEnabled(false, requestId).catch((error) => {
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
        await Promise.all([
          setRemoteControlMaxDevices(maxDevices),
          setRemoteControlSessionExpiry(expiry),
          setRemoteControlReadOnly(readOnly),
          setRemoteControlShellInput(allowShellInput),
        ])
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
