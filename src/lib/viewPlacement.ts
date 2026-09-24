import { useMemo } from 'react'

import { useProjectsStore } from '../stores/projectsStore'
import {
  sidebarTabContributions,
  useContributions,
  type SidebarSide,
  type SidebarTabContribution,
} from './plugins'

import { resolveViewSide, type ViewPlacements } from './plugins/placement'

export { resolveViewSide, type ViewPlacements }

function bySide(
  views: readonly SidebarTabContribution[],
  placements: ViewPlacements | undefined,
  side: SidebarSide,
): SidebarTabContribution[] {
  return views
    .filter((view) => resolveViewSide(view, placements) === side)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

/** Contributed views currently placed in one sidebar, in display order. */
export function useSidebarViews(side: SidebarSide): readonly SidebarTabContribution[] {
  const views = useContributions(sidebarTabContributions)
  const placements = useProjectsStore((state) => state.preferences.viewPlacements)
  return useMemo(() => bySide(views, placements, side), [views, placements, side])
}
