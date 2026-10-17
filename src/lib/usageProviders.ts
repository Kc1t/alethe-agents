import type { BuiltinAgentType, Preferences, UsageProviderId } from './types'

/**
 * Usage/subscription providers surfaced in the AI usage details modal, the home usage
 * strip, and the topbar pills. Editors render from this list (AiUsageModal customize
 * panel, TopbarSettingsModal, the usage reading switches) and UsageStrip filters its cards by it, so a future
 * provider only needs an entry here plus its card.
 */
export interface UsageProviderDef {
  id: UsageProviderId
  agentType: BuiltinAgentType
  /** Company whose service a usage read contacts; a proper name, never translated. */
  vendor: string
  /** Preferences key controlling the usage panel card (modal + home strip). */
  usagePrefKey: keyof Pick<
    Preferences,
    'usageShowClaude' | 'usageShowCodex' | 'usageShowAntigravity' | 'usageShowKimi'
  >
  /** Preferences key controlling the topbar pill. */
  topbarPrefKey: keyof Pick<
    Preferences,
    | 'topbarShowClaudeUsage'
    | 'topbarShowCodexUsage'
    | 'topbarShowAntigravityUsage'
    | 'topbarShowKimiUsage'
  >
}

export const USAGE_PROVIDERS: UsageProviderDef[] = [
  {
    id: 'claude',
    agentType: 'claude',
    vendor: 'Anthropic',
    usagePrefKey: 'usageShowClaude',
    topbarPrefKey: 'topbarShowClaudeUsage',
  },
  {
    id: 'codex',
    agentType: 'codex',
    vendor: 'OpenAI',
    usagePrefKey: 'usageShowCodex',
    topbarPrefKey: 'topbarShowCodexUsage',
  },
  {
    id: 'antigravity',
    agentType: 'antigravity',
    vendor: 'Google',
    usagePrefKey: 'usageShowAntigravity',
    topbarPrefKey: 'topbarShowAntigravityUsage',
  },
  {
    id: 'kimi',
    agentType: 'kimi',
    vendor: 'Moonshot AI',
    usagePrefKey: 'usageShowKimi',
    topbarPrefKey: 'topbarShowKimiUsage',
  },
]
