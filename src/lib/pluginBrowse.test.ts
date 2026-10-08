import { describe, expect, it } from 'vitest'

import {
  browseRows,
  type BrowseRow,
  capabilityFacets,
  EMPTY_FILTER,
  foldSearch,
  listWindow,
  matchesFilter,
  mergeRows,
} from './pluginBrowse'
import type { CatalogPlugin } from './tauri'

function row(patch: Partial<BrowseRow> = {}): BrowseRow {
  return {
    id: 'acme.thing',
    name: 'Thing',
    description: 'Does a thing.',
    author: 'Acme',
    version: '1.0.0',
    capabilities: ['ui.command'],
    installed: false,
    enabled: false,
    origin: null,
    updateTo: null,
    installable: true,
    pageUrl: null,
    ...patch,
  }
}

describe('finding a plugin by typing', () => {
  it('ignores case and accents', () => {
    const sessions = row({ name: 'Sessão' })
    expect(matchesFilter(sessions, { ...EMPTY_FILTER, query: 'sessao' })).toBe(true)
    expect(matchesFilter(sessions, { ...EMPTY_FILTER, query: 'SESSÃO' })).toBe(true)
    expect(foldSearch('  Café  ')).toBe('cafe')
  })

  it('matches every word in any order, not the phrase', () => {
    const todo = row({ name: 'Todo List' })
    expect(matchesFilter(todo, { ...EMPTY_FILTER, query: 'list todo' })).toBe(true)
    expect(matchesFilter(todo, { ...EMPTY_FILTER, query: 'todo missing' })).toBe(false)
  })

  it('looks in the id, author and description, not only the name', () => {
    const one = row({ id: 'jbnado.hello', author: 'João', description: 'A worked example.' })
    for (const query of ['jbnado', 'joao', 'worked example']) {
      expect(matchesFilter(one, { ...EMPTY_FILTER, query })).toBe(true)
    }
  })

  it('keeps everything when nothing was typed', () => {
    expect(matchesFilter(row(), EMPTY_FILTER)).toBe(true)
    expect(matchesFilter(row(), { ...EMPTY_FILTER, query: '   ' })).toBe(true)
  })
})

describe('narrowing the list', () => {
  it('requires every chosen capability, not any of them', () => {
    const both = row({ capabilities: ['ui.command', 'ui.theme'] })
    const one = row({ capabilities: ['ui.command'] })
    const filter = { ...EMPTY_FILTER, capabilities: ['ui.command', 'ui.theme'] }
    expect(matchesFilter(both, filter)).toBe(true)
    expect(matchesFilter(one, filter)).toBe(false)
  })

  it('separates what ships with Alethe from what was installed here', () => {
    const mine = row({ installed: true, origin: 'local' })
    const shipped = row({ installed: true, origin: 'bundled' })
    const filter = { ...EMPTY_FILTER, origins: ['local' as const] }
    expect(matchesFilter(mine, filter)).toBe(true)
    expect(matchesFilter(shipped, filter)).toBe(false)
  })

  it('offers only the capabilities that actually appear', () => {
    expect(
      capabilityFacets([
        row({ capabilities: ['ui.theme'] }),
        row({ capabilities: ['ui.command'] }),
      ]),
    ).toEqual(['ui.command', 'ui.theme'])
  })
})

describe('ordering', () => {
  it('puts an offered update first, because it is the only row asking for an action', () => {
    const idle = row({ id: 'a', name: 'Aaa' })
    const outdated = row({ id: 'z', name: 'Zzz', installed: true, updateTo: '2.0.0' })
    expect(browseRows([idle, outdated], EMPTY_FILTER, 'updated').map((e) => e.id)).toEqual([
      'z',
      'a',
    ])
  })
})

describe('what to actually render of a long list', () => {
  it('mounts a screenful plus overscan, never the whole thousand', () => {
    const window = listWindow(1000, 0, 600, 64)
    expect(window.start).toBe(0)
    expect(window.end).toBeLessThan(40)
    expect(window.padTop).toBe(0)
    expect(window.padBottom).toBe((1000 - window.end) * 64)
  })

  it('keeps the spacers honest when scrolled into the middle', () => {
    const window = listWindow(1000, 6400, 600, 64)
    // Whatever is mounted, the padding above and below plus the mounted rows must add up to the
    // full height — otherwise the scrollbar reports a length the list does not have.
    const mounted = (window.end - window.start) * 64
    expect(window.padTop + mounted + window.padBottom).toBe(1000 * 64)
  })

  it('renders nothing for an empty list', () => {
    expect(listWindow(0, 0, 600, 64)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 })
  })
})

describe('one list from the catalogue and what is installed', () => {
  const listed: CatalogPlugin = {
    id: 'jbnado.hello',
    name: 'Hello World',
    description: 'A worked example.',
    author: 'João Bernardo',
    repo: 'Jbnado/alethe-plugin-hello',
    downloadUrl: 'https://example.invalid/releases',
    version: '0.2.0',
    minApiVersion: 1,
    capabilities: ['ui.sidebarTab'],
    package: { url: 'https://example.invalid/p.zip', sha256: 'a'.repeat(64) },
  }

  it('shows a plugin present in both exactly once', () => {
    const rows = mergeRows(
      [listed],
      [
        {
          id: 'jbnado.hello',
          name: 'Hello World',
          description: 'A worked example.',
          version: '0.1.0',
          capabilities: ['ui.sidebarTab', 'ui.command'],
          enabled: true,
          origin: 'local',
        },
      ],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].installed).toBe(true)
    expect(rows[0].updateTo).toBe('0.2.0')
    // What runs is the manifest on disk, so its capabilities win over the listing's copy.
    expect(rows[0].capabilities).toEqual(['ui.sidebarTab', 'ui.command'])
  })

  it('offers no update when the installed version is the listed one', () => {
    const rows = mergeRows(
      [listed],
      [
        {
          id: 'jbnado.hello',
          name: 'Hello World',
          description: '',
          version: '0.2.0',
          capabilities: ['ui.sidebarTab'],
          enabled: true,
          origin: 'local',
        },
      ],
    )
    expect(rows[0].updateTo).toBeNull()
  })

  it('keeps a plugin that no listing mentions, and marks it uninstallable from here', () => {
    const rows = mergeRows(
      [],
      [
        {
          id: 'local.only',
          name: 'Local Only',
          description: 'Imported from a folder.',
          version: '1.0.0',
          capabilities: [],
          enabled: false,
          origin: 'local',
        },
      ],
    )
    expect(rows[0].origin).toBe('local')
    expect(rows[0].installable).toBe(false)
  })

  it('never offers an update for a listing that cannot be installed from here', () => {
    const pointer: CatalogPlugin = { ...listed, package: undefined }
    const rows = mergeRows(
      [pointer],
      [
        {
          id: 'jbnado.hello',
          name: 'Hello World',
          description: '',
          version: '0.1.0',
          capabilities: [],
          enabled: true,
          origin: 'local',
        },
      ],
    )
    expect(rows[0].updateTo).toBeNull()
  })
})
