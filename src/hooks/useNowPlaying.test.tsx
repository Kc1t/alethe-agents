import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spotifyGetCurrent, spotifyStatus } = vi.hoisted(() => ({
  spotifyGetCurrent: vi.fn(),
  spotifyStatus: vi.fn(),
}))

vi.mock('../lib/storageNamespace', () => ({
  readScopedStorage: vi.fn(() => null),
  writeScopedStorage: vi.fn(),
}))

vi.mock('../lib/tauri', () => ({
  spotifyGetCurrent,
  spotifyLogin: vi.fn(),
  spotifyLogout: vi.fn(),
  spotifyStatus,
}))

vi.mock('../stores/projectsStore', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown) =>
    selector({ preferences: { spotifyClientId: '', spotifyClientSecret: '' } }),
}))

import { useNowPlaying } from './useNowPlaying'

describe('useNowPlaying', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('shares status and current-track requests across concurrent widgets', async () => {
    spotifyStatus.mockResolvedValue(true)
    spotifyGetCurrent.mockResolvedValue({
      album: 'Album',
      album_image_url: null,
      artist: 'Artist',
      playing: true,
      track: 'Track',
      track_url: null,
    })

    const { result, unmount } = renderHook(() => [useNowPlaying(true), useNowPlaying(true)])

    await waitFor(() => {
      expect(result.current[0].current?.track).toBe('Track')
      expect(result.current[1].current?.track).toBe('Track')
    })

    expect(spotifyStatus).toHaveBeenCalledTimes(1)
    expect(spotifyGetCurrent).toHaveBeenCalledTimes(1)
    unmount()
  })
})
