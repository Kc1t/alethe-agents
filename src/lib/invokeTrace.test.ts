import { afterEach, describe, expect, it, vi } from 'vitest'

import { setCurrentCorrelation, withCorrelation } from './correlation'
import { CORRELATION_ARG } from './correlation.constants'
import { installInvokeCorrelation } from './invokeTrace'

type Internals = Record<string, unknown> | undefined

function setInternals(value: Internals) {
  ;(window as unknown as Record<string, Internals>).__TAURI_INTERNALS__ = value
}

afterEach(() => {
  setInternals(undefined)
  setCurrentCorrelation(null)
  vi.restoreAllMocks()
})

describe('installInvokeCorrelation', () => {
  it('does not throw when invoke is read-only, and says correlation is off', () => {
    // The regression this exists for: a plain assignment threw `Cannot assign to read only
    // property` on a Tauri build that defines `invoke` non-writable, and because this runs at
    // module scope the whole UI failed to load — a blank window, caused by a feature whose only
    // job is to label log lines.
    const original = vi.fn()
    const internals: Record<string, unknown> = {}
    Object.defineProperty(internals, 'invoke', {
      value: original,
      writable: false,
      configurable: false,
    })
    setInternals(internals)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => installInvokeCorrelation()).not.toThrow()
    expect(installInvokeCorrelation()).toBe('not-writable')
    expect(warn).toHaveBeenCalled()
    // The original is untouched, so calls still work — just without a correlation id.
    expect(internals.invoke).toBe(original)
  })

  it('wraps invoke when the property merely is not writable but is configurable', () => {
    const original = vi.fn().mockResolvedValue('ok')
    const internals: Record<string, unknown> = {}
    Object.defineProperty(internals, 'invoke', {
      value: original,
      writable: false,
      configurable: true,
    })
    setInternals(internals)

    expect(installInvokeCorrelation()).toBe('installed')
    expect(internals.invoke).not.toBe(original)
  })

  it('attaches the correlation id of the gesture in effect', async () => {
    const original = vi.fn().mockResolvedValue('ok')
    setInternals({ invoke: original })
    installInvokeCorrelation()

    await withCorrelation('test', async () => {
      await internalsInvoke()('some_command', { a: 1 })
    })

    const [, args] = original.mock.calls[0]
    expect(args.a).toBe(1)
    expect(String(args[CORRELATION_ARG])).toMatch(/^test_/)
  })

  it('leaves a call with no gesture in effect exactly as it was', async () => {
    const original = vi.fn().mockResolvedValue('ok')
    setInternals({ invoke: original })
    installInvokeCorrelation()

    await internalsInvoke()('some_command', { a: 1 })
    expect(original.mock.calls[0][1]).toEqual({ a: 1 })
  })

  it('does not reshape an array payload into something the backend cannot read', async () => {
    const original = vi.fn().mockResolvedValue('ok')
    setInternals({ invoke: original })
    installInvokeCorrelation()

    await withCorrelation('test', async () => {
      await internalsInvoke()('some_command', [1, 2])
    })
    expect(original.mock.calls[0][1]).toEqual([1, 2])
  })

  it('is idempotent, so a second call cannot append the id twice', () => {
    setInternals({ invoke: vi.fn() })
    expect(installInvokeCorrelation()).toBe('installed')
    expect(installInvokeCorrelation()).toBe('already-installed')
  })

  it('is a no-op outside Tauri', () => {
    setInternals(undefined)
    expect(installInvokeCorrelation()).toBe('no-internals')
  })
})

function internalsInvoke() {
  return (window as unknown as Record<string, Record<string, unknown>>).__TAURI_INTERNALS__
    .invoke as (cmd: string, args?: unknown) => Promise<unknown>
}
