import { type HTMLAttributes, type PointerEvent, useEffect, useRef } from 'react'

import styles from './AsciiEffect.module.css'

export interface AsciiEffectProps extends Omit<HTMLAttributes<HTMLDivElement>, 'color'> {
  imageSrc: string
  alt?: string
  variant?: 'image' | 'flow' | 'glitch'
  chars?: string
  fontSize?: number
  fontFamily?: string
  fontWeight?: number | string
  lineHeight?: number
  characterSpacing?: number
  brightnessBoost?: number
  contrast?: number
  threshold?: number
  posterize?: number
  dither?: 'none' | 'floyd-steinberg' | 'bayer'
  ditherStrength?: number
  flowSpeed?: number
  flowDirection?: number
  flowStrength?: number
  flowFrequency?: number
  mouseRadius?: number
  mouseStrength?: number
  mouseWaveSpeed?: number
  scale?: number
  fit?: 'cover' | 'contain' | 'stretch'
  colors?: string[]
  colorMode?: 'gradient' | 'source'
  backgroundColor?: string
  invert?: boolean
  glitchIntensity?: number
  glitchFrequency?: number
  revealDuration?: number
  frameRate?: number
  reducedMotion?: boolean
}

type SampleCache = {
  columns: number
  rows: number
  cellWidth: number
  cellHeight: number
  pixels: Uint8ClampedArray
  luminance: Float32Array
}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))

function resolveColor(element: HTMLElement, color: string): string {
  const match = /^var\((--[^),]+)(?:,[^)]+)?\)$/.exec(color.trim())
  if (!match) return color
  return getComputedStyle(element).getPropertyValue(match[1]).trim() || color
}

function parseHex(color: string): [number, number, number] | null {
  const short = /^#([\da-f])([\da-f])([\da-f])$/i.exec(color)
  if (short)
    return short.slice(1).map((part) => Number.parseInt(`${part}${part}`, 16)) as [
      number,
      number,
      number,
    ]
  const full = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color)
  return full
    ? (full.slice(1).map((part) => Number.parseInt(part, 16)) as [number, number, number])
    : null
}

function gradientColor(colors: string[], amount: number): string {
  if (colors.length < 2) return colors[0] ?? '#ffffff'
  const position = clamp(amount) * (colors.length - 1)
  const index = Math.min(Math.floor(position), colors.length - 2)
  const mix = position - index
  const from = parseHex(colors[index])
  const to = parseHex(colors[index + 1])
  if (!from || !to) return colors[Math.round(position)] ?? colors[0]
  return `rgb(${from.map((channel, i) => Math.round(channel + (to[i] - channel) * mix)).join(', ')})`
}

export function AsciiEffect({
  imageSrc,
  alt = 'ASCII rendering',
  variant = 'image',
  chars = ' .:-=+*#%@',
  fontSize = 9,
  fontFamily = 'Arial, Helvetica, sans-serif',
  fontWeight = 400,
  lineHeight = 1,
  characterSpacing = 1,
  brightnessBoost = 2.2,
  contrast = 1.1,
  threshold = 0.06,
  posterize = 32,
  dither = 'floyd-steinberg',
  ditherStrength = 0.8,
  flowSpeed = 0.22,
  flowDirection = 0,
  flowStrength = 12,
  flowFrequency = 0.018,
  mouseRadius = 150,
  mouseStrength = 22,
  mouseWaveSpeed = 1.2,
  scale = 1.15,
  fit = 'cover',
  colors = ['var(--fg-faint)', 'var(--accent)'],
  colorMode = 'gradient',
  backgroundColor = 'transparent',
  invert = false,
  glitchIntensity = 0.65,
  glitchFrequency = 1.4,
  revealDuration = 1400,
  frameRate = 30,
  reducedMotion = false,
  className,
  onPointerMove,
  onPointerLeave,
  ...props
}: AsciiEffectProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pointer = useRef({ x: 0, y: 0, targetX: 0, targetY: 0, active: false })
  const pointerIdleTimer = useRef<number | null>(null)
  const colorSignature = colors.join('\u0000')

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas || !chars.length) return
    const context = canvas.getContext('2d')
    const sampleCanvas = document.createElement('canvas')
    const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true })
    if (!context || !sampleContext) return
    const pointerState = pointer.current

    const image = new Image()
    image.crossOrigin = 'anonymous'
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const effectColors = colorSignature.split('\u0000')
    const targetFrameMs = 1000 / Math.min(60, Math.max(1, frameRate))
    const supportsIntersectionObserver = typeof IntersectionObserver !== 'undefined'
    let frame = 0
    let width = 0
    let height = 0
    let dpr = 1
    let loaded = false
    let isIntersecting = !supportsIntersectionObserver
    let systemReducedMotion = motionQuery.matches
    let startedAt = 0
    let lastFrameAt = 0
    let nextGlitchAt = 0
    let glitchUntil = 0
    let glitchBands = new Map<number, number>()
    let sampleCache: SampleCache | null = null
    let sampleDirty = true
    let resolvedColors: string[] = []
    let resolvedBackground = 'transparent'

    const isMotionReduced = () => reducedMotion || systemReducedMotion
    const canAnimate = () =>
      loaded &&
      sampleCache !== null &&
      !isMotionReduced() &&
      variant !== 'image' &&
      document.visibilityState !== 'hidden' &&
      isIntersecting

    const refreshColors = () => {
      resolvedColors = effectColors.map((color) => resolveColor(container, color))
      resolvedBackground = resolveColor(container, backgroundColor)
    }

    const rebuildSample = () => {
      if (!loaded || !width || !height) return
      const cellHeight = Math.max(4, fontSize * Math.max(0.5, lineHeight))
      context.font = `${fontWeight} ${fontSize}px ${fontFamily}`
      const cellWidth = Math.max(
        2,
        context.measureText('M').width * Math.max(0.5, characterSpacing),
      )
      const columns = Math.ceil(width / cellWidth) + 2
      const rows = Math.ceil(height / cellHeight) + 2
      sampleCanvas.width = columns
      sampleCanvas.height = rows

      const imageScale =
        fit === 'stretch'
          ? 1
          : (fit === 'contain'
              ? Math.min(width / image.naturalWidth, height / image.naturalHeight)
              : Math.max(width / image.naturalWidth, height / image.naturalHeight)) *
            Math.max(0.1, scale)
      const drawWidth = fit === 'stretch' ? columns : (image.naturalWidth * imageScale) / cellWidth
      const drawHeight = fit === 'stretch' ? rows : (image.naturalHeight * imageScale) / cellHeight
      sampleContext.clearRect(0, 0, columns, rows)
      sampleContext.drawImage(
        image,
        (columns - drawWidth) / 2,
        (rows - drawHeight) / 2,
        drawWidth,
        drawHeight,
      )

      const pixels = sampleContext.getImageData(0, 0, columns, rows).data
      const luminance = new Float32Array(columns * rows)
      const steps = Math.max(2, Math.round(posterize))
      for (let index = 0; index < luminance.length; index += 1) {
        const pixel = index * 4
        const alpha = pixels[pixel + 3] / 255
        let value =
          (pixels[pixel] * 0.2126 + pixels[pixel + 1] * 0.7152 + pixels[pixel + 2] * 0.0722) / 255
        value = clamp((value - 0.5) * Math.max(0, contrast) + 0.5)
        value = clamp(value * brightnessBoost * alpha)
        luminance[index] =
          value <= threshold ? 0 : (value - threshold) / Math.max(0.001, 1 - threshold)
      }

      if (dither === 'bayer') {
        const matrix = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
        luminance.forEach((value, index) => {
          const row = Math.floor(index / columns)
          const column = index % columns
          luminance[index] = clamp(
            value + ((matrix[(row % 4) * 4 + (column % 4)] / 16 - 0.5) * clamp(ditherStrength)) / 4,
          )
        })
      } else {
        luminance.forEach((value, index) => {
          const quantized = Math.round(clamp(value) * (steps - 1)) / (steps - 1)
          luminance[index] =
            dither === 'floyd-steinberg'
              ? value + (quantized - value) * clamp(ditherStrength)
              : quantized
        })
      }

      sampleCache = { columns, rows, cellWidth, cellHeight, pixels, luminance }
      sampleDirty = false
    }

    const draw = (now: number) => {
      const cache = sampleCache
      if (!loaded || !width || !height || !cache) return
      const { columns, rows, cellWidth, cellHeight, pixels, luminance } = cache
      const motionReduced = isMotionReduced()
      pointerState.x += (pointerState.targetX - pointerState.x) * 0.08
      pointerState.y += (pointerState.targetY - pointerState.y) * 0.08
      context.font = `${fontWeight} ${fontSize}px ${fontFamily}`

      if (variant === 'glitch' && !motionReduced && glitchFrequency > 0 && now >= nextGlitchAt) {
        glitchBands = new Map()
        const count = Math.max(1, Math.round(clamp(glitchIntensity) * 4))
        for (let i = 0; i < count; i += 1) {
          const row = Math.floor(Math.random() * rows)
          glitchBands.set(row, (Math.random() - 0.5) * fontSize * 12 * clamp(glitchIntensity))
        }
        glitchUntil = now + 70 + 90 * clamp(glitchIntensity)
        nextGlitchAt = now + 1000 / glitchFrequency
      }
      if (now > glitchUntil) glitchBands.clear()

      context.clearRect(0, 0, width, height)
      if (resolvedBackground !== 'transparent') {
        context.fillStyle = resolvedBackground
        context.fillRect(0, 0, width, height)
      }
      context.textBaseline = 'top'
      const reveal =
        variant === 'glitch' && !motionReduced && revealDuration > 0
          ? clamp((now - startedAt) / revealDuration)
          : 1
      const radians = (flowDirection * Math.PI) / 180
      const directionX = Math.cos(radians)
      const directionY = Math.sin(radians)

      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const dx = column / Math.max(1, columns - 1) - 0.5
          const dy = row / Math.max(1, rows - 1) - 0.5
          if (Math.hypot(dx, dy) > reveal * 0.72) continue
          let sourceColumn = column
          let sourceRow = row
          if (variant === 'flow' && !motionReduced) {
            const x = column * cellWidth
            const y = row * cellHeight
            const phase =
              (x * directionX + y * directionY) * flowFrequency + now * flowSpeed * Math.PI * 0.002
            const drift = Math.sin(phase) * flowStrength
            sourceColumn -= (directionX * drift) / cellWidth
            sourceRow -= (directionY * drift) / cellHeight
            if (pointerState.active && mouseRadius > 0) {
              const mouseX = x - pointerState.x
              const mouseY = y - pointerState.y
              const distance = Math.hypot(mouseX, mouseY)
              const influence = clamp(1 - distance / mouseRadius)
              if (distance > 0 && influence > 0) {
                const ripple = Math.sin(distance * 0.055 - now * mouseWaveSpeed * Math.PI * 0.002)
                sourceColumn -=
                  ((mouseX / distance) * influence ** 2 * mouseStrength * ripple) / cellWidth
                sourceRow -=
                  ((mouseY / distance) * influence ** 2 * mouseStrength * ripple) / cellHeight
              }
            }
          }
          const sampledColumn = Math.round(clamp(sourceColumn, 0, columns - 1))
          const sampledRow = Math.round(clamp(sourceRow, 0, rows - 1))
          const sampleIndex = sampledRow * columns + sampledColumn
          const pixel = sampleIndex * 4
          const value = invert ? 1 - clamp(luminance[sampleIndex]) : clamp(luminance[sampleIndex])
          const character =
            chars[Math.min(chars.length - 1, Math.floor(value * (chars.length - 1)))]
          if (!character?.trim()) continue
          context.fillStyle =
            colorMode === 'source'
              ? `rgb(${pixels[pixel]}, ${pixels[pixel + 1]}, ${pixels[pixel + 2]})`
              : gradientColor(resolvedColors, value)
          context.fillText(
            character,
            column * cellWidth - cellWidth + (glitchBands.get(row) ?? 0),
            row * cellHeight - cellHeight,
          )
        }
      }
    }

    const cancelLoop = () => {
      if (!frame) return
      cancelAnimationFrame(frame)
      frame = 0
    }

    const animate = (now: number) => {
      frame = 0
      if (!canAnimate()) return
      if (now - lastFrameAt >= targetFrameMs) {
        lastFrameAt = now
        draw(now)
      }
      frame = requestAnimationFrame(animate)
    }

    const updatePlayback = (redrawStatic = true) => {
      const canRender = loaded && document.visibilityState !== 'hidden' && isIntersecting
      if (!canRender) {
        cancelLoop()
        return
      }
      const rebuilt = sampleDirty || sampleCache === null
      if (rebuilt) rebuildSample()
      if (canAnimate()) {
        if (rebuilt) draw(performance.now())
        if (!frame) frame = requestAnimationFrame(animate)
        return
      }
      cancelLoop()
      if ((redrawStatic || rebuilt) && sampleCache) {
        draw(performance.now())
      }
    }

    const resize = () => {
      const rect = container.getBoundingClientRect()
      const nextWidth = Math.max(1, rect.width)
      const nextHeight = Math.max(1, rect.height)
      const nextDpr = Math.min(window.devicePixelRatio || 1, 2)
      if (sampleCache && nextWidth === width && nextHeight === height && nextDpr === dpr) {
        return
      }
      width = nextWidth
      height = nextHeight
      dpr = nextDpr
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (!loaded) return
      sampleDirty = true
      updatePlayback()
    }

    const start = () => {
      if (loaded || !image.naturalWidth || !image.naturalHeight) return
      loaded = true
      startedAt = performance.now()
      refreshColors()
      resize()
    }
    const handleVisibilityChange = () => updatePlayback()
    const handleMotionChange = (event: MediaQueryListEvent) => {
      systemReducedMotion = event.matches
      updatePlayback()
    }

    image.onload = start
    image.src = imageSrc
    if (image.complete) start()

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)
    const intersectionObserver = !supportsIntersectionObserver
      ? null
      : new IntersectionObserver(([entry]) => {
          isIntersecting = entry?.isIntersecting ?? true
          updatePlayback()
        })
    intersectionObserver?.observe(container)
    const themeObserver = new MutationObserver(() => {
      refreshColors()
      updatePlayback()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    document.addEventListener('visibilitychange', handleVisibilityChange)
    motionQuery.addEventListener('change', handleMotionChange)

    return () => {
      cancelLoop()
      resizeObserver.disconnect()
      intersectionObserver?.disconnect()
      themeObserver.disconnect()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      motionQuery.removeEventListener('change', handleMotionChange)
      image.onload = null
      pointerState.active = false
      if (pointerIdleTimer.current !== null) {
        window.clearTimeout(pointerIdleTimer.current)
        pointerIdleTimer.current = null
      }
    }
  }, [
    backgroundColor,
    brightnessBoost,
    characterSpacing,
    chars,
    colorMode,
    colorSignature,
    contrast,
    dither,
    ditherStrength,
    fit,
    flowDirection,
    flowFrequency,
    flowSpeed,
    flowStrength,
    fontFamily,
    fontSize,
    fontWeight,
    frameRate,
    glitchFrequency,
    glitchIntensity,
    imageSrc,
    invert,
    lineHeight,
    mouseRadius,
    mouseStrength,
    mouseWaveSpeed,
    posterize,
    reducedMotion,
    revealDuration,
    scale,
    threshold,
    variant,
  ])

  const trackPointer = (event: PointerEvent<HTMLDivElement>) => {
    onPointerMove?.(event)
    if (variant !== 'flow' || reducedMotion) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    if (!pointer.current.active) {
      pointer.current.x = x
      pointer.current.y = y
    }
    pointer.current.active = true
    pointer.current.targetX = x
    pointer.current.targetY = y
    if (pointerIdleTimer.current !== null) window.clearTimeout(pointerIdleTimer.current)
    pointerIdleTimer.current = window.setTimeout(() => {
      pointer.current.active = false
      pointerIdleTimer.current = null
    }, 700)
  }

  const resetPointer = (event: PointerEvent<HTMLDivElement>) => {
    onPointerLeave?.(event)
    pointer.current.active = false
    if (pointerIdleTimer.current !== null) {
      window.clearTimeout(pointerIdleTimer.current)
      pointerIdleTimer.current = null
    }
  }

  return (
    <div
      ref={containerRef}
      className={`${styles.root} ${className ?? ''}`}
      onPointerMove={trackPointer}
      onPointerLeave={resetPointer}
      {...props}
    >
      <canvas ref={canvasRef} role="img" aria-label={alt} className={styles.canvas} />
    </div>
  )
}
