import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { NarrationBehaviorSection } from './NarrationBehaviorSection'

const prefs = () => useProjectsStore.getState().preferences

afterEach(cleanup)

describe('NarrationBehaviorSection', () => {
  beforeEach(() => {
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  })

  it('is disabled while voice conversation is off', () => {
    render(<NarrationBehaviorSection />)
    const dropdowns = screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-haspopup') === 'listbox')
    expect(dropdowns.length).toBe(2)
    expect(dropdowns.every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
  })

  it('saves the verbosity picked while conversation is on', () => {
    useProjectsStore.getState().setPreferences({ voiceConversationEnabled: true })
    render(<NarrationBehaviorSection />)
    const verbosity = screen
      .getAllByRole('button', { name: 'Narration' })
      .find((button) => button.getAttribute('aria-haspopup') === 'listbox')!
    fireEvent.click(verbosity)
    const option = screen.getAllByRole('option')[0]
    fireEvent.pointerDown(option)
    fireEvent.click(option)
    expect(prefs().voiceVerbosity).toBe('silent')
  })
})
