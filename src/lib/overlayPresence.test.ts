import { afterEach, describe, expect, it, vi } from 'vitest'

import { isOverlayPresent, subscribeOverlayPresence } from './overlayPresence'

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
})
