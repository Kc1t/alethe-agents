import { beforeEach, describe, expect, it } from 'vitest'

import type { PluginStorage } from '../../lib/plugins'
import type { TodoItem } from '../../lib/types'
import { hydrateTodos, resetTodosStoreForTests, useTodosStore } from './store'

function fakeStorage(initial: Record<string, unknown> = {}) {
  let record = { ...initial }
  const storage: PluginStorage = {
    read: async () => ({ ...record }),
    get: async (key, fallback) => (record[key] === undefined ? fallback : (record[key] as never)),
    set: async (key, value) => {
      record = { ...record, [key]: value }
    },
    remove: async (key) => {
      const { [key]: _dropped, ...rest } = record
      record = rest
    },
    clear: async () => {
      record = {}
    },
  }
  return { storage, snapshot: () => record }
}

const legacyItem: TodoItem = { id: 'a', title: 'From projects.json', completed: false, tags: [] }

beforeEach(() => resetTodosStoreForTests())

describe('hydrateTodos', () => {
  it('adopts the pre-plugin list when the plugin has stored nothing', async () => {
    const { storage, snapshot } = fakeStorage()

    await hydrateTodos(storage, { todos: [legacyItem], storagePath: 'C:/notes' })

    expect(useTodosStore.getState().todos).toEqual([legacyItem])
    expect(useTodosStore.getState().storagePath).toBe('C:/notes')
    // Copied into the plugin's own record, so the core copy is only a backup.
    expect(snapshot().todos).toEqual([legacyItem])
    expect(snapshot().storagePath).toBe('C:/notes')
  })

  it('never lets the legacy copy overwrite what the plugin already owns', async () => {
    const owned: TodoItem = { id: 'b', title: 'Mine', completed: false, tags: [] }
    const { storage } = fakeStorage({ todos: [owned], storagePath: '' })

    await hydrateTodos(storage, { todos: [legacyItem], storagePath: 'C:/notes' })

    expect(useTodosStore.getState().todos).toEqual([owned])
    // An empty stored path is a choice the user made, not a missing value.
    expect(useTodosStore.getState().storagePath).toBe('')
  })

  it('treats an emptied list as owned, not as an absent record', async () => {
    const { storage } = fakeStorage({ todos: [] })

    await hydrateTodos(storage, { todos: [legacyItem], storagePath: '' })

    expect(useTodosStore.getState().todos).toEqual([])
  })
})

describe('todo actions', () => {
  beforeEach(async () => {
    await hydrateTodos(fakeStorage().storage, { todos: [], storagePath: '' })
  })

  it('adds, renames, toggles and deletes', () => {
    const store = useTodosStore.getState()
    const created = store.createTodo('  Write the doc  ', ['docs'])
    expect(created?.title).toBe('Write the doc')

    useTodosStore.getState().renameTodo(created!.id, 'Rewrite the doc')
    expect(useTodosStore.getState().todos[0].title).toBe('Rewrite the doc')

    useTodosStore.getState().toggleTodo(created!.id)
    expect(useTodosStore.getState().todos[0].completed).toBe(true)

    useTodosStore.getState().deleteTodo(created!.id)
    expect(useTodosStore.getState().todos).toEqual([])
  })

  it('refuses an empty title instead of storing a blank row', () => {
    expect(useTodosStore.getState().createTodo('   ')).toBeNull()
    expect(useTodosStore.getState().todos).toEqual([])
  })

  it('clears the project when one is unset', () => {
    const created = useTodosStore.getState().createTodo('Task', [], 'p1')
    expect(created?.projectId).toBe('p1')

    useTodosStore.getState().setTodoProject(created!.id, null)
    expect(useTodosStore.getState().todos[0].projectId).toBeUndefined()
  })

  it('persists every change into the plugin record', async () => {
    const { storage, snapshot } = fakeStorage()
    await hydrateTodos(storage, { todos: [], storagePath: '' })

    useTodosStore.getState().createTodo('Persisted')
    await Promise.resolve()

    expect((snapshot().todos as TodoItem[])[0].title).toBe('Persisted')
  })
})
