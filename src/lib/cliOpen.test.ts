import { describe, expect, it } from 'vitest'

import { planCliOpen } from './cliOpen'
import type { Project } from './types'

function project(id: string, defaultCwd?: string): Project {
  return {
    id,
    name: id,
    groupId: null,
    terminals: [],
    layoutMode: 'auto',
    collapsed: false,
    createdAt: 0,
    ...(defaultCwd ? { defaultCwd } : {}),
  }
}

describe('planCliOpen', () => {
  it('cria projeto quando nenhuma pasta bate', () => {
    expect(planCliOpen('/home/u/novo', [project('a', '/home/u/outro')])).toEqual({
      kind: 'create',
      name: 'novo',
      cwd: '/home/u/novo',
    })
  })

  it('reaproveita o projeto existente da mesma pasta', () => {
    expect(
      planCliOpen('/home/u/app', [project('a', '/home/u/outro'), project('b', '/home/u/app')]),
    ).toEqual({ kind: 'existing', projectId: 'b' })
  })

  it('ignora projetos sem defaultCwd', () => {
    expect(planCliOpen('/home/u/app', [project('sem-pasta')])).toEqual({
      kind: 'create',
      name: 'app',
      cwd: '/home/u/app',
    })
  })

  it('casa a pasta no Windows ignorando caixa e separador', () => {
    expect(planCliOpen('C:/Users/Deb/App', [project('a', 'C:\\Users\\deb\\app')])).toEqual({
      kind: 'existing',
      projectId: 'a',
    })
  })

  it('não confunde caixa diferente em caminho POSIX (case-sensitive)', () => {
    expect(planCliOpen('/home/u/App', [project('a', '/home/u/app')])).toEqual({
      kind: 'create',
      name: 'App',
      cwd: '/home/u/App',
    })
  })

  it('ignora barra final ao comparar', () => {
    expect(planCliOpen('/home/u/app/', [project('a', '/home/u/app')])).toEqual({
      kind: 'existing',
      projectId: 'a',
    })
  })

  it('nomeia o projeto com a última pasta do caminho', () => {
    expect(planCliOpen('C:\\dev\\meu-projeto', [])).toEqual({
      kind: 'create',
      name: 'meu-projeto',
      cwd: 'C:\\dev\\meu-projeto',
    })
  })

  it('devolve null pra caminho vazio', () => {
    expect(planCliOpen('   ', [])).toBeNull()
  })
})
