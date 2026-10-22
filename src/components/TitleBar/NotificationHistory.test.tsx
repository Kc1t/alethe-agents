import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useUiStore } from '../../stores/uiStore'
import { NotificationHistory } from './NotificationHistory'

beforeEach(() => {
  useUiStore.getState().clearNotifications()
  useUiStore.setState({ toasts: [] })
})

afterEach(cleanup)

describe('NotificationHistory', () => {
  it('opens from the bell, lists notifications, clears them, and shows the empty state', () => {
    useUiStore.getState().pushToast({ title: 'Build complete', body: 'The build passed.' })
    const { container } = render(
      <div data-testid="titlebar">
        <NotificationHistory />
      </div>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open notifications' }))
    expect(screen.getByRole('button', { name: 'Open notifications' })).toHaveAttribute(
      'title',
      'Open notifications',
    )
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeTruthy()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Notifications' }).parentElement).toBe(document.body)
    expect(screen.getByText('Build complete')).toBeTruthy()
    expect(screen.getByText('The build passed.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(useUiStore.getState().notifications).toEqual([])
    expect(screen.getByText('No new notifications right now.')).toBeTruthy()
  })

  it('closes on Escape and returns focus to the bell', () => {
    render(<NotificationHistory />)
    const trigger = screen.getByRole('button', { name: 'Open notifications' })
    fireEvent.click(trigger)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on an outside pointerdown', () => {
    render(<NotificationHistory />)
    fireEvent.click(screen.getByRole('button', { name: 'Open notifications' }))

    fireEvent.pointerDown(document.body)

    expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull()
  })

  it('stays open when clicking inside the popover', () => {
    render(<NotificationHistory />)
    fireEvent.click(screen.getByRole('button', { name: 'Open notifications' }))
    const dialog = screen.getByRole('dialog', { name: 'Notifications' })

    fireEvent.click(dialog)

    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBe(dialog)
  })
})
