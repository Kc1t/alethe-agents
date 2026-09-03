import { currentCorrelation } from './correlation'
import { CORRELATION_ARG } from './correlation.constants'

type InvokeFn = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>

/**
 * Attaches the current correlation id to every Tauri command call.
 *
 * This wraps `window.__TAURI_INTERNALS__.invoke`, which is the single funnel every `invoke` in the
 * app goes through — 28 modules import `invoke` directly, and Tauri's own JS bindings call it too,
 * so wrapping the funnel catches all of them at once instead of touching every call site. It is the
 * exact mirror of `obs_ipc::correlated` on the Rust side, which wraps the generated command handler
 * for the same reason.
 *
 * Adding a key no command declares is safe: Tauri reads command parameters one key at a time, never
 * by deserializing the payload into a struct, so an undeclared key is simply never looked at.
 *
 * Installed once at startup and idempotent — a second call is a no-op rather than a double wrap
 * that would append the id twice.
 */
export function installInvokeCorrelation(): void {
  const internals = (window as unknown as Record<string, Record<string, unknown> | undefined>)
    .__TAURI_INTERNALS__
  if (!internals) return
  if (internals.__aletheCorrelated) return

  const original = internals.invoke as InvokeFn | undefined
  if (typeof original !== 'function') return

  internals.invoke = ((cmd: string, args?: unknown, options?: unknown) => {
    const corr = currentCorrelation()
    // Only objects can carry the extra key. A command called with an array or a primitive payload
    // is left exactly as it was rather than being reshaped into something the backend cannot read.
    if (corr && args && typeof args === 'object' && !Array.isArray(args)) {
      return original(
        cmd,
        { ...(args as Record<string, unknown>), [CORRELATION_ARG]: corr },
        options,
      )
    }
    if (corr && args === undefined) {
      return original(cmd, { [CORRELATION_ARG]: corr }, options)
    }
    return original(cmd, args, options)
  }) as InvokeFn
  internals.__aletheCorrelated = true
}
