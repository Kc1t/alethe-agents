import { describe, expect, it } from 'vitest'

import {
  buildLocalProjectView,
  fromPathHint,
  type MachineInfo,
  materializeProject,
  mergeProjects,
  normalizeRemote,
  parseSyncedProject,
  planMaterialize,
  planProjectUpdates,
  settleProjects,
  type SyncedProject,
  toPathHint,
  toSyncedProject,
} from './projectSync'
import type { Project } from './types'

const WIN_HOME = 'C:\\Users\\kauam'
const HERE: MachineInfo = { id: 'm-here', name: 'DESKTOP' }
const AWAY = { name: 'LAPTOP', path: '~/work/alethe' }

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Alethe',
    groupId: null,
    terminals: [],
    layoutMode: 'auto',
    collapsed: false,
    createdAt: 1,
    defaultCwd: 'C:\\Users\\kauam\\code\\alethe',
    ...overrides,
  }
}

const synced = (overrides: Partial<SyncedProject> = {}): SyncedProject => ({
  id: 'p1',
  name: 'Alethe',
  machines: { 'm-away': AWAY },
  ...overrides,
})

const view = (input: Partial<Parameters<typeof buildLocalProjectView>[0]>) =>
  buildLocalProjectView({
    local: [],
    home: WIN_HOME,
    machine: HERE,
    base: null,
    remote: {},
    aliases: {},
    ...input,
  })

describe('toSyncedProject', () => {
  it('carries settings and this machine folder but no terminals or layout', () => {
    const entry = toSyncedProject(
      project({
        validationCommands: ['npm test'],
        gridLayoutHistory: [],
        terminals: [{ id: 't1' } as Project['terminals'][number]],
      }),
      'p1',
      WIN_HOME,
      HERE,
    )
    expect(entry).toMatchObject({
      id: 'p1',
      name: 'Alethe',
      validationCommands: ['npm test'],
      machines: { 'm-here': { name: 'DESKTOP', path: '~/code/alethe' } },
    })
    expect(entry).not.toHaveProperty('terminals')
    expect(entry).not.toHaveProperty('gridLayoutHistory')
    expect(entry).not.toHaveProperty('defaultCwd')
  })

  it('drops oversized inline icons', () => {
    const entry = toSyncedProject(
      project({ iconUrl: `data:image/png;base64,${'a'.repeat(40_000)}` }),
      'p1',
      WIN_HOME,
      HERE,
    )
    expect(entry).not.toHaveProperty('iconUrl')
  })

  it('keeps the folder of other machines and replaces only its own', () => {
    const prior = synced({ machines: { 'm-away': AWAY, 'm-here': { name: 'OLD', path: 'D:/x' } } })
    const entry = toSyncedProject(project(), 'p1', WIN_HOME, HERE, prior)
    expect(entry.machines).toEqual({
      'm-away': AWAY,
      'm-here': { name: 'DESKTOP', path: '~/code/alethe' },
    })
  })

  it('keeps the shared values of groups this machine overrides', () => {
    const prior = synced({ validationCommands: ['npm test'], toolingManifest: undefined })
    const entry = toSyncedProject(
      project({
        validationCommands: ['pnpm test'],
        localOverrides: ['agents'],
        toolingManifest: { capturedAt: 1, mcpServers: [], skills: [] },
      }),
      'p1',
      WIN_HOME,
      HERE,
      prior,
    )
    expect(entry.validationCommands).toEqual(['npm test'])
    expect(entry.toolingManifest).toEqual({ capturedAt: 1, mcpServers: [], skills: [] })
    expect(entry.machines['m-here'].custom).toEqual(['agents'])
  })

  it('removes forgotten machines', () => {
    const entry = toSyncedProject(project(), 'p1', WIN_HOME, HERE, synced(), ['m-away'])
    expect(Object.keys(entry.machines)).toEqual(['m-here'])
  })
})

describe('parseSyncedProject', () => {
  it('keeps valid machine folders and drops broken ones', () => {
    const parsed = parseSyncedProject('p1', {
      id: 'p1',
      name: 'Alethe',
      machines: {
        a: { name: 'A', path: '~/a', custom: ['tooling', 'nope'] },
        b: { path: '~/b' },
        c: { name: 'C' },
      },
    })
    expect(parsed?.machines).toEqual({
      a: { name: 'A', path: '~/a', custom: ['tooling'] },
      c: { name: 'C', path: null },
    })
    expect(parseSyncedProject('p2', { id: 'p1', name: 'x' })).toBeNull()
  })
})

describe('path hints', () => {
  it('stores paths under the home folder relative to it', () => {
    expect(toPathHint('C:\\Users\\kauam\\code\\alethe\\', WIN_HOME)).toBe('~/code/alethe')
    expect(toPathHint('c:\\users\\KAUAM', WIN_HOME)).toBe('~')
    expect(toPathHint('/Users/kc/code/app', '/Users/kc')).toBe('~/code/app')
  })

  it('keeps paths outside the home folder absolute', () => {
    expect(toPathHint('D:\\work\\app', WIN_HOME)).toBe('D:/work/app')
    expect(toPathHint('\\\\wsl.localhost\\Ubuntu\\home\\me\\app', WIN_HOME)).toBe(
      '//wsl.localhost/Ubuntu/home/me/app',
    )
  })

  it('expands hints against the home folder of this machine', () => {
    expect(fromPathHint('~/code/alethe', 'C:\\Users\\other')).toBe('C:\\Users\\other\\code\\alethe')
    expect(fromPathHint('~/code/alethe', '/Users/kc')).toBe('/Users/kc/code/alethe')
    expect(fromPathHint('D:/work/app', WIN_HOME)).toBe('D:\\work\\app')
    expect(fromPathHint('//wsl.localhost/Ubuntu/home/me/app', WIN_HOME)).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\app',
    )
    expect(fromPathHint('~/code/alethe', null)).toBeNull()
  })
})

describe('normalizeRemote', () => {
  it('treats ssh, https and scp-style remotes of one repository as equal', () => {
    const expected = 'github.com/kc1t/alethe'
    expect(normalizeRemote('git@github.com:Kc1t/alethe.git')).toBe(expected)
    expect(normalizeRemote('https://github.com/Kc1t/alethe')).toBe(expected)
    expect(normalizeRemote('https://github.com/Kc1t/alethe.git/')).toBe(expected)
    expect(normalizeRemote('ssh://git@github.com/Kc1t/alethe.git')).toBe(expected)
    expect(normalizeRemote('https://user:token@github.com/Kc1t/alethe')).toBe(expected)
  })

  it('keeps ports and rejects empty values', () => {
    expect(normalizeRemote('ssh://git@host:2222/team/app.git')).toBe('host:2222/team/app')
    expect(normalizeRemote('  ')).toBeNull()
    expect(normalizeRemote(undefined)).toBeNull()
  })
})

describe('buildLocalProjectView', () => {
  it('links a local project to the remote one for the same repository', () => {
    const result = view({
      local: [project({ id: 'local-1', githubUrl: 'git@github.com:Kc1t/alethe.git' })],
      remote: { r1: synced({ id: 'r1', githubUrl: 'https://github.com/Kc1t/alethe' }) },
    })
    expect(result.aliases).toEqual({ r1: 'local-1' })
    expect(Object.keys(result.projects)).toEqual(['r1'])
    expect(Object.keys(result.projects.r1.machines).sort()).toEqual(['m-away', 'm-here'])
  })

  it('links by a folder another machine uses', () => {
    const result = view({
      local: [project({ id: 'local-2' })],
      remote: { r2: synced({ id: 'r2', machines: { x: { name: 'X', path: '~/Code/Alethe' } } }) },
    })
    expect(result.aliases).toEqual({ r2: 'local-2' })
  })

  it('never links a project that already syncs under its own id', () => {
    const result = view({ local: [project()], remote: { p1: synced(), r9: synced({ id: 'r9' }) } })
    expect(result.aliases).toEqual({})
  })

  it('passes through projects this machine does not have, without its own folder', () => {
    const base = {
      p9: synced({
        id: 'p9',
        machines: { 'm-away': AWAY, 'm-here': { name: 'DESKTOP', path: '~/p9' } },
      }),
    }
    const result = view({ base, remote: base })
    expect(result.projects.p9.machines).toEqual({ 'm-away': AWAY })
  })

  it('forgets aliases whose local project is gone and skips agent sandboxes', () => {
    const result = view({
      local: [project({ id: 'sandbox', mode: 'agentSandbox' })],
      aliases: { r1: 'deleted-local' },
    })
    expect(result.aliases).toEqual({})
    expect(result.projects).toEqual({})
  })
})

describe('mergeProjects and settleProjects', () => {
  it('merges machine folders independently of shared settings', () => {
    const base = { p1: synced() }
    const local = {
      p1: synced({
        color: 'red',
        machines: { 'm-away': AWAY, 'm-here': { name: 'DESKTOP', path: '~/a' } },
      }),
    }
    const remote = {
      p1: synced({ machines: { 'm-away': { name: 'LAPTOP', path: '~/moved' } } }),
    }
    expect(mergeProjects(base, local, remote).p1).toEqual(
      synced({
        color: 'red',
        machines: {
          'm-away': { name: 'LAPTOP', path: '~/moved' },
          'm-here': { name: 'DESKTOP', path: '~/a' },
        },
      }),
    )
  })

  it('drops projects that no machine has anymore', () => {
    const merged = { p1: synced({ machines: {} }), p2: synced({ id: 'p2' }) }
    expect(Object.keys(settleProjects(merged, {}, 'm-here'))).toEqual(['p2'])
  })

  it('keeps a project this machine has even when another machine removed it', () => {
    const local = { p1: synced({ machines: { 'm-here': { name: 'DESKTOP', path: '~/a' } } }) }
    expect(settleProjects({}, local, 'm-here')).toEqual(local)
  })
})

describe('planProjectUpdates', () => {
  const linked = (overrides: Partial<SyncedProject> = {}) =>
    synced({ machines: { 'm-here': { name: 'DESKTOP', path: '~/code/alethe' } }, ...overrides })

  it('updates synced settings without touching the local folder', () => {
    const updates = planProjectUpdates(
      [project()],
      { p1: linked() },
      { p1: linked({ name: 'Renamed', healthCheckPath: '/health' }) },
      {},
      HERE.id,
    )
    expect(updates).toEqual([{ id: 'p1', patch: { name: 'Renamed', healthCheckPath: '/health' } }])
  })

  it('leaves groups this machine overrides alone', () => {
    const updates = planProjectUpdates(
      [project({ localOverrides: ['agents'] })],
      { p1: linked() },
      { p1: linked({ validationCommands: ['make'], color: 'blue' }) },
      {},
      HERE.id,
    )
    expect(updates).toEqual([{ id: 'p1', patch: { color: 'blue' } }])
  })

  it('applies changes to the aliased local project and ignores projects not here', () => {
    const updates = planProjectUpdates(
      [project({ id: 'local-1' })],
      { r1: linked({ id: 'r1' }), r2: synced({ id: 'r2' }) },
      { r1: linked({ id: 'r1', color: 'blue' }), r2: synced({ id: 'r2', color: 'red' }) },
      { r1: 'local-1' },
      HERE.id,
    )
    expect(updates.map((u) => u.id)).toEqual(['local-1'])
  })
})

describe('materializing projects', () => {
  it('uses a folder another machine points to when it exists here', () => {
    const entries = [
      synced({ id: 'here', machines: { a: { name: 'A', path: '~/code/here' } } }),
      synced({ id: 'away', machines: { a: { name: 'A', path: '~/code/away' } } }),
    ]
    const [here, away] = planMaterialize(
      entries,
      'C:\\Users\\other',
      new Set(['C:\\Users\\other\\code\\here']),
      42,
    )
    expect(here).toMatchObject({ defaultCwd: 'C:\\Users\\other\\code\\here', createdAt: 42 })
    expect(here.pendingRelocation).toBeUndefined()
    expect(away.defaultCwd).toBeUndefined()
    expect(away.pendingRelocation).toEqual({ originalPath: 'C:\\Users\\other\\code\\away' })
    expect(away.terminals).toEqual([])
  })

  it('creates the project with the chosen folder and no machine data', () => {
    const created = materializeProject(synced({ color: 'red' }), 'D:\\src\\alethe', null, 7)
    expect(created).toMatchObject({ id: 'p1', color: 'red', defaultCwd: 'D:\\src\\alethe' })
    expect(created).not.toHaveProperty('machines')
  })
})
