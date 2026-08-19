import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AsciiEffect } from './ascii-effect'

type FrameCallback = (time: number) => void

describe('AsciiEffect scheduling', () => {
  let frameCallbacks: Map<number, FrameCallback>
  let nextFrameId: number
  let motionMatches: boolean
  let motionListener: ((event: MediaQueryListEvent) => void) | null
  let visibility: DocumentVisibilityState
  let rectWidth: number
  let resizeCallback: ResizeObserverCallback | null
  let intersectionCallback: IntersectionObserverCallback | null
  let context: CanvasRenderingContext2D
  let getImageData: ReturnType<typeof vi.fn>
  let fillText: ReturnType<typeof vi.fn>

  const runFrame = (time = 1000) => {
    const entry = frameCallbacks.entries().next().value as [number, FrameCallback] | undefined
    expect(entry).toBeDefined()
    frameCallbacks.delete(entry![0])
    entry![1](time)
  }

  beforeEach(() => {
    frameCallbacks = new Map()
    nextFrameId = 1
    motionMatches = false
    motionListener = null
    visibility = 'visible'
    rectWidth = 120
    resizeCallback = null
    intersectionCallback = null

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          width: rectWidth,
          height: 80,
          top: 0,
          right: rectWidth,
          bottom: 80,
          left: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    )

    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameCallback) => {
        const id = nextFrameId++
        frameCallbacks.set(id, callback)
        return id
      }),
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        frameCallbacks.delete(id)
      }),
    )
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: motionMatches,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          motionListener = listener
        },
        removeEventListener: () => {
          motionListener = null
        },
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })

    class MockImage {
      complete = false
      crossOrigin = ''
      naturalHeight = 80
      naturalWidth = 120
      onload: (() => void) | null = null
      private value = ''

      get src() {
        return this.value
      }

      set src(value: string) {
        this.value = value
        this.complete = true
        this.onload?.()
      }
    }
    vi.stubGlobal('Image', MockImage)

    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver)

    class MockIntersectionObserver {
      root = null
      rootMargin = '0px'
      thresholds = [0]
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback
      }
      observe() {
        intersectionCallback?.(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        )
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)

    getImageData = vi.fn((_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4).fill(255),
    }))
    fillText = vi.fn()
    context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: '',
      fillText,
      font: '',
      getImageData,
      measureText: vi.fn(() => ({ width: 6 })),
      setTransform: vi.fn(),
      textBaseline: 'top',
    } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders one static frame without scheduling animation when reduced motion is selected', () => {
    render(<AsciiEffect imageSrc="background.png" variant="flow" reducedMotion />)

    expect(getImageData).toHaveBeenCalledTimes(1)
    expect(fillText).toHaveBeenCalled()
    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })

  it('honors the operating system reduced-motion preference', () => {
    motionMatches = true

    render(<AsciiEffect imageSrc="background.png" variant="flow" />)

    expect(getImageData).toHaveBeenCalledTimes(1)
    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })

  it('reuses sampled pixels and luminance across animation frames', () => {
    render(<AsciiEffect imageSrc="background.png" variant="flow" frameRate={20} />)

    expect(getImageData).toHaveBeenCalledTimes(1)
    runFrame(1000)
    runFrame(1060)

    expect(getImageData).toHaveBeenCalledTimes(1)
    expect(frameCallbacks.size).toBe(1)
  })

  it('keeps the Home effect at its original 8px grid and 30 FPS cadence', () => {
    render(<AsciiEffect imageSrc="background.png" variant="flow" fontSize={8} />)

    expect(context.font).toContain('8px')
    runFrame(1000)
    const drawsAfterFirstFrame = fillText.mock.calls.length

    runFrame(1020)
    expect(fillText).toHaveBeenCalledTimes(drawsAfterFirstFrame)

    runFrame(1034)
    expect(fillText.mock.calls.length).toBeGreaterThan(drawsAfterFirstFrame)
  })

  it('rebuilds the sample only when the rendered size changes', () => {
    render(<AsciiEffect imageSrc="background.png" variant="flow" />)

    expect(getImageData).toHaveBeenCalledTimes(1)
    resizeCallback?.([], {} as ResizeObserver)
    expect(getImageData).toHaveBeenCalledTimes(1)

    rectWidth = 180
    resizeCallback?.([], {} as ResizeObserver)
    expect(getImageData).toHaveBeenCalledTimes(2)
  })

  it('cancels and resumes the loop as document visibility changes', () => {
    render(<AsciiEffect imageSrc="background.png" variant="flow" />)
    expect(frameCallbacks.size).toBe(1)

    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frameCallbacks.size).toBe(0)
    expect(cancelAnimationFrame).toHaveBeenCalled()

    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frameCallbacks.size).toBe(1)
  })

  it('defers resize sampling while the document is hidden', () => {
    render(<AsciiEffect imageSrc="background.png" variant="flow" />)
    expect(getImageData).toHaveBeenCalledTimes(1)

    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    rectWidth = 180
    resizeCallback?.([], {} as ResizeObserver)
    expect(getImageData).toHaveBeenCalledTimes(1)

    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(getImageData).toHaveBeenCalledTimes(2)
  })

  it('cancels and resumes the loop as the canvas leaves and re-enters the viewport', () => {
    render(<AsciiEffect imageSrc="background.png" variant="flow" />)
    expect(frameCallbacks.size).toBe(1)

    intersectionCallback?.(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    )
    expect(frameCallbacks.size).toBe(0)

    intersectionCallback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    )
    expect(frameCallbacks.size).toBe(1)
  })

  it('defers resize sampling while the canvas is outside the viewport', () => {
    render(<AsciiEffect imageSrc="background.png" variant="flow" />)
    expect(getImageData).toHaveBeenCalledTimes(1)

    intersectionCallback?.(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    )
    rectWidth = 180
    resizeCallback?.([], {} as ResizeObserver)
    expect(getImageData).toHaveBeenCalledTimes(1)

    intersectionCallback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    )
    expect(getImageData).toHaveBeenCalledTimes(2)
  })

  it('reacts when the operating system enables reduced motion', () => {
    render(<AsciiEffect imageSrc="background.png" variant="flow" />)
    expect(frameCallbacks.size).toBe(1)

    motionListener?.({ matches: true } as MediaQueryListEvent)
    expect(frameCallbacks.size).toBe(0)

    motionListener?.({ matches: false } as MediaQueryListEvent)
    expect(frameCallbacks.size).toBe(1)
  })

  it('clears pointer ripple state when rendering options restart the effect', () => {
    const clearTimeout = vi.spyOn(window, 'clearTimeout')
    const { container, rerender } = render(<AsciiEffect imageSrc="background.png" variant="flow" />)
    fireEvent.pointerMove(container.firstElementChild as Element, { clientX: 30, clientY: 20 })

    rerender(<AsciiEffect imageSrc="background.png" variant="flow" reducedMotion />)
    expect(clearTimeout).toHaveBeenCalled()

    rerender(<AsciiEffect imageSrc="background.png" variant="flow" />)
    expect(frameCallbacks.size).toBe(1)
  })
})
