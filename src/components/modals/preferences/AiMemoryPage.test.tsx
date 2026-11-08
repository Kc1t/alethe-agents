import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ enabled: false, openModal_: vi.fn() }))

vi.mock('../../../stores/projectsStore', () => ({
  useProjectsStore: (
    selector: (value: { preferences: { enabledFeatures: { aiMemory: boolean } } }) => unknown,
  ) => selector({ preferences: { enabledFeatures: { aiMemory: state.enabled } } }),
}))
vi.mock('../../../stores/uiStore', () => ({
  useUiStore: (selector: (value: { openModal_: typeof state.openModal_ }) => unknown) =>
    selector({ openModal_: state.openModal_ }),
}))
vi.mock('./AiMemoryPanel', () => ({ AiMemoryPanel: () => <div>AI Memory service controls</div> }))

import { AiMemoryPage } from './AiMemoryPage'

describe('AiMemoryPage', () => {
  beforeEach(() => {
    state.enabled = false
    state.openModal_.mockReset()
  })

  it('shows the disabled note and routes to Features while keeping service controls visible', () => {
    render(<AiMemoryPage />)

    expect(screen.getByText(/AI Memory is disabled/)).toBeTruthy()
    expect(screen.getByText('AI Memory service controls')).toBeTruthy()
    expect(document.querySelector('[data-setting-id="ai-memory-service"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Enable in Features' }))
    expect(state.openModal_).toHaveBeenCalledWith('preferences', {
      category: 'features',
      target: 'feature-aiMemory',
    })
  })

  it('titles its section differently from the page header', () => {
    render(<AiMemoryPage />)

    expect(screen.getByRole('heading', { name: 'Service' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'AI Memory' })).toBeNull()
  })
})
