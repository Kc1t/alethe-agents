import { describe, expect, it } from 'vitest'

import { toWslGuestPath, wslDistroRootUnc, wslTargetFor } from './wsl'

// The parser is reached only through the feature gate; enabled, `wslTargetFor` is that parser.
const parse = (path: string) => wslTargetFor(path, true)

describe('WSL UNC parsing', () => {
  it('parses both WSL hosts, case-insensitively, with either slash direction', () => {
    expect(parse(String.raw`\\wsl.localhost\Ubuntu\home\dev\projects`)).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/home/dev/projects',
    })
    expect(parse(String.raw`\\wsl$\Debian\etc`)).toEqual({
      distro: 'Debian',
      linuxPath: '/etc',
    })
    expect(parse(String.raw`\\WSL.LOCALHOST\Ubuntu-22.04\srv`)).toEqual({
      distro: 'Ubuntu-22.04',
      linuxPath: '/srv',
    })
    expect(parse('//wsl.localhost/Ubuntu/home/x')).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/home/x',
    })
  })

  it('maps a distro-only path to the Linux root and tolerates duplicated separators', () => {
    expect(parse(String.raw`\\wsl.localhost\Ubuntu`)).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/',
    })
    expect(parse('\\\\wsl.localhost\\Ubuntu\\')).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/',
    })
    expect(parse('\\\\wsl.localhost\\Ubuntu\\\\home\\\\dev\\')).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/home/dev',
    })
  })

  it('rejects anything that is not a WSL UNC path', () => {
    expect(parse(String.raw`\\server\share`)).toBeNull()
    expect(parse(String.raw`C:\Users\x`)).toBeNull()
    expect(parse('/home/dev')).toBeNull()
    expect(parse('')).toBeNull()
    expect(parse('   ')).toBeNull()
    expect(parse(String.raw`\\wsl.localhost`)).toBeNull()
    expect(parse('\\\\wsl$\\')).toBeNull()
  })
})

describe('wslDistroRootUnc', () => {
  it('builds the distro root UNC path', () => {
    expect(wslDistroRootUnc('Ubuntu')).toBe(String.raw`\\wsl.localhost\Ubuntu`)
    expect(wslDistroRootUnc('  Ubuntu-22.04  ')).toBe(String.raw`\\wsl.localhost\Ubuntu-22.04`)
  })

  it('rejects an empty distro name', () => {
    expect(wslDistroRootUnc('')).toBeNull()
    expect(wslDistroRootUnc('   ')).toBeNull()
  })
})

describe('toWslGuestPath', () => {
  it('maps a Windows drive-letter path onto the WSL automount root', () => {
    expect(toWslGuestPath(String.raw`C:\Users\dev\AppData\Local\Temp\x.json`)).toBe(
      '/mnt/c/Users/dev/AppData/Local/Temp/x.json',
    )
    expect(toWslGuestPath(String.raw`D:\a\b`)).toBe('/mnt/d/a/b')
    expect(toWslGuestPath('C:/tmp/x')).toBe('/mnt/c/tmp/x')
  })

  it('unwraps a WSL UNC path, which already names a guest-side file', () => {
    expect(toWslGuestPath(String.raw`\\wsl.localhost\Ubuntu\home\dev\x.json`)).toBe(
      '/home/dev/x.json',
    )
    expect(toWslGuestPath(String.raw`\\wsl$\Debian\etc`)).toBe('/etc')
  })

  it('rejects anything whose guest-side location is unknown', () => {
    expect(toWslGuestPath(String.raw`relative\x.json`)).toBeNull()
    expect(toWslGuestPath('')).toBeNull()
    expect(toWslGuestPath('   ')).toBeNull()
    expect(toWslGuestPath(String.raw`\\server\share\x.json`)).toBeNull()
    expect(toWslGuestPath('/home/dev/x.json')).toBeNull()
  })
})

describe('wslTargetFor', () => {
  it('parses the cwd while the WSL integration is enabled', () => {
    expect(wslTargetFor(String.raw`\\wsl.localhost\Ubuntu\home\dev`, true)).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/home/dev',
    })
  })

  it('sees no target at all while the WSL integration is disabled', () => {
    expect(wslTargetFor(String.raw`\\wsl.localhost\Ubuntu\home\dev`, false)).toBeNull()
  })

  it('tolerates a missing cwd', () => {
    expect(wslTargetFor(null, true)).toBeNull()
    expect(wslTargetFor(undefined, true)).toBeNull()
    expect(wslTargetFor(String.raw`C:\projects\app`, true)).toBeNull()
  })
})
