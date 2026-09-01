import type { MessageKey } from './i18n'
import type { McpEnvInput, McpServerInput } from './tauri/mcp'
import type {
  McpAgent,
  McpAgentSnapshot,
  McpCapability,
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

/**
 * Only an agent whose every source parsed can be said to be *missing* a server — with an
 * unreadable file we cannot tell, and with no source at all the question does not apply.
 */
export function isAgentReadable(snapshot: McpAgentSnapshot): boolean {
  return (
    snapshot.sources.length > 0 && snapshot.sources.every((source) => source.parseError === null)
  )
}

export function groupServersByName(snapshots: McpAgentSnapshot[]): McpServerGroup[] {
  const readableAgents = snapshots.filter(isAgentReadable).map((snapshot) => snapshot.agent)

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

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function envInputs(value: unknown, interpolate: boolean): McpEnvInput[] {
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([key, raw]) => {
    if (typeof raw !== 'string') return []
    const inner =
      interpolate && raw.startsWith('{env:') && raw.endsWith('}') ? raw.slice(5, -1).trim() : null
    return [inner ? { key, passthroughFrom: inner } : { key, value: raw }]
  })
}

function secondsOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

function serverFromEntry(name: string, entry: UnknownRecord): McpServerInput | null {
  const declared = typeof entry.type === 'string' ? entry.type : ''
  const url = typeof entry.url === 'string' ? entry.url.trim() : ''
  const interpolate = 'environment' in entry
  const env = envInputs(entry.environment ?? entry.env, interpolate)
  const timeouts = {
    startupSecs: secondsOf(entry.startup_timeout_sec),
    toolSecs: secondsOf(entry.tool_timeout_sec),
  }
  const shared = {
    name,
    env,
    enabled: entry.enabled === false ? false : true,
    timeouts,
    bearerTokenEnvVar:
      typeof entry.bearer_token_env_var === 'string' ? entry.bearer_token_env_var : null,
  }

  if (url) {
    return {
      ...shared,
      transport: {
        kind: declared === 'sse' ? 'sse' : 'http',
        url,
        headers: envInputs(entry.headers, interpolate),
      },
    }
  }

  // OpenCode packs the command and its arguments into one array.
  const packed = stringArray(entry.command)
  const command =
    packed.length > 0 ? packed[0] : typeof entry.command === 'string' ? entry.command : ''
  if (!command.trim()) return null
  const args = packed.length > 0 ? packed.slice(1) : stringArray(entry.args)

  return {
    ...shared,
    transport: {
      kind: 'stdio',
      command: command.trim(),
      args,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
    },
  }
}

export type PasteResult = { ok: true; servers: McpServerInput[] } | { ok: false; error: MessageKey }

/**
 * Accepts every shape people copy out of an agent's docs: a `mcpServers`/`mcp` wrapper, a
 * bare `{ "<name>": {...} }` map, or a single server object (which needs a name typed in).
 */
export function parsePastedServer(text: string, fallbackName = ''): PasteResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: 'mcp.pasteEmpty' }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, error: 'mcp.pasteInvalidJson' }
  }
  if (!isRecord(parsed)) return { ok: false, error: 'mcp.pasteInvalidJson' }

  const wrapper = parsed.mcpServers ?? parsed.mcp ?? parsed.servers
  const container = isRecord(wrapper) ? wrapper : parsed

  const entries = Object.entries(container).filter((entry): entry is [string, UnknownRecord] =>
    isRecord(entry[1]),
  )
  const looksLikeOneServer = !isRecord(wrapper) && ('command' in container || 'url' in container)

  const servers = looksLikeOneServer
    ? [serverFromEntry(fallbackName.trim(), container)].filter(
        (server): server is McpServerInput => server !== null && server.name.length > 0,
      )
    : entries
        .map(([name, entry]) => serverFromEntry(name, entry))
        .filter((server): server is McpServerInput => server !== null)

  if (servers.length === 0) {
    return {
      ok: false,
      error: looksLikeOneServer ? 'mcp.pasteNeedsName' : 'mcp.pasteNoServer',
    }
  }
  return { ok: true, servers }
}

/** Mirrors `unsupported_fields` in mcp_model.rs so the UI can warn before a write is attempted. */
export function unsupportedFor(
  capability: McpCapability | undefined,
  server: McpServerInput,
): string[] {
  if (!capability) return []
  const out: string[] = []
  if (!capability.envPassthrough) {
    for (const entry of server.env ?? []) {
      if (entry.passthroughFrom) out.push(`env.${entry.key}`)
    }
  }
  if (!capability.timeouts && (server.timeouts?.startupSecs || server.timeouts?.toolSecs)) {
    out.push('timeouts')
  }
  if (!capability.remote && server.transport.kind !== 'stdio') out.push('transport')
  if (
    !capability.headers &&
    server.transport.kind !== 'stdio' &&
    (server.transport.headers?.length ?? 0) > 0
  ) {
    out.push('headers')
  }
  if (server.bearerTokenEnvVar && capability.agent !== 'codex') out.push('bearerTokenEnvVar')
  return out
}

export function matchesQuery(group: McpServerGroup, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  if (group.name.toLowerCase().includes(needle)) return true
  return group.records.some((record) =>
    transportSummary(record.server.transport).toLowerCase().includes(needle),
  )
}
