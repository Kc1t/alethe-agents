import type { ComponentType } from 'react'

import { splitCustomCliCommand } from './customAgents'
import { ContributionList, useContributions } from './plugins/registry'
import {
  AGENT_TYPE_LABELS,
  agentCliCommand,
  type AgentType,
  ALL_AGENT_TYPES,
  type BuiltinAgentType,
  type CustomAgentDefinition,
  UNRESTRICTED_FLAG,
} from './types'

export type AgentProviderContribution = {
  /** The agent type id, e.g. `cursor`. */
  id: string
  /** Display name. Provider names are not translated. */
  label: string
  /** Binary the launcher runs. Absent means the provider opens a plain shell. */
  cliCommand?: string
  /** Flag that skips permission prompts, or null when the CLI has none. */
  unrestrictedFlag?: string | null
  /** An `--agent-*` CSS custom property, including the leading dashes. */
  accentToken?: string
  icon?: ComponentType<{ size?: number | string }>
}

export const agentProviderContributions = new ContributionList<AgentProviderContribution>()

const DEFAULT_ACCENT_TOKEN = '--agent-shell'

const BUILTIN_IDS = new Set<string>(ALL_AGENT_TYPES)

export function isBuiltinAgentType(id: AgentType): id is BuiltinAgentType {
  return BUILTIN_IDS.has(id)
}

/** True when the id is a built-in or a currently registered provider. */
export function isKnownAgentType(id: AgentType): boolean {
  return isBuiltinAgentType(id) || agentProviderContributions.has(id)
}

export function findAgentProvider(id: AgentType): AgentProviderContribution | undefined {
  return agentProviderContributions.get(id)
}

/** Built-ins first, then contributed providers in registration order. */
export function allAgentTypes(): AgentType[] {
  return [...ALL_AGENT_TYPES, ...agentProviderContributions.all().map((provider) => provider.id)]
}

/** Reactive `allAgentTypes()` — re-renders when a plugin adds or removes a provider. */
export function useAgentTypes(): AgentType[] {
  const contributed = useContributions(agentProviderContributions)
  return [...ALL_AGENT_TYPES, ...contributed.map((provider) => provider.id)]
}

export function agentLabel(id: AgentType): string {
  if (isBuiltinAgentType(id)) return AGENT_TYPE_LABELS[id]
  return findAgentProvider(id)?.label ?? id
}

export function resolveAgentCliCommand(id: AgentType): string | undefined {
  if (isBuiltinAgentType(id)) return agentCliCommand(id)
  return findAgentProvider(id)?.cliCommand
}

export function resolveUnrestrictedFlag(id: AgentType): string | null {
  if (isBuiltinAgentType(id)) return UNRESTRICTED_FLAG[id]
  return findAgentProvider(id)?.unrestrictedFlag ?? null
}

/** Backends report the agent as a free-form string; anything unknown stays unidentified. */
export function parseAgentType(value: string | null | undefined): AgentType | null {
  const raw = (value ?? '').trim()
  if (!raw) return null
  if (isKnownAgentType(raw)) return raw
  const key = raw.toLowerCase()
  return isKnownAgentType(key) ? key : null
}

export function agentAccentToken(id: AgentType): string {
  if (isBuiltinAgentType(id)) return `--agent-${id}`
  const token = findAgentProvider(id)?.accentToken
  return token?.startsWith('--') ? token : DEFAULT_ACCENT_TOKEN
}

/** A `var()` that survives a token no theme defines, such as an unknown provider. */
export function agentAccentVar(id: AgentType): string {
  return `var(${agentAccentToken(id)}, var(${DEFAULT_ACCENT_TOKEN}))`
}

/** Contributed providers are on unless the user turned them off. */
export function isAgentEnabled(
  enabled: Partial<Record<AgentType, boolean>>,
  id: AgentType,
): boolean {
  return enabled[id] ?? !isBuiltinAgentType(id)
}

const CUSTOM_OWNER = 'custom-agents'

type CustomRegistryState = {
  dispose: () => void
  args: string[]
}

const customRegistry = new Map<string, CustomRegistryState>()

function customContributionFor(
  definition: CustomAgentDefinition,
  icon?: ComponentType<{ size?: number | string }>,
): AgentProviderContribution {
  const split = splitCustomCliCommand(definition.cliCommand)
  return {
    id: definition.id,
    label: definition.label,
    cliCommand: split?.binary,
    unrestrictedFlag: definition.unrestrictedFlag ?? null,
    accentToken: definition.accentToken,
    icon,
  }
}

export function syncCustomAgentProviders(
  definitions: readonly CustomAgentDefinition[],
  resolveIcon?: (
    definition: CustomAgentDefinition,
  ) => ComponentType<{ size?: number | string }> | undefined,
): void {
  const wanted = new Map<string, CustomAgentDefinition>()
  for (const definition of definitions) {
    if (isBuiltinAgentType(definition.id)) continue
    if (wanted.has(definition.id)) continue
    wanted.set(definition.id, definition)
  }
  for (const [id, state] of [...customRegistry]) {
    if (!wanted.has(id)) {
      state.dispose()
      customRegistry.delete(id)
    }
  }
  for (const definition of wanted.values()) {
    const split = splitCustomCliCommand(definition.cliCommand)
    if (!split) continue
    const contribution = customContributionFor(definition, resolveIcon?.(definition))
    const existing = customRegistry.get(definition.id)
    if (existing) {
      existing.args = split.args
      agentProviderContributions.update(CUSTOM_OWNER, definition.id, contribution)
      continue
    }
    if (agentProviderContributions.has(definition.id)) continue
    try {
      const handle = agentProviderContributions.add(CUSTOM_OWNER, contribution)
      customRegistry.set(definition.id, { dispose: () => handle.dispose(), args: split.args })
    } catch {
      continue
    }
  }
}

export function resolveCustomAgentArgs(id: AgentType): string[] {
  return customRegistry.get(id)?.args ?? []
}
