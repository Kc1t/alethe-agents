import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect } from 'react'

import { type CloseFailureStage, createCloseCoordinator } from '../lib/closeCoordinator'
import { confirmAction } from '../lib/dialog'
import { getLocale, translate } from '../lib/i18n'
import { isMacOS } from '../lib/platform'
import { quitApp, recordFrontendError } from '../lib/tauri'
import { flushProjectsState } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

function errorDetails(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack ?? null }
  }
  return { message: String(error), stack: null }
}

function reportCloseFailure(stage: CloseFailureStage, error: unknown): void {
  const details = errorDetails(error)
  void recordFrontendError(
    `App close failed during ${stage}: ${details.message}`,
    details.stack,
    'app-close',
  )

  if (stage !== 'quit') return
  const locale = getLocale()
  useUiStore.getState().pushToast({
    title: translate(locale, 'appClose.failedTitle'),
    body: translate(locale, 'appClose.failedBody'),
  })
}

const appWindow = getCurrentWindow()
const closeCoordinator = createCloseCoordinator({
  confirmNative: () => {
    const locale = getLocale()
    // A failing native dialog is reported and replaced by the in-app one, which also works on
    // macOS, where `window.confirm` always answers false.
    return confirmAction(translate(locale, 'appClose.message'), {
      title: translate(locale, 'appClose.title'),
      kind: 'warning',
      okLabel: translate(locale, 'appClose.confirm'),
      cancelLabel: translate(locale, 'appClose.cancel'),
      onNativeError: (error) => reportCloseFailure('confirm', error),
    })
  },
  // Last resort only: confirmAction already falls back to the in-app dialog. On macOS
  // `window.confirm` always answers false, which would leave the app impossible to close, and the
  // workspace is flushed before closing anyway.
  confirmFallback: () => isMacOS() || window.confirm(translate(getLocale(), 'appClose.message')),
  beforeClose: flushProjectsState,
  destroyWindow: () => appWindow.destroy(),
  quitApp: () => quitApp(),
  onFailure: reportCloseFailure,
})

export function requestAppClose(): Promise<void> {
  return closeCoordinator.handleCloseRequest({ preventDefault: () => {} })
}

export function useCloseConfirmation(): void {
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null

    void appWindow
      .onCloseRequested((event) => closeCoordinator.handleCloseRequest(event))
      .then((stopListening) => {
        if (cancelled) stopListening()
        else unlisten = stopListening
      })
      .catch((error) => reportCloseFailure('confirm', error))

    // Cmd+Q on macOS: the menu asks instead of quitting, so it gets the same confirmation and
    // flush as the window's close button (see macos_menu.rs).
    let unlistenQuit: (() => void) | null = null
    void listen('app://quit-requested', () => void requestAppClose())
      .then((stopListening) => {
        if (cancelled) stopListening()
        else unlistenQuit = stopListening
      })
      .catch((error) => reportCloseFailure('confirm', error))

    return () => {
      cancelled = true
      unlisten?.()
      unlistenQuit?.()
    }
  }, [])
}
