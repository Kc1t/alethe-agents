import {
  Boxes,
  Check,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  ListTodo,
  type LucideIcon,
  Play,
  Plug,
  Puzzle,
  Search,
  Settings,
  Sparkles,
  Terminal,
} from 'lucide-react'

/**
 * Icons a manifest may name. Curated on purpose: a manifest names an icon, it
 * never supplies a component.
 */
const PLUGIN_ICONS: Record<string, LucideIcon> = {
  boxes: Boxes,
  check: Check,
  'file-text': FileText,
  'git-branch': GitBranch,
  'git-commit': GitCommitHorizontal,
  'list-todo': ListTodo,
  play: Play,
  plug: Plug,
  puzzle: Puzzle,
  search: Search,
  settings: Settings,
  sparkles: Sparkles,
  terminal: Terminal,
}

export function pluginIcon(name?: string | null): LucideIcon {
  return (name && PLUGIN_ICONS[name]) || Puzzle
}

export function isKnownPluginIcon(name: string): boolean {
  return name in PLUGIN_ICONS
}
