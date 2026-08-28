import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const created: MockWebview[] = []
let intersectionCallback: ((entries: IntersectionObserverEntry[]) => void) | null = null
let resizeCallback: (() => void) | null = null
let frameCallbacks: Map<number, FrameRequestCallback>
let nextFrameId = 1
let rect = { x: 100, y: 50, width: 400, height: 300 }

class MockWebview {
  label: string
  options: Record<string, unknown>
  handlers = new Map<string, (event: { payload?: unknown }) => void>()
  setPosition = vi.fn(async () => {})
  setSize = vi.fn(async () => {})
  show = vi.fn(async () => {})
  hide = vi.fn(async () => {})
  close = vi.fn(async () => {})
  setZoom = vi.fn(async () => {})

  constructor(_window: unknown, label: string, options: Record<string, unknown>) {
    this.label = label
    this.options = options
    created.push(this)
  }

  async once(event: string, handler: (event: { payload?: unknown }) => void) {
    this.handlers.set(event, handler)
    return () => {}
  }

  emitCreated() {
    this.handlers.get('tauri://created')?.({})
  }
}

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/webview', () => ({ Webview: MockWebview }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onScaleChanged: async () => () => {} }),
}))
vi.mock('@tauri-apps/api/dpi', () => ({
  PhysicalPosition: class {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
  PhysicalSize: class {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
}))
vi.mock('../../lib/tauri', () => ({ recordFrontendError: vi.fn(async () => {}) }))
vi.mock('../../lib/i18n', () => ({ useT: () => (key: string) => key }))

const { PrivateBrowserSurface } = await import('./PrivateBrowserSurface')

const props = {
  paneId: 'pane-1',
  url: 'https://example.com',
  title: 'Example',
  reloadKey: 0,
  javascriptEnabled: true,
  hiddenEvictionDelayMs: null,
  zoom: 1,
  visible: true,
}

/** Drains queued frames, letting each sync's awaits settle before the next one runs. */
async function pump(times = 3) {
  for (let round = 0; round < times; round += 1) {
    const entry = frameCallbacks.entries().next().value
    if (entry) {
      frameCallbacks.delete(entry[0])
      entry[1](performance.now())
    }
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
}

async function mountReady() {
  render(<PrivateBrowserSurface {...props} />)
  await pump()
  const webview = created[0]!
  webview.emitCreated()
  await pump()
  return webview
}

beforeEach(() => {
  created.length = 0
  frameCallbacks = new Map()
  nextFrameId = 1
  intersectionCallback = null
  resizeCallback = null
  rect = { x: 100, y: 50, width: 400, height: 300 }
  window.innerWidth = 1920
  window.innerHeight = 1080

  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback) => {
      const id = nextFrameId++
      frameCallbacks.set(id, cb)
      return id
    }),
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => frameCallbacks.delete(id)),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        resizeCallback = cb
      }
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: (entries: IntersectionObserverEntry[]) => void) {
        intersectionCallback = cb
      }
      observe() {}
      disconnect() {}
    },
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        ...rect,
        left: rect.x,
        top: rect.y,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
        toJSON: () => rect,
      }) as DOMRect,
  )
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('PrivateBrowserSurface', () => {
  it('creates the native webview at the measured rect', async () => {
    render(<PrivateBrowserSurface {...props} />)
    await pump()
    expect(created).toHaveLength(1)
    expect(created[0]!.options).toMatchObject({ x: 100, y: 50, width: 400, height: 300 })
  })

  it('does not create a webview while the pane is not visible', async () => {
    render(<PrivateBrowserSurface {...props} visible={false} />)
    await pump()
    expect(created).toHaveLength(0)
  })

  it('does not create a webview when the pane is clipped away', async () => {
    rect = { x: 0, y: 0, width: 0, height: 0 }
    render(<PrivateBrowserSurface {...props} />)
    await pump()
    expect(created).toHaveLength(0)
  })

  it('repositions before showing again after being hidden', async () => {
    const webview = await mountReady()
    expect(webview.show).toHaveBeenCalledTimes(1)

    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'dialog')
    document.body.append(overlay)
    resizeCallback?.()
    await pump()
    expect(webview.hide).toHaveBeenCalledTimes(1)

    webview.setPosition.mockClear()
    overlay.remove()
    resizeCallback?.()
    await pump()

    expect(
      webview.setPosition,
      'the surface must be placed before it is revealed, even at an unchanged rect',
    ).toHaveBeenCalled()
    expect(webview.show).toHaveBeenCalledTimes(2)
  })

  it('moves the surface when the pane rect changes', async () => {
    const webview = await mountReady()
    webview.setPosition.mockClear()
    webview.setSize.mockClear()

    rect = { x: 220, y: 70, width: 500, height: 320 }
    resizeCallback?.()
    await pump()

    expect(webview.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 220, y: 70 }))
    expect(webview.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 500, height: 320 }),
    )
  })

  it('hides the surface when it leaves the viewport', async () => {
    const webview = await mountReady()
    intersectionCallback?.([{ isIntersecting: false } as IntersectionObserverEntry])
    await pump()
    expect(webview.hide).toHaveBeenCalledTimes(1)
  })

  it('does not latch a rect that failed to apply, and retries it', async () => {
    const webview = await mountReady()
    webview.show.mockClear()
    webview.setPosition.mockRejectedValueOnce(new Error('move rejected'))

    rect = { x: 300, y: 300, width: 200, height: 200 }
    resizeCallback?.()
    await pump()

    expect(
      webview.show,
      'a surface that failed to move must not be revealed',
    ).not.toHaveBeenCalled()

    const attempts = webview.setPosition.mock.calls.filter(
      ([position]) => (position as { x: number }).x === 300,
    )
    expect(
      attempts.length,
      'the rejected rect must be attempted again instead of being latched as applied',
    ).toBeGreaterThan(1)
  })

  it('scales the rect to physical pixels on a HiDPI display', async () => {
    vi.stubGlobal('devicePixelRatio', 2)
    render(<PrivateBrowserSurface {...props} />)
    await pump()
    expect(created[0]!.options).toMatchObject({ x: 200, y: 100, width: 800, height: 600 })
  })
})
