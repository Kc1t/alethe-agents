import { describe, expect, it } from 'vitest'

import type { SyncedProject } from '../projectSync'
import { buildMachinesView } from './machines'
import { makeProject } from './testing'

const HERE = { id: 'm-here', name: 'DESKTOP' }

const entry = (id: string, machines: SyncedProject['machines']): SyncedProject => ({
  id,
  name: id,
  machines,
})

describe('buildMachinesView', () => {
  const base = {
    shared: entry('shared', {
      'm-here': { name: 'DESKTOP', path: '~/shared' },
      'm-laptop': { name: 'LAPTOP', path: '~/work/shared', custom: ['tooling'] },
    }),
    away: entry('away', { 'm-laptop': { name: 'LAPTOP', path: '~/away' } }),
    old: entry('old', { 'm-old': { name: 'OLD-PC', path: '~/old' } }),
  }

  it('shows every project with the computers that have it', () => {
    const view = buildMachinesView({
      base,
      local: [
        makeProject({ id: 'shared', defaultCwd: 'C:\\Users\\me\\shared' }),
        makeProject({ id: 'fresh', defaultCwd: 'C:\\Users\\me\\fresh' }),
      ],
      aliases: {},
      machine: HERE,
      home: 'C:\\Users\\me',
      forget: [],
    })
    expect(view.synced).toBe(true)
    expect(view.rows.map((row) => [row.id, row.localId])).toEqual([
      ['away', null],
      ['fresh', 'fresh'],
      ['old', null],
      ['shared', 'shared'],
    ])
    const shared = view.rows.find((row) => row.id === 'shared')!
    expect(shared.machines).toEqual([
      { id: 'm-here', name: 'DESKTOP', path: '~/shared', custom: [], current: true },
      {
        id: 'm-laptop',
        name: 'LAPTOP',
        path: '~/work/shared',
        custom: ['tooling'],
        current: false,
      },
    ])
    expect(view.machines).toEqual([
      { id: 'm-here', name: 'DESKTOP', current: true, projects: 2 },
      { id: 'm-laptop', name: 'LAPTOP', current: false, projects: 2 },
      { id: 'm-old', name: 'OLD-PC', current: false, projects: 1 },
    ])
  })

  it('hides forgotten computers and the projects only they had', () => {
    const view = buildMachinesView({
      base,
      local: [],
      aliases: {},
      machine: HERE,
      home: null,
      forget: ['m-old'],
    })
    expect(view.rows.map((row) => row.id)).toEqual(['away', 'shared'])
    expect(view.rows.find((row) => row.id === 'shared')!.machines.map((m) => m.id)).toEqual([
      'm-laptop',
    ])
    expect(view.machines.map((m) => m.id)).toEqual(['m-here', 'm-laptop'])
  })

  it('works before the first sync', () => {
    const view = buildMachinesView({
      base: null,
      local: [makeProject({ id: 'p1' })],
      aliases: {},
      machine: HERE,
      home: null,
      forget: [],
    })
    expect(view.synced).toBe(false)
    expect(view.rows.map((row) => row.id)).toEqual(['p1'])
  })
})
