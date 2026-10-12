import { describe, expect, it } from 'vitest'

import { ptyLaunchTarget } from './ptyLaunchTarget'

describe('ptyLaunchTarget', () => {
  it('spawns each Pi family runtime from its own binary', () => {
    expect(ptyLaunchTarget('pi')).toEqual({ command: 'pi', launcherOverride: undefined })
    expect(ptyLaunchTarget('oh-my-pi')).toEqual({ command: 'omp', launcherOverride: undefined })
  })

  it('keeps the plain shell fallback out of agent tabs', () => {
    expect(ptyLaunchTarget('shell').command).toBeUndefined()
  })
})
