export type SidebarPanelSize = { inPixels: number }

// A resize that lands while the window is hidden is never a user action: closing the app
// tears the webview down and the panel group emits one last zero-width layout on the way
// out, which would otherwise be saved as "the user collapsed both sidebars".
export function visibilityFromPanelResize(
  layoutReady: boolean,
  userInitiated: boolean,
  windowHidden: boolean,
  size: SidebarPanelSize,
  previous: SidebarPanelSize | undefined,
  currentVisible: boolean,
): boolean | null {
  if (!layoutReady || !userInitiated || windowHidden || !previous) return null
  const nextVisible = size.inPixels >= 1
  return nextVisible === currentVisible ? null : nextVisible
}

export function widthFromPanelResize(
  layoutReady: boolean,
  userInitiated: boolean,
  windowHidden: boolean,
  size: SidebarPanelSize,
  previous: SidebarPanelSize | undefined,
  min: number,
  max: number,
): number | null {
  if (
    !layoutReady ||
    !userInitiated ||
    windowHidden ||
    !previous ||
    size.inPixels < min ||
    Math.abs(size.inPixels - previous.inPixels) < 1
  ) {
    return null
  }
  return Math.max(min, Math.min(max, Math.round(size.inPixels)))
}
