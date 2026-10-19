import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EMPTY_PROJECTS_FILE } from '../../../lib/types'
import { NARRATION_PRESETS } from '../../../lib/voice/narration'
import { useProjectsStore } from '../../../stores/projectsStore'
import { NarrationBehaviorSection } from './NarrationBehaviorSection'

const prefs = () => useProjectsStore.getState().preferences
const listboxes = () =>
  screen
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-haspopup') === 'listbox')
const presetPicker = () =>
  screen
    .getAllByRole('button', { name: 'Preset' })
    .find((button) => button.getAttribute('aria-haspopup') === 'listbox')!
const pick = (label: string) => {
  const option = screen.getByRole('option', { name: label })
  fireEvent.pointerDown(option)
  fireEvent.click(option)
}

afterEach(cleanup)

describe('NarrationBehaviorSection', () => {
  beforeEach(() => {
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  })

  it('is disabled while voice conversation is off', () => {
    render(<NarrationBehaviorSection />)
    expect(listboxes().length).toBe(2)
    expect(listboxes().every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
    const toggles = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(toggles.length).toBe(7)
    expect(toggles.every((toggle) => toggle.disabled)).toBe(true)
  })

  it('sets every toggle from a preset', () => {
    useProjectsStore.getState().setPreferences({ voiceConversationEnabled: true })
    render(<NarrationBehaviorSection />)
    expect(presetPicker().textContent).toContain('Normal')
    fireEvent.click(presetPicker())
    pick('Detailed')
    expect(prefs().voiceNarration).toEqual(NARRATION_PRESETS.detailed)
    expect((screen.getByRole('checkbox', { name: /Actions/ }) as HTMLInputElement).checked).toBe(
      true,
    )
  })

  it('saves one toggle and shows Custom when no preset matches', () => {
    useProjectsStore.getState().setPreferences({ voiceConversationEnabled: true })
    render(<NarrationBehaviorSection />)
    fireEvent.click(screen.getByRole('checkbox', { name: /Thinking/ }))
    expect(prefs().voiceNarration).toEqual({ ...NARRATION_PRESETS.normal, thinking: true })
    expect(presetPicker().textContent).toContain('Custom')
    // Turning it back off matches the preset again.
    fireEvent.click(screen.getByRole('checkbox', { name: /Thinking/ }))
    expect(presetPicker().textContent).toContain('Normal')
  })

  it('says which harnesses expose thinking', () => {
    render(<NarrationBehaviorSection />)
    expect(screen.getByText(/Other harnesses don't expose it/)).toBeTruthy()
  })

  it('says permission requests are not spoken while answers are panel only', () => {
    useProjectsStore
      .getState()
      .setPreferences({ voiceConversationEnabled: true, voiceApprovalChannel: 'hud' })
    render(<NarrationBehaviorSection />)
    expect(
      screen.getByText(/Not spoken while permission answers are set to Panel only/),
    ).toBeTruthy()
  })

  it('turns the silence delay off with its status toggle', () => {
    useProjectsStore.getState().setPreferences({ voiceConversationEnabled: true })
    render(<NarrationBehaviorSection />)
    fireEvent.click(screen.getByRole('checkbox', { name: /Status after a silence/ }))
    const delay = listboxes().find((button) => button !== presetPicker()) as HTMLButtonElement
    expect(delay.disabled).toBe(true)
  })
})
