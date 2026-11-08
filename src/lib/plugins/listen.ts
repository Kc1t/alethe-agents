import { auditLogger } from '../auditLogger'
import { pluginListen } from '../tauri'
import type { Disposable } from './types'

export function trackedListen<T>(
  subscriptions: Disposable[],
  event: string,
  handler: (payload: T) => void,
): Disposable {
  let target: ((payload: T) => void) | null = handler
  let unlisten: (() => void) | null = null
  const disposable: Disposable = {
    dispose: () => {
      target = null
      const index = subscriptions.indexOf(disposable)
      if (index !== -1) subscriptions.splice(index, 1)
      unlisten?.()
      unlisten = null
    },
  }
  subscriptions.push(disposable)
  void pluginListen<T>(event, (payload) => target?.(payload)).then(
    (stop) => {
      if (target) unlisten = stop
      else stop()
    },
    () => {
      disposable.dispose()
      auditLogger.log({
        level: 'error',
        category: 'TAURI',
        message: 'Plugin listener failed: ' + event,
      })
    },
  )
  return disposable
}
