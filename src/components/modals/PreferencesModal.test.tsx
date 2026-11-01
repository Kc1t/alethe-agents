import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '../../stores/uiStore'
import { PreferencesModal } from './PreferencesModal'

beforeAll(() => {
  Element.prototype.scrollTo = vi.fn()
})

afterEach(() => {
  cleanup()
  useUiStore.getState().closeModal()
})

describe('PreferencesModal', () => {
  it('closes an open dropdown on Escape and keeps the settings open', () => {
    useUiStore.getState().openModal_('preferences')
    render(<PreferencesModal />)

    fireEvent.click(screen.getByText('Appearance'))
    fireEvent.click(screen.getByLabelText('Topbar style'))
    expect(screen.getByRole('listbox', { name: 'Topbar style' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('listbox', { name: 'Topbar style' })).not.toBeInTheDocument()
    expect(useUiStore.getState().openModal).toBe('preferences')
  })
})
