import { bindingPaths, planMaterialize, planProjectUpdates } from '../projectSync'
import { secretFieldsFor } from '../toolingManifest'
import {
  type ImplementedScope,
  isRecord,
  type ProjectsPayload,
  type ScopePayloads,
  type SettingsPayload,
  SYNC_FORMAT,
  type ToolingPayload,
} from './contract'
import { ADAPTERS, emptyState } from './engine'
import {
  type ApplyReport,
  checkFormat,
  type ScopeContext,
  SyncFailure,
  type SyncHost,
} from './host'
import { sameValue } from './merge'

export const BUNDLE_KIND = 'alethe-bundle'
export const BUNDLE_EXTENSION = 'alethe'

export type AletheBundle = {
  kind: typeof BUNDLE_KIND
  format: number
  exportedAt: string
  scopes: Partial<ScopePayloads>
}

const BUNDLE_SCOPES: readonly ImplementedScope[] = ['settings', 'projects', 'tooling']

async function newContext(host: SyncHost, materialize = false): Promise<ScopeContext> {
  return {
    host,
    state: emptyState(),
    home: await host.homeDir(),
    machine: await host.machine(),
    materialize,
  }
}

export async function buildBundle(host: SyncHost, now = Date.now()): Promise<AletheBundle> {
  const ctx = await newContext(host)
  const scopes: Partial<Record<ImplementedScope, unknown>> = {}
  for (const scope of BUNDLE_SCOPES) {
    const adapter = ADAPTERS[scope]
    scopes[scope] = await adapter.collect(ctx, null, adapter.empty())
  }
  return {
    kind: BUNDLE_KIND,
    format: SYNC_FORMAT,
    exportedAt: new Date(now).toISOString(),
    scopes: scopes as Partial<ScopePayloads>,
  }
}

export function parseBundle(raw: unknown): AletheBundle {
  if (!isRecord(raw) || raw.kind !== BUNDLE_KIND || !checkFormat(raw.format, SYNC_FORMAT)) {
    throw new SyncFailure('invalid_bundle')
  }
  const source = isRecord(raw.scopes) ? raw.scopes : {}
  const scopes: Partial<Record<ImplementedScope, unknown>> = {}
  for (const scope of BUNDLE_SCOPES) {
    if (source[scope] === undefined) continue
    const parsed = ADAPTERS[scope].parse(source[scope])
    if (parsed) scopes[scope] = parsed
  }
  return {
    kind: BUNDLE_KIND,
    format: SYNC_FORMAT,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    scopes: scopes as Partial<ScopePayloads>,
  }
}

export type BundlePreview = {
  preferences: number
  plugins: number
  projectsCreated: number
  projectsUpdated: number
  relocations: number
  tooling: number
  secretsNeeded: number
}

export type PreparedImport = {
  preview: BundlePreview
  isEmpty: boolean
  apply(): Promise<ApplyReport>
}

export async function prepareImport(bundle: AletheBundle, host: SyncHost): Promise<PreparedImport> {
  const ctx = await newContext(host, true)
  const steps: { scope: ImplementedScope; merged: unknown; local: unknown }[] = []
  const preview: BundlePreview = {
    preferences: 0,
    plugins: 0,
    projectsCreated: 0,
    projectsUpdated: 0,
    relocations: 0,
    tooling: 0,
    secretsNeeded: 0,
  }

  for (const scope of BUNDLE_SCOPES) {
    const incoming = bundle.scopes[scope]
    if (!incoming) continue
    const adapter = ADAPTERS[scope]
    const local = await adapter.collect(ctx, null, incoming)
    const merged = adapter.merge(null, local, incoming, ctx)
    if (sameValue(merged, local)) continue
    steps.push({ scope, merged, local })

    if (scope === 'settings') {
      const m = merged as SettingsPayload
      const l = local as SettingsPayload
      preview.preferences = Object.keys(m.preferences).filter(
        (key) => !sameValue(m.preferences[key], l.preferences[key]),
      ).length
      preview.plugins = Object.keys(m.plugins).filter(
        (id) => id in l.plugins && l.plugins[id] !== m.plugins[id],
      ).length
    } else if (scope === 'projects') {
      const m = merged as ProjectsPayload
      const l = local as ProjectsPayload
      const machineId = ctx.machine.id
      const unbound = Object.values(m.projects).filter(
        (entry) => !l.projects[entry.id]?.machines[machineId],
      )
      const candidates = unbound.flatMap((entry) => bindingPaths(entry, ctx.home))
      const creates = planMaterialize(unbound, ctx.home, await host.existingDirectories(candidates))
      preview.projectsCreated = creates.length
      preview.projectsUpdated = planProjectUpdates(
        host.projects(),
        l.projects,
        m.projects,
        ctx.state.aliases.projects,
        machineId,
      ).length
      preview.relocations = creates.filter((p) => p.pendingRelocation).length
    } else {
      const m = merged as ToolingPayload
      const l = local as ToolingPayload
      const addedServers = Object.keys(m.mcpServers).filter((key) => !l.mcpServers[key])
      preview.tooling =
        addedServers.length + Object.keys(m.skills).filter((key) => !l.skills[key]).length
      preview.secretsNeeded = addedServers.reduce(
        (sum, key) => sum + secretFieldsFor(m.mcpServers[key]).length,
        0,
      )
    }
  }

  return {
    preview,
    isEmpty: steps.length === 0,
    async apply() {
      let report: ApplyReport = { changed: false }
      for (const step of steps) {
        const result = await ADAPTERS[step.scope].apply(ctx, step.merged, step.local, null)
        report = { ...report, ...result, changed: report.changed || result.changed }
      }
      return report
    },
  }
}
