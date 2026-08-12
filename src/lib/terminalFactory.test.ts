import { describe, expect, it } from 'vitest'

import { getProjectDefaultCwd } from './terminalFactory'
import type { Project } from './types'

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test',
    groupId: null,
    terminals: [],
    layoutMode: 'auto',
    collapsed: false,
    createdAt: 0,
    ...overrides,
  }
}

describe('getProjectDefaultCwd', () => {
  it('returns defaultCwd as-is when it is a normal path', () => {
    const project = makeProject({ defaultCwd: 'D:\\Projetos\\meu-repo' })
    expect(getProjectDefaultCwd(project, [project])).toBe('D:\\Projetos\\meu-repo')
  })

  // Bug real, visto ao vivo: projeto sem nenhum terminal "puro" pra
  // referenciar (todos isolados, ou todos apagados) mantinha `defaultCwd`
  // apontando pra uma worktree isolada de uma sessão anterior — o modal
  // "Adicionar terminal" sugeria essa pasta efêmera em vez da raiz do
  // projeto.
  it('derives the repo root when defaultCwd points into an isolated worktree', () => {
    const project = makeProject({
      defaultCwd: 'D:\\Projetos\\meu-repo\\.alethe\\worktrees\\op--KG5Ff',
    })
    expect(getProjectDefaultCwd(project, [project])).toBe('D:\\Projetos\\meu-repo')
  })

  it('derives the repo root when defaultCwd points into an ephemeral merge env', () => {
    const project = makeProject({
      defaultCwd: 'D:\\Projetos\\meu-repo\\.alethe\\merge-envs\\a1b2c3',
    })
    expect(getProjectDefaultCwd(project, [project])).toBe('D:\\Projetos\\meu-repo')
  })

  it('falls back to the most recently used pure terminal when defaultCwd is unset', () => {
    const project = makeProject({
      terminals: [
        {
          id: 't1',
          name: 'shell',
          cwd: 'D:\\Projetos\\meu-repo',
          tabs: [],
          activeTabId: '',
          disabled: false,
          laneVisible: null,
          lastUsedAt: 10,
        },
      ],
    })
    expect(getProjectDefaultCwd(project, [project])).toBe('D:\\Projetos\\meu-repo')
  })
})
