import { pluginStorageRead, pluginStorageWrite } from '../tauri/plugins'

export type PluginStorage = {
  /** The plugin's whole record. Empty when it has never stored anything. */
  read: () => Promise<Record<string, unknown>>
  get: <T>(key: string, fallback: T) => Promise<T>
  set: (key: string, value: unknown) => Promise<void>
  remove: (key: string) => Promise<void>
  clear: () => Promise<void>
}

type Backend = {
  read: (id: string) => Promise<string | null>
  write: (id: string, body: string | null) => Promise<void>
}

function parse(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

export function createPluginStorage(
  pluginId: string,
  backend: Backend = { read: pluginStorageRead, write: pluginStorageWrite },
): PluginStorage {
  // Writes are read-modify-write, so they queue: two concurrent `set` calls
  // that both read the old record would otherwise lose one of the values.
  let queue: Promise<unknown> = Promise.resolve()

  const read = async () => parse(await backend.read(pluginId))

  const mutate = (change: (record: Record<string, unknown>) => Record<string, unknown> | null) => {
    const next = queue.then(async () => {
      const record = change(await read())
      await backend.write(pluginId, record === null ? null : JSON.stringify(record))
    })
    queue = next.catch(() => undefined)
    return next
  }

  return {
    read,
    get: async <T>(key: string, fallback: T): Promise<T> => {
      const value = (await read())[key]
      return value === undefined ? fallback : (value as T)
    },
    set: (key, value) => mutate((record) => ({ ...record, [key]: value })),
    remove: (key) =>
      mutate((record) => {
        const { [key]: _dropped, ...rest } = record
        return rest
      }),
    clear: () => mutate(() => null),
  }
}
