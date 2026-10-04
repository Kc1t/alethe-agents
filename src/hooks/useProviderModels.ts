import { useEffect, useMemo, useState } from 'react'

import { type DiscoveredModel, discoverProviderModels } from '../lib/tauri'
import { type AgentType, type BuiltinAgentType, PROVIDER_MODELS } from '../lib/types'

export type ProviderModelOption = DiscoveredModel

// Module-level so it survives tab switches and remounts: asking a CLI for its models spawns it.
const modelsCache: Record<string, ProviderModelOption[]> = {}
// One lookup per provider at a time: a settings page shows the same provider in several rows.
const inFlight = new Map<string, Promise<ProviderModelOption[]>>()

function discover(provider: AgentType): Promise<ProviderModelOption[]> {
  let pending = inFlight.get(provider)
  if (!pending) {
    pending = discoverProviderModels(provider).finally(() => inFlight.delete(provider))
    inFlight.set(provider, pending)
  }
  return pending
}

/**
 * Claude Code reports a `default` entry that stands for "whatever the CLI picks". It is how the
 * effort choices follow the default model, but it is not a model to choose: leaving the field
 * empty already means that.
 */
function isDefaultSentinel(model: ProviderModelOption): boolean {
  return model.id === 'default'
}

/**
 * The models a provider's CLI reports, falling back to the built-in list when it reports none.
 * `all` keeps everything the CLI said, including what its default model is, for effort lookups;
 * `models` is what a person can pick.
 */
export function useProviderModels(provider: AgentType): {
  models: ProviderModelOption[]
  all: ProviderModelOption[]
  loading: boolean
} {
  const [all, setAll] = useState<ProviderModelOption[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let active = true
    const fallback = PROVIDER_MODELS[provider as BuiltinAgentType] ?? []
    const cached = modelsCache[provider]
    setAll(cached || fallback)

    // With the cache already filled this is a silent revalidation, so there is no loading state
    // to flash: the picker only shows one when it has nothing to list yet.
    if (!cached) setLoading(true)
    discover(provider)
      .then((list) => {
        if (!active) return
        const resolved = list && list.length > 0 ? list : fallback
        modelsCache[provider] = resolved
        setAll(resolved)
      })
      .catch(() => {
        if (!active) return
        modelsCache[provider] = fallback
        setAll(fallback)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [provider])

  const models = useMemo(() => all.filter((model) => !isDefaultSentinel(model)), [all])
  return { models, all, loading }
}
