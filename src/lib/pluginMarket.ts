import type { PluginRuntimeEntry } from './plugins/types'
import type { CatalogPlugin } from './tauri/plugins'

export type PluginMarketRow = {
  id: string
  name: string
  description: string
  author: string
  version: string
  capabilities: readonly string[]
  repo: string
  installed: boolean
  enabled: boolean
  outdated: boolean
  source: 'bundled' | 'local' | 'catalog'
}

export type PluginMarketStatus =
  'all' | 'installed' | 'available' | 'enabled' | 'disabled' | 'updates'
export type PluginMarketSource = 'all' | PluginMarketRow['source']
export type PluginMarketSort = 'relevance' | 'name' | 'installed' | 'updates'

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export function mergePluginMarket(
  installed: readonly PluginRuntimeEntry[],
  catalog: readonly CatalogPlugin[],
): PluginMarketRow[] {
  const byId = new Map<string, PluginMarketRow>()
  for (const entry of installed) {
    const { manifest } = entry
    byId.set(manifest.id, {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      author: typeof manifest.spec.author === 'string' ? manifest.spec.author : '',
      version: manifest.version,
      capabilities: manifest.capabilities,
      repo: '',
      installed: true,
      enabled: entry.enabled,
      outdated: false,
      source: entry.source,
    })
  }
  for (const listing of catalog) {
    const local = byId.get(listing.id)
    byId.set(listing.id, {
      id: listing.id,
      name: listing.name,
      description: listing.description || local?.description || '',
      author: listing.author || local?.author || '',
      version: local?.version ?? listing.version,
      capabilities: [...new Set([...(local?.capabilities ?? []), ...listing.capabilities])],
      repo: listing.repo,
      installed: local?.installed ?? false,
      enabled: local?.enabled ?? false,
      outdated: local !== undefined && listing.version !== '' && local.version !== listing.version,
      source: local?.source ?? 'catalog',
    })
  }
  return [...byId.values()]
}

export function searchPluginMarket(
  rows: readonly PluginMarketRow[],
  query: string,
  status: PluginMarketStatus = 'all',
  source: PluginMarketSource = 'all',
  sort: PluginMarketSort = 'relevance',
): PluginMarketRow[] {
  const tokens = normalize(query).split(/\s+/).filter(Boolean)
  const score = (row: PluginMarketRow) => {
    const name = normalize(row.name)
    const id = normalize(row.id)
    return tokens.reduce(
      (sum, token) =>
        sum +
        (name === token || id === token
          ? 4
          : name.split(' ').some((word) => word.startsWith(token))
            ? 3
            : name.includes(token) || id.includes(token)
              ? 2
              : 0),
      0,
    )
  }
  return rows
    .filter((row) => {
      if (source !== 'all' && row.source !== source) return false
      if (status === 'installed' && !row.installed) return false
      if (status === 'available' && row.installed) return false
      if (status === 'enabled' && (!row.installed || !row.enabled)) return false
      if (status === 'disabled' && (!row.installed || row.enabled)) return false
      if (status === 'updates' && !row.outdated) return false
      const haystack = normalize(
        [row.id, row.name, row.author, row.description, row.repo, ...row.capabilities].join(' '),
      )
      return tokens.every((token) => haystack.includes(token))
    })
    .sort((a, b) => {
      if (sort === 'relevance' && tokens.length) {
        const diff = score(b) - score(a)
        if (diff) return diff
      }
      if (sort === 'updates' && a.outdated !== b.outdated) return a.outdated ? -1 : 1
      if (sort !== 'name' && a.installed !== b.installed) return a.installed ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}
