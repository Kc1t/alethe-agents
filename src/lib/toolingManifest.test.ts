import { describe, expect, it } from 'vitest'

import type { SkillAgentSnapshot } from './tauri/skills'
import {
  bundledKey,
  countPending,
  inspectAgainstScan,
  mcpServersFromScan,
  mergeManifests,
  removeFromManifest,
  skillsFromScan,
  toServerInput,
} from './toolingManifest'
import type { McpAgentSnapshot, McpServerRecord, ToolingManifest } from './types'

function record(overrides: Partial<McpServerRecord['server']> = {}): McpServerRecord {
  return {
    server: {
      name: 'github',
      transport: {
        kind: 'http',
        url: 'https://api.example.com/mcp',
        headers: {
          Authorization: { literal: { preview: '••••', empty: false }, passthroughFrom: null },
          'X-Team': { literal: null, passthroughFrom: 'TEAM_ID' },
        },
      },
      env: {
        API_KEY: { literal: { preview: '••••••••', empty: false }, passthroughFrom: null },
        HOME_DIR: { literal: null, passthroughFrom: 'HOME' },
      },
      enabled: true,
      timeouts: { startupSecs: null, toolSecs: 30 },
      bearerTokenEnvVar: null,
      ...overrides,
    },
    agent: 'claude',
    scope: 'global',
    sourceKind: 'user',
    sourcePath: 'C:/Users/me/.claude.json',
    managedByImport: null,
  }
}

function snapshot(servers: McpServerRecord[]): McpAgentSnapshot {
  return { agent: 'claude', scope: 'global', sources: [], servers }
}

function skillSnapshot(names: string[]): SkillAgentSnapshot {
  return {
    agent: 'claude',
    root: 'C:/Users/me/.claude/skills',
    exists: true,
    skills: names.map((name) => ({
      name,
      agent: 'claude',
      path: `C:/Users/me/.claude/skills/${name}`,
      resolvedPath: `C:/Users/me/.claude/skills/${name}`,
      description: '',
      linked: false,
      shared: false,
      bundled: false,
      fromAlethe: false,
      entryCount: 1,
    })),
  }
}

const empty: ToolingManifest = { capturedAt: 0, mcpServers: [], skills: [] }

describe('mcpServersFromScan', () => {
  it('keeps env and header keys but never literal values', () => {
    const [server] = mcpServersFromScan([snapshot([record()])])
    expect(server.env).toEqual([
      { key: 'API_KEY', passthroughFrom: null },
      { key: 'HOME_DIR', passthroughFrom: 'HOME' },
    ])
    expect(JSON.stringify(server)).not.toContain('••')
    expect(server.transport).toEqual({
      kind: 'http',
      url: 'https://api.example.com/mcp',
      headers: [
        { key: 'Authorization', passthroughFrom: null },
        { key: 'X-Team', passthroughFrom: 'TEAM_ID' },
      ],
    })
  })

  it('skips servers owned by a plugin import', () => {
    const imported = { ...record(), managedByImport: 'some-plugin' }
    expect(mcpServersFromScan([snapshot([imported])])).toEqual([])
  })
})

describe('skillsFromScan', () => {
  it('flags skills that ship with Alethe', () => {
    const skills = skillsFromScan(
      [skillSnapshot(['alethe', 'mine'])],
      new Set([bundledKey('claude', 'alethe')]),
    )
    expect(skills).toEqual([
      { agent: 'claude', name: 'alethe', bundled: true },
      { agent: 'claude', name: 'mine', bundled: false },
    ])
  })
})

describe('inspectAgainstScan', () => {
  const manifest: ToolingManifest = {
    capturedAt: 1,
    mcpServers: mcpServersFromScan([snapshot([record(), record({ name: 'linear' })])]),
    skills: [
      { agent: 'claude', name: 'alethe-orchestrate', bundled: true },
      { agent: 'claude', name: 'custom', bundled: false },
      { agent: 'claude', name: 'present', bundled: false },
      { agent: 'opencode', name: 'alethe', bundled: false },
    ],
  }

  it('marks what this machine already has, what can be installed, and what cannot', () => {
    const inspection = inspectAgainstScan(
      manifest,
      [snapshot([record({ name: 'linear' })])],
      [skillSnapshot(['present'])],
      new Set([bundledKey('claude', 'alethe'), bundledKey('codex', 'alethe')]),
    )
    expect(inspection.mcp.map((i) => [i.server.name, i.status])).toEqual([
      ['github', 'missing'],
      ['linear', 'installed'],
    ])
    expect(inspection.skills.map((i) => [i.skill.name, i.status])).toEqual([
      ['alethe-orchestrate', 'missing'],
      ['custom', 'unavailable'],
      ['present', 'installed'],
      ['alethe', 'unavailable'],
    ])
    expect(countPending(inspection)).toBe(2)
  })

  it('asks only for literal values, not passthrough ones', () => {
    const inspection = inspectAgainstScan(manifest, [], null, new Set())
    expect(inspection.mcp[0].secretFields.map((f) => f.id)).toEqual([
      'env:API_KEY',
      'header:Authorization',
    ])
  })
})

describe('toServerInput', () => {
  it('fills literal values from the secrets the user typed', () => {
    const [server] = mcpServersFromScan([snapshot([record()])])
    const input = toServerInput(server, { 'env:API_KEY': 'k', 'header:Authorization': 'Bearer t' })
    expect(input.env).toEqual([
      { key: 'API_KEY', value: 'k' },
      { key: 'HOME_DIR', passthroughFrom: 'HOME' },
    ])
    expect(input.transport).toEqual({
      kind: 'http',
      url: 'https://api.example.com/mcp',
      headers: [
        { key: 'Authorization', value: 'Bearer t' },
        { key: 'X-Team', passthroughFrom: 'TEAM_ID' },
      ],
    })
  })
})

describe('mergeManifests / removeFromManifest', () => {
  it('adds captured entries without dropping ones missing on this machine', () => {
    const base: ToolingManifest = {
      capturedAt: 1,
      mcpServers: mcpServersFromScan([snapshot([record({ name: 'elsewhere' })])]),
      skills: [{ agent: 'claude', name: 'a', bundled: false }],
    }
    const captured: ToolingManifest = {
      capturedAt: 2,
      mcpServers: mcpServersFromScan([snapshot([record()])]),
      skills: [{ agent: 'claude', name: 'b', bundled: false }],
    }
    const merged = mergeManifests(base, captured)
    expect(merged.capturedAt).toBe(2)
    expect(merged.mcpServers.map((s) => s.name)).toEqual(['elsewhere', 'github'])
    expect(merged.skills.map((s) => s.name)).toEqual(['a', 'b'])

    const pruned = removeFromManifest(merged, { kind: 'mcp', agent: 'claude', name: 'elsewhere' })
    expect(pruned.mcpServers.map((s) => s.name)).toEqual(['github'])
    expect(removeFromManifest(empty, { kind: 'skill', agent: 'x', name: 'y' })).toEqual(empty)
  })
})
