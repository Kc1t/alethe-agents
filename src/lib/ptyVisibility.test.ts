import { afterEach, describe, expect, it } from 'vitest'

import { useUiStore } from '../stores/uiStore'
import { computeVisibleFocusedPtyIds } from './ptyVisibility'

afterEach(() => {
  useUiStore.setState({ inspectorPtyId: null })
})

describe('computeVisibleFocusedPtyIds', () => {
  it('reports the inspector overlay’s shell as visible and focused', () => {
    useUiStore.setState({ inspectorPtyId: 'orchestrator-shell-01' })

    const { visible, focused } = computeVisibleFocusedPtyIds()

    // A hidden PTY gets no scrollback replay and has its output stream switched off, which is what
    // made the overlay open blank while still accepting keystrokes.
    expect(visible.has('orchestrator-shell-01')).toBe(true)
    expect(focused.has('orchestrator-shell-01')).toBe(true)
  })

  it('stops reporting it once the overlay closes', () => {
    useUiStore.setState({ inspectorPtyId: 'orchestrator-shell-01' })
    useUiStore.setState({ inspectorPtyId: null })

    const { visible, focused } = computeVisibleFocusedPtyIds()

    expect(visible.has('orchestrator-shell-01')).toBe(false)
    expect(focused.has('orchestrator-shell-01')).toBe(false)
  })
})
