import type { MessageKey } from './i18n'
import type {
  McpAgent,
  McpAgentSnapshot,
  McpServerRecord,
  McpTransport,
} from './types'
import { MCP_AGENTS } from './types'

/** Backend errors are lowercase sentinels; anything unmapped falls back to a generic key. */
export function mcpErrorKey(error: string): MessageKey {
  const sentinel = error.split(':', 1)[0]
  switch (sentinel) {
    case 'unparsable':
      return 'mcp.errUnparsable'
    case 'not_found':
      return 'mcp.errNotFound'
    case 'unsupported_disable':
      return 'mcp.errNoDisable'
    case 'unsupported_scope':
      return 'mcp.errNoScope'
    case 'unsupported_fields':
      return 'mcp.errUnsupportedFields'
    case 'jsonc_unsupported':
      return 'mcp.errJsonc'
    case 'self_check_failed':
      return 'mcp.errSelfCheck'
    case 'unreadable':
      return 'mcp.errUnreadable'
    case 'write_failed':
    case 'mkdir_failed':
      return 'mcp.errWrite'
    default:
      return 'mcp.errGeneric'
  }
}

export type McpServerGroup = {
  name: string
  records: McpServerRecord[]
  agents: McpAgent[]
  missingAgents: McpAgent[]
  hasDisabled: boolean
}

export function groupServersByName(snapshots: McpAgentSnapshot[]): McpServerGroup[] {
  const readableAgents = snapshots
    .filter((snapshot) => snapshot.parseError === null && snapshot.sourcePath !== null)
    .map((snapshot) => snapshot.agent)

  const byName = new Map<string, McpServerRecord[]>()
  for (const snapshot of snapshots) {
    for (const record of snapshot.servers) {
      const bucket = byName.get(record.server.name)
      if (bucket) bucket.push(record)
      else byName.set(record.server.name, [record])
    }
  }

  return [...byName.entries()]
    .map(([name, records]) => {
      const agents = records.map((record) => record.agent)
      return {
        name,
        records,
        agents: MCP_AGENTS.filter((agent) => agents.includes(agent)),
        missingAgents: MCP_AGENTS.filter(
          (agent) => readableAgents.includes(agent) && !agents.includes(agent),
        ),
        hasDisabled: records.some((record) => !record.server.enabled),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function transportKind(transport: McpTransport): 'stdio' | 'http' | 'sse' {
  return transport.kind
}

/** Short one-line identity of a server, used as the row subtitle. */
export function transportSummary(transport: McpTransport): string {
  if (transport.kind === 'stdio') {
    return [transport.command, ...transport.args].filter(Boolean).join(' ')
  }
  return transport.url
}

export function countServers(snapshots: McpAgentSnapshot[]): number {
  return snapshots.reduce((total, snapshot) => total + snapshot.servers.length, 0)
}

export function matchesQuery(group: McpServerGroup, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  if (group.name.toLowerCase().includes(needle)) return true
  return group.records.some((record) =>
    transportSummary(record.server.transport).toLowerCase().includes(needle),
  )
}
