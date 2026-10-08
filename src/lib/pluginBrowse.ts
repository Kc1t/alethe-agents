import type { CatalogPlugin } from './tauri'

/**
 * Where an installed plugin lives, which is all the app records today.
 *
 * It deliberately does not say which door it came through — catalogue, pasted URL or imported
 * folder — because that is not stored anywhere. Telling those apart needs the install to record it,
 * and until it does, a filter offering the distinction would be inventing one.
 */
export type PluginOrigin = 'bundled' | 'local'

export type BrowseRow = {
  id: string
  name: string
  description: string
  author: string
  /** The version on offer in the catalogue, or the installed one when it is not listed. */
  version: string
  capabilities: readonly string[]
  installed: boolean
  enabled: boolean
  origin: PluginOrigin | null
  /** Set when the catalogue lists a version other than the installed one. */
  updateTo: string | null
  /** False for a listing that only points at a page: nothing to install from inside the app. */
  installable: boolean
  /** The page a person visits when Alethe cannot install it for them. */
  pageUrl: string | null
}

export type BrowseSort = 'name' | 'updated'

export type BrowseFilter = {
  query: string
  capabilities: readonly string[]
  origins: readonly PluginOrigin[]
  /** `null` keeps both; used only where installed plugins are listed. */
  enabled: boolean | null
}

export const EMPTY_FILTER: BrowseFilter = {
  query: '',
  capabilities: [],
  origins: [],
  enabled: null,
}

/**
 * Folds case and Latin accents so `sessao` finds `Sessão`.
 *
 * Deliberately the same shape as the rule the orchestrator uses for rule-set names: a person
 * typing a plugin's name should not have to reproduce its diacritics.
 */
export function foldSearch(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

/** Every field a person might type a fragment of, joined once so matching stays cheap. */
function haystack(row: BrowseRow): string {
  return foldSearch(`${row.name} ${row.id} ${row.author} ${row.description}`)
}

export function matchesQuery(row: BrowseRow, query: string): boolean {
  const wanted = foldSearch(query)
  if (!wanted) return true
  const hay = haystack(row)
  // Every word must appear, in any order: "todo list" and "list todo" find the same plugin.
  return wanted.split(/\s+/).every((word) => hay.includes(word))
}

export function matchesFilter(row: BrowseRow, filter: BrowseFilter): boolean {
  if (!matchesQuery(row, filter.query)) return false
  if (filter.capabilities.length > 0) {
    // Asking for two capabilities means both, not either: the filter narrows.
    if (!filter.capabilities.every((capability) => row.capabilities.includes(capability))) {
      return false
    }
  }
  if (filter.origins.length > 0) {
    if (!row.origin || !filter.origins.includes(row.origin)) return false
  }
  if (filter.enabled !== null && row.enabled !== filter.enabled) return false
  return true
}

function compare(a: BrowseRow, b: BrowseRow, sort: BrowseSort): number {
  if (sort === 'name') return a.name.localeCompare(b.name)
  // `updated`: an offered update first — it is the only thing on this screen that asks for an
  // action — then the rest by name, since the index carries no publication date.
  const aUpdate = a.updateTo ? 0 : 1
  const bUpdate = b.updateTo ? 0 : 1
  if (aUpdate !== bUpdate) return aUpdate - bUpdate
  return a.name.localeCompare(b.name)
}

export function browseRows(
  rows: readonly BrowseRow[],
  filter: BrowseFilter,
  sort: BrowseSort,
): BrowseRow[] {
  return rows.filter((row) => matchesFilter(row, filter)).sort((a, b) => compare(a, b, sort))
}

/** Every capability any of these plugins asks for, so the filter offers only what exists. */
export function capabilityFacets(rows: readonly BrowseRow[]): string[] {
  const seen = new Set<string>()
  for (const row of rows) for (const capability of row.capabilities) seen.add(capability)
  return [...seen].sort()
}

export type Window = { start: number; end: number; padTop: number; padBottom: number }

/**
 * Which slice of a long list to actually render.
 *
 * A thousand rows is a thousand React nodes with nothing gained: only a screenful is visible. Rows
 * are a fixed height so the arithmetic is exact and the scrollbar never lies — the spacer above and
 * below stands in for what is not mounted.
 */
export function listWindow(
  total: number,
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  overscan = 6,
): Window {
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 }
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const visible = Math.ceil(viewport / rowHeight) + overscan * 2
  const start = Math.min(first, Math.max(0, total - 1))
  const end = Math.min(total, start + Math.max(visible, 1))
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (total - end) * rowHeight),
  }
}

/**
 * Turns the catalogue and what is installed into one list.
 *
 * A plugin present in both appears once: the catalogue supplies the description, the installed
 * record supplies the truth about this machine.
 */
export function mergeRows(
  catalog: readonly CatalogPlugin[],
  installed: readonly {
    id: string
    name: string
    description: string
    version: string
    capabilities: readonly string[]
    enabled: boolean
    origin: PluginOrigin
  }[],
): BrowseRow[] {
  const byId = new Map<string, BrowseRow>()

  for (const entry of catalog) {
    byId.set(entry.id, {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      author: entry.author,
      version: entry.version,
      capabilities: entry.capabilities,
      installed: false,
      enabled: false,
      origin: null,
      updateTo: null,
      installable: Boolean(entry.package),
      pageUrl: entry.downloadUrl || null,
    })
  }

  for (const entry of installed) {
    const listed = byId.get(entry.id)
    if (!listed) {
      byId.set(entry.id, {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        author: '',
        version: entry.version,
        capabilities: entry.capabilities,
        installed: true,
        enabled: entry.enabled,
        origin: entry.origin,
        updateTo: null,
        installable: false,
        pageUrl: null,
      })
      continue
    }
    byId.set(entry.id, {
      ...listed,
      // The manifest on disk is what actually runs, so it wins over the listing's copy.
      capabilities: entry.capabilities,
      version: entry.version,
      installed: true,
      enabled: entry.enabled,
      origin: entry.origin,
      updateTo:
        listed.installable && listed.version && listed.version !== entry.version
          ? listed.version
          : null,
    })
  }

  return [...byId.values()]
}
