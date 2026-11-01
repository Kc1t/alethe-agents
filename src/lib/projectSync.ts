import { normalizeProjectGrids } from './projectGrids'
import { isRecord } from './sync/contract'
import { mergeFields, mergeKeyed, sameValue } from './sync/merge'
import { getProjectRepoRoot } from './terminalFactory'
import type { Project, ProjectOverrideGroup } from './types'

const SYNCED_PROJECT_KEYS = [
  'name',
  'mode',
  'color',
  'iconUrl',
  'githubUrl',
  'archived',
  'hidden',
  'worktreeMode',
  'validationCommands',
  'healthCheckCommand',
  'healthCheckPath',
  'gsdWatcherEnabled',
  'conflictAgentProvider',
  'conflictAgentModel',
  'reviewAgentProvider',
  'reviewAgentModel',
  'graphifyEnabled',
  'autoWorktree',
  'mergePostAction',
  'toolingManifest',
] as const satisfies readonly (keyof Project)[]

type SyncedProjectKey = (typeof SYNCED_PROJECT_KEYS)[number]

export const PROJECT_OVERRIDE_FIELDS: Record<ProjectOverrideGroup, readonly SyncedProjectKey[]> = {
  agents: [
    'worktreeMode',
    'validationCommands',
    'healthCheckCommand',
    'healthCheckPath',
    'gsdWatcherEnabled',
    'conflictAgentProvider',
    'conflictAgentModel',
    'reviewAgentProvider',
    'reviewAgentModel',
    'graphifyEnabled',
    'autoWorktree',
    'mergePostAction',
  ],
  tooling: ['toolingManifest'],
}

const OVERRIDE_GROUPS = Object.keys(PROJECT_OVERRIDE_FIELDS) as ProjectOverrideGroup[]

const MAX_INLINE_ICON_LENGTH = 32_768

export type MachineInfo = { id: string; name: string }

export type MachineBinding = {
  name: string
  path: string | null
  custom?: ProjectOverrideGroup[]
}

export type SyncedProject = Partial<Pick<Project, SyncedProjectKey>> & {
  id: string
  name: string
  machines: Record<string, MachineBinding>
}

export type ProjectMergePlan = {
  updates: { id: string; patch: Partial<Project> }[]
  creates: Project[]
}

export function projectPath(project: Project): string | null {
  const path = project.defaultCwd?.trim() || getProjectRepoRoot(project)
  return path || project.pendingRelocation?.originalPath || null
}

const trimSlashes = (path: string) => path.replace(/[\\/]+$/, '')

export function toPathHint(path: string | null | undefined, home: string | null): string | null {
  const trimmed = path?.trim()
  if (!trimmed) return null
  const normalized = trimSlashes(trimmed).replace(/\\/g, '/')
  if (home?.trim()) {
    const homeNormalized = trimSlashes(home.trim()).replace(/\\/g, '/')
    const lower = normalized.toLowerCase()
    const homeLower = homeNormalized.toLowerCase()
    if (lower === homeLower) return '~'
    if (lower.startsWith(`${homeLower}/`)) return `~${normalized.slice(homeNormalized.length)}`
  }
  return normalized
}

export function fromPathHint(hint: string | null | undefined, home: string | null): string | null {
  const trimmed = hint?.trim()
  if (!trimmed) return null
  const windowsHome = !!home && /\\|^[A-Za-z]:/.test(home)
  const toNative = (path: string) => (windowsHome ? path.replace(/\//g, '\\') : path)
  if (trimmed === '~' || trimmed.startsWith('~/')) {
    if (!home?.trim()) return null
    return trimSlashes(home.trim()) + toNative(trimmed.slice(1))
  }
  if (/^[A-Za-z]:\//.test(trimmed) || trimmed.startsWith('//')) return toNative(trimmed)
  return trimmed
}

export function normalizeRemote(url: string | null | undefined): string | null {
  let value = url?.trim().toLowerCase()
  if (!value) return null
  value = value
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d)/, '$1/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  return value || null
}

export function localOverrides(project: Project): ProjectOverrideGroup[] {
  return OVERRIDE_GROUPS.filter((group) => project.localOverrides?.includes(group))
}

function overriddenKeys(groups: readonly ProjectOverrideGroup[]): Set<SyncedProjectKey> {
  return new Set(groups.flatMap((group) => PROJECT_OVERRIDE_FIELDS[group]))
}

export function sharedFields(project: Project): Partial<Pick<Project, SyncedProjectKey>> {
  const fields: Record<string, unknown> = {}
  for (const key of SYNCED_PROJECT_KEYS) {
    const value = project[key]
    if (value !== undefined) fields[key] = value
  }
  if (typeof project.iconUrl === 'string' && project.iconUrl.length > MAX_INLINE_ICON_LENGTH) {
    delete fields.iconUrl
  }
  return fields as Partial<Pick<Project, SyncedProjectKey>>
}

export function projectFingerprint(project: Project): unknown {
  return {
    ...sharedFields(project),
    path: projectPath(project),
    localOverrides: localOverrides(project),
  }
}

export function machineBinding(
  project: Project,
  home: string | null,
  machine: MachineInfo,
): MachineBinding {
  const custom = localOverrides(project)
  return {
    name: machine.name,
    path: toPathHint(projectPath(project), home),
    ...(custom.length ? { custom } : {}),
  }
}

const withoutMachines = (
  machines: Record<string, MachineBinding>,
  drop: ReadonlySet<string>,
): Record<string, MachineBinding> =>
  Object.fromEntries(Object.entries(machines).filter(([id]) => !drop.has(id)))

export function toSyncedProject(
  project: Project,
  id: string,
  home: string | null,
  machine: MachineInfo,
  prior?: SyncedProject,
  forget: readonly string[] = [],
): SyncedProject {
  const fields: Record<string, unknown> = sharedFields(project)
  if (prior) {
    for (const key of overriddenKeys(localOverrides(project))) {
      if (prior[key] === undefined) delete fields[key]
      else fields[key] = prior[key]
    }
  }
  const drop = new Set([...forget, machine.id])
  return {
    ...fields,
    id,
    name: project.name,
    machines: {
      ...withoutMachines(prior?.machines ?? {}, drop),
      [machine.id]: machineBinding(project, home, machine),
    },
  }
}

function parseBinding(raw: unknown): MachineBinding | null {
  if (!isRecord(raw) || typeof raw.name !== 'string') return null
  const listed = Array.isArray(raw.custom) ? (raw.custom as unknown[]) : []
  const custom = OVERRIDE_GROUPS.filter((group) => listed.includes(group))
  return {
    name: raw.name,
    path: typeof raw.path === 'string' ? raw.path : null,
    ...(custom.length ? { custom } : {}),
  }
}

export function parseSyncedProject(id: string, raw: unknown): SyncedProject | null {
  if (!isRecord(raw) || raw.id !== id || typeof raw.name !== 'string') return null
  const machines: Record<string, MachineBinding> = {}
  if (isRecord(raw.machines)) {
    for (const [machineId, value] of Object.entries(raw.machines)) {
      const binding = parseBinding(value)
      if (binding) machines[machineId] = binding
    }
  }
  return { ...(raw as SyncedProject), machines }
}

export function linkedProjects(
  local: Project[],
  aliases: Record<string, string>,
): Map<string, Project> {
  const byId = new Map(local.map((project) => [project.id, project]))
  const linked = new Map<string, Project>()
  for (const project of local) linked.set(project.id, project)
  for (const [remoteId, localId] of Object.entries(aliases)) {
    const project = byId.get(localId)
    if (project) {
      linked.delete(localId)
      linked.set(remoteId, project)
    }
  }
  return linked
}

const pathKey = (hint: string | null | undefined) => hint?.toLowerCase() ?? null

export type LocalProjectView = {
  projects: Record<string, SyncedProject>
  aliases: Record<string, string>
}

export function buildLocalProjectView(input: {
  local: Project[]
  home: string | null
  machine: MachineInfo
  base: Record<string, SyncedProject> | null
  remote: Record<string, SyncedProject>
  aliases: Record<string, string>
  forget?: readonly string[]
}): LocalProjectView {
  const { home, machine, base, remote } = input
  const forget = (input.forget ?? []).filter((id) => id !== machine.id)
  const syncable = input.local.filter((project) => project.mode !== 'agentSandbox')
  const localIds = new Set(syncable.map((project) => project.id))

  const aliases: Record<string, string> = {}
  for (const [remoteId, localId] of Object.entries(input.aliases)) {
    if (localIds.has(localId)) aliases[remoteId] = localId
  }
  const remoteIdFor = new Map(Object.entries(aliases).map(([rid, lid]) => [lid, rid]))
  const known = new Set([...Object.keys(remote), ...Object.keys(base ?? {})])

  const unclaimed = Object.values(remote).filter(
    (candidate) => !localIds.has(candidate.id) && !aliases[candidate.id],
  )
  for (const project of syncable) {
    if (remoteIdFor.has(project.id) || known.has(project.id)) continue
    const remoteKey = normalizeRemote(project.githubUrl)
    const hintKey = pathKey(toPathHint(projectPath(project), home))
    const index = unclaimed.findIndex(
      (candidate) =>
        (remoteKey !== null && normalizeRemote(candidate.githubUrl) === remoteKey) ||
        (hintKey !== null &&
          Object.values(candidate.machines).some((binding) => pathKey(binding.path) === hintKey)),
    )
    if (index === -1) continue
    const [match] = unclaimed.splice(index, 1)
    aliases[match.id] = project.id
    remoteIdFor.set(project.id, match.id)
  }

  const projects: Record<string, SyncedProject> = {}
  for (const project of syncable) {
    const id = remoteIdFor.get(project.id) ?? project.id
    projects[id] = toSyncedProject(project, id, home, machine, base?.[id] ?? remote[id], forget)
  }
  const drop = new Set([...forget, machine.id])
  for (const id of Object.keys(remote)) {
    if (projects[id]) continue
    const prior = base?.[id] ?? remote[id]
    projects[id] = { ...prior, machines: withoutMachines(prior.machines, drop) }
  }
  return { projects, aliases }
}

function mergeProject(
  base: SyncedProject | null,
  local: SyncedProject,
  remote: SyncedProject,
): SyncedProject {
  const strip = ({ machines: _machines, ...fields }: SyncedProject) => fields
  return {
    ...mergeFields(base ? strip(base) : null, strip(local), strip(remote)),
    machines: mergeKeyed(base?.machines ?? null, local.machines, remote.machines),
  } as SyncedProject
}

export function mergeProjects(
  base: Record<string, SyncedProject> | null,
  local: Record<string, SyncedProject>,
  remote: Record<string, SyncedProject>,
): Record<string, SyncedProject> {
  const ids = new Set([...Object.keys(local), ...Object.keys(remote)])
  const merged: Record<string, SyncedProject> = {}
  for (const id of ids) {
    const b = base?.[id]
    const l = local[id]
    const r = remote[id]
    if (l && r) merged[id] = mergeProject(b ?? null, l, r)
    else if (l) {
      if (!b || !sameValue(l, b)) merged[id] = l
    } else if (r) {
      if (!b || !sameValue(r, b)) merged[id] = r
    }
  }
  return merged
}

export function settleProjects(
  merged: Record<string, SyncedProject>,
  local: Record<string, SyncedProject>,
  machineId: string,
  keepUnbound = false,
): Record<string, SyncedProject> {
  const settled: Record<string, SyncedProject> = {}
  for (const [id, entry] of Object.entries(merged)) {
    const own = local[id]?.machines[machineId]
    const machines = { ...entry.machines }
    if (own) machines[machineId] = own
    else if (!keepUnbound) delete machines[machineId]
    if (!keepUnbound && Object.keys(machines).length === 0) continue
    settled[id] = { ...entry, machines }
  }
  for (const [id, entry] of Object.entries(local)) {
    if (!settled[id] && entry.machines[machineId]) settled[id] = entry
  }
  return settled
}

export function planProjectUpdates(
  local: Project[],
  localView: Record<string, SyncedProject>,
  merged: Record<string, SyncedProject>,
  aliases: Record<string, string>,
  machineId: string,
): ProjectMergePlan['updates'] {
  const linked = linkedProjects(local, aliases)
  const updates: ProjectMergePlan['updates'] = []
  for (const [id, entry] of Object.entries(merged)) {
    const view = localView[id]
    const project = linked.get(id)
    if (!view?.machines[machineId] || !project) continue
    const skip = overriddenKeys(localOverrides(project))
    const patch: Record<string, unknown> = {}
    for (const key of SYNCED_PROJECT_KEYS) {
      if (!skip.has(key) && !sameValue(view[key], entry[key])) patch[key] = entry[key]
    }
    if (Object.keys(patch).length > 0) {
      updates.push({ id: project.id, patch: patch as Partial<Project> })
    }
  }
  return updates
}

export function bindingPaths(
  entry: SyncedProject,
  home: string | null,
  exceptMachine?: string,
): string[] {
  const paths = Object.entries(entry.machines)
    .filter(([id]) => id !== exceptMachine)
    .map(([, binding]) => fromPathHint(binding.path, home))
    .filter((path): path is string => !!path)
  return [...new Set(paths)]
}

export function materializeProject(
  entry: SyncedProject,
  path: string | null,
  missingPath: string | null,
  now = Date.now(),
): Project {
  const fields: Record<string, unknown> = {}
  for (const key of SYNCED_PROJECT_KEYS) {
    if (entry[key] !== undefined) fields[key] = entry[key]
  }
  return normalizeProjectGrids({
    ...fields,
    id: entry.id,
    name: entry.name,
    groupId: null,
    terminals: [],
    layoutMode: 'auto',
    collapsed: false,
    createdAt: now,
    ...(path ? { defaultCwd: path } : {}),
    ...(!path && missingPath ? { pendingRelocation: { originalPath: missingPath } } : {}),
  })
}

export function planMaterialize(
  entries: SyncedProject[],
  home: string | null,
  existing: ReadonlySet<string>,
  now = Date.now(),
): Project[] {
  return entries.map((entry) => {
    const candidates = bindingPaths(entry, home)
    const found = candidates.find((path) => existing.has(path)) ?? null
    return materializeProject(entry, found, candidates[0] ?? null, now)
  })
}

export function sharedValuesFor(
  entry: SyncedProject,
  group: ProjectOverrideGroup,
): Partial<Project> {
  const patch: Record<string, unknown> = {}
  for (const key of PROJECT_OVERRIDE_FIELDS[group]) patch[key] = entry[key]
  return patch as Partial<Project>
}
