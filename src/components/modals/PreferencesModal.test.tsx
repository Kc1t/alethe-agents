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

vi.mock('./preferences/voice/VoicePage', () => ({
  VoicePage: () => <div data-testid="voice-page" />,
}))

describe('PreferencesModal', () => {
  it('opens the core Voice page by its stable modal context id', () => {
    useUiStore.getState().openModal_('preferences', { category: 'voice' })
    render(<PreferencesModal />)
    expect(screen.getByTestId('voice-page')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Voice Manage cloud/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('finds Voice resource settings through Preferences search', () => {
    useUiStore.getState().openModal_('preferences')
    render(<PreferencesModal />)
    fireEvent.change(screen.getByPlaceholderText('Search settings'), {
      target: { value: 'hugging face' },
    })
    fireEvent.click(screen.getByRole('option', { name: /Voice/ }))
    expect(screen.getByTestId('voice-page')).toBeInTheDocument()
  })
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
