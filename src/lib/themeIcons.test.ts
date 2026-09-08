import { afterEach, describe, expect, it, vi } from 'vitest'

import { getThemeIcon } from './themeIcons'

describe('getThemeIcon', () => {
  afterEach(() => vi.restoreAllMocks())

  it('uses the high-resolution master for the Linux window switcher', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)')

    expect(getThemeIcon('elite-indigo')).toContain('/src/assets/theme-icons/elite-indigo.png')
    expect(getThemeIcon('elite-indigo', 32)).toContain(
      '/src/assets/theme-icons/32/elite-indigo.png',
    )
  })
})
