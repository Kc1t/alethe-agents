import type { MachineInfo, ProjectMergePlan } from '../projectSync'
import type { Preferences, Project } from '../types'
import type { ImplementedScope } from './contract'

export type SyncHost = {
  preferences(): Preferences
  setPreferences(patch: Partial<Preferences>): void
  projects(): Project[]
  applyProjectMergePlan(plan: ProjectMergePlan): void
  setProjectGithubUrl(id: string, url: string): void
  plugins(): Promise<{ id: string; enabled: boolean }[]>
  setPluginEnabled(id: string, enabled: boolean): Promise<void>
  homeDir(): Promise<string | null>
  machine(): Promise<MachineInfo>
  existingDirectories(paths: string[]): Promise<Set<string>>
  gitRemote(path: string): Promise<string | null>
}

export type ApplyReport = {
  changed: boolean
  preferences?: number
  plugins?: number
  created?: number
  updated?: number
  relocations?: number
  available?: number
  tooling?: number
}

export type SyncState = {
  version: 1
  lastSyncAt: number | null
  scopes: Partial<Record<ImplementedScope, { version: number; base: unknown }>>
  aliases: { projects: Record<string, string> }
  forgetMachines: string[]
}

export type ScopeContext = {
  host: SyncHost
  state: SyncState
  home: string | null
  machine: MachineInfo
  materialize?: boolean
}

export type ScopeAdapter<T> = {
  scope: ImplementedScope
  empty(): T
  parse(raw: unknown): T | null
  collect(ctx: ScopeContext, base: T | null, remote: T): Promise<T>
  merge(base: T | null, local: T, remote: T, ctx: ScopeContext): T
  apply(ctx: ScopeContext, merged: T, local: T, base: T | null): Promise<ApplyReport>
  committed?(ctx: ScopeContext): void
}

export class SyncFailure extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export function checkFormat(format: unknown, current: number): boolean {
  if (typeof format !== 'number') return false
  if (format > current) throw new SyncFailure('client_outdated')
  return true
}
