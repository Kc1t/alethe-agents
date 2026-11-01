import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  preferences: { language: 'en', customAgents: [], enabledAgents: {} },
  setAgentEnabled: () => {},
  addCustomAgent: () => {},
  updateCustomAgent: () => {},
  removeCustomAgent: () => {},
}))

vi.mock('../../../stores/projectsStore', () => ({
  useProjectsStore: (selector: (current: typeof state) => unknown) => selector(state),
}))

import { CustomAgentsSection } from './CustomAgentsSection'

afterEach(cleanup)

const openForm = () => {
  render(<CustomAgentsSection enabledCount={1} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add custom agent' }))
}

describe('custom agent pickers', () => {
  it('names accent colors after their agent instead of the CSS token', () => {
    openForm()
    fireEvent.click(screen.getByRole('button', { name: 'Accent color' }))

    const listbox = screen.getByRole('listbox', { name: 'Accent color' })
    expect(within(listbox).getByRole('option', { name: 'Claude Code' })).toBeInTheDocument()
    expect(listbox.textContent).not.toContain('--agent-')
  })

  it('names icon presets, with the bot preset shown as Generic', () => {
    openForm()
    fireEvent.click(screen.getByRole('button', { name: 'Icon' }))

    const listbox = screen.getByRole('listbox', { name: 'Icon' })
    expect(within(listbox).getByRole('option', { name: 'Generic' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(within(listbox).getByRole('option', { name: 'Codex' })).toBeInTheDocument()
  })
})
