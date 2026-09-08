import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog'

import { isTauriEnv } from './api/transport'

/**
 * Asks the user to confirm a destructive or irreversible action.
 *
 * Calls the dialog plugin directly rather than relying on the webview's `window.confirm`. Tauri
 * intercepts that global and routes it through the same plugin, but the interception was failing
 * with "dialog.confirm not allowed. Command not found" — and because a rejected promise is not a
 * `false` return, the caller's `if (!confirm(...))` never ran: the click did nothing at all, with
 * only an unhandled rejection in the console to show for it. Calling the plugin explicitly removes
 * that indirection.
 *
 * A failure is treated as "not confirmed". For a prompt that only guards destructive actions,
 * refusing to proceed is the safe direction to fail in.
 */
export async function confirmAction(message: string, title?: string): Promise<boolean> {
  if (!isTauriEnv()) return window.confirm(message)
  try {
    return await tauriConfirm(message, title ? { title } : undefined)
  } catch (cause) {
    console.error('[confirm] dialog failed, treating as declined', cause)
    return false
  }
}
