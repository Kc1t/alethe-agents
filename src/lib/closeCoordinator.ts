export type CloseRequestEventLike = {
  preventDefault: () => void
}

export type CloseFailureStage = 'confirm' | 'persist' | 'destroy' | 'quit'

type CloseCoordinatorDependencies = {
  confirmNative: () => Promise<boolean>
  confirmFallback: () => boolean
  beforeClose?: () => Promise<void>
  destroyWindow: () => Promise<void>
  quitApp: () => Promise<void>
  quitTimeoutMs?: number
  onFailure?: (stage: CloseFailureStage, error: unknown) => void
}

export function createCloseCoordinator(deps: CloseCoordinatorDependencies): {
  handleCloseRequest: (event: CloseRequestEventLike) => Promise<void>
} {
  let confirming = false
  let closing = false

  const quitWithTimeout = async (): Promise<void> => {
    const timeoutMs = deps.quitTimeoutMs ?? 4_000
    let timeoutId: number | null = null
    try {
      await Promise.race([
        deps.quitApp(),
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(
            () => reject(new Error(`App quit timed out after ${timeoutMs} ms`)),
            timeoutMs,
          )
        }),
      ])
    } finally {
      if (timeoutId !== null) window.clearTimeout(timeoutId)
    }
  }

  const handleCloseRequest = async (event: CloseRequestEventLike): Promise<void> => {
    event.preventDefault()
    if (confirming || closing) return

    confirming = true
    let confirmed: boolean
    try {
      confirmed = await deps.confirmNative()
    } catch (error) {
      deps.onFailure?.('confirm', error)
      confirmed = deps.confirmFallback()
    } finally {
      confirming = false
    }

    if (!confirmed) return
    closing = true

    try {
      await deps.beforeClose?.()
    } catch (error) {
      deps.onFailure?.('persist', error)
    }

    // ("cannot move state from Destroyed") no meio do teardown, abortando o

    try {
      await quitWithTimeout()
      return
    } catch (error) {
      deps.onFailure?.('quit', error)
    }

    try {
      await deps.destroyWindow()
    } catch (error) {
      closing = false
      deps.onFailure?.('destroy', error)
    }
  }

  return { handleCloseRequest }
}
