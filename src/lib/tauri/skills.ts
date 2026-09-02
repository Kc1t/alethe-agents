import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv, webApiFetch } from '../api/transport'

export type SkillSummary = {
  name: string
  agent: string
  path: string
  resolvedPath: string
  description: string
  linked: boolean
  shared: boolean
  bundled: boolean
  entryCount: number
}

export type SkillAgentSnapshot = {
  agent: string
  root: string | null
  exists: boolean
  skills: SkillSummary[]
}

export type SkillNode = {
  name: string
  path: string
  isDir: boolean
  size: number
  children: SkillNode[]
  truncated: boolean
}

export type SkillLockInfo = {
  source: string | null
  sourceUrl: string | null
  installedAt: string | null
  updatedAt: string | null
}

export type SkillDetail = {
  summary: SkillSummary
  frontmatter: Record<string, string>
  frontmatterRaw: string
  body: string
  tree: SkillNode[]
  lock: SkillLockInfo | null
}

export type SkillRemoveReport = {
  path: string
  removedLinkOnly: boolean
  sharedCopyPath: string | null
}

/** Result of copying one skill into one target agent.
 *
 *  Per target, never all-or-nothing: an agent that cannot take the skill is reported with its
 *  reason while the others still receive it — the same contract `mcpSync` returns. */
export type SkillSyncOutcome = {
  agent: string
  status: 'ok' | 'skipped' | 'blocked' | 'failed'
  /** Set for `blocked` and `failed`: what stopped this target specifically. */
  reason: string | null
  path: string | null
}

export async function skillsScan(): Promise<SkillAgentSnapshot[]> {
  if (isTauriEnv()) return invoke<SkillAgentSnapshot[]>('skills_scan')
  return webApiFetch<SkillAgentSnapshot[]>('/api/skills/scan')
}

export async function skillsDetail(agent: string, name: string): Promise<SkillDetail> {
  if (isTauriEnv()) return invoke<SkillDetail>('skills_detail', { agent, name })
  return webApiFetch<SkillDetail>(
    `/api/skills/detail?agent=${encodeURIComponent(agent)}&name=${encodeURIComponent(name)}`,
  )
}

export async function skillsUninstall(agent: string, name: string): Promise<SkillRemoveReport> {
  if (isTauriEnv()) return invoke<SkillRemoveReport>('skills_uninstall', { agent, name })
  return webApiFetch<SkillRemoveReport>('/api/skills/uninstall', {
    method: 'POST',
    body: JSON.stringify({ agent, name }),
  })
}

/** Copies a skill into other agents' stores, which is all it takes for them to have it — a skill
 *  is installed by being in the store, with no registration step. `overwrite` replaces what is
 *  there; without it an existing skill of the same name comes back as `skipped` rather than being
 *  silently replaced. */
export async function skillsSync(
  from: string,
  to: string[],
  name: string,
  overwrite = false,
): Promise<SkillSyncOutcome[]> {
  if (isTauriEnv())
    return invoke<SkillSyncOutcome[]>('skills_sync', { from, to, name, overwrite })
  return webApiFetch<SkillSyncOutcome[]>('/api/skills/sync', {
    method: 'POST',
    body: JSON.stringify({ from, to, name, overwrite }),
  })
}
