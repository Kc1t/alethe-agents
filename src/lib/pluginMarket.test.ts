import { describe, expect, it } from 'vitest'
import type { PluginRuntimeEntry } from './plugins/types'
import type { CatalogPlugin } from './tauri/plugins'
import { mergePluginMarket, searchPluginMarket, type PluginMarketRow } from './pluginMarket'

const row = (id: string, overrides: Partial<PluginMarketRow> = {}): PluginMarketRow => ({
  id,
  name: id,
  description: '',
  author: '',
  version: '1.0.0',
  capabilities: [],
  repo: '',
  installed: false,
  enabled: false,
  outdated: false,
  source: 'catalog',
  ...overrides,
})

describe('plugin market discovery', () => {
  it('matches words across metadata and capabilities without depending on accents', () => {
    const rows = [
      row('tools', { name: 'Validation', author: 'José', capabilities: ['filesystem:read'] }),
    ]
    expect(searchPluginMarket(rows, 'JOSE validation read')).toEqual(rows)
    expect(searchPluginMarket(rows, 'validation missing')).toEqual([])
    expect(searchPluginMarket(rows, 'filesystem:read')).toEqual(rows)
  })
  it('ranks name matches ahead of description matches and supports alphabetical sorting', () => {
    const rows = [
      row('a', { name: 'A helper', description: 'git tools' }),
      row('git', { name: 'Git control' }),
    ]
    expect(searchPluginMarket(rows, 'git').map((row) => row.id)).toEqual(['git', 'a'])
    expect(searchPluginMarket(rows, 'git', 'all', 'all', 'name').map((row) => row.id)).toEqual([
      'a',
      'git',
    ])
  })
  it('combines status and source without treating uninstalled plugins as disabled', () => {
    const rows = [
      row('available'),
      row('local', { installed: true, source: 'local' }),
      row('bundled', { installed: true, source: 'bundled', enabled: true, outdated: true }),
    ]
    expect(searchPluginMarket(rows, '', 'disabled').map((row) => row.id)).toEqual(['local'])
    expect(searchPluginMarket(rows, '', 'enabled', 'bundled').map((row) => row.id)).toEqual([
      'bundled',
    ])
    expect(searchPluginMarket(rows, '', 'available').map((row) => row.id)).toEqual(['available'])
    expect(searchPluginMarket(rows, '', 'updates', 'local')).toEqual([])
  })
  it('deduplicates catalog entries while preserving installed state and metadata', () => {
    const installed = [
      {
        manifest: {
          id: 'git',
          name: 'Git',
          description: 'local description',
          version: '1.0.0',
          capabilities: ['local:read'],
          spec: {},
        },
        enabled: false,
        source: 'local',
      },
    ] as PluginRuntimeEntry[]
    const catalog = [
      {
        id: 'git',
        name: 'Git control',
        description: '',
        author: 'Alice',
        version: '2.0.0',
        repo: 'alice/git',
        capabilities: ['remote:read'],
      },
    ] as CatalogPlugin[]
    const merged = mergePluginMarket(installed, catalog)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      name: 'Git control',
      version: '1.0.0',
      installed: true,
      enabled: false,
      outdated: true,
      source: 'local',
      description: 'local description',
      author: 'Alice',
    })
    expect(searchPluginMarket(merged, 'remote alice', 'updates', 'local')).toEqual(merged)
  })
})
