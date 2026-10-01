import { describe, expect, it, vi } from 'vitest'

import { createPluginStorage } from './storage'

function backend(initial: string | null = null) {
  const state = { body: initial }
  return {
    state,
    read: vi.fn(async () => state.body),
    write: vi.fn(async (_id: string, body: string | null) => {
      state.body = body
    }),
  }
}

describe('createPluginStorage', () => {
  it('reads an empty record when nothing was ever stored', async () => {
    const storage = createPluginStorage('a.b', backend())
    expect(await storage.read()).toEqual({})
    expect(await storage.get('missing', 'fallback')).toBe('fallback')
  })

  it('treats a corrupt or non-object body as empty instead of throwing', async () => {
    expect(await createPluginStorage('a.b', backend('not json')).read()).toEqual({})
    expect(await createPluginStorage('a.b', backend('[1,2]')).read()).toEqual({})
    expect(await createPluginStorage('a.b', backend('null')).read()).toEqual({})
  })

  it('round-trips values and distinguishes a stored null from a missing key', async () => {
    const storage = createPluginStorage('a.b', backend())
    await storage.set('items', [{ id: '1' }])
    await storage.set('empty', null)

    expect(await storage.get('items', [])).toEqual([{ id: '1' }])
    expect(await storage.get('empty', 'fallback')).toBeNull()
    expect(await storage.get('absent', 'fallback')).toBe('fallback')
  })

  it('does not lose a value when two writes race', async () => {
    const io = backend()
    const storage = createPluginStorage('a.b', io)

    // Both reads would see the same empty record if writes did not queue.
    await Promise.all([storage.set('first', 1), storage.set('second', 2)])

    expect(await storage.read()).toEqual({ first: 1, second: 2 })
  })

  it('removes one key and clears the whole record', async () => {
    const io = backend()
    const storage = createPluginStorage('a.b', io)
    await storage.set('a', 1)
    await storage.set('b', 2)

    await storage.remove('a')
    expect(await storage.read()).toEqual({ b: 2 })

    await storage.clear()
    expect(io.write).toHaveBeenLastCalledWith('a.b', null)
    expect(await storage.read()).toEqual({})
  })

  it('keeps working after a failed write', async () => {
    const io = backend()
    io.write.mockRejectedValueOnce(new Error('disk full'))
    const storage = createPluginStorage('a.b', io)

    await expect(storage.set('a', 1)).rejects.toThrow('disk full')
    await storage.set('b', 2)
    expect(await storage.read()).toEqual({ b: 2 })
  })
})
