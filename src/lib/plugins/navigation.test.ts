import { describe, expect, it } from 'vitest'

import { resolveViewSide } from './placement'
import type { SidebarTabContribution } from './types'

function view(id: string, side: 'left' | 'right'): SidebarTabContribution {
  return {
    id,
    pluginId: 'jbnado.hello',
    side,
    label: id,
    icon: null,
    order: 0,
    component: null,
  } as SidebarTabContribution
}

describe('where a contributed view opens', () => {
  it('follows the manifest when the person never moved it', () => {
    expect(resolveViewSide(view('hello', 'right'), undefined)).toBe('right')
    expect(resolveViewSide(view('git', 'left'), {})).toBe('left')
  })

  it('follows the person over the manifest', () => {
    // Revealing has to land where the tab actually is. Assuming the right sidebar — which the
    // bundled Todo plugin used to do — sends a left-placed view to a sidebar it does not live in.
    expect(resolveViewSide(view('hello', 'right'), { hello: 'left' })).toBe('left')
    expect(resolveViewSide(view('git', 'left'), { git: 'right' })).toBe('right')
  })

  it('ignores a placement stored for a different view', () => {
    expect(resolveViewSide(view('hello', 'right'), { git: 'left' })).toBe('right')
  })
})
