import { useProjectsStore } from '../../stores/projectsStore'
import {
  bindingPaths,
  localOverrides,
  materializeProject,
  sharedValuesFor,
  type SyncedProject,
} from '../projectSync'
import {
  cloudSyncGet,
  cloudSyncMachine,
  cloudSyncManifest,
  cloudSyncPut,
  cloudSyncStateRead,
  cloudSyncStateWrite,
  cloudSyncStatus,
  gitRemoteOrigin,
  homeDirectory,
  listDirectory,
  pluginSetEnabled,
  pluginsList,
} from '../tauri'
import { notifyMissingProfileTooling } from '../toolingNotice'
import type { ProjectOverrideGroup } from '../types'
import { type ImplementedScope, scopesForPlan } from './contract'
import {
  detectRemoteChanges,
  parseState,
  type RemoteChanges,
  runSync,
  type SyncResult,
  type SyncTransport,
} from './engine'
import type { SyncHost, SyncState } from './host'
import { type AccountProjectRow, buildMachinesView, type MachinesView } from './machines'
import { projectsScope } from './scopes/projects'

export { type RemoteChanges, type SyncResult } from './engine'
export { SyncFailure } from './host'
export type { AccountProjectRow, MachineSummary, MachinesView } from './machines'

export const cloudTransport: SyncTransport = {
  manifest: cloudSyncManifest,
  get: cloudSyncGet,
  put: cloudSyncPut,
  readState: cloudSyncStateRead,
  writeState: cloudSyncStateWrite,
}

const probedRemotes = new Map<string, Promise<string | null>>()

export const storeHost: SyncHost = {
  preferences: () => useProjectsStore.getState().preferences,
  setPreferences: (patch) => useProjectsStore.getState().setPreferences(patch),
  projects: () => useProjectsStore.getState().projects,
  applyProjectMergePlan: (plan) => useProjectsStore.getState().applyProjectMergePlan(plan),
  setProjectGithubUrl: (id, url) => useProjectsStore.getState().setProjectGithubUrl(id, url),
  plugins: async () => (await pluginsList()).map(({ id, enabled }) => ({ id, enabled })),
  setPluginEnabled: (id, enabled) => pluginSetEnabled(id, enabled).then(() => undefined),
  homeDir: () => homeDirectory().catch(() => null),
  machine: cloudSyncMachine,
  existingDirectories: async (paths) => {
    const unique = [...new Set(paths)]
    const found = await Promise.all(
      unique.map((path) =>
        listDirectory(path).then(
          () => path,
          () => null,
        ),
      ),
    )
    return new Set(found.filter((path): path is string => path !== null))
  },
  gitRemote: (path) => {
    let probe = probedRemotes.get(path)
    if (!probe) {
      probe = gitRemoteOrigin(path).catch(() => null)
      probedRemotes.set(path, probe)
    }
    return probe
  },
}

let running: Promise<SyncResult> | null = null

export function syncNow(scopes?: readonly ImplementedScope[]): Promise<SyncResult> {
  if (running) return running
  running = (async () => {
    try {
      const status = await cloudSyncStatus()
      if (!status.connected) throw new Error('not_connected')
      const result = await runSync({
        transport: cloudTransport,
        host: storeHost,
        scopes: scopes ?? scopesForPlan(status.plan),
      })
      if (result.scopes.some((scope) => scope.scope === 'tooling' && scope.report.changed)) {
        void notifyMissingProfileTooling()
      }
      return result
    } finally {
      running = null
    }
  })()
  return running
}

export function isSyncRunning(): boolean {
  return running !== null
}

export async function checkRemoteChanges(): Promise<RemoteChanges | null> {
  const status = await cloudSyncStatus()
  if (!status.connected) return null
  return detectRemoteChanges(cloudTransport, scopesForPlan(status.plan), status.device_id)
}

export function summarizeResult(result: SyncResult) {
  const totals = {
    preferences: 0,
    plugins: 0,
    updated: 0,
    available: 0,
    tooling: 0,
  }
  let pushed = false
  for (const scope of result.scopes) {
    pushed ||= scope.pushed
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
      totals[key] += scope.report[key] ?? 0
    }
  }
  const pulled = result.scopes.some((scope) => scope.report.changed)
  return { ...totals, pushed, pulled }
}

async function readState(): Promise<SyncState> {
  return parseState(await cloudSyncStateRead().catch(() => null))
}

function syncedProjects(state: SyncState): Record<string, SyncedProject> | null {
  const entry = state.scopes.projects
  return entry ? (projectsScope.parse(entry.base)?.projects ?? null) : null
}

export async function loadMachinesView(): Promise<MachinesView> {
  const state = await readState()
  const [machine, home] = await Promise.all([storeHost.machine(), storeHost.homeDir()])
  const view = buildMachinesView({
    base: syncedProjects(state),
    local: useProjectsStore.getState().projects,
    aliases: state.aliases.projects,
    machine,
    home,
    forget: state.forgetMachines,
  })
  const pending = view.rows.flatMap((row) =>
    !row.localId && row.entry ? [{ row, paths: bindingPaths(row.entry, home) }] : [],
  )
  const existing = await storeHost.existingDirectories(pending.flatMap(({ paths }) => paths))
  for (const { row, paths } of pending) {
    row.foundPath = paths.find((path) => existing.has(path)) ?? null
    row.missingPath = paths[0] ?? null
  }
  return view
}

export function addProjectToThisMachine(row: AccountProjectRow, path: string | null): void {
  if (!row.entry || row.localId) return
  const project = materializeProject(row.entry, path, path ? null : row.missingPath)
  useProjectsStore.getState().applyProjectMergePlan({ updates: [], creates: [project] })
}

export async function forgetMachine(machineId: string): Promise<void> {
  const state = await readState()
  if (state.forgetMachines.includes(machineId)) return
  state.forgetMachines.push(machineId)
  await cloudSyncStateWrite(state)
}

export async function adoptSharedVersion(
  projectId: string,
  group: ProjectOverrideGroup,
): Promise<void> {
  const state = await readState()
  const remoteId =
    Object.entries(state.aliases.projects).find(([, localId]) => localId === projectId)?.[0] ??
    projectId
  const entry = syncedProjects(state)?.[remoteId]
  if (entry) {
    useProjectsStore.getState().applyProjectMergePlan({
      updates: [{ id: projectId, patch: sharedValuesFor(entry, group) }],
      creates: [],
    })
  }
  keepOnThisMachine(projectId, group, false)
}

export function keepOnThisMachine(
  projectId: string,
  group: ProjectOverrideGroup,
  enabled: boolean,
): void {
  const store = useProjectsStore.getState()
  const project = store.projects.find((p) => p.id === projectId)
  if (!project) return
  const groups = localOverrides(project).filter((g) => g !== group)
  store.setProjectLocalOverrides(projectId, enabled ? [...groups, group] : groups)
}
