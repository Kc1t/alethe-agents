import type { LucideIcon } from 'lucide-react'
import {
  AppWindow,
  BrainCircuit,
  GitPullRequest,
  Network,
  Plug,
  SquareMousePointer,
} from 'lucide-react'

import type { FeatureId } from '../../lib/types'

/** One glyph per concept, shared by the onboarding step and the Preferences page. */
export const FEATURE_ICONS: Record<FeatureId, LucideIcon> = {
  browser: AppWindow,
  mcp: Plug,
  playwright: SquareMousePointer,
  orchestrator: Network,
  aiMemory: BrainCircuit,
  prs: GitPullRequest,
}
