import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Sparkle } from 'lucide-react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderUseCard } from './ProviderUseCard'

vi.mock('../../../../lib/i18n', () => ({ useT: () => (key: string) => key }))
afterEach(cleanup)

const card = (props: Partial<Parameters<typeof ProviderUseCard>[0]> = {}) =>
  render(
    <ProviderUseCard
      icon={Sparkle}
      title="OpenAI"
      description="Cloud models"
      status="connected"
      selected={false}
      onSelect={() => undefined}
      {...props}
    />,
  )

describe('ProviderUseCard', () => {
  it('shows the provider like the providers grid', () => {
    card()
    expect(screen.getByRole('heading', { name: 'OpenAI' })).toBeTruthy()
    expect(screen.getByText('Cloud models')).toBeTruthy()
    expect(screen.getByText('prefs.voiceStatusConnected')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'OpenAI' }).getAttribute('aria-checked')).toBe('false')
  })

  it('marks the selected card as in use', () => {
    const { container } = card({ selected: true })
    expect(screen.getByText('prefs.voiceStatusInUse')).toBeTruthy()
    expect(screen.queryByText('prefs.voiceStatusConnected')).toBeNull()
    expect(screen.getByRole('radio', { name: 'OpenAI' }).getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector('article')?.hasAttribute('data-selected')).toBe(true)
  })

  it('selects through a native button so the keyboard works too', () => {
    const onSelect = vi.fn()
    card({ onSelect })
    const radio = screen.getByRole('radio', { name: 'OpenAI' })
    expect(radio.tagName).toBe('BUTTON')
    fireEvent.click(radio)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('cannot be selected while it is not usable', () => {
    const onSelect = vi.fn()
    card({ onSelect, disabled: true, status: 'disconnected' })
    const radio = screen.getByRole('radio', { name: 'OpenAI' }) as HTMLButtonElement
    expect(radio.disabled).toBe(true)
    fireEvent.click(radio)
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByText('prefs.voiceStatusDisconnected')).toBeTruthy()
  })

  it('renders its footer without selecting the card from it', () => {
    const onSelect = vi.fn()
    const onFooter = vi.fn()
    card({
      onSelect,
      footer: (
        <button type="button" onClick={onFooter}>
          footer-action
        </button>
      ),
    })
    fireEvent.click(screen.getByRole('button', { name: 'footer-action' }))
    expect(onFooter).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps warning about an invalid key on the selected card', () => {
    const { container } = card({ selected: true, status: 'invalid' })
    expect(screen.getByText('prefs.voiceStatusInvalid')).toBeTruthy()
    expect(screen.queryByText('prefs.voiceStatusInUse')).toBeNull()
    expect(screen.getByRole('radio', { name: 'OpenAI' }).getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector('article')?.hasAttribute('data-selected')).toBe(true)
  })

  it('keeps a not-ready warning on the selected card instead of "In use"', () => {
    const { container } = card({ selected: true, status: 'notReady', note: 'Model not downloaded' })
    expect(screen.getByText('prefs.voiceStatusNotReady')).toBeTruthy()
    expect(screen.queryByText('prefs.voiceStatusInUse')).toBeNull()
    expect(container.querySelector('[data-status="notReady"]')).toBeTruthy()
    expect(screen.getByText('Model not downloaded')).toBeTruthy()
  })

  it('shows a note under the footer', () => {
    card({ note: 'Audio is sent to OpenAI.' })
    expect(screen.getByText('Audio is sent to OpenAI.')).toBeTruthy()
  })

  it('flags an invalid key', () => {
    card({ status: 'invalid' })
    expect(screen.getByText('prefs.voiceStatusInvalid')).toBeTruthy()
  })
})
