import { describe, expect, it } from 'vitest'

import { countSkills, groupSkillsByName, matchesSkillQuery } from './skills'
import type { SkillAgentSnapshot, SkillSummary } from './tauri/skills'

function skill(agent: string, name: string, overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name,
    agent,
    path: `C:/${agent}/skills/${name}`,
    resolvedPath: `C:/${agent}/skills/${name}`,
    description: '',
    linked: false,
    shared: false,
    bundled: false,
    entryCount: 1,
    ...overrides,
  }
}

function snapshot(agent: string, skills: SkillSummary[]): SkillAgentSnapshot {
  return { agent, root: `C:/${agent}/skills`, exists: true, skills }
}

describe('groupSkillsByName', () => {
  it('merges the same skill across agents', () => {
    const groups = groupSkillsByName([
      snapshot('claude', [skill('claude', 'brand'), skill('claude', 'lousa')]),
      snapshot('codex', [skill('codex', 'brand')]),
    ])

    expect(groups.map((group) => group.name)).toEqual(['brand', 'lousa'])
    expect(groups[0].agents).toEqual(['claude', 'codex'])
  })

  it('never offers the shared copy for a bulk remove', () => {
    const groups = groupSkillsByName([
      snapshot('claude', [skill('claude', 'brand', { linked: true, shared: true })]),
      snapshot('shared', [skill('shared', 'brand')]),
    ])

    expect(groups[0].agents).toEqual(['claude'])
    expect(groups[0].removable.map((entry) => entry.agent)).toEqual(['claude'])
    expect(groups[0].sharedEntry?.agent).toBe('shared')
  })

  it('excludes a bundled skill from the removable set', () => {
    const groups = groupSkillsByName([
      snapshot('codex', [skill('codex', 'imagegen', { bundled: true })]),
      snapshot('claude', [skill('claude', 'imagegen')]),
    ])

    expect(groups[0].removable.map((entry) => entry.agent)).toEqual(['claude'])
    expect(groups[0].bundled).toBe(false)
  })

  it('marks a group bundled only when every agent copy is bundled', () => {
    const groups = groupSkillsByName([
      snapshot('codex', [skill('codex', 'imagegen', { bundled: true })]),
    ])
    expect(groups[0].bundled).toBe(true)
    expect(groups[0].removable).toEqual([])
  })

  it('takes the first non-empty description it finds', () => {
    const groups = groupSkillsByName([
      snapshot('claude', [skill('claude', 'brand')]),
      snapshot('codex', [skill('codex', 'brand', { description: 'Brand system' })]),
    ])
    expect(groups[0].description).toBe('Brand system')
  })

  it('counts groups, not per-agent copies', () => {
    const snapshots = [
      snapshot('claude', [skill('claude', 'brand')]),
      snapshot('codex', [skill('codex', 'brand')]),
    ]
    expect(countSkills(snapshots)).toBe(1)
    expect(countSkills([])).toBe(0)
  })
})

describe('matchesSkillQuery', () => {
  const [group] = groupSkillsByName([
    snapshot('claude', [skill('claude', 'brand', { description: 'Diffusion Studio system' })]),
  ])

  it('matches on name and on description', () => {
    expect(matchesSkillQuery(group, 'BRA')).toBe(true)
    expect(matchesSkillQuery(group, 'diffusion')).toBe(true)
  })

  it('accepts an empty query and rejects a non-match', () => {
    expect(matchesSkillQuery(group, '  ')).toBe(true)
    expect(matchesSkillQuery(group, 'pptx')).toBe(false)
  })
})
