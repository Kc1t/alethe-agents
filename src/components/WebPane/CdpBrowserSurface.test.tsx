import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const browserPaneOpen = vi.fn(async () => ({ paneId: 'p1', targetId: 'T1' }))
const browserPaneClose = vi.fn(async () => {})
const browserPaneTargets = vi.fn(async () => [])
const browserPaneReload = vi.fn(async () => {})
let frameHandler: ((frame: unknown) => void) | null = null

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))

vi.mock('../../lib/tauri', () => ({
  browserPaneOpen: (...args: unknown[]) => browserPaneOpen(...(args as [])),
  browserPaneClose: (...args: unknown[]) => browserPaneClose(...(args as [])),
  browserPaneCloseTarget: vi.fn(async () => {}),
  browserPaneKey: vi.fn(async () => {}),
  browserPaneReload: (...args: unknown[]) => browserPaneReload(...(args as [])),
  browserPaneMouse: vi.fn(async () => {}),
  browserPaneResize: vi.fn(async () => {}),
  browserPaneSetStreaming: vi.fn(async () => {}),
  browserPaneTargets: (...args: unknown[]) => browserPaneTargets(...(args as [])),
  browserPaneWatch: vi.fn(async () => {}),
  listenBrowserPaneFrames: vi.fn(async (_paneId: string, handler: (frame: unknown) => void) => {
    frameHandler = handler
    return () => {}
  }),
  recordFrontendError: vi.fn(async () => {}),
}))

// The real hook builds a new function on every render, which is exactly what made the pane reopen
// itself in a loop. Reproducing that here is the point of the test.
vi.mock('../../lib/i18n', () => ({
  useT: () => (key: string) => `translated:${key}`,
}))

const { CdpBrowserSurface } = await import('./CdpBrowserSurface')

beforeEach(() => {
  browserPaneOpen.mockClear()
  browserPaneClose.mockClear()
  browserPaneTargets.mockClear()
  browserPaneReload.mockClear()
  frameHandler = null
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('CdpBrowserSurface', () => {
  it('opens the pane once and keeps it open across re-renders', async () => {
    const props = { paneId: 'p1', url: 'http://localhost/x', reloadKey: 0, visible: true }
    const view = render(<CdpBrowserSurface {...props} />)
    await flush()
    expect(browserPaneOpen).toHaveBeenCalledTimes(1)

    for (let index = 0; index < 5; index += 1) {
      view.rerender(<CdpBrowserSurface {...props} />)
      await flush()
    }

    expect(
      browserPaneOpen,
      'a re-render must not tear the pane down and open a second one',
    ).toHaveBeenCalledTimes(1)
    expect(
      browserPaneClose,
      'the pane must not be closed while it is still mounted',
    ).not.toHaveBeenCalled()
  })

  it('does not reopen the pane when frames arrive', async () => {
    const props = { paneId: 'p1', url: 'http://localhost/x', reloadKey: 0, visible: true }
    render(<CdpBrowserSurface {...props} />)
    await flush()
    expect(frameHandler).toBeTypeOf('function')

    for (let index = 0; index < 4; index += 1) {
      frameHandler?.({
        data: '',
        deviceWidth: 800,
        deviceHeight: 600,
        offsetTop: 0,
        pageScaleFactor: 1,
      })
      await flush()
    }

    expect(
      browserPaneOpen,
      'painting a frame must never restart the session that produced it',
    ).toHaveBeenCalledTimes(1)
  })

  it('reopens only when the pane is pointed at something else', async () => {
    const props = { paneId: 'p1', url: 'http://localhost/x', reloadKey: 0, visible: true }
    const view = render(<CdpBrowserSurface {...props} />)
    await flush()

    view.rerender(<CdpBrowserSurface {...props} url="http://localhost/y" />)
    await flush()
    expect(browserPaneOpen).toHaveBeenCalledTimes(2)

    view.rerender(<CdpBrowserSurface {...props} url="http://localhost/y" reloadKey={1} />)
    await flush()
    expect(
      browserPaneOpen,
      'a reload must not open a second tab; the point is to reload the one already there',
    ).toHaveBeenCalledTimes(2)
    expect(browserPaneReload, 'the reload has to reach the page').toHaveBeenCalledTimes(1)
  })

  it('reloads without cache rather than opening a fresh tab', async () => {
    const props = { paneId: 'p1', url: 'http://localhost/x', reloadKey: 0, visible: true }
    const view = render(<CdpBrowserSurface {...props} />)
    await flush()
    expect(browserPaneReload, 'mounting is not a reload').not.toHaveBeenCalled()

    view.rerender(<CdpBrowserSurface {...props} reloadKey={1} />)
    await flush()
    expect(browserPaneReload).toHaveBeenCalledTimes(1)
    expect(browserPaneOpen, 'the tab stays put across a reload').toHaveBeenCalledTimes(1)
  })
})
