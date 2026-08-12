// Este foi feito para adicionar a verificação de isTauriEnv() antes de chamar getCurrentWindow() no useCloseConfirmation.ts, evitando o lançamento de exceção não tratada na Web que causava a tela branca no navegador.

import { getCurrentWindow } from '@tauri-apps/api/window'
import { confirm } from '@tauri-apps/plugin-dialog'
import { useEffect } from 'react'

import { isTauriEnv } from '../lib/api/transport'
import { type CloseFailureStage, createCloseCoordinator } from '../lib/closeCoordinator'
import { getLocale, translate } from '../lib/i18n'
import { quitApp, recordFrontendError } from '../lib/tauri'
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

const getAppWindowSafely = () => {
  if (typeof window === 'undefined' || !isTauriEnv()) return null
  try {
    return getCurrentWindow()
  } catch {
    return null
  }
}

const appWindow = getAppWindowSafely()
const closeCoordinator = createCloseCoordinator({
  confirmNative: () => {
    const locale = getLocale()
    return confirm(translate(locale, 'appClose.message'), {
      title: translate(locale, 'appClose.title'),
      kind: 'warning',
      okLabel: translate(locale, 'appClose.confirm'),
      cancelLabel: translate(locale, 'appClose.cancel'),
    })
  },
  confirmFallback: () => window.confirm(translate(getLocale(), 'appClose.message')),
  destroyWindow: () => (appWindow ? appWindow.destroy() : Promise.resolve()),
  quitApp: () => quitApp(),
  onFailure: reportCloseFailure,
})

export function requestAppClose(): Promise<void> {
  return closeCoordinator.handleCloseRequest({ preventDefault: () => {} })
}

export function useCloseConfirmation(): void {
  useEffect(() => {
    if (!appWindow) return
    const unlistenPromise = appWindow.onCloseRequested((event) => {
      event.preventDefault()
      void requestAppClose()
    })

    return () => {
      void unlistenPromise.then((unlisten) => unlisten())
    }
  }, [])
}
