export type SidebarPanelSize = { inPixels: number }

export function visibilityFromPanelResize(
  layoutReady: boolean,
  userInitiated: boolean,
  size: SidebarPanelSize,
  previous: SidebarPanelSize | undefined,
  currentVisible: boolean,
): boolean | null {
  if (!layoutReady || !userInitiated || !previous) return null
  const nextVisible = size.inPixels >= 1
  return nextVisible === currentVisible ? null : nextVisible
}

export function widthFromPanelResize(
  layoutReady: boolean,
  userInitiated: boolean,
  size: SidebarPanelSize,
  previous: SidebarPanelSize | undefined,
  min: number,
  max: number,
): number | null {
  if (
    !layoutReady ||
    !userInitiated ||
    !previous ||
    size.inPixels < min ||
    Math.abs(size.inPixels - previous.inPixels) < 1
  ) {
    return null
  }
  return Math.max(min, Math.min(max, Math.round(size.inPixels)))
}
