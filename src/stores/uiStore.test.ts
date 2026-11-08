import { beforeEach, describe, expect, it } from 'vitest'

import { useUiStore } from './uiStore'

beforeEach(() => {
  useUiStore.getState().clearNotifications()
  useUiStore.setState({ toasts: [] })
})

describe('notification history', () => {
  it('keeps a dismissed toast in notifications until the history is cleared', () => {
    useUiStore.getState().pushToast({ title: 'Build complete', body: 'The build passed.' })
    const toast = useUiStore.getState().toasts[0]

    useUiStore.getState().dismissToast(toast.id)

    expect(useUiStore.getState().toasts).toHaveLength(0)
    expect(useUiStore.getState().notifications).toMatchObject([
      { title: 'Build complete', body: 'The build passed.' },
    ])

    useUiStore.getState().clearNotifications()
    expect(useUiStore.getState().notifications).toEqual([])
  })
})
