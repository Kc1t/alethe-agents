import { describe, expect, it } from 'vitest'

import { resolveWindowControlsLayout } from './windowControls'

describe('resolveWindowControlsLayout', () => {
  const gnomeLeft = {
    side: 'left' as const,
    buttons: ['close', 'minimize', 'maximize'] as const,
    source: 'gnome',
  }

  it('keeps the detected GNOME left layout when preference is system', () => {
    expect(resolveWindowControlsLayout({ ...gnomeLeft, buttons: [...gnomeLeft.buttons] }, 'system')).toEqual(
      {
        side: 'left',
        buttons: ['close', 'minimize', 'maximize'],
        source: 'gnome',
      },
    )
  })

  it('forces right-hand Windows-like order when preference is right', () => {
    expect(resolveWindowControlsLayout({ ...gnomeLeft, buttons: [...gnomeLeft.buttons] }, 'right')).toEqual(
      {
        side: 'right',
        buttons: ['minimize', 'maximize', 'close'],
        source: 'gnome',
      },
    )
  })

  it('falls back to right when detection is missing', () => {
    expect(resolveWindowControlsLayout(null, 'system').side).toBe('right')
  })
})
