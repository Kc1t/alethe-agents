import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { settingsContributions } from '../../lib/plugins'
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

describe('contributed Voice preferences', () => {
  it('renders Voice settings below core content, keeps default settings in Integrations, and searches the correct category', () => {
    const voice = settingsContributions.add('test', {
      id: 'test-conversation',
      category: 'voice',
      title: () => 'Conversation controls',
      keywords: 'conversation controls',
      component: () => <div>Voice plugin settings</div>,
    })
    const integrations = settingsContributions.add('test', {
      id: 'test-integration',
      title: () => 'Integration controls',
      component: () => <div>Integration plugin settings</div>,
    })
    try {
      useUiStore.getState().openModal_('preferences', { category: 'voice' })
      render(<PreferencesModal />)
      expect(screen.getByText('Voice plugin settings')).toBeInTheDocument()
      expect(screen.queryByText('Integration plugin settings')).not.toBeInTheDocument()
      expect(
        screen
          .getByTestId('voice-page')
          .compareDocumentPosition(screen.getByText('Voice plugin settings')) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      fireEvent.click(screen.getByText('Integrations', { selector: 'strong' }))
      expect(screen.getByText('Integration plugin settings')).toBeInTheDocument()
      expect(screen.queryByText('Voice plugin settings')).not.toBeInTheDocument()
      fireEvent.change(screen.getByPlaceholderText('Search settings'), {
        target: { value: 'conversation controls' },
      })
      fireEvent.click(screen.getByRole('option', { name: /Conversation controls/ }))
      expect(screen.getByTestId('voice-page')).toBeInTheDocument()
      expect(screen.getByText('Voice plugin settings')).toBeInTheDocument()
    } finally {
      voice.dispose()
      integrations.dispose()
    }
  })
})
