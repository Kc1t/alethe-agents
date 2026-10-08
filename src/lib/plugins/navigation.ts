import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { resolveViewSide } from './placement'
import type { SidebarTabContribution } from './types'

/**
 * Reveals a contributed view wherever it currently lives, opening the sidebar that holds it.
 *
 * Placement is the person's, not the manifest's: a view they moved to the other side still opens
 * where they put it.
 */
export function revealContributedView(view: SidebarTabContribution): void {
  const { preferences, setPreferences } = useProjectsStore.getState()
  if (resolveViewSide(view, preferences.viewPlacements) === 'left') {
    useUiStore.getState().setLeftSidebarTab(view.id)
    setPreferences({ leftSidebarVisible: true })
    return
  }
  useUiStore.getState().setRightSidebarMode(view.id)
  setPreferences({ rightSidebarVisible: true })
}

export function openContributedModal(modalId: string): void {
  useUiStore.getState().openModal_(modalId)
}
