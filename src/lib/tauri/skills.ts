import { invoke } from '@tauri-apps/api/core'

export type SkillSummary = {
  name: string
  agent: string
  path: string
  resolvedPath: string
  description: string
  linked: boolean
  shared: boolean
  bundled: boolean
  fromAlethe: boolean
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

export type BundledSkillState = 'available' | 'installed' | 'update' | 'conflict'

export type BundledSkillAgent = {
  agent: string
  state: BundledSkillState
  path: string | null
  /** Why installing or removing failed for this agent; the other agents still ran. */
  error: string | null
}

/** An official skill: it ships inside the app and installs globally or into one project. */
export type BundledSkill = {
  name: string
  description: string
  version: number
  repository: string
  body: string
  agents: BundledSkillAgent[]
}

export async function skillsScan(): Promise<SkillAgentSnapshot[]> {
  return invoke<SkillAgentSnapshot[]>('skills_scan')
}

export async function skillsDetail(agent: string, name: string): Promise<SkillDetail> {
  return invoke<SkillDetail>('skills_detail', { agent, name })
}

export async function skillsUninstall(agent: string, name: string): Promise<SkillRemoveReport> {
  return invoke<SkillRemoveReport>('skills_uninstall', { agent, name })
}

/** Without `projectPath` the states are for the user's global skill folders. */
export async function skillsCatalog(projectPath?: string): Promise<BundledSkill[]> {
  return invoke<BundledSkill[]>('skills_catalog', { projectPath: projectPath ?? null })
}

export async function skillsInstallBundled(
  name: string,
  agents: string[],
  projectPath?: string,
): Promise<BundledSkillAgent[]> {
  return invoke<BundledSkillAgent[]>('skills_install_bundled', {
    name,
    agents,
    projectPath: projectPath ?? null,
  })
}

/** Removes only what Alethe installed; files the user added stay. */
export async function skillsRemoveBundled(
  name: string,
  agents: string[],
  projectPath?: string,
): Promise<BundledSkillAgent[]> {
  return invoke<BundledSkillAgent[]>('skills_remove_bundled', {
    name,
    agents,
    projectPath: projectPath ?? null,
  })
}
