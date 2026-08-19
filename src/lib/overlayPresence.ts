const OVERLAY_SELECTOR = '[role="dialog"], [role="menu"]'

const listeners = new Set<() => void>()
let observer: MutationObserver | null = null
let overlayPresent = false

function readPresence(): boolean {
  return typeof document !== 'undefined' && document.querySelector(OVERLAY_SELECTOR) !== null
}

function refreshPresence(): void {
  const next = readPresence()
  if (next === overlayPresent) return
  overlayPresent = next
  for (const listener of listeners) listener()
}

function startObserver(): void {
  if (observer || typeof document === 'undefined') return
  overlayPresent = readPresence()
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
  return observer ? overlayPresent : readPresence()
}

/** Shares one document observer across all native browser surfaces. */
export function subscribeOverlayPresence(listener: () => void): () => void {
  listeners.add(listener)
  startObserver()
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    observer?.disconnect()
    observer = null
    overlayPresent = false
  }
}
