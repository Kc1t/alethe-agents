import type { Router9Install, Router9Status } from './tauri/router9'
import {
  type AgentType,
  ROUTER9_DEFAULT_PORT,
  type Router9Preferences,
  type Router9Source,
} from './types'

export const ROUTER9_ADVISORIES_URL = 'https://github.com/decolua/9router/security/advisories'
export const ROUTER9_DOCS_URL = 'https://github.com/decolua/9router'

type Dialect = 'anthropic' | 'openai'

const AGENT_DIALECT: Partial<Record<AgentType, Dialect>> = {
  claude: 'anthropic',
  codex: 'openai',
  opencode: 'openai',
}

export function router9SupportsAgent(agent: AgentType): boolean {
  return AGENT_DIALECT[agent] !== undefined
}

export function router9BaseUrl(port: number): string {
  return `http://127.0.0.1:${normalizePort(port)}`
}

export function normalizePort(port: number): number {
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : ROUTER9_DEFAULT_PORT
}

/**
 * Env vars that point one agent at the local router. Empty whenever routing must not apply, so the
 * caller can always spread the result without branching.
 */
export function router9EnvFor(
  agent: AgentType,
  config: Router9Preferences | undefined,
): Record<string, string> {
  if (!config?.enabled) return {}
  const apiKey = config.apiKey.trim()
  if (!apiKey) return {}
  const dialect = AGENT_DIALECT[agent]
  if (!dialect) return {}

  const baseUrl = router9BaseUrl(config.port)
  if (dialect === 'anthropic') {
    return { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey }
  }
  return { OPENAI_BASE_URL: `${baseUrl}/v1`, OPENAI_API_KEY: apiKey }
}

/** True when any 9router is available to route through, whichever install it is. */
export function router9HasInstall(status: Router9Status | null): boolean {
  return Boolean(status && (status.managed.installed || status.external.installed))
}

/**
 * The install a start request will actually use: the preferred one when it exists, otherwise the
 * other one, and null when neither is installed. Returning the fallback explicitly keeps the UI
 * able to say which install it is about to run instead of guessing.
 */
export function router9ResolveSource(
  status: Router9Status | null,
  preferred: Router9Source,
): { source: Router9Source; install: Router9Install } | null {
  if (!status) return null
  const order: Router9Source[] =
    preferred === 'external' ? ['external', 'managed'] : ['managed', 'external']
  for (const source of order) {
    const install = status[source]
    if (install.installed) return { source, install }
  }
  return null
}
