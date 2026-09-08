import { basename, sameCwd } from './paths'
import { getProjectRepoRoot } from './terminalFactory'
import type { Project } from './types'

export type CliOpenPlan =
  { kind: 'existing'; projectId: string } | { kind: 'create'; name: string; cwd: string }

export function planCliOpen(path: string, projects: Project[]): CliOpenPlan | null {
  const cwd = path.trim()
  if (!cwd) return null

  // Self-heals a `defaultCwd` left pointing at a dead merge/worktree env folder — matching
  // against the raw, possibly-poisoned value would fail to recognize an already-open project
  // and spawn a duplicate one instead.
  const existing = projects.find((project) => {
    const root = getProjectRepoRoot(project) || project.defaultCwd
    return root && sameCwd(root, cwd)
  })
  if (existing) return { kind: 'existing', projectId: existing.id }

  return { kind: 'create', name: basename(cwd) || cwd, cwd }
}
