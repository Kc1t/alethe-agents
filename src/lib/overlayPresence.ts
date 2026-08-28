// Anything that paints over a pane has to hide the native surfaces, because a native surface is
// composited above the DOM and no z-index can reach it. Listbox and alertdialog are included for
// dropdowns and confirmations, which sit over panes just like dialogs and menus do.
const OVERLAY_SELECTOR = '[role="dialog"], [role="menu"], [role="listbox"], [role="alertdialog"]'

const listeners = new Set<() => void>()
let observer: MutationObserver | null = null
let overlayNodePresent = false
let suspendCount = 0

function readNodePresence(): boolean {
  return typeof document !== 'undefined' && document.querySelector(OVERLAY_SELECTOR) !== null
}

function notify(): void {
  for (const listener of listeners) listener()
}

function refreshPresence(): void {
  const next = readNodePresence()
  if (next === overlayNodePresent) return
  overlayNodePresent = next
  notify()
}

function startObserver(): void {
  if (observer || typeof document === 'undefined') return
  overlayNodePresent = readNodePresence()
  observer = new MutationObserver(refreshPresence)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['role'],
  })
}

/** Returns whether a native-surface-blocking modal or menu is still mounted. */
export function isOverlayPresent(): boolean {
  if (suspendCount > 0) return true
  return observer ? overlayNodePresent : readNodePresence()
}

/**
 * Hides every native surface until the returned handle is released.
 *
 * Some things that cover a pane leave no queryable node behind — a native `confirm()`, a drag in
 * progress, a panel resize. Those call this instead of relying on the observer.
 */
export function suspendNativeSurfaces(): () => void {
  suspendCount += 1
  if (suspendCount === 1) notify()
  let released = false
  return () => {
    if (released) return
    released = true
    suspendCount -= 1
    if (suspendCount === 0) notify()
  }
}

/** Shares one document observer across all native surfaces. */
export function subscribeOverlayPresence(listener: () => void): () => void {
  listeners.add(listener)
  startObserver()
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    observer?.disconnect()
    observer = null
    overlayNodePresent = false
  }
}
