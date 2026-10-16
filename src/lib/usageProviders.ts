import {
  AGENT_TYPE_LABELS,
  type BuiltinAgentType,
  type Preferences,
  type UsageProviderId,
} from './types'

/**
 * Usage/subscription providers surfaced in the AI usage details modal, the home usage
 * strip, and the topbar pills. Editors render from this list (AiUsageModal customize
 * panel, TopbarSettingsModal, the usage reading switches) and UsageStrip filters its cards by it, so a future
 * provider only needs an entry here plus its card.
 */
export interface UsageProviderDef {
  id: UsageProviderId
  /** The agent this provider meters; absent for a service that is not an agent (OpenRouter). */
  agentType?: BuiltinAgentType
  /** Display name; a proper name, never translated. */
  label: string
  /** What a usage read uses: an installed CLI's sign-in, or keys saved in the keychain. */
  credential: 'signin' | 'key'
  /** Company whose service a usage read contacts; a proper name, never translated. */
  vendor: string
  /** Preferences key controlling the usage panel card (modal + home strip). */
  usagePrefKey: keyof Pick<
    Preferences,
    | 'usageShowClaude'
    | 'usageShowCodex'
    | 'usageShowAntigravity'
    | 'usageShowKimi'
    | 'usageShowOpenRouter'
  >
  /** Preferences key controlling the topbar pill. */
  topbarPrefKey: keyof Pick<
    Preferences,
    | 'topbarShowClaudeUsage'
    | 'topbarShowCodexUsage'
    | 'topbarShowAntigravityUsage'
    | 'topbarShowKimiUsage'
    | 'topbarShowOpenRouterUsage'
  >
}

export const USAGE_PROVIDERS: UsageProviderDef[] = [
  {
    id: 'claude',
    agentType: 'claude',
    label: AGENT_TYPE_LABELS.claude,
    credential: 'signin',
    vendor: 'Anthropic',
    usagePrefKey: 'usageShowClaude',
    topbarPrefKey: 'topbarShowClaudeUsage',
  },
  {
    id: 'codex',
    agentType: 'codex',
    label: AGENT_TYPE_LABELS.codex,
    credential: 'signin',
    vendor: 'OpenAI',
    usagePrefKey: 'usageShowCodex',
    topbarPrefKey: 'topbarShowCodexUsage',
  },
  {
    id: 'antigravity',
    agentType: 'antigravity',
    label: AGENT_TYPE_LABELS.antigravity,
    credential: 'signin',
    vendor: 'Google',
    usagePrefKey: 'usageShowAntigravity',
    topbarPrefKey: 'topbarShowAntigravityUsage',
  },
  {
    id: 'kimi',
    agentType: 'kimi',
    label: AGENT_TYPE_LABELS.kimi,
    credential: 'signin',
    vendor: 'Moonshot AI',
    usagePrefKey: 'usageShowKimi',
    topbarPrefKey: 'topbarShowKimiUsage',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    credential: 'key',
    vendor: 'OpenRouter',
    usagePrefKey: 'usageShowOpenRouter',
    topbarPrefKey: 'topbarShowOpenRouterUsage',
  },
]
