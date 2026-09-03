import type { LucideIcon } from 'lucide-react'
import {
  AppWindow,
  BrainCircuit,
  ListChecks,
  Network,
  Plug,
  Share2,
  SquareMousePointer,
} from 'lucide-react'

import type { FeatureId } from '../../lib/types'

/** One glyph per concept, shared by the onboarding step and the Preferences page. */
export const FEATURE_ICONS: Record<FeatureId, LucideIcon> = {
  todos: ListChecks,
  browser: AppWindow,
  mcp: Plug,
  playwright: SquareMousePointer,
  orchestrator: Network,
  graphify: Share2,
  aiMemory: BrainCircuit,
}
