import { isLinux } from './platform'
import type { BrowserEngine } from './types'

/**
 * The engine a browser pane uses until the person picks one. On Linux, Tauri adds a child webview
 * to the window's own GTK box instead of placing it at the pane's bounds, so a native page would
 * be stacked under the app rather than inside its pane; the CDP engine draws inside the pane.
 */
export function defaultBrowserEngine(): BrowserEngine {
  return isLinux() ? 'cdp' : 'native'
}
