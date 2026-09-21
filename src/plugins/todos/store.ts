import { nanoid } from 'nanoid'
import { create } from 'zustand'

import type { PluginStorage } from '../../lib/plugins'
import { DEFAULT_TODOS, normalizeTodoTags, normalizeTodoTitle, reorderTodoItems } from '../../lib/todos'
import type { TodoItem } from '../../lib/types'

const TODOS_KEY = 'todos'
const STORAGE_PATH_KEY = 'storagePath'

type TodosState = {
  todos: TodoItem[]
  storagePath: string
  hydrated: boolean
  createTodo: (title: string, tags?: string[], projectId?: string) => TodoItem | null
  createTodoFromPullRequest: (
    pr: { number: number; title: string; url: string; repo: string },
    projectId?: string,
  ) => TodoItem
  renameTodo: (id: string, title: string) => void
  updateTodoTags: (id: string, tags: string[]) => void
  setTodoProject: (id: string, projectId: string | null | undefined) => void
  toggleTodo: (id: string) => void
  deleteTodo: (id: string) => void
  reorderTodo: (draggedId: string, targetId: string) => void
  resetTodosToDefault: () => void
  setStoragePath: (path: string) => void
}

let storage: PluginStorage | null = null

function persistTodos(todos: TodoItem[]) {
  void storage?.set(TODOS_KEY, todos)
}

export const useTodosStore = create<TodosState>((set, get) => {
  const write = (todos: TodoItem[]) => {
    persistTodos(todos)
    set({ todos })
  }

  return {
    todos: [],
    storagePath: '',
    hydrated: false,

    createTodo: (rawTitle, rawTags = [], projectId) => {
      const title = normalizeTodoTitle(rawTitle)
      if (!title) return null
      const todo: TodoItem = {
        id: nanoid(),
        title,
        completed: false,
        tags: normalizeTodoTags(rawTags),
        ...(projectId ? { projectId } : {}),
      }
      const todos = get().todos
      const completedIndex = todos.findIndex((item) => item.completed)
      const insertAt = completedIndex === -1 ? todos.length : completedIndex
      write([...todos.slice(0, insertAt), todo, ...todos.slice(insertAt)])
      return todo
    },

    createTodoFromPullRequest: (pr, projectId) => {
      const existing = get().todos.find(
        (item) => item.prRepo === pr.repo && item.prNumber === pr.number,
      )
      if (existing) return existing
      const todo: TodoItem = {
        id: nanoid(),
        title: normalizeTodoTitle(`PR #${pr.number}: ${pr.title}`),
        completed: false,
        tags: ['pr'],
        ...(projectId ? { projectId } : {}),
        prUrl: pr.url,
        prNumber: pr.number,
        prRepo: pr.repo,
      }
      const todos = get().todos
      const completedIndex = todos.findIndex((item) => item.completed)
      const insertAt = completedIndex === -1 ? todos.length : completedIndex
      write([...todos.slice(0, insertAt), todo, ...todos.slice(insertAt)])
      return todo
    },

    renameTodo: (id, rawTitle) => {
      const title = normalizeTodoTitle(rawTitle)
      if (!title) return
      write(get().todos.map((item) => (item.id === id ? { ...item, title } : item)))
    },

    updateTodoTags: (id, tags) =>
      write(
        get().todos.map((item) =>
          item.id === id ? { ...item, tags: normalizeTodoTags(tags) } : item,
        ),
      ),

    setTodoProject: (id, projectId) =>
      write(
        get().todos.map((item) => {
          if (item.id !== id) return item
          const next = { ...item }
          if (projectId) next.projectId = projectId
          else delete next.projectId
          return next
        }),
      ),

    toggleTodo: (id) => {
      const todos = get().todos
      const current = todos.find((item) => item.id === id)
      if (!current) return
      const changed = { ...current, completed: !current.completed }
      const remaining = todos.filter((item) => item.id !== id)
      if (changed.completed) {
        write([...remaining, changed])
        return
      }
      const completedIndex = remaining.findIndex((item) => item.completed)
      const insertAt = completedIndex === -1 ? remaining.length : completedIndex
      write([...remaining.slice(0, insertAt), changed, ...remaining.slice(insertAt)])
    },

    deleteTodo: (id) => write(get().todos.filter((item) => item.id !== id)),

    reorderTodo: (draggedId, targetId) =>
      write(reorderTodoItems(get().todos, draggedId, targetId)),

    resetTodosToDefault: () =>
      write(DEFAULT_TODOS.map((item) => ({ ...item, id: nanoid() }))),

    setStoragePath: (path) => {
      void storage?.set(STORAGE_PATH_KEY, path)
      set({ storagePath: path })
    },
  }
})

/**
 * Loads the plugin's own record, falling back to whatever the pre-plugin core
 * had stored. The legacy values are copied, never cleared: if this plugin is
 * removed the user's list is still in `projects.json`.
 */
export async function hydrateTodos(
  pluginStorage: PluginStorage,
  legacy: { todos: TodoItem[]; storagePath: string },
): Promise<void> {
  storage = pluginStorage
  const record = await pluginStorage.read()

  const stored = Array.isArray(record[TODOS_KEY]) ? (record[TODOS_KEY] as TodoItem[]) : null
  const todos = stored ?? legacy.todos
  const storagePath =
    typeof record[STORAGE_PATH_KEY] === 'string'
      ? (record[STORAGE_PATH_KEY] as string)
      : legacy.storagePath

  useTodosStore.setState({ todos, storagePath, hydrated: true })

  if (!stored && legacy.todos.length > 0) await pluginStorage.set(TODOS_KEY, legacy.todos)
  if (record[STORAGE_PATH_KEY] === undefined && legacy.storagePath) {
    await pluginStorage.set(STORAGE_PATH_KEY, legacy.storagePath)
  }
}

export function resetTodosStoreForTests(): void {
  storage = null
  useTodosStore.setState({ todos: [], storagePath: '', hydrated: false })
}
