import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { listenerCleanup } from './listeners'

/** Lets pending promise callbacks and Node's unhandled-rejection check run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('listenerCleanup', () => {
  const rejections: unknown[] = []
  const onRejection = (reason: unknown) => rejections.push(reason)
  beforeEach(() => {
    rejections.length = 0
    process.on('unhandledRejection', onRejection)
  })
  afterEach(() => {
    process.off('unhandledRejection', onRejection)
  })

  // Plain functions, not vi.fn: a mock observes the promise it returns and would hide the rejection.
  const counting = (result: () => unknown) => {
    const fn = () => {
      fn.calls += 1
      return result()
    }
    fn.calls = 0
    return fn
  }

  it('stops a listener that arrives after the cleanup already ran', async () => {
    const unlisten = counting(() => undefined)
    const cleanup = listenerCleanup(Promise.resolve(unlisten))
    cleanup()
    await settle()
    expect(unlisten.calls).toBe(1)
  })

  it('stops a listener at most once', async () => {
    const unlisten = counting(() => undefined)
    const cleanup = listenerCleanup(Promise.resolve(unlisten))
    await settle()
    cleanup()
    cleanup()
    await settle()
    expect(unlisten.calls).toBe(1)
  })

  it('swallows an unlisten that rejects', async () => {
    const unlisten = counting(() =>
      Promise.reject(
        new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')"),
      ),
    )
    const cleanup = listenerCleanup(Promise.resolve(unlisten))
    await settle()
    cleanup()
    await settle()
    expect(unlisten.calls).toBe(1)
    expect(rejections).toEqual([])
  })

  it('swallows an unlisten that throws', async () => {
    const unlisten = counting(() => {
      throw new Error('already gone')
    })
    const cleanup = listenerCleanup(Promise.resolve(unlisten))
    await settle()
    expect(() => cleanup()).not.toThrow()
    expect(unlisten.calls).toBe(1)
  })

  it('ignores a listener that could not be registered', async () => {
    const cleanup = listenerCleanup(Promise.reject(new Error('no ipc')))
    cleanup()
    await settle()
    expect(rejections).toEqual([])
  })
})
