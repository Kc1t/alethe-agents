import type { MessageKey } from './i18n'
import type { FeatureId } from './types'

export type FeatureDefinition = {
  id: FeatureId
  titleKey: MessageKey
  descriptionKey: MessageKey
  /** Synonyms the onboarding search matches on, beyond the title and description. */
  keywordsKey: MessageKey
  /** Modules kept behind "show others" until the user goes looking for them. */
  secondary?: true
}

export const FEATURES: readonly FeatureDefinition[] = [
  {
    id: 'browser',
    titleKey: 'features.browser.title',
    descriptionKey: 'features.browser.description',
    keywordsKey: 'features.browser.keywords',
  },
  {
    id: 'graphify',
    titleKey: 'features.graphify.title',
    descriptionKey: 'features.graphify.description',
    keywordsKey: 'features.graphify.keywords',
    secondary: true,
  },
  {
    id: 'mcp',
    titleKey: 'features.mcp.title',
    descriptionKey: 'features.mcp.description',
    keywordsKey: 'features.mcp.keywords',
  },
  {
    id: 'playwright',
    titleKey: 'features.playwright.title',
    descriptionKey: 'features.playwright.description',
    keywordsKey: 'features.playwright.keywords',
  },
  {
    id: 'orchestrator',
    titleKey: 'features.orchestrator.title',
    descriptionKey: 'features.orchestrator.description',
    keywordsKey: 'features.orchestrator.keywords',
  },
  {
    id: 'gsdSync',
    titleKey: 'features.gsdSync.title',
    descriptionKey: 'features.gsdSync.description',
    keywordsKey: 'features.gsdSync.keywords',
    secondary: true,
  },
  {
    id: 'aiMemory',
    titleKey: 'features.aiMemory.title',
    descriptionKey: 'features.aiMemory.description',
    keywordsKey: 'features.aiMemory.keywords',
    secondary: true,
  },
  {
    id: 'prs',
    titleKey: 'features.prs.title',
    descriptionKey: 'features.prs.description',
    keywordsKey: 'features.prs.keywords',
  },
]

type StoredFeaturePreferences = {
  enabledFeatures?: Partial<Record<FeatureId, boolean>> & LegacyFeatureFlags
  showGitControl?: boolean
}

/** Feature ids that became plugins. Read only by the one-time migration. */
export type LegacyFeatureFlags = { git?: boolean; todos?: boolean }

/**
 * Git Control is a plugin now. Returns the legacy flag once, so the caller can
 * carry the user's old choice over to the plugin's enabled state.
 */
export function legacyGitFeatureFlag(
  raw: StoredFeaturePreferences | undefined,
): boolean | undefined {
  return raw?.enabledFeatures?.git ?? raw?.showGitControl
}

/**
 * Todo List is a plugin now. Before it was one, an existing profile with no
 * `enabledFeatures` had Todo off — only a fresh profile got it. Returning
 * undefined leaves the plugin at its default, so that case must say `false`
 * explicitly or the tab would appear for people who never had it.
 */
export function legacyTodosFeatureFlag(
  raw: StoredFeaturePreferences | undefined,
): boolean | undefined {
  if (raw === undefined) return undefined
  if (raw.enabledFeatures) return raw.enabledFeatures.todos ?? true
  return false
}

export function normalizeEnabledFeatures(
  raw: StoredFeaturePreferences | undefined,
): Record<FeatureId, boolean> {
  if (raw?.enabledFeatures) {
    return {
      browser: raw.enabledFeatures.browser ?? true,
      graphify: raw.enabledFeatures.graphify ?? true,
      mcp: raw.enabledFeatures.mcp ?? true,

      aiMemory: raw.enabledFeatures.aiMemory ?? false,
      // Opt-in: it launches a real browser process, so it must never start on its own.
      playwright: raw.enabledFeatures.playwright ?? false,
      // Opt-in: it lets the lead agent spawn worker agents that write to disk.
      orchestrator: raw.enabledFeatures.orchestrator ?? false,
      // Opt-in: OpenCode-only, and it polls the worktrees of every watched project.
      gsdSync: raw.enabledFeatures.gsdSync ?? false,
      prs: raw.enabledFeatures.prs ?? true,
    }
  }
  return {
    browser: true,
    graphify: true,
    aiMemory: false,
    mcp: true,
    playwright: false,
    orchestrator: false,
    gsdSync: false,
    prs: true,
  }
}
