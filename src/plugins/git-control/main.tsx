import { GitBranch } from 'lucide-react'

import type { Disposable, PluginContext, PluginModule, SidebarSide } from '../../lib/plugins'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { GitLeftTab, GitRightTab } from './GitTabs'

const TAB_ID = 'git'

function placement(): SidebarSide {
  return useProjectsStore.getState().preferences.gitControlPlacement === 'right' ? 'right' : 'left'
}

const plugin: PluginModule = {
  activate(context: PluginContext) {
    let handle: Disposable | null = null
    let side: SidebarSide | null = null

    // The tab moves between sidebars with the user's placement preference, so
    // it is re-registered rather than filtered by the shells.
    const sync = () => {
      const next = placement()
      if (next === side) return
      handle?.dispose()
      side = next
      handle = context.contributes.sidebarTab({
        id: TAB_ID,
        side: next,
        icon: GitBranch,
        label: 'Source Control',
        labelKey: 'ui.sidebar.git',
        panelLabelKey: 'ui.sidebar.sourceControl',
        order: 10,
        component: next === 'right' ? GitRightTab : GitLeftTab,
      })
    }

    sync()
    context.subscriptions.push({ dispose: useProjectsStore.subscribe(sync) })

    context.contributes.command({
      id: 'git.reveal',
      label: 'Source Control',
      labelKey: 'ui.sidebar.sourceControl',
      icon: GitBranch,
      keywords: 'git source control commit branch diff status',
      run: () => {
        if (placement() === 'right') {
          useUiStore.getState().setRightSidebarMode(TAB_ID)
          useProjectsStore.getState().setPreferences({ rightSidebarVisible: true })
          return
        }
        useUiStore.getState().setLeftSidebarTab(TAB_ID)
        useProjectsStore.getState().setPreferences({ leftSidebarVisible: true })
      },
    })
  },
}

export default plugin
