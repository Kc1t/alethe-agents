const STORAGE_PREFIX = 'alethe'
const LEGACY_PREFIX = 'ensemble'

let activeNamespace = 'default'

export function setStorageNamespace(namespace: string): void {
  activeNamespace = namespace.trim() || 'default'
}

export function getStorageNamespace(): string {
  return activeNamespace
}

export function scopedStorageKey(key: string): string {
  return `${STORAGE_PREFIX}:${activeNamespace}:${key}`
}

function legacyStorageKey(key: string): string {
  return `${STORAGE_PREFIX}:${key}`
}

function ancientLegacyStorageKey(key: string): string {
  return `${LEGACY_PREFIX}:${key}`
}

export function readScopedStorage(key: string, allowLegacy = false): string | null {
  const namespacedKey = scopedStorageKey(key)
  const current = localStorage.getItem(namespacedKey)
  if (current !== null) return current
  if (!allowLegacy || activeNamespace !== 'default') return null

  const candidates = [legacyStorageKey(key), ancientLegacyStorageKey(key)]
  for (const legacyKey of candidates) {
    const raw = localStorage.getItem(legacyKey)
    if (raw !== null) {
      localStorage.setItem(namespacedKey, raw)
      return raw
    }
  }
  return null
}

export function writeScopedStorage(key: string, value: string): void {
  localStorage.setItem(scopedStorageKey(key), value)
}

export function removeScopedStorage(key: string): void {
  localStorage.removeItem(scopedStorageKey(key))
}

export function scopedStorageSnapshot(namespace: string = activeNamespace): Record<string, string> {
  const prefix = `${STORAGE_PREFIX}:${namespace}:`
  const entries: Record<string, string> = {}
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (!key?.startsWith(prefix)) continue
    const value = localStorage.getItem(key)
    if (value !== null) entries[key.slice(prefix.length)] = value
  }
  return entries
}

export function restoreScopedStorage(entries: Record<string, string>): number {
  let restored = 0
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== 'string') continue
    try {
      writeScopedStorage(key, value)
      restored += 1
    } catch {
      // A full quota keeps what fits; the rest is local convenience state.
    }
  }
  return restored
}
