import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

import { useUiStore } from '../stores/uiStore'
import type { AgentType } from './types'

let permissionPromise: Promise<boolean> | null = null

/**
 * App "na frente" = janela focada e não minimizada. Quando true mostramos o
 * banner in-app; quando false (alt-tab, minimizado, atrás de outra janela)
 * disparamos a notificação do SO. Nunca os dois — evita aviso duplicado.
 */
import { isTauriEnv } from './api/transport'

async function appInForeground(): Promise<boolean> {
  if (!isTauriEnv()) {
    try {
      return document.hasFocus()
    } catch {
      return true
    }
  }
  try {
    const win = getCurrentWindow()
    const [focused, minimized] = await Promise.all([win.isFocused(), win.isMinimized()])
    return focused && !minimized
  } catch {
    return document.hasFocus()
  }
}

async function ensureNotificationPermission(): Promise<boolean> {
  if (!permissionPromise) {
    permissionPromise = (async () => {
      try {
        if (await isPermissionGranted()) return true
        return (await requestPermission()) === 'granted'
      } catch {
        return false
      }
    })()
  }
  return permissionPromise
}

async function deliver(title: string, body: string, agent?: AgentType): Promise<void> {
  const pushToast = useUiStore.getState().pushToast

  if (await appInForeground()) {
    pushToast({ title, body, agent })
    return
  }

  if (await ensureNotificationPermission()) {
    pushToast({ title, body, agent, silent: true })
    try {
      sendNotification({ title, body })
    } catch {
      /* Notification failures should not affect the terminal session. */
    }
  } else {
    pushToast({ title, body, agent })
  }
}

export async function notifyAgentDone(
  title: string,
  body: string,
  meta?: { agent?: AgentType },
): Promise<void> {
  return deliver(title, body, meta?.agent)
}

export async function notifyLimitReset(
  title: string,
  body: string,
  agent?: AgentType,
): Promise<void> {
  return deliver(title, body, agent)
}
