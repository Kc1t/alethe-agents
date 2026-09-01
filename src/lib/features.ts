import type { MessageKey } from './i18n'
import type { FeatureId } from './types'

export type FeatureDefinition = {
  id: FeatureId
  titleKey: MessageKey
  descriptionKey: MessageKey
}

export const FEATURES: readonly FeatureDefinition[] = [
  {
    id: 'todos',
    titleKey: 'features.todos.title',
    descriptionKey: 'features.todos.description',
  },
  {
    id: 'git',
    titleKey: 'features.git.title',
    descriptionKey: 'features.git.description',
  },
  {
    id: 'browser',
    titleKey: 'features.browser.title',
    descriptionKey: 'features.browser.description',
  },
  {
    id: 'graphify',
    titleKey: 'features.graphify.title',
    descriptionKey: 'features.graphify.description',
  },
  {
    id: 'mcp',
    titleKey: 'features.mcp.title',
    descriptionKey: 'features.mcp.description',
  },
  {
    id: 'playwright',
    titleKey: 'features.playwright.title',
    descriptionKey: 'features.playwright.description',
  },
  {
    id: 'orchestrator',
    titleKey: 'features.orchestrator.title',
    descriptionKey: 'features.orchestrator.description',
  },
]

type StoredFeaturePreferences = {
  enabledFeatures?: Partial<Record<FeatureId, boolean>>
  showGitControl?: boolean
}

export function normalizeEnabledFeatures(
  raw: StoredFeaturePreferences | undefined,
): Record<FeatureId, boolean> {
  if (raw?.enabledFeatures) {
    return {
      todos: raw.enabledFeatures.todos ?? true,
      git: raw.enabledFeatures.git ?? true,
      browser: raw.enabledFeatures.browser ?? true,
      graphify: raw.enabledFeatures.graphify ?? true,
      mcp: raw.enabledFeatures.mcp ?? true,

      aiMemory: raw.enabledFeatures.aiMemory ?? false,
      // Opt-in: it launches a real browser process, so it must never start on its own.
      playwright: raw.enabledFeatures.playwright ?? false,
      // Opt-in: it lets the lead agent spawn worker agents that write to disk.
      orchestrator: raw.enabledFeatures.orchestrator ?? false,
    }
  }
  return {
    todos: raw === undefined,
    git: raw?.showGitControl ?? true,
    browser: true,
    graphify: true,
    aiMemory: false,
    mcp: true,
    playwright: false,
    orchestrator: false,
  }
}
