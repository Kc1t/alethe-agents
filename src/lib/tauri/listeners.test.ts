import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { listenerCleanup } from './listeners'

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('listenerCleanup', () => {
  const errors: unknown[] = []
  const onError = (cause: unknown) => errors.push(cause)
  const rejections: unknown[] = []
  const onRejection = (reason: unknown) => rejections.push(reason)
  beforeEach(() => {
    errors.length = 0
    rejections.length = 0
    process.on('unhandledRejection', onRejection)
  })
  afterEach(() => {
    process.off('unhandledRejection', onRejection)
  })
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
    const cleanup = listenerCleanup(Promise.resolve(unlisten), onError)
    cleanup()
    await settle()
    expect(unlisten.calls).toBe(1)
  })

  it('stops a listener at most once', async () => {
    const unlisten = counting(() => undefined)
    const cleanup = listenerCleanup(Promise.resolve(unlisten), onError)
    await settle()
    cleanup()
    cleanup()
    await settle()
    expect(unlisten.calls).toBe(1)
  })

  it('reports a rejected unlisten without an unhandled rejection', async () => {
    const unlisten = counting(() =>
      Promise.reject(
        new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')"),
      ),
    )
    const cleanup = listenerCleanup(Promise.resolve(unlisten), onError)
    await settle()
    cleanup()
    await settle()
    expect(unlisten.calls).toBe(1)
    expect(rejections).toEqual([])
  })

  it('reports an unlisten that throws', async () => {
    const unlisten = counting(() => {
      throw new Error('already gone')
    })
    const cleanup = listenerCleanup(Promise.resolve(unlisten), onError)
    await settle()
    expect(() => cleanup()).not.toThrow()
    expect(unlisten.calls).toBe(1)
  })

  it('reports a listener registration failure', async () => {
    const cleanup = listenerCleanup(Promise.reject(new Error('no ipc')), onError)
    cleanup()
    await settle()
    expect(rejections).toEqual([])
  })
})
