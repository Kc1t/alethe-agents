// Queue behind the in-app confirm/message/prompt dialog. It replaces `window.prompt()` everywhere,
// and stands in for the native dialogs when they cannot be shown (e.g. a window without the
// dialog capability). WKWebView on macOS implements none of the `window.*` dialogs.

export type AppDialogKind = 'confirm' | 'message' | 'prompt'

export type AppDialogRequest = {
  id: number
  kind: AppDialogKind
  message: string
  title?: string
  okLabel?: string
  cancelLabel?: string
  /** Prompt only: the initial text in the input. */
  defaultValue?: string
  /** Confirm only: renders the accept button as destructive. */
  danger?: boolean
}

export type AppDialogResult = {
  confirmed: boolean
  /** Prompt only: the submitted text, or null when cancelled. */
  value: string | null
}

type PendingDialog = {
  request: AppDialogRequest
  settle: (result: AppDialogResult) => void
}

const listeners = new Set<() => void>()
let queue: PendingDialog[] = []
let nextId = 1

function notify(): void {
  for (const listener of listeners) listener()
}

/** Queues a dialog; dialogs are shown one at a time, oldest first. */
export function openAppDialog(request: Omit<AppDialogRequest, 'id'>): Promise<AppDialogResult> {
  return new Promise<AppDialogResult>((resolve) => {
    queue = [...queue, { request: { ...request, id: nextId++ }, settle: resolve }]
    notify()
  })
}

/** The dialog currently on screen (a stable reference while it stays open). */
export function activeAppDialog(): AppDialogRequest | null {
  return queue[0]?.request ?? null
}

export function settleAppDialog(id: number, result: AppDialogResult): void {
  const pending = queue.find((entry) => entry.request.id === id)
  if (!pending) return
  queue = queue.filter((entry) => entry !== pending)
  pending.settle(result)
  notify()
}

export function subscribeAppDialogs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
