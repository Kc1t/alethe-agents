import { beforeEach, describe, expect, it, vi } from 'vitest'

const { allowAssetPreview } = vi.hoisted(() => ({ allowAssetPreview: vi.fn() }))

vi.mock('./tauri', () => ({ allowAssetPreview }))
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}))

import { mediaUrl } from './mediaUrl'

describe('mediaUrl', () => {
  beforeEach(() => {
    allowAssetPreview.mockReset()
  })

  it('asks the backend once per file and loads the path it allowed', async () => {
    allowAssetPreview.mockResolvedValue('/home/me/real.png')

    const first = await mediaUrl('/home/me/link.png')
    const second = await mediaUrl('/home/me/link.png')

    expect(first).toBe('asset://localhost/%2Fhome%2Fme%2Freal.png')
    expect(second).toBe(first)
    expect(allowAssetPreview).toHaveBeenCalledTimes(1)
  })

  it('asks again after a refusal, so a file created later can still be shown', async () => {
    allowAssetPreview.mockRejectedValueOnce('preview_not_found').mockResolvedValue('/tmp/new.png')

    await expect(mediaUrl('/tmp/new.png')).rejects.toBe('preview_not_found')
    await expect(mediaUrl('/tmp/new.png')).resolves.toContain('new.png')
    expect(allowAssetPreview).toHaveBeenCalledTimes(2)
  })
})
