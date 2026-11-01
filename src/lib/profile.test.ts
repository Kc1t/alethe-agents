import { describe, expect, it } from 'vitest'

import { getProfileAccountName, getProfileImageUrl } from './profile'
import { DEFAULT_PREFERENCES } from './types'

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

describe('getProfileImageUrl', () => {
  it('falls back to the app icon the person picked', () => {
    const blush = getProfileImageUrl({ ...DEFAULT_PREFERENCES, appIconTheme: 'elite-blush' })
    expect(blush).toContain('elite-blush')
    expect(getProfileImageUrl({ ...DEFAULT_PREFERENCES, profileImageUrl: '  ' })).toContain(
      'elite-indigo',
    )
  })

  it('prefers a photo the person set', () => {
    expect(
      getProfileImageUrl({ ...DEFAULT_PREFERENCES, profileImageUrl: ' https://x.test/me.png ' }),
    ).toBe('https://x.test/me.png')
  })
})
