import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  setPreferences: vi.fn(),
  state: {
    preferences: {
      appIconTheme: 'dark',
      gitControlPlacement: 'left',
      language: 'en',
      motionPreference: 'animated',
      terminalTheme: null,
      topbarStyle: 'classic',
      uiTheme: 'dark',
      uiZoom: 1,
      visualStyle: 'normal',
      windowOpacity: 1,
    },
    setPreferences: vi.fn(),
    setTerminalTheme: vi.fn(),
    setUiTheme: vi.fn(),
    setUiZoom: vi.fn(),
  },
}))

vi.mock('../../../stores/projectsStore', () => ({
  UI_ZOOM_LIMITS: { min: 0.75, max: 1.5, step: 0.05 },
  useProjectsStore: (selector: (state: typeof store.state) => unknown) => selector(store.state),
}))

import { AppearancePage } from './AppearancePage'

describe('AppearancePage motion preference', () => {
  beforeEach(() => {
    store.state.setPreferences.mockReset()
  })

  it('shows visual Animated and Reduced choices and stores the selected mode', () => {
    render(<AppearancePage />)

    const animated = screen.getByRole('button', { name: /Animated/ })
    const reduced = screen.getByRole('button', { name: /Reduced/ })
    expect(animated.getAttribute('aria-pressed')).toBe('true')
    expect(reduced.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(reduced)
    expect(store.state.setPreferences).toHaveBeenCalledWith({ motionPreference: 'reduced' })
  })
})
