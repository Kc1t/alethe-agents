import { describe, expect, it } from 'vitest'

import type { ToolingMcpServer } from '../types'
import { buildBundle, parseBundle, prepareImport } from './bundle'
import { fakeHost, makeProject } from './testing'

const server: ToolingMcpServer = {
  agent: 'claude',
  sourceKind: 'user',
  name: 'github',
  transport: {
    kind: 'http',
    url: 'https://api.example.com/mcp',
    headers: [{ key: 'Authorization', passthroughFrom: null }],
  },
  env: [{ key: 'GITHUB_TOKEN', passthroughFrom: null }],
  enabled: true,
  timeouts: {} as ToolingMcpServer['timeouts'],
  bearerTokenEnvVar: null,
}

describe('bundles', () => {
  it('round-trips through JSON without secrets', async () => {
    const host = fakeHost({
      preferences: {
        uiTheme: 'dark',
        spotifyClientSecret: 'sk-spotify',
        router9: { apiKey: 'r9-key' },
        toolingManifest: { capturedAt: 5, mcpServers: [server], skills: [] },
      },
      projects: [makeProject({ id: 'p1', defaultCwd: 'C:\\Users\\me\\code\\p1' })],
    })
    const bundle = await buildBundle(host, 0)
    const raw = JSON.stringify(bundle)
    expect(raw).not.toContain('sk-spotify')
    expect(raw).not.toContain('r9-key')
    expect(parseBundle(JSON.parse(raw))).toEqual(bundle)
  })

  it('previews and applies an import as a merge', async () => {
    const source = fakeHost({
      preferences: {
        uiTheme: 'dark',
        toolingManifest: { capturedAt: 5, mcpServers: [server], skills: [] },
      },
      projects: [
        makeProject({ id: 'p1', defaultCwd: 'C:\\Users\\me\\code\\p1' }),
        makeProject({ id: 'p2', defaultCwd: 'C:\\Users\\me\\code\\p2' }),
      ],
    })
    const bundle = await buildBundle(source)

    const target = fakeHost({
      preferences: { uiTheme: 'light' },
      projects: [
        makeProject({ id: 'p1', name: 'old name', defaultCwd: 'C:\\Users\\me\\code\\p1' }),
        makeProject({ id: 'mine' }),
      ],
      dirs: ['C:\\Users\\me\\code\\p2'],
    })
    const prepared = await prepareImport(bundle, target)
    expect(prepared.preview).toEqual({
      preferences: 1,
      plugins: 0,
      projectsCreated: 1,
      projectsUpdated: 1,
      relocations: 0,
      tooling: 1,
      secretsNeeded: 2,
    })

    await prepared.apply()
    expect(target.prefs.uiTheme).toBe('dark')
    expect(target.projectList.map((p) => p.id).sort()).toEqual(['mine', 'p1', 'p2'])
    expect(target.projectList.find((p) => p.id === 'p1')?.name).toBe('p1')
  })

  it('reports an empty import when nothing would change', async () => {
    const host = fakeHost({ preferences: { uiTheme: 'dark' } })
    const prepared = await prepareImport(await buildBundle(host), host)
    expect(prepared.isEmpty).toBe(true)
  })

  it('rejects files that are not bundles or come from a newer version', () => {
    expect(() => parseBundle({ kind: 'something-else', format: 3 })).toThrow('invalid_bundle')
    expect(() => parseBundle({ kind: 'alethe-bundle', format: 99, scopes: {} })).toThrow(
      'client_outdated',
    )
  })
})
