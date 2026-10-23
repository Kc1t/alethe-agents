import { confirm, type DialogFilter, message, open, save } from '@tauri-apps/plugin-dialog'

import { ensureAppDialogHost } from '../components/AppDialogs/mount'
import { useUiStore } from '../stores/uiStore'
import { openAppDialog } from './appDialogs'
import { getLocale, translate } from './i18n'

function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export type FsBrowserCallback = (path: string | null) => void

let pendingFsResolver: FsBrowserCallback | null = null

export function resolvePendingFsBrowser(path: string | null) {
  if (pendingFsResolver) {
    pendingFsResolver(path)
    pendingFsResolver = null
  }
}

export async function pickDirectory(opts?: { defaultPath?: string }): Promise<string | null> {
  if (!isTauriEnv()) {
    return new Promise<string | null>((resolve) => {
      pendingFsResolver = resolve
      useUiStore.getState().openModal_('fsBrowser', {
        mode: 'folder',
        defaultPath: opts?.defaultPath,
      })
    })
  }
  const result = await open({
    directory: true,
    multiple: false,
    defaultPath: opts?.defaultPath,
  })
  if (typeof result === 'string') return result
  return null
}

export async function pickFile(opts?: {
  title?: string
  filters?: DialogFilter[]
  defaultPath?: string
}): Promise<string | null> {
  if (!isTauriEnv()) {
    return new Promise<string | null>((resolve) => {
      pendingFsResolver = resolve
      useUiStore.getState().openModal_('fsBrowser', {
        mode: 'file',
        title: opts?.title,
        defaultPath: opts?.defaultPath,
      })
    })
  }
  const result = await open({
    directory: false,
    multiple: false,
    title: opts?.title,
    filters: opts?.filters,
    defaultPath: opts?.defaultPath,
  })
  if (typeof result === 'string') return result
  return null
}

export async function saveFile(opts: {
  title?: string
  defaultPath?: string
  filters?: DialogFilter[]
}): Promise<string | null> {
  if (!isTauriEnv()) {
    return new Promise<string | null>((resolve) => {
      pendingFsResolver = resolve
      useUiStore.getState().openModal_('fsBrowser', {
        mode: 'file',
        title: opts.title,
        defaultPath: opts.defaultPath,
      })
    })
  }
  const result = await save({
    title: opts.title,
    defaultPath: opts.defaultPath,
    filters: opts.filters,
  })
  return result ?? null
}

// `window.confirm/alert/prompt` are no-ops in WKWebView (macOS): confirm resolves false, prompt
// null, and alert shows nothing. Everything goes through the helpers below instead.

export type DialogKind = 'info' | 'warning' | 'error'

/**
 * Outside Tauri (Vite dev server, tests) and under WebDriver automation (the E2E suite answers
 * dialogs through `acceptAlert()`), the browser dialogs are used for confirm/message.
 */
function prefersBrowserDialogs(): boolean {
  return !isTauriEnv() || (typeof navigator !== 'undefined' && navigator.webdriver === true)
}

export type ConfirmActionOptions = {
  title?: string
  /** Icon of the native dialog; defaults to 'warning'. */
  kind?: DialogKind
  okLabel?: string
  cancelLabel?: string
  /** Called when the native dialog fails, before falling back to the in-app one. */
  onNativeError?: (error: unknown) => void
}

export type ShowMessageOptions = {
  title?: string
  /** Icon of the native dialog; defaults to 'info'. */
  kind?: DialogKind
  okLabel?: string
}

export type PromptTextOptions = {
  title?: string
  defaultValue?: string
  okLabel?: string
  cancelLabel?: string
}

/**
 * Asks the user to confirm an action. Native dialog under Tauri, the in-app dialog when the
 * native one fails, and `window.confirm` where `prefersBrowserDialogs()` holds.
 */
export async function confirmAction(
  text: string,
  opts: ConfirmActionOptions = {},
): Promise<boolean> {
  if (prefersBrowserDialogs()) return window.confirm(text)
  const locale = getLocale()
  const kind = opts.kind ?? 'warning'
  const okLabel = opts.okLabel ?? translate(locale, 'common.ok')
  const cancelLabel = opts.cancelLabel ?? translate(locale, 'common.cancel')
  try {
    return await confirm(text, { title: opts.title, kind, okLabel, cancelLabel })
  } catch (error) {
    if (opts.onNativeError) opts.onNativeError(error)
    else console.warn('[dialog] native confirm failed, using the in-app dialog:', error)
    ensureAppDialogHost()
    const result = await openAppDialog({
      kind: 'confirm',
      message: text,
      title: opts.title,
      okLabel,
      cancelLabel,
      danger: kind !== 'info',
    })
    return result.confirmed
  }
}

/** Shows an informational or error message and resolves once it is dismissed. */
export async function showMessage(text: string, opts: ShowMessageOptions = {}): Promise<void> {
  if (prefersBrowserDialogs()) {
    window.alert(text)
    return
  }
  const okLabel = opts.okLabel ?? translate(getLocale(), 'common.ok')
  try {
    await message(text, { title: opts.title, kind: opts.kind ?? 'info', okLabel })
  } catch (error) {
    console.warn('[dialog] native message failed, using the in-app dialog:', error)
    ensureAppDialogHost()
    await openAppDialog({ kind: 'message', message: text, title: opts.title, okLabel })
  }
}

/**
 * Asks for a line of text in the in-app dialog (there is no native text-input dialog). Resolves
 * with the raw text, or null when cancelled — the same contract as `window.prompt`.
 */
export async function promptText(
  text: string,
  opts: PromptTextOptions = {},
): Promise<string | null> {
  ensureAppDialogHost()
  const result = await openAppDialog({
    kind: 'prompt',
    message: text,
    title: opts.title,
    defaultValue: opts.defaultValue,
    okLabel: opts.okLabel,
    cancelLabel: opts.cancelLabel,
  })
  return result.confirmed ? result.value : null
}
