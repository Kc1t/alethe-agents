import { AGENT_INSTALL_CATALOG } from './agentInstall'
import type { AgentType } from './types'

const NPM_INSTALL_PATTERN = /npm install -g (\S+)/
const REGISTRY_TIMEOUT_MS = 4_000

/** npm package that ships this agent, when one of its documented installers uses npm. */
export function npmPackageFor(agent: AgentType): string | undefined {
  const method = AGENT_INSTALL_CATALOG[agent]?.methods.find((entry) => entry.id === 'npm')
  if (!method) return undefined
  return NPM_INSTALL_PATTERN.exec(method.command)?.[1]
}

function numericParts(version: string): number[] {
  return version
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0))
}

/** True when `latest` is a higher release than `installed`. Prerelease suffixes are ignored. */
export function isOutdated(installed: string, latest: string): boolean {
  const current = numericParts(installed)
  const next = numericParts(latest)
  const length = Math.max(current.length, next.length)
  for (let index = 0; index < length; index += 1) {
    const a = current[index] ?? 0
    const b = next[index] ?? 0
    if (a !== b) return b > a
  }
  return false
}

/**
 * Latest published version of an npm package. Returns null on any failure — an update hint is
 * never worth blocking or failing the screen that shows it.
 */
export async function latestNpmVersion(packageName: string): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      headers: { Accept: 'application/vnd.npm.install-v1+json, application/json' },
    })
    if (!response.ok) return null
    const payload = (await response.json()) as { version?: unknown }
    return typeof payload.version === 'string' ? payload.version : null
  } catch {
    return null
  }
}
