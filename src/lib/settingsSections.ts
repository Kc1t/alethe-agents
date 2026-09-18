import { readScopedStorage, writeScopedStorage } from './storageNamespace'

const STORAGE_KEY = 'preferences.collapsedSections'

/** What the person has folded away, by section id. Absent means "as the page shipped it". */
export type CollapsedSections = Record<string, boolean>

/**
 * A section is collapsed when the person said so. Only when they never touched it does the page's
 * own default apply — so a telemetry section that ships folded stays open once it has been opened.
 */
export function isSectionCollapsed(
  stored: CollapsedSections,
  id: string,
  defaultCollapsed: boolean,
): boolean {
  const choice = stored[id]
  return choice === undefined ? defaultCollapsed : choice
}

export function parseCollapsedSections(raw: string | null): CollapsedSections {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: CollapsedSections = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') out[id] = value
    }
    return out
  } catch {
    // A corrupted entry is not worth a broken Preferences panel; the defaults are always valid.
    return {}
  }
}

let cache: CollapsedSections | null = null
const listeners = new Set<() => void>()

export function collapsedSections(): CollapsedSections {
  if (cache) return cache
  let raw: string | null = null
  try {
    raw = readScopedStorage(STORAGE_KEY)
  } catch {
    raw = null
  }
  cache = parseCollapsedSections(raw)
  return cache
}

export function setSectionCollapsed(id: string, collapsed: boolean): void {
  const next = { ...collapsedSections(), [id]: collapsed }
  cache = next
  try {
    writeScopedStorage(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private windows and blocked site data still get a working panel for this session.
  }
  for (const listener of listeners) listener()
}

export function subscribeCollapsedSections(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: drops the in-memory copy so the next read goes back to storage. */
export function resetCollapsedSectionsCache(): void {
  cache = null
}
