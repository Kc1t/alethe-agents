import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// The browser pane and the terminal pane each drive a surface that is composited above the DOM and
// therefore has to solve the same two problems: what part of the pane is actually on screen, and
// what is covering it. They drifted apart once — one clipped nothing and had its own, narrower
// idea of an overlay — and the browser overflowed its pane on Linux as a result.
const SURFACES = [
  'src/components/WebPane/PrivateBrowserSurface.tsx',
  'src/components/GhosttySurface/index.tsx',
]

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('native surfaces stay on one implementation', () => {
  it.each(SURFACES)('%s measures with the shared geometry module', (path) => {
    const source = read(path)
    expect(source, 'must import from lib/surfaceGeometry').toContain('lib/surfaceGeometry')
    expect(
      source.includes('visibleRectOf'),
      'must use visibleRectOf so ancestor clipping is applied',
    ).toBe(true)
    expect(
      source.includes('node.getBoundingClientRect()'),
      'the raw bounding box ignores clipping ancestors and must not be measured directly',
    ).toBe(false)
  })

  it.each(SURFACES)('%s asks the shared module what is covering it', (path) => {
    const source = read(path)
    expect(source, 'must import from lib/overlayPresence').toContain('lib/overlayPresence')
    expect(
      source.includes('new MutationObserver'),
      'occlusion is tracked by one shared document observer, not a private one per surface',
    ).toBe(false)
  })

  it('keeps a single rect comparator', () => {
    for (const path of SURFACES) {
      expect(read(path), `${path} must reuse surfaceRectsEqual`).toContain('surfaceRectsEqual')
    }
  })
})
