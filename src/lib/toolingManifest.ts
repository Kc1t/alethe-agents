import { type McpEnvInput, mcpScan, type McpServerInput, mcpUpsert } from './tauri/mcp'
import {
  type SkillAgentSnapshot,
  skillsCatalog,
  skillsInstallBundled,
  skillsScan,
} from './tauri/skills'
import type {
  McpAgentSnapshot,
  McpEnvEntry,
  McpScope,
  ToolingEnvKey,
  ToolingManifest,
  ToolingMcpServer,
  ToolingMcpTransport,
  ToolingSkill,
} from './types'

export type ToolingStatus = 'installed' | 'missing' | 'unavailable'

export type ToolingSecretField = {
  id: string
  key: string
  location: 'env' | 'header'
}

export type ToolingMcpItem = {
  server: ToolingMcpServer
  status: ToolingStatus
  secretFields: ToolingSecretField[]
}

export type ToolingSkillItem = {
  skill: ToolingSkill
  status: ToolingStatus
}

export type ToolingInspection = {
  mcp: ToolingMcpItem[]
  skills: ToolingSkillItem[]
}

function envKeys(entries: Record<string, McpEnvEntry>): ToolingEnvKey[] {
  return Object.entries(entries)
    .map(([key, entry]) => ({ key, passthroughFrom: entry.passthroughFrom ?? null }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

function manifestTransport(transport: McpAgentSnapshot['servers'][number]['server']['transport']) {
  if (transport.kind === 'stdio') {
    return { ...transport, args: [...transport.args] } satisfies ToolingMcpTransport
  }
  return {
    kind: transport.kind,
    url: transport.url,
    headers: envKeys(transport.headers),
  } satisfies ToolingMcpTransport
}

export function mcpServersFromScan(snapshots: McpAgentSnapshot[]): ToolingMcpServer[] {
  return snapshots
    .flatMap((snapshot) => snapshot.servers)
    .filter((record) => !record.managedByImport)
    .map((record) => ({
      agent: record.agent,
      sourceKind: record.sourceKind,
      name: record.server.name,
      transport: manifestTransport(record.server.transport),
      env: envKeys(record.server.env),
      enabled: record.server.enabled,
      timeouts: { ...record.server.timeouts },
      bearerTokenEnvVar: record.server.bearerTokenEnvVar,
    }))
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.name.localeCompare(b.name))
}

/** Official skills that were renamed; manifests saved before keep the earlier name. */
const BUNDLED_RENAMES: Record<string, string> = { 'alethe-orchestrate': 'alethe' }

export function currentBundledName(name: string): string {
  return BUNDLED_RENAMES[name] ?? name
}

/** An official skill installs only for the agents its catalog entry lists. */
export function bundledKey(agent: string, name: string): string {
  return `${agent}\u0000${currentBundledName(name)}`
}

export function skillsFromScan(
  snapshots: SkillAgentSnapshot[],
  bundledKeys: ReadonlySet<string>,
): ToolingSkill[] {
  return snapshots
    .flatMap((snapshot) => snapshot.skills)
    .map((skill) => ({
      agent: skill.agent,
      name: skill.name,
      bundled: bundledKeys.has(bundledKey(skill.agent, skill.name)),
    }))
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.name.localeCompare(b.name))
}

async function bundledSkillKeys(): Promise<Set<string>> {
  try {
    return new Set(
      (await skillsCatalog()).flatMap((skill) =>
        skill.agents.map((entry) => bundledKey(entry.agent, skill.name)),
      ),
    )
  } catch {
    return new Set()
  }
}

export async function captureToolingManifest(
  scope: McpScope,
  repo: string | null,
): Promise<ToolingManifest> {
  const snapshots = await mcpScan(scope, repo)
  const skills =
    scope === 'global' ? skillsFromScan(await skillsScan(), await bundledSkillKeys()) : []
  return { capturedAt: Date.now(), mcpServers: mcpServersFromScan(snapshots), skills }
}

export function secretFieldsFor(server: ToolingMcpServer): ToolingSecretField[] {
  const fields: ToolingSecretField[] = server.env
    .filter((entry) => !entry.passthroughFrom)
    .map((entry) => ({ id: `env:${entry.key}`, key: entry.key, location: 'env' }))
  if (server.transport.kind !== 'stdio') {
    for (const header of server.transport.headers) {
      if (header.passthroughFrom) continue
      fields.push({ id: `header:${header.key}`, key: header.key, location: 'header' })
    }
  }
  return fields
}

export function inspectAgainstScan(
  manifest: ToolingManifest,
  mcpSnapshots: McpAgentSnapshot[],
  skillSnapshots: SkillAgentSnapshot[] | null,
  bundledKeys: ReadonlySet<string>,
): ToolingInspection {
  const installedMcp = new Set(
    mcpSnapshots.flatMap((s) => s.servers).map((r) => `${r.agent}\u0000${r.server.name}`),
  )
  const installedSkills = new Set(
    (skillSnapshots ?? []).flatMap((s) => s.skills).map((k) => `${k.agent}\u0000${k.name}`),
  )
  return {
    mcp: manifest.mcpServers.map((server) => ({
      server,
      status: installedMcp.has(`${server.agent}\u0000${server.name}`) ? 'installed' : 'missing',
      secretFields: secretFieldsFor(server),
    })),
    skills: manifest.skills.map((skill) => {
      const current = currentBundledName(skill.name)
      if (
        installedSkills.has(`${skill.agent}\u0000${skill.name}`) ||
        installedSkills.has(`${skill.agent}\u0000${current}`)
      ) {
        return { skill, status: 'installed' }
      }
      return {
        skill,
        status: bundledKeys.has(bundledKey(skill.agent, skill.name)) ? 'missing' : 'unavailable',
      }
    }),
  }
}

export async function inspectToolingManifest(
  manifest: ToolingManifest,
  scope: McpScope,
  repo: string | null,
): Promise<ToolingInspection> {
  const [mcpSnapshots, skillSnapshots, bundled] = await Promise.all([
    mcpScan(scope, repo),
    manifest.skills.length > 0 ? skillsScan() : Promise.resolve(null),
    manifest.skills.length > 0 ? bundledSkillKeys() : Promise.resolve(new Set<string>()),
  ])
  return inspectAgainstScan(manifest, mcpSnapshots, skillSnapshots, bundled)
}

export function countPending(inspection: ToolingInspection): number {
  return (
    inspection.mcp.filter((item) => item.status === 'missing').length +
    inspection.skills.filter((item) => item.status === 'missing').length
  )
}

function envInputs(
  entries: ToolingEnvKey[],
  location: ToolingSecretField['location'],
  secrets: Record<string, string>,
): McpEnvInput[] {
  return entries.map((entry) =>
    entry.passthroughFrom
      ? { key: entry.key, passthroughFrom: entry.passthroughFrom }
      : { key: entry.key, value: secrets[`${location}:${entry.key}`] ?? '' },
  )
}

export function toServerInput(
  server: ToolingMcpServer,
  secrets: Record<string, string>,
): McpServerInput {
  const transport =
    server.transport.kind === 'stdio'
      ? {
          kind: 'stdio' as const,
          command: server.transport.command,
          args: server.transport.args,
          cwd: server.transport.cwd,
        }
      : {
          kind: server.transport.kind,
          url: server.transport.url,
          headers: envInputs(server.transport.headers, 'header', secrets),
        }
  return {
    name: server.name,
    transport,
    env: envInputs(server.env, 'env', secrets),
    enabled: server.enabled,
    timeouts: server.timeouts,
    bearerTokenEnvVar: server.bearerTokenEnvVar,
  }
}

export async function applyToolingMcp(
  server: ToolingMcpServer,
  scope: McpScope,
  repo: string | null,
  secrets: Record<string, string>,
): Promise<void> {
  await mcpUpsert(server.agent, scope, repo, toServerInput(server, secrets), server.sourceKind)
}

export async function applyToolingSkill(skill: ToolingSkill): Promise<void> {
  const report = await skillsInstallBundled(currentBundledName(skill.name), [skill.agent])
  const failed = report.find((entry) => entry.error)
  if (failed?.error) throw new Error(failed.error)
}

export function mergeManifests(base: ToolingManifest, captured: ToolingManifest): ToolingManifest {
  const mcpKey = (s: ToolingMcpServer) => `${s.agent}\u0000${s.name}`
  const skillKey = (s: ToolingSkill) => `${s.agent}\u0000${s.name}`
  const mcp = new Map(base.mcpServers.map((s) => [mcpKey(s), s]))
  for (const server of captured.mcpServers) mcp.set(mcpKey(server), server)
  const skills = new Map(base.skills.map((s) => [skillKey(s), s]))
  for (const skill of captured.skills) skills.set(skillKey(skill), skill)
  return {
    capturedAt: captured.capturedAt,
    mcpServers: [...mcp.values()],
    skills: [...skills.values()],
  }
}

export function removeFromManifest(
  manifest: ToolingManifest,
  target: { kind: 'mcp' | 'skill'; agent: string; name: string },
): ToolingManifest {
  const keep = (entry: { agent: string; name: string }) =>
    !(entry.agent === target.agent && entry.name === target.name)
  return target.kind === 'mcp'
    ? { ...manifest, mcpServers: manifest.mcpServers.filter(keep) }
    : { ...manifest, skills: manifest.skills.filter(keep) }
}
