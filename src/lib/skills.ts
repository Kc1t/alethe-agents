import type {
  BundledSkill,
  BundledSkillAgent,
  SkillAgentSnapshot,
  SkillSummary,
} from './tauri/skills'

export const SHARED_SKILL_AGENT = 'shared'

export type SkillGroup = {
  name: string
  description: string
  entries: SkillSummary[]
  agents: string[]
  /** Entries a bulk remove may touch: never the shared copy other agents link to. */
  removable: SkillSummary[]
  sharedEntry: SkillSummary | null
  bundled: boolean
  /** Installed by Alethe from its own catalog; still removable, unlike `bundled`. */
  fromAlethe: boolean
}

export function groupSkillsByName(snapshots: SkillAgentSnapshot[]): SkillGroup[] {
  const byName = new Map<string, SkillSummary[]>()
  for (const snapshot of snapshots) {
    for (const skill of snapshot.skills) {
      const bucket = byName.get(skill.name)
      if (bucket) bucket.push(skill)
      else byName.set(skill.name, [skill])
    }
  }

  return [...byName.entries()]
    .map(([name, entries]) => {
      const agentEntries = entries.filter((entry) => entry.agent !== SHARED_SKILL_AGENT)
      return {
        name,
        description: entries.find((entry) => entry.description)?.description ?? '',
        entries,
        agents: agentEntries.map((entry) => entry.agent),
        removable: agentEntries.filter((entry) => !entry.bundled),
        sharedEntry: entries.find((entry) => entry.agent === SHARED_SKILL_AGENT) ?? null,
        bundled: agentEntries.length > 0 && agentEntries.every((entry) => entry.bundled),
        fromAlethe: entries.some((entry) => entry.fromAlethe),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function countSkills(snapshots: SkillAgentSnapshot[]): number {
  return groupSkillsByName(snapshots).length
}

export function matchesSkillQuery(group: SkillGroup, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (
    group.name.toLowerCase().includes(needle) || group.description.toLowerCase().includes(needle)
  )
}

/** Agents an install would write to: missing copies and outdated ones, never a conflict. */
export function pendingBundledAgents(skill: BundledSkill): string[] {
  return skill.agents
    .filter((entry) => entry.state === 'available' || entry.state === 'update')
    .map((entry) => entry.agent)
}

export function hasBundledUpdate(skill: BundledSkill): boolean {
  return skill.agents.some((entry) => entry.state === 'update')
}

/** Agents holding Alethe's copy, current or outdated, which a remove may delete. */
export function installedBundledAgents(skill: BundledSkill): string[] {
  return skill.agents
    .filter((entry) => entry.state === 'installed' || entry.state === 'update')
    .map((entry) => entry.agent)
}

/** Splits an install or remove report into the agents it reached and the ones that failed. */
export function splitBundledReport(
  report: BundledSkillAgent[],
  reached: (entry: BundledSkillAgent) => boolean,
): { done: BundledSkillAgent[]; failed: BundledSkillAgent[] } {
  return {
    done: report.filter((entry) => !entry.error && reached(entry)),
    failed: report.filter((entry) => Boolean(entry.error)),
  }
}
