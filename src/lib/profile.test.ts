import { describe, expect, it } from 'vitest'

import { getProfileAccountName } from './profile'

describe('getProfileAccountName', () => {
  it('uses the active display name instead of the default profile placeholder', () => {
    expect(
      getProfileAccountName({
        profileId: 'default',
        profileName: 'Default',
        activeProfileId: 'default',
        displayName: 'luca',
      }),
    ).toBe('luca')
  })

  it('keeps an explicitly renamed profile name', () => {
    expect(
      getProfileAccountName({
        profileId: 'default',
        profileName: 'Work',
        activeProfileId: 'default',
        displayName: 'luca',
      }),
    ).toBe('Work')
  })

  it('does not apply the active display name to another profile', () => {
    expect(
      getProfileAccountName({
        profileId: 'client',
        profileName: 'Default',
        activeProfileId: 'default',
        displayName: 'luca',
      }),
    ).toBe('Default')
  })

  it('keeps the placeholder when the display name is empty', () => {
    expect(
      getProfileAccountName({
        profileId: 'default',
        profileName: 'Default',
        activeProfileId: 'default',
        displayName: '   ',
      }),
    ).toBe('Default')
  })
})
