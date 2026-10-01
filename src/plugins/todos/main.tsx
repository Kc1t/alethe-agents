import type { PluginContext, PluginModule } from '../../lib/plugins'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { TODO_SETTINGS_MODAL_ID } from './manifest'
import { hydrateTodos } from './store'
import { TodoSettingsModal } from './TodoSettingsModal'
import { TodoSidebar } from './TodoSidebar'

const VIEW_ID = 'todos'

const plugin: PluginModule = {
  async activate(context: PluginContext) {
    const { todos, preferences } = useProjectsStore.getState()
    await hydrateTodos(context.storage, {
      todos,
      storagePath: preferences.todoStoragePath ?? '',
    })

    context.registerView(VIEW_ID, TodoSidebar)
    context.contributes.modal({ id: TODO_SETTINGS_MODAL_ID, component: TodoSettingsModal })

    context.registerCommand('todos.reveal', () => {
      const { preferences: current, setPreferences } = useProjectsStore.getState()
      if (current.viewPlacements?.[VIEW_ID] === 'left') {
        useUiStore.getState().setLeftSidebarTab(VIEW_ID)
        setPreferences({ leftSidebarVisible: true })
        return
      }
      useUiStore.getState().setRightSidebarMode(VIEW_ID)
      setPreferences({ rightSidebarVisible: true })
    })
  },
}

export default plugin
