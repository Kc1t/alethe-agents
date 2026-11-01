import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ContextMenu, type MenuItem } from './ContextMenu'

afterEach(cleanup)

describe('ContextMenu submenus', () => {
  it('opens a submenu in place and runs the picked item', () => {
    const onClose = vi.fn()
    const pick = vi.fn()
    const items: MenuItem[] = [
      {
        kind: 'submenu',
        label: 'Move to group…',
        items: [{ kind: 'item', label: 'Personal', onClick: pick }],
      },
    ]
    render(<ContextMenu x={0} y={0} items={items} onClose={onClose} />)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to group…' }))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Personal' }))
    expect(pick).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
