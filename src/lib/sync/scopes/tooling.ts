import type { ToolingManifest, ToolingMcpServer, ToolingSkill } from '../../types'
import { isRecord, SYNC_FORMAT, type ToolingPayload } from '../contract'
import { checkFormat, type ScopeAdapter } from '../host'
import { keyedBy, mergeKeyed, sameValue } from '../merge'

const toolKey = (entry: { agent: string; name: string }) => `${entry.agent}::${entry.name}`

const byAgentThenName = (a: { agent: string; name: string }, b: { agent: string; name: string }) =>
  a.agent.localeCompare(b.agent) || a.name.localeCompare(b.name)

export function toolingPayloadFrom(manifest: ToolingManifest | undefined): ToolingPayload {
  return {
    format: SYNC_FORMAT,
    capturedAt: manifest?.capturedAt ?? null,
    mcpServers: keyedBy(manifest?.mcpServers ?? [], toolKey),
    skills: keyedBy(manifest?.skills ?? [], toolKey),
  }
}

export function manifestFrom(payload: ToolingPayload): ToolingManifest {
  return {
    capturedAt: payload.capturedAt ?? Date.now(),
    mcpServers: Object.values(payload.mcpServers).sort(byAgentThenName),
    skills: Object.values(payload.skills).sort(byAgentThenName),
  }
}

const isTool = (value: unknown): value is { agent: string; name: string } =>
  isRecord(value) && typeof value.agent === 'string' && typeof value.name === 'string'

function parseEntries<T>(raw: unknown): Record<string, T> {
  const out: Record<string, T> = {}
  if (!isRecord(raw)) return out
  for (const value of Object.values(raw)) {
    if (isTool(value)) out[toolKey(value)] = value as T
  }
  return out
}

export const toolingScope: ScopeAdapter<ToolingPayload> = {
  scope: 'tooling',

  empty: () => toolingPayloadFrom(undefined),

  parse(raw) {
    if (!isRecord(raw) || !checkFormat(raw.format, SYNC_FORMAT)) return null
    return {
      format: SYNC_FORMAT,
      capturedAt: typeof raw.capturedAt === 'number' ? raw.capturedAt : null,
      mcpServers: parseEntries<ToolingMcpServer>(raw.mcpServers),
      skills: parseEntries<ToolingSkill>(raw.skills),
    }
  },

  async collect(ctx) {
    return toolingPayloadFrom(ctx.host.preferences().toolingManifest)
  },

  merge(base, local, remote) {
    const capturedAt = Math.max(local.capturedAt ?? 0, remote.capturedAt ?? 0) || null
    return {
      format: SYNC_FORMAT,
      capturedAt,
      mcpServers: mergeKeyed(base?.mcpServers ?? null, local.mcpServers, remote.mcpServers),
      skills: mergeKeyed(base?.skills ?? null, local.skills, remote.skills),
    }
  },

  async apply(ctx, merged, local) {
    if (sameValue(merged.mcpServers, local.mcpServers) && sameValue(merged.skills, local.skills)) {
      return { changed: false }
    }
    const added =
      Object.keys(merged.mcpServers).filter((key) => !local.mcpServers[key]).length +
      Object.keys(merged.skills).filter((key) => !local.skills[key]).length
    ctx.host.setPreferences({ toolingManifest: manifestFrom(merged) })
    return { changed: true, tooling: added }
  },
}
