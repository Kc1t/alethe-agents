import type { CloudDoc, CloudManifest, CloudPutOutcome } from '../tauri/cloud'
import { type ImplementedScope, isRecord } from './contract'
import {
  type ApplyReport,
  type ScopeAdapter,
  type ScopeContext,
  SyncFailure,
  type SyncHost,
  type SyncState,
} from './host'
import { sameValue } from './merge'
import { projectsScope } from './scopes/projects'
import { settingsScope } from './scopes/settings'
import { toolingScope } from './scopes/tooling'

export type SyncTransport = {
  manifest(): Promise<CloudManifest>
  get(scope: ImplementedScope): Promise<CloudDoc | null>
  put(scope: ImplementedScope, payload: unknown, baseVersion: number): Promise<CloudPutOutcome>
  readState(): Promise<unknown>
  writeState(state: SyncState): Promise<void>
}

export type ScopeResult = {
  scope: ImplementedScope
  pushed: boolean
  report: ApplyReport
}

export type SyncResult = {
  at: number
  scopes: ScopeResult[]
}

const MAX_ATTEMPTS = 3

export const ADAPTERS: { [S in ImplementedScope]: ScopeAdapter<unknown> } = {
  settings: settingsScope as ScopeAdapter<unknown>,
  projects: projectsScope as ScopeAdapter<unknown>,
  tooling: toolingScope as ScopeAdapter<unknown>,
}

export function emptyState(): SyncState {
  return { version: 1, lastSyncAt: null, scopes: {}, aliases: { projects: {} }, forgetMachines: [] }
}

export function parseState(raw: unknown): SyncState {
  if (!isRecord(raw) || raw.version !== 1) return emptyState()
  const scopes: SyncState['scopes'] = {}
  if (isRecord(raw.scopes)) {
    for (const scope of Object.keys(ADAPTERS) as ImplementedScope[]) {
      const entry = raw.scopes[scope]
      if (isRecord(entry) && typeof entry.version === 'number') {
        scopes[scope] = { version: entry.version, base: entry.base }
      }
    }
  }
  const aliases =
    isRecord(raw.aliases) && isRecord(raw.aliases.projects)
      ? Object.fromEntries(
          Object.entries(raw.aliases.projects).filter(
            (pair): pair is [string, string] => typeof pair[1] === 'string',
          ),
        )
      : {}
  const forgetMachines = Array.isArray(raw.forgetMachines)
    ? raw.forgetMachines.filter((id): id is string => typeof id === 'string')
    : []
  return {
    version: 1,
    lastSyncAt: typeof raw.lastSyncAt === 'number' ? raw.lastSyncAt : null,
    scopes,
    aliases: { projects: aliases },
    forgetMachines,
  }
}

function parseRemote<T>(adapter: ScopeAdapter<T>, payload: unknown): T {
  const parsed = adapter.parse(payload)
  if (!parsed) throw new SyncFailure('malformed_payload')
  return parsed
}

const mergeReports = (a: ApplyReport, b: ApplyReport): ApplyReport => {
  const out: ApplyReport = { changed: a.changed || b.changed }
  for (const key of [
    'preferences',
    'plugins',
    'created',
    'updated',
    'relocations',
    'tooling',
  ] as const) {
    const sum = (a[key] ?? 0) + (b[key] ?? 0)
    if (sum) out[key] = sum
  }
  if (b.available) out.available = b.available
  return out
}

async function syncScope<T>(
  adapter: ScopeAdapter<T>,
  ctx: ScopeContext,
  transport: SyncTransport,
  remoteVersion: number,
): Promise<ScopeResult> {
  const entry = ctx.state.scopes[adapter.scope]
  let base = entry ? adapter.parse(entry.base) : null
  let remote: T
  let version: number

  if (entry && base && entry.version === remoteVersion) {
    remote = base
    version = entry.version
  } else {
    const doc = remoteVersion > 0 ? await transport.get(adapter.scope) : null
    if (doc) {
      remote = parseRemote(adapter, doc.payload)
      version = doc.version
    } else {
      remote = adapter.empty()
      version = 0
      base = null
    }
  }

  let report: ApplyReport = { changed: false }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const local = await adapter.collect(ctx, base, remote)
    const merged = adapter.merge(base, local, remote, ctx)
    report = mergeReports(report, await adapter.apply(ctx, merged, local, base))

    if (version > 0 && sameValue(merged, remote)) {
      ctx.state.scopes[adapter.scope] = { version, base: merged }
      adapter.committed?.(ctx)
      return { scope: adapter.scope, pushed: false, report }
    }

    const outcome = await transport.put(adapter.scope, merged, version)
    if (outcome.kind === 'ok') {
      ctx.state.scopes[adapter.scope] = { version: outcome.version, base: merged }
      adapter.committed?.(ctx)
      return { scope: adapter.scope, pushed: true, report }
    }

    if (outcome.remote.version > 0 && outcome.remote.payload !== null) {
      base = remote
      remote = parseRemote(adapter, outcome.remote.payload)
      version = outcome.remote.version
    } else {
      base = null
      remote = adapter.empty()
      version = 0
    }
  }
  throw new SyncFailure('conflict_retry_exhausted')
}

export async function runSync(options: {
  transport: SyncTransport
  host: SyncHost
  scopes: readonly ImplementedScope[]
  now?: () => number
}): Promise<SyncResult> {
  const { transport, host, scopes } = options
  const now = options.now ?? Date.now
  const state = parseState(await transport.readState())
  const ctx: ScopeContext = {
    host,
    state,
    home: await host.homeDir(),
    machine: await host.machine(),
  }
  const manifest = await transport.manifest()
  const results: ScopeResult[] = []
  for (const scope of scopes) {
    const remoteVersion = manifest.scopes[scope]?.version ?? 0
    results.push(await syncScope(ADAPTERS[scope], ctx, transport, remoteVersion))
    await transport.writeState(state)
  }
  state.lastSyncAt = now()
  await transport.writeState(state)
  return { at: state.lastSyncAt, scopes: results }
}

export type RemoteChanges = {
  scopes: ImplementedScope[]
  devices: string[]
}

export async function detectRemoteChanges(
  transport: Pick<SyncTransport, 'manifest' | 'readState'>,
  scopes: readonly ImplementedScope[],
  ownDeviceId: string | null,
): Promise<RemoteChanges> {
  const [manifest, rawState] = await Promise.all([transport.manifest(), transport.readState()])
  const state = parseState(rawState)
  const changed: ImplementedScope[] = []
  const devices = new Set<string>()
  for (const scope of scopes) {
    const remote = manifest.scopes[scope]
    if (!remote || remote.version === (state.scopes[scope]?.version ?? 0)) continue
    if (remote.updatedBy?.id && remote.updatedBy.id === ownDeviceId) continue
    changed.push(scope)
    if (remote.updatedBy?.name) devices.add(remote.updatedBy.name)
  }
  return { scopes: changed, devices: [...devices] }
}
