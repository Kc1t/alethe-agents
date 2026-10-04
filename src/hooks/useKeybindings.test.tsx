import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useUiStore } from '../stores/uiStore'
import { useKeybindings } from './useKeybindings'

function Harness() {
  useKeybindings()
  return null
}

afterEach(() => {
  cleanup()
  useUiStore.setState({ openModal: null, modalContext: null })
  document.querySelectorAll('[data-alethe-dropdown-menu]').forEach((node) => node.remove())
})

describe('useKeybindings Escape', () => {
  it('closes the open modal', () => {
    useUiStore.setState({ openModal: 'preferences' })
    render(<Harness />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(useUiStore.getState().openModal).toBeNull()
  })

  it('leaves the modal open while a select has its list open', () => {
    useUiStore.setState({ openModal: 'preferences' })
    render(<Harness />)
    const menu = document.createElement('div')
    menu.setAttribute('data-alethe-dropdown-menu', '')
    document.body.append(menu)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(useUiStore.getState().openModal).toBe('preferences')
  })
})
