import type { PluginManifest } from '../../lib/tauri'

export const TODOS_MANIFEST: PluginManifest = {
  id: 'alethe.todos',
  name: 'Todo List',
  version: '1.0.0',
  kind: 'ui',
  apiVersion: 1,
  description: 'A checklist in the right sidebar, with tags and per-project assignment.',
  capabilities: ['ui.sidebarTab', 'ui.command', 'ui.modal', 'invoke:ensure_todo_template'],
  activation: ['onView:todos', 'onCommand:todos.reveal'],
  contributes: {
    views: [
      {
        id: 'todos',
        container: 'rightSidebar',
        title: 'Todo',
        titleKey: 'rightSidebar.todoTab',
        panelTitleKey: 'todo.title',
        icon: 'list-todo',
        order: 10,
      },
    ],
    commands: [
      {
        id: 'todos.reveal',
        title: 'Todo list',
        titleKey: 'todo.title',
        icon: 'list-todo',
        keywords: 'todo task checklist list pending',
      },
    ],
  },
  spec: {},
}

export const TODOS_PLUGIN_ID = TODOS_MANIFEST.id
export const TODO_SETTINGS_MODAL_ID = 'todos.settings'
