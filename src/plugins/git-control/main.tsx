import type { PluginContext, PluginModule } from '../../lib/plugins'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { GitTab } from './GitTabs'

const VIEW_ID = 'git'

const plugin: PluginModule = {
  activate(context: PluginContext) {
    context.registerView(VIEW_ID, GitTab)

    context.registerCommand('git.reveal', () => {
      const { preferences, setPreferences } = useProjectsStore.getState()
      if (preferences.viewPlacements?.[VIEW_ID] === 'right') {
        useUiStore.getState().setRightSidebarMode(VIEW_ID)
        setPreferences({ rightSidebarVisible: true })
        return
      }
      useUiStore.getState().setLeftSidebarTab(VIEW_ID)
      setPreferences({ leftSidebarVisible: true })
    })
  },
}

export default plugin
