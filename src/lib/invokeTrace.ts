import { currentCorrelation } from './correlation'
import { CORRELATION_ARG } from './correlation.constants'

type InvokeFn = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>

/** What the last install attempt did, for diagnostics and tests. */
export type InstallOutcome = 'installed' | 'already-installed' | 'no-internals' | 'not-writable'

/**
 * Attaches the current correlation id to every Tauri command call.
 *
 * This wraps `window.__TAURI_INTERNALS__.invoke`, the single funnel every `invoke` in the app goes
 * through — 28 modules import `invoke` directly, and Tauri's own JS bindings call it too, so
 * wrapping the funnel catches all of them at once instead of touching every call site. It is the
 * mirror of `obs_ipc::correlated` on the Rust side, which wraps the generated command handler for
 * the same reason.
 *
 * Adding a key no command declares is safe: Tauri reads command parameters one key at a time, never
 * by deserializing the payload into a struct, so an undeclared key is simply never looked at.
 *
 * **Nothing here may ever throw.** A plain assignment to `invoke` threw
 * `Cannot assign to read only property` on a Tauri build that defines it non-writable, and because
 * this runs at module scope in `main.tsx` it took the entire UI down — a blank window, from a
 * feature whose only job is to label log lines. Diagnostics that can break the thing they observe
 * are worse than no diagnostics: every failure path here degrades to "correlation is off" and says
 * so once.
 */
export function installInvokeCorrelation(): InstallOutcome {
  try {
    const internals = (window as unknown as Record<string, Record<string, unknown> | undefined>)
      .__TAURI_INTERNALS__
    if (!internals) return 'no-internals'
    if (internals.__aletheCorrelated) return 'already-installed'

    const original = internals.invoke as InvokeFn | undefined
    if (typeof original !== 'function') return 'no-internals'

    const wrapped = ((cmd: string, args?: unknown, options?: unknown) => {
      const corr = currentCorrelation()
      // Only objects can carry the extra key. A command called with an array or a primitive payload
      // is left exactly as it was rather than reshaped into something the backend cannot read.
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

    // `defineProperty` rather than assignment: the property is defined non-writable on some Tauri
    // builds, where assigning throws in strict mode (which every ES module is).
    try {
      Object.defineProperty(internals, 'invoke', {
        value: wrapped,
        writable: true,
        configurable: true,
        enumerable: true,
      })
    } catch {
      // Non-configurable too: there is no way in. Correlation is off, and that is all.
      console.warn(
        '[obs] correlação desligada: __TAURI_INTERNALS__.invoke não pode ser envolvido nesta build',
      )
      return 'not-writable'
    }

    internals.__aletheCorrelated = true
    return 'installed'
  } catch (cause) {
    console.warn('[obs] correlação desligada:', cause)
    return 'not-writable'
  }
}
