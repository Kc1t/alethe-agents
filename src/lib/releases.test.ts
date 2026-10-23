import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  compareVersions,
  fetchAletheReleases,
  olderReleases,
  parseReleases,
  releasePageUrl,
} from './releases'

const githubReleases = [
  {
    tag_name: 'v1.7.0',
    published_at: '2026-09-20T12:00:00Z',
    assets: [{ name: 'Alethe_1.7.0_x64-setup.exe' }, { name: 'latest.json' }],
  },
  { tag_name: 'v1.8.0-beta.1', prerelease: true, assets: [{ name: 'latest.json' }] },
  { tag_name: 'v1.6.0', published_at: '2026-08-17T12:00:00Z', assets: [{ name: 'latest.json' }] },
  { tag_name: 'v1.9.0', draft: true, assets: [{ name: 'latest.json' }] },
  { tag_name: 'v1.10.0', published_at: '2026-11-01T12:00:00Z', assets: [{ name: 'Alethe.msi' }] },
  { tag_name: 'v1.2.1', published_at: '2026-06-29T12:00:00Z', assets: [] },
  { tag_name: 'v1.2.3', published_at: '2026-07-01T12:00:00Z', assets: [{ name: 'Alethe.msi' }] },
  { tag_name: 'nightly', assets: [] },
  null,
  'v0.1.0',
]

describe('releases', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps published releases with files and marks the ones the updater can install', () => {
    expect(parseReleases(githubReleases)).toEqual([
      { version: '1.7.0', publishedAt: '2026-09-20T12:00:00Z', installable: true },
      { version: '1.6.0', publishedAt: '2026-08-17T12:00:00Z', installable: true },
      { version: '1.10.0', publishedAt: '2026-11-01T12:00:00Z', installable: false },
      { version: '1.2.3', publishedAt: '2026-07-01T12:00:00Z', installable: false },
    ])
    expect(parseReleases({ message: 'Not Found' })).toEqual([])
  })

  it('compares versions numerically, not as text', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1)
  })

  it('lists only releases older than the running one, newest first', () => {
    const versions = olderReleases(parseReleases(githubReleases), '1.7.0').map(
      (release) => release.version,
    )
    expect(versions).toEqual(['1.6.0', '1.2.3'])
  })

  it('builds the release page from the version, not from the response', () => {
    expect(releasePageUrl('1.6.0')).toBe(
      'https://github.com/Kc1t/alethe-agents/releases/tag/v1.6.0',
    )
  })

  it('reports a failed request instead of an empty list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 403 })),
    )
    await expect(fetchAletheReleases()).rejects.toThrow('GitHub returned 403')
  })
})
