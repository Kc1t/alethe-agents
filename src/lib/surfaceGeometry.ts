export type SurfaceRect = { x: number; y: number; width: number; height: number }

const MIN_VISIBLE_PX = 1

function intersect(a: SurfaceRect, b: SurfaceRect): SurfaceRect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right - x < MIN_VISIBLE_PX || bottom - y < MIN_VISIBLE_PX) return null
  return { x, y, width: right - x, height: bottom - y }
}

// An unset computed overflow reads as an empty string outside a real browser; treat it as visible
// so an unstyled ancestor is never mistaken for a clipping box.
function clips(overflow: string): boolean {
  return overflow !== '' && overflow !== 'visible'
}

function clipsDescendants(style: CSSStyleDeclaration): boolean {
  return clips(style.overflowX) || clips(style.overflowY)
}

function boxOf(element: Element): SurfaceRect {
  const box = element.getBoundingClientRect()
  return { x: box.left, y: box.top, width: box.width, height: box.height }
}

/**
 * The part of `node` that is actually on screen, in CSS pixels.
 *
 * A native surface is positioned in window coordinates, so it is never clipped by an ancestor's
 * `overflow` the way a DOM child would be. Feeding it the raw bounding box lets it overhang its
 * pane; this walks the ancestors and intersects with every box that would have clipped it.
 *
 * Once a `position: fixed` ancestor is reached the walk stops: a fixed subtree escapes the
 * overflow of everything above it, which is what focus mode relies on.
 */
export function visibleRectOf(node: Element): SurfaceRect | null {
  const view = node.ownerDocument?.defaultView
  if (!view) return null

  let rect: SurfaceRect | null = boxOf(node)
  if (rect.width < MIN_VISIBLE_PX || rect.height < MIN_VISIBLE_PX) return null

  if (view.getComputedStyle(node).position !== 'fixed') {
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = view.getComputedStyle(ancestor)
      if (clipsDescendants(style)) {
        rect = intersect(rect, boxOf(ancestor))
        if (!rect) return null
      }
      if (style.position === 'fixed') break
    }
  }

  return intersect(rect, { x: 0, y: 0, width: view.innerWidth, height: view.innerHeight })
}

/**
 * Native surfaces are placed in physical pixels while the DOM reports CSS pixels.
 * `devicePixelRatio` folds in both display scaling and webview zoom.
 */
export function toPhysicalRect(rect: SurfaceRect, ratio: number): SurfaceRect {
  const scale = ratio > 0 ? ratio : 1
  return {
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale)),
  }
}

/** Physical rects are whole pixels, so exact equality is enough to skip a redundant move. */
export function surfaceRectsEqual(a: SurfaceRect | null, b: SurfaceRect | null): boolean {
  if (a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}
