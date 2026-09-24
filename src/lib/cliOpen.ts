import { basename, sameCwd } from './paths'
import type { Project } from './types'

export type CliOpenPlan =
  { kind: 'existing'; projectId: string } | { kind: 'create'; name: string; cwd: string }

export function planCliOpen(path: string, projects: Project[]): CliOpenPlan | null {
  const cwd = path.trim()
  if (!cwd) return null

  const existing = projects.find(
    (project) => project.defaultCwd && sameCwd(project.defaultCwd, cwd),
  )
  if (existing) return { kind: 'existing', projectId: existing.id }

  return { kind: 'create', name: basename(cwd) || cwd, cwd }
}
