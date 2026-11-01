import type { MachineInfo, ProjectMergePlan } from '../projectSync'
import type { CloudDoc, CloudManifest, CloudPutOutcome } from '../tauri/cloud'
import type { Preferences, Project } from '../types'
import type { ImplementedScope } from './contract'
import type { SyncTransport } from './engine'
import type { SyncHost, SyncState } from './host'

type StoredDoc = { payload: unknown; version: number; device: string }

export class MemoryServer {
  docs = new Map<ImplementedScope, StoredDoc>()
  writes = 0
  beforePut: ((scope: ImplementedScope) => void) | null = null

  manifest(): CloudManifest {
    const scopes: CloudManifest['scopes'] = {}
    for (const [scope, doc] of this.docs) {
      scopes[scope] = {
        version: doc.version,
        updatedAt: 0,
        updatedBy: { id: doc.device, name: doc.device },
      }
    }
    return { profile: 'default', scopes }
  }

  get(scope: ImplementedScope): CloudDoc | null {
    const doc = this.docs.get(scope)
    if (!doc) return null
    return {
      payload: structuredClone(doc.payload),
      version: doc.version,
      updatedAt: 0,
      updatedBy: { id: doc.device, name: doc.device },
    }
  }

  put(
    scope: ImplementedScope,
    payload: unknown,
    baseVersion: number,
    device: string,
  ): CloudPutOutcome {
    const hook = this.beforePut
    this.beforePut = null
    hook?.(scope)
    const current = this.docs.get(scope)
    if ((current?.version ?? 0) !== baseVersion) {
      return {
        kind: 'conflict',
        remote: current
          ? {
              payload: structuredClone(current.payload),
              version: current.version,
              updatedAt: 0,
              updatedBy: null,
            }
          : { payload: null, version: 0, updatedAt: null, updatedBy: null },
      }
    }
    this.writes += 1
    const version = baseVersion + 1
    this.docs.set(scope, { payload: structuredClone(payload), version, device })
    return { kind: 'ok', version }
  }

  transport(device: string, store: { state: unknown }): SyncTransport {
    return {
      manifest: async () => this.manifest(),
      get: async (scope) => this.get(scope),
      put: async (scope, payload, baseVersion) => this.put(scope, payload, baseVersion, device),
      readState: async () => structuredClone(store.state),
      writeState: async (state: SyncState) => {
        store.state = structuredClone(state)
      },
    }
  }
}

export function makeProject(overrides: Partial<Project> & { id: string }): Project {
  return {
    name: overrides.id,
    groupId: null,
    terminals: [],
    layoutMode: 'auto',
    collapsed: false,
    createdAt: 1,
    ...overrides,
  }
}

export type FakeHost = SyncHost & {
  prefs: Record<string, unknown>
  projectList: Project[]
  pluginState: Record<string, boolean>
}

export function fakeHost(init: {
  preferences?: Record<string, unknown>
  projects?: Project[]
  plugins?: Record<string, boolean>
  home?: string
  dirs?: string[]
  remotes?: Record<string, string>
  machine?: MachineInfo
}): FakeHost {
  const dirs = new Set(init.dirs ?? [])
  const host: FakeHost = {
    prefs: { ...(init.preferences ?? {}) },
    projectList: [...(init.projects ?? [])],
    pluginState: { ...(init.plugins ?? {}) },
    preferences: () => host.prefs as unknown as Preferences,
    setPreferences: (patch) => {
      host.prefs = { ...host.prefs, ...patch }
    },
    projects: () => host.projectList,
    applyProjectMergePlan: (plan: ProjectMergePlan) => {
      const patches = new Map(plan.updates.map((u) => [u.id, u.patch]))
      host.projectList = [
        ...host.projectList.map((p) => (patches.has(p.id) ? { ...p, ...patches.get(p.id) } : p)),
        ...plan.creates,
      ]
    },
    setProjectGithubUrl: (id, url) => {
      host.projectList = host.projectList.map((p) => (p.id === id ? { ...p, githubUrl: url } : p))
    },
    plugins: async () => Object.entries(host.pluginState).map(([id, enabled]) => ({ id, enabled })),
    setPluginEnabled: async (id, enabled) => {
      host.pluginState[id] = enabled
    },
    homeDir: async () => init.home ?? 'C:\\Users\\me',
    machine: async () => init.machine ?? { id: 'm-default', name: 'PC' },
    existingDirectories: async (paths) => new Set(paths.filter((path) => dirs.has(path))),
    gitRemote: async (path) => init.remotes?.[path] ?? null,
  }
  return host
}
