import { describe, expect, it } from 'vitest'

import { IMPLEMENTED_SCOPES } from './contract'
import { detectRemoteChanges, runSync } from './engine'
import { fakeHost, makeProject, MemoryServer } from './testing'

const ALL = IMPLEMENTED_SCOPES

function device(server: MemoryServer, name: string, host: ReturnType<typeof fakeHost>) {
  const store: { state: unknown } = { state: null }
  const transport = server.transport(name, store)
  host.machine = async () => ({ id: `m-${name}`, name })
  return {
    host,
    store,
    transport,
    sync: (scopes: readonly (typeof ALL)[number][] = ALL) =>
      runSync({ transport, host, scopes, now: () => 1000 }),
  }
}

describe('runSync', () => {
  it('uploads every scope on the first sync', async () => {
    const server = new MemoryServer()
    const a = device(
      server,
      'PC-A',
      fakeHost({
        preferences: { uiTheme: 'dark', spotifyClientSecret: 'sk-secret' },
        projects: [makeProject({ id: 'p1', defaultCwd: 'C:\\Users\\me\\code\\p1' })],
        plugins: { todos: true },
      }),
    )
    const result = await a.sync()
    expect(result.scopes.every((scope) => scope.pushed)).toBe(true)
    expect(server.get('settings')?.payload).toMatchObject({
      preferences: { uiTheme: 'dark' },
      plugins: { todos: true },
    })
    expect(JSON.stringify(server.get('settings')?.payload)).not.toContain('sk-secret')
    expect(server.get('projects')?.payload).toMatchObject({
      projects: { p1: { id: 'p1', machines: { 'm-PC-A': { name: 'PC-A', path: '~/code/p1' } } } },
    })
  })

  it('lists projects from another machine without creating them', async () => {
    const server = new MemoryServer()
    await device(
      server,
      'PC-A',
      fakeHost({
        preferences: { uiTheme: 'dark' },
        projects: [
          makeProject({ id: 'here', defaultCwd: 'C:\\Users\\me\\code\\here' }),
          makeProject({ id: 'away', defaultCwd: 'C:\\Users\\me\\code\\away' }),
        ],
      }),
    ).sync()

    const b = device(server, 'PC-B', fakeHost({ preferences: { uiTheme: 'light' } }))
    const result = await b.sync()
    expect(b.host.prefs.uiTheme).toBe('dark')
    expect(b.host.projectList).toEqual([])
    expect(result.scopes.find((s) => s.scope === 'projects')?.report).toMatchObject({
      changed: false,
      available: 2,
    })

    b.host.projectList.push(makeProject({ id: 'here', defaultCwd: 'D:\\src\\here' }))
    await b.sync()
    const payload = server.get('projects')?.payload as {
      projects: Record<string, { machines: Record<string, { path: string }> }>
    }
    expect(payload.projects.here.machines).toEqual({
      'm-PC-A': { name: 'PC-A', path: '~/code/here' },
      'm-PC-B': { name: 'PC-B', path: 'D:/src/here' },
    })
    expect(Object.keys(payload.projects.away.machines)).toEqual(['m-PC-A'])
  })

  it('removing a project on one machine keeps it on the others', async () => {
    const server = new MemoryServer()
    const a = device(server, 'PC-A', fakeHost({ projects: [makeProject({ id: 'p1' })] }))
    const b = device(server, 'PC-B', fakeHost({ projects: [makeProject({ id: 'p1' })] }))
    await a.sync()
    await b.sync()

    a.host.projectList = []
    await a.sync()
    await b.sync()
    expect(b.host.projectList.map((p) => p.id)).toEqual(['p1'])
    const payload = server.get('projects')?.payload as {
      projects: Record<string, { machines: Record<string, unknown> }>
    }
    expect(Object.keys(payload.projects.p1.machines)).toEqual(['m-PC-B'])
  })

  it('a project removed from the last machine that had it leaves the account', async () => {
    const server = new MemoryServer()
    const a = device(server, 'PC-A', fakeHost({ projects: [makeProject({ id: 'p1' })] }))
    const b = device(server, 'PC-B', fakeHost({}))
    await a.sync()
    await b.sync()

    a.host.projectList = []
    await a.sync()
    const result = await b.sync()
    expect(server.get('projects')?.payload).toEqual({ format: 3, projects: {} })
    expect(result.scopes.find((s) => s.scope === 'projects')?.report.available).toBeUndefined()
  })

  it('keeps the settings a machine overrides on that machine only', async () => {
    const server = new MemoryServer()
    const a = device(
      server,
      'PC-A',
      fakeHost({ projects: [makeProject({ id: 'p1', validationCommands: ['npm test'] })] }),
    )
    const b = device(
      server,
      'PC-B',
      fakeHost({ projects: [makeProject({ id: 'p1', validationCommands: ['npm test'] })] }),
    )
    await a.sync()
    await b.sync()

    b.host.projectList = [
      { ...b.host.projectList[0], localOverrides: ['agents'], validationCommands: ['make check'] },
    ]
    await b.sync()
    await a.sync()
    expect(a.host.projectList[0].validationCommands).toEqual(['npm test'])

    a.host.projectList = [
      { ...a.host.projectList[0], validationCommands: ['npm ci'], color: 'red' },
    ]
    await a.sync()
    await b.sync()
    expect(b.host.projectList[0]).toMatchObject({
      validationCommands: ['make check'],
      color: 'red',
    })
    const payload = server.get('projects')?.payload as {
      projects: Record<string, { machines: Record<string, { custom?: string[] }> }>
    }
    expect(payload.projects.p1.machines['m-PC-B'].custom).toEqual(['agents'])
  })

  it('forgets a machine, which comes back if it syncs again', async () => {
    const server = new MemoryServer()
    const a = device(server, 'PC-A', fakeHost({ projects: [makeProject({ id: 'a1' })] }))
    const b = device(server, 'PC-B', fakeHost({ projects: [makeProject({ id: 'b1' })] }))
    await a.sync()
    await b.sync()
    await a.sync()

    a.store.state = { ...(a.store.state as object), forgetMachines: ['m-PC-B'] }
    await a.sync()
    const keys = () =>
      Object.keys((server.get('projects')?.payload as { projects: object }).projects).sort()
    expect(keys()).toEqual(['a1'])
    expect((a.store.state as { forgetMachines: string[] }).forgetMachines).toEqual([])

    await b.sync()
    expect(keys()).toEqual(['a1', 'b1'])
  })

  it('merges edits made on two machines between syncs', async () => {
    const server = new MemoryServer()
    const a = device(server, 'PC-A', fakeHost({ preferences: { uiTheme: 'dark', uiZoom: 1 } }))
    const b = device(server, 'PC-B', fakeHost({}))
    await a.sync()
    await b.sync()

    a.host.setPreferences({ uiTheme: 'light' } as never)
    b.host.setPreferences({ uiZoom: 1.25 } as never)
    await a.sync()
    await b.sync()
    await a.sync()

    expect(a.host.prefs).toMatchObject({ uiTheme: 'light', uiZoom: 1.25 })
    expect(b.host.prefs).toMatchObject({ uiTheme: 'light', uiZoom: 1.25 })
  })

  it('retries with a fresh merge when another machine writes first', async () => {
    const server = new MemoryServer()
    const a = device(server, 'PC-A', fakeHost({ preferences: { uiTheme: 'dark', uiZoom: 1 } }))
    await a.sync()

    a.host.setPreferences({ uiZoom: 2 } as never)
    server.beforePut = (scope) => {
      const doc = server.docs.get(scope)!
      const payload = structuredClone(doc.payload) as { preferences: Record<string, unknown> }
      payload.preferences.uiTheme = 'blue'
      server.docs.set(scope, { payload, version: doc.version + 1, device: 'PC-B' })
    }
    await a.sync(['settings'])

    expect(server.get('settings')).toMatchObject({
      version: 3,
      payload: { preferences: { uiTheme: 'blue', uiZoom: 2 } },
    })
    expect(a.host.prefs).toMatchObject({ uiTheme: 'blue', uiZoom: 2 })
  })

  it('does not write when nothing changed', async () => {
    const server = new MemoryServer()
    const a = device(server, 'PC-A', fakeHost({ preferences: { uiTheme: 'dark' } }))
    await a.sync()
    const writes = server.writes
    const result = await a.sync()
    expect(server.writes).toBe(writes)
    expect(result.scopes.some((scope) => scope.pushed)).toBe(false)
  })

  it('never deletes local data when the server lost the scope', async () => {
    const server = new MemoryServer()
    const a = device(server, 'PC-A', fakeHost({ projects: [makeProject({ id: 'p1' })] }))
    await a.sync()
    server.docs.clear()
    await a.sync()
    expect(a.host.projectList.map((p) => p.id)).toEqual(['p1'])
    expect(server.get('projects')?.payload).toMatchObject({ projects: { p1: { id: 'p1' } } })
  })

  it('links a local project to the same repository synced under another id', async () => {
    const server = new MemoryServer()
    await device(
      server,
      'PC-A',
      fakeHost({ projects: [makeProject({ id: 'a1', githubUrl: 'https://github.com/kc1t/app' })] }),
    ).sync()
    const b = device(
      server,
      'PC-B',
      fakeHost({
        projects: [makeProject({ id: 'b1', name: 'app', defaultCwd: 'D:\\app' })],
        remotes: { 'D:\\app': 'git@github.com:Kc1t/app.git' },
      }),
    )
    await b.sync()
    expect(b.host.projectList.map((p) => p.id)).toEqual(['b1'])
    expect(b.host.projectList[0].name).toBe('a1')
    const payload = server.get('projects')?.payload as { projects: Record<string, unknown> }
    expect(Object.keys(payload.projects)).toEqual(['a1'])
  })

  it('refuses payloads written by a newer app version', async () => {
    const server = new MemoryServer()
    server.docs.set('settings', { payload: { format: 99 }, version: 1, device: 'future' })
    const a = device(server, 'PC-A', fakeHost({}))
    await expect(a.sync(['settings'])).rejects.toThrow('client_outdated')
  })

  it('toggles only plugins installed on this machine', async () => {
    const server = new MemoryServer()
    await device(server, 'PC-A', fakeHost({ plugins: { todos: false, extra: true } })).sync()
    const b = device(server, 'PC-B', fakeHost({ plugins: { todos: true } }))
    await b.sync()
    expect(b.host.pluginState).toEqual({ todos: false })
    expect(server.get('settings')?.payload).toMatchObject({
      plugins: { todos: false, extra: true },
    })
  })
})

describe('detectRemoteChanges', () => {
  it('reports scopes changed by other devices only', async () => {
    const server = new MemoryServer()
    const a = device(server, 'PC-A', fakeHost({ preferences: { uiTheme: 'dark' } }))
    const b = device(server, 'PC-B', fakeHost({}))
    await a.sync()
    await b.sync()
    expect(await detectRemoteChanges(b.transport, ALL, 'PC-B')).toEqual({ scopes: [], devices: [] })

    a.host.setPreferences({ uiTheme: 'light' } as never)
    await a.sync()
    expect(await detectRemoteChanges(b.transport, ALL, 'PC-B')).toEqual({
      scopes: ['settings'],
      devices: ['PC-A'],
    })
    expect(await detectRemoteChanges(a.transport, ALL, 'PC-A')).toEqual({ scopes: [], devices: [] })
  })
})
