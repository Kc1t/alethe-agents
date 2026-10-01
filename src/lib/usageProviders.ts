import type { BuiltinAgentType, Preferences } from './types'

/**
 * Usage/subscription providers surfaced in the AI usage details modal, the home usage
 * strip, and the topbar pills. Editors render from this list (AiUsageModal customize
 * panel, TopbarSettingsModal) and UsageStrip filters its cards by it, so a future
 * provider only needs an entry here plus its card.
 */
export interface UsageProviderDef {
  id: 'claude' | 'codex' | 'antigravity'
  agentType: BuiltinAgentType
  /** Preferences key controlling the usage panel card (modal + home strip). */
  usagePrefKey: keyof Pick<
    Preferences,
    'usageShowClaude' | 'usageShowCodex' | 'usageShowAntigravity'
  >
  /** Preferences key controlling the topbar pill. */
  topbarPrefKey: keyof Pick<
    Preferences,
    'topbarShowClaudeUsage' | 'topbarShowCodexUsage' | 'topbarShowAntigravityUsage'
  >
}

export const USAGE_PROVIDERS: UsageProviderDef[] = [
  {
    id: 'claude',
    agentType: 'claude',
    usagePrefKey: 'usageShowClaude',
    topbarPrefKey: 'topbarShowClaudeUsage',
  },
  {
    id: 'codex',
    agentType: 'codex',
    usagePrefKey: 'usageShowCodex',
    topbarPrefKey: 'topbarShowCodexUsage',
  },
  {
    id: 'antigravity',
    agentType: 'antigravity',
    usagePrefKey: 'usageShowAntigravity',
    topbarPrefKey: 'topbarShowAntigravityUsage',
  },
]
