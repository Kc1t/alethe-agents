import {
  bindingPaths,
  buildLocalProjectView,
  mergeProjects,
  parseSyncedProject,
  planMaterialize,
  planProjectUpdates,
  projectPath,
  settleProjects,
  type SyncedProject,
} from '../../projectSync'
import type { Project } from '../../types'
import { isRecord, type ProjectsPayload, SYNC_FORMAT } from '../contract'
import { checkFormat, type ScopeAdapter, type SyncHost } from '../host'

export async function fillMissingRemotes(host: SyncHost): Promise<void> {
  for (const project of host.projects()) {
    if (project.githubUrl || project.mode === 'agentSandbox') continue
    const path = project.defaultCwd?.trim() || projectPath(project)
    if (!path || project.pendingRelocation) continue
    const remote = await host.gitRemote(path).catch(() => null)
    if (remote) host.setProjectGithubUrl(project.id, remote)
  }
}

export function parseProjects(raw: unknown): Record<string, SyncedProject> {
  const projects: Record<string, SyncedProject> = {}
  if (!isRecord(raw)) return projects
  for (const [id, value] of Object.entries(raw)) {
    const project = parseSyncedProject(id, value)
    if (project) projects[id] = project
  }
  return projects
}

export const projectsScope: ScopeAdapter<ProjectsPayload> = {
  scope: 'projects',

  empty: () => ({ format: SYNC_FORMAT, projects: {} }),

  parse(raw) {
    if (!isRecord(raw) || !checkFormat(raw.format, SYNC_FORMAT)) return null
    return { format: SYNC_FORMAT, projects: parseProjects(raw.projects) }
  },

  async collect(ctx, base, remote) {
    await fillMissingRemotes(ctx.host)
    const view = buildLocalProjectView({
      local: ctx.host.projects(),
      home: ctx.home,
      machine: ctx.machine,
      base: base?.projects ?? null,
      remote: remote.projects,
      aliases: ctx.state.aliases.projects,
      forget: ctx.state.forgetMachines,
    })
    ctx.state.aliases.projects = view.aliases
    return { format: SYNC_FORMAT, projects: view.projects }
  },

  merge(base, local, remote, ctx) {
    const merged = mergeProjects(base?.projects ?? null, local.projects, remote.projects)
    return {
      format: SYNC_FORMAT,
      projects: settleProjects(merged, local.projects, ctx.machine.id, ctx.materialize),
    }
  },

  async apply(ctx, merged, local, base) {
    const machineId = ctx.machine.id
    const updates = planProjectUpdates(
      ctx.host.projects(),
      local.projects,
      merged.projects,
      ctx.state.aliases.projects,
      machineId,
    )
    const unbound = Object.values(merged.projects).filter(
      (entry) => !local.projects[entry.id]?.machines[machineId],
    )
    let creates: Project[] = []
    if (ctx.materialize) {
      const candidates = unbound.flatMap((entry) => bindingPaths(entry, ctx.home))
      creates = planMaterialize(unbound, ctx.home, await ctx.host.existingDirectories(candidates))
    }
    const available = ctx.materialize
      ? 0
      : unbound.filter((entry) => !base?.projects[entry.id]).length
    const extra = available ? { available } : {}
    if (updates.length === 0 && creates.length === 0) return { changed: false, ...extra }
    ctx.host.applyProjectMergePlan({ updates, creates })
    return {
      changed: true,
      updated: updates.length,
      created: creates.length,
      relocations: creates.filter((project) => project.pendingRelocation).length,
      ...extra,
    }
  },

  committed(ctx) {
    ctx.state.forgetMachines = []
  },
}
