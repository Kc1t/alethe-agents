import type { SidebarSide, SidebarTabContribution } from './types'

export type ViewPlacements = Record<string, SidebarSide>

/** The manifest declares a container; the user may move the view from it. */
export function resolveViewSide(
  view: SidebarTabContribution,
  placements: ViewPlacements | undefined,
): SidebarSide {
  return placements?.[view.id] ?? view.side
}
