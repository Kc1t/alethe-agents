import { Route } from 'lucide-react'

import type { Theme } from '../../lib/types'
import type { UsageProviderDef } from '../../lib/usageProviders'
import { AgentIcon } from './AgentIcons'

/** An agent provider's own icon; OpenRouter, which is no agent, gets the route glyph voice uses. */
export function UsageProviderIcon({
  provider,
  size = 16,
  theme,
}: {
  provider: UsageProviderDef
  size?: number
  theme: Theme
}) {
  if (provider.agentType) return <AgentIcon type={provider.agentType} size={size} theme={theme} />
  return <Route size={size} />
}
