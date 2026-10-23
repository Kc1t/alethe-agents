import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { AppDialogHost } from './index'

const HOST_ID = 'alethe-app-dialogs'

type HostElement = HTMLElement & { __aletheDialogRoot?: Root }

/**
 * Mounts the dialog host in its own root on first use, so every window (main app, detached
 * orchestration board) gets it without wiring. Idempotent across HMR reloads.
 */
export function ensureAppDialogHost(): void {
  if (typeof document === 'undefined') return
  let node = document.getElementById(HOST_ID) as HostElement | null
  if (!node) {
    node = document.createElement('div') as HostElement
    node.id = HOST_ID
    document.body.appendChild(node)
  }
  node.__aletheDialogRoot ??= createRoot(node)
  node.__aletheDialogRoot.render(createElement(AppDialogHost))
}
