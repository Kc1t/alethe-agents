import {
  linkedProjects,
  localOverrides,
  type MachineInfo,
  projectPath,
  type SyncedProject,
  toPathHint,
} from '../projectSync'
import type { Project, ProjectOverrideGroup } from '../types'

export type ProjectMachine = {
  id: string
  name: string
  path: string | null
  custom: ProjectOverrideGroup[]
  current: boolean
}

export type AccountProjectRow = {
  id: string
  name: string
  color?: string
  iconUrl?: string
  localId: string | null
  entry: SyncedProject | null
  machines: ProjectMachine[]
  foundPath: string | null
  missingPath: string | null
}

export type MachineSummary = {
  id: string
  name: string
  current: boolean
  projects: number
}

export type MachinesView = {
  rows: AccountProjectRow[]
  machines: MachineSummary[]
  synced: boolean
}

export function buildMachinesView(input: {
  base: Record<string, SyncedProject> | null
  local: Project[]
  aliases: Record<string, string>
  machine: MachineInfo
  home: string | null
  forget: readonly string[]
}): MachinesView {
  const { base, machine, home } = input
  const hidden = new Set([...input.forget.filter((id) => id !== machine.id), machine.id])
  const linked = linkedProjects(
    input.local.filter((project) => project.mode !== 'agentSandbox'),
    input.aliases,
  )

  const currentMachine = (project: Project): ProjectMachine => ({
    id: machine.id,
    name: machine.name,
    path: toPathHint(projectPath(project), home),
    custom: localOverrides(project),
    current: true,
  })

  const rows: AccountProjectRow[] = []
  for (const [id, entry] of Object.entries(base ?? {})) {
    const project = linked.get(id)
    const others = Object.entries(entry.machines)
      .filter(([machineId]) => !hidden.has(machineId))
      .map(([machineId, binding]) => ({
        id: machineId,
        name: binding.name,
        path: binding.path,
        custom: binding.custom ?? [],
        current: false,
      }))
    rows.push({
      id,
      name: project?.name ?? entry.name,
      color: project?.color ?? entry.color,
      iconUrl: project?.iconUrl ?? entry.iconUrl,
      localId: project?.id ?? null,
      entry,
      machines: project ? [currentMachine(project), ...others] : others,
      foundPath: null,
      missingPath: null,
    })
  }
  for (const [id, project] of linked) {
    if (base?.[id]) continue
    rows.push({
      id,
      name: project.name,
      color: project.color,
      iconUrl: project.iconUrl,
      localId: project.id,
      entry: null,
      machines: [currentMachine(project)],
      foundPath: null,
      missingPath: null,
    })
  }
  const visible = rows
    .filter((row) => row.machines.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name))

  const machines = new Map<string, MachineSummary>([
    [machine.id, { id: machine.id, name: machine.name, current: true, projects: 0 }],
  ])
  for (const row of visible) {
    for (const entry of row.machines) {
      const summary = machines.get(entry.id) ?? {
        id: entry.id,
        name: entry.name,
        current: false,
        projects: 0,
      }
      summary.projects += 1
      machines.set(entry.id, summary)
    }
  }
  const [current, ...others] = machines.values()
  return {
    rows: visible,
    machines: [current, ...others.sort((a, b) => a.name.localeCompare(b.name))],
    synced: base !== null,
  }
}
