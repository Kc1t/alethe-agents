import { describe, expect, it } from 'vitest'

import { countServers, groupServersByName, matchesQuery, transportSummary } from './mcp'
import type { McpAgent, McpAgentSnapshot, McpServerRecord, McpTransport } from './types'

const stdio: McpTransport = {
  kind: 'stdio',
  command: 'node',
  args: ['C:/x/server.js'],
  cwd: null,
}

function record(agent: McpAgent, name: string, enabled = true): McpServerRecord {
  return {
    server: {
      name,
      transport: stdio,
      env: {},
      enabled,
      timeouts: { startupSecs: null, toolSecs: null },
      bearerTokenEnvVar: null,
    },
    agent,
    scope: 'global',
    sourcePath: `C:/${agent}/config`,
    managedByImport: null,
  }
}

function snapshot(
  agent: McpAgent,
  servers: McpServerRecord[],
  overrides: Partial<McpAgentSnapshot> = {},
): McpAgentSnapshot {
  return {
    agent,
    scope: 'global',
    sourcePath: `C:/${agent}/config`,
    exists: true,
    writable: true,
    parseError: null,
    mtimeMs: 1,
    servers,
    ...overrides,
  }
}

describe('groupServersByName', () => {
  it('merges the same server across agents and reports the gaps', () => {
    const groups = groupServersByName([
      snapshot('claude', [record('claude', 'figma')]),
      snapshot('codex', [record('codex', 'figma'), record('codex', 'swarm')]),
      snapshot('opencode', []),
      snapshot('antigravity', []),
    ])

    expect(groups.map((group) => group.name)).toEqual(['figma', 'swarm'])
    const figma = groups[0]
    expect(figma.agents).toEqual(['claude', 'codex'])
    expect(figma.missingAgents).toEqual(['opencode', 'antigravity'])
  })

  it('does not report a gap for an agent whose config could not be read', () => {
    const groups = groupServersByName([
      snapshot('claude', [record('claude', 'figma')]),
      snapshot('codex', [], { parseError: 'unparsable:toml line 4' }),
      snapshot('opencode', [], { sourcePath: null, exists: false }),
      snapshot('antigravity', []),
    ])

    expect(groups[0].missingAgents).toEqual(['antigravity'])
  })

  it('flags a group where any agent has the server disabled', () => {
    const groups = groupServersByName([
      snapshot('claude', [record('claude', 'figma')]),
      snapshot('codex', [record('codex', 'figma', false)]),
    ])
    expect(groups[0].hasDisabled).toBe(true)
  })

  it('returns nothing when no agent has a server', () => {
    expect(groupServersByName([snapshot('claude', [])])).toEqual([])
    expect(countServers([snapshot('claude', [])])).toBe(0)
  })
})

describe('transportSummary', () => {
  it('joins command and args for stdio', () => {
    expect(transportSummary(stdio)).toBe('node C:/x/server.js')
  })

  it('uses the url for remote transports', () => {
    expect(
      transportSummary({ kind: 'http', url: 'https://mcp.figma.com/mcp', headers: {} }),
    ).toBe('https://mcp.figma.com/mcp')
  })
})

describe('matchesQuery', () => {
  const groups = groupServersByName([snapshot('codex', [record('codex', 'figma')])])

  it('matches on the server name', () => {
    expect(matchesQuery(groups[0], 'FIG')).toBe(true)
  })

  it('matches on the transport summary', () => {
    expect(matchesQuery(groups[0], 'server.js')).toBe(true)
  })

  it('accepts everything for an empty query', () => {
    expect(matchesQuery(groups[0], '   ')).toBe(true)
  })

  it('rejects a non-match', () => {
    expect(matchesQuery(groups[0], 'sentry')).toBe(false)
  })
})
