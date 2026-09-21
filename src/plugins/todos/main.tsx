import type { PluginContext, PluginModule } from '../../lib/plugins'
import { useProjectsStore } from '../../stores/projectsStore'
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

    // Through the same surface a third-party plugin gets: being bundled is not a licence to
    // reach into the app's stores for something every plugin needs.
    context.registerCommand('todos.reveal', () => {
      context.ui.revealView(VIEW_ID)
    })
  },
}

export default plugin
