import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isOverlayPresent,
  subscribeOverlayPresence,
  suspendNativeSurfaces,
} from './overlayPresence'

describe('overlayPresence', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('tracks a dialog through its full mounted lifetime', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeOverlayPresence(listener)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')

    document.body.append(dialog)
    await vi.waitFor(() => expect(isOverlayPresent()).toBe(true))

    dialog.setAttribute('data-state', 'closed')
    expect(isOverlayPresent()).toBe(true)

    dialog.remove()
    await vi.waitFor(() => expect(isOverlayPresent()).toBe(false))
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it.each(['dialog', 'menu', 'listbox', 'alertdialog'])(
    'treats role="%s" as covering a pane',
    async (role) => {
      const unsubscribe = subscribeOverlayPresence(() => {})
      const node = document.createElement('div')
      node.setAttribute('role', role)
      document.body.append(node)
      await vi.waitFor(() => expect(isOverlayPresent(), `role="${role}" must occlude`).toBe(true))
      node.remove()
      await vi.waitFor(() => expect(isOverlayPresent()).toBe(false))
      unsubscribe()
    },
  )

  it('stays occluded while a manual suspension is held, with no node in the document', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeOverlayPresence(listener)
    expect(isOverlayPresent()).toBe(false)

    const release = suspendNativeSurfaces()
    expect(isOverlayPresent()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    release()
    expect(isOverlayPresent()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('counts overlapping suspensions and ignores a double release', () => {
    const unsubscribe = subscribeOverlayPresence(() => {})
    const first = suspendNativeSurfaces()
    const second = suspendNativeSurfaces()

    first()
    expect(isOverlayPresent(), 'the second suspension still holds it').toBe(true)
    first()
    expect(isOverlayPresent(), 'releasing twice must not decrement again').toBe(true)

    second()
    expect(isOverlayPresent()).toBe(false)
    unsubscribe()
  })
})
