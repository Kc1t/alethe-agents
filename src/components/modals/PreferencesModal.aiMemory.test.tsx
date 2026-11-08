import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  open: true,
  context: { category: 'account' as string },
}))

vi.mock('../../stores/uiStore', () => ({
  useUiStore: (selector: (value: unknown) => unknown) =>
    selector({
      openModal: state.open ? 'preferences' : null,
      closeModal: vi.fn(),
      openModal_: vi.fn(),
      modalContext: state.context,
    }),
}))
vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: (selector: (value: unknown) => unknown) =>
    selector({
      preferences: {
        displayName: 'Tester',
        language: 'en',
        enabledAgents: {},
        profileImageUrl: '',
        enabledFeatures: { aiMemory: false },
      },
    }),
}))
vi.mock('./preferences/AiMemoryPanel', () => ({
  AiMemoryPanel: () => <div>AI Memory service panel</div>,
}))
vi.mock('./preferences/AccountPage', () => ({ AccountPage: () => null }))

import { PreferencesModal } from './PreferencesModal'

describe('PreferencesModal AI Memory category', () => {
  beforeEach(() => {
    state.context = { category: 'account' }
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  it('navigates to AI Memory and renders its panel', () => {
    render(<PreferencesModal />)
    fireEvent.click(screen.getByRole('button', { name: /^AI Memory/ }))
    expect(screen.getByText('AI Memory service panel')).toBeTruthy()
  })
})
