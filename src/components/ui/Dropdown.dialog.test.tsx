import * as Dialog from '@radix-ui/react-dialog'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Dropdown } from './Dropdown'

afterEach(cleanup)

const OPTIONS = [
  { value: 'scribe', label: 'ElevenLabs: Scribe v2' },
  { value: 'gemini', label: 'Google: Gemini 3.5 Transcribe' },
  { value: 'fish', label: 'Fish Audio: Transcribe 1 Pro' },
]

function InDialog() {
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Content aria-describedby={undefined}>
          <Dialog.Title>Preferences</Dialog.Title>
          <Dropdown
            value="fish"
            ariaLabel="Model"
            searchable
            searchPlaceholder="Search models…"
            options={OPTIONS}
            onChange={() => undefined}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

describe('Dropdown inside a modal dialog', () => {
  it('keeps focus in its search box so typing filters the options', async () => {
    render(<InDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    const search = await screen.findByPlaceholderText('Search models…')
    await waitFor(() => expect(document.activeElement).toBe(search))

    // The dialog's focus trap must not pull focus back to the trigger.
    act(() => search.focus())
    expect(document.activeElement).toBe(search)

    fireEvent.change(search, { target: { value: 'gemini' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option').textContent).toContain('Gemini 3.5')
  })
})
