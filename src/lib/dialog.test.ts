import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}))

vi.mock('../stores/uiStore', () => ({
  useUiStore: {
    getState: vi.fn(),
  },
}))

import { open, save } from '@tauri-apps/plugin-dialog'

import { pickDirectory, pickFile, resolvePendingFsBrowser, saveFile } from './dialog'
import { useUiStore } from '../stores/uiStore'

function setUserAgent(ua: string) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
}

describe('dialog pickers', () => {
  const openFsBrowser = vi.fn()

  beforeEach(() => {
    openFsBrowser.mockReset()
    vi.mocked(useUiStore.getState).mockReturnValue({ openFsBrowser } as never)
    vi.mocked(open).mockReset()
    vi.mocked(save).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resolvePendingFsBrowser(null)
  })

  it('uses the native OS dialog on Linux when running inside Tauri', async () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    vi.mocked(open).mockResolvedValue('/home/akira/proj')

    await expect(pickDirectory({ defaultPath: '/home/akira' })).resolves.toBe('/home/akira/proj')
    expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      defaultPath: '/home/akira',
    })
    expect(openFsBrowser).not.toHaveBeenCalled()
  })

  it('uses the native dialog for folders on Windows', async () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    vi.mocked(open).mockResolvedValue('D:\\Projects\\foo')

    await expect(pickDirectory({ defaultPath: 'D:\\Projects' })).resolves.toBe('D:\\Projects\\foo')
    expect(openFsBrowser).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      defaultPath: 'D:\\Projects',
    })
  })

  it('falls back to the in-app browser when the native picker throws', async () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    vi.mocked(open).mockRejectedValue(new Error('portal unavailable'))

    const pending = pickFile({ title: 'Pick md', defaultPath: '/tmp' })
    await vi.waitFor(() => {
      expect(openFsBrowser).toHaveBeenCalledWith({
        mode: 'file',
        title: 'Pick md',
        defaultPath: '/tmp',
      })
    })

    resolvePendingFsBrowser('/tmp/a.md')
    await expect(pending).resolves.toBe('/tmp/a.md')
  })

  it('opens the in-app browser outside Tauri', async () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')
    // Ensure no Tauri globals from prior tests.
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__

    const pending = saveFile({ title: 'Export', defaultPath: '/tmp/out.json' })
    expect(save).not.toHaveBeenCalled()
    expect(openFsBrowser).toHaveBeenCalledWith({
      mode: 'file',
      title: 'Export',
      defaultPath: '/tmp/out.json',
    })

    resolvePendingFsBrowser('/tmp/out.json')
    await expect(pending).resolves.toBe('/tmp/out.json')
  })
})
