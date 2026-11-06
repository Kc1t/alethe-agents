import type { Router9Install, Router9Status } from './tauri/router9'
import {
  type AgentType,
  ROUTER9_DEFAULT_PORT,
  type Router9Models,
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

/** Gateway base without trailing slashes or the `/v1` suffix the OpenAI dialect appends itself. */
export function normalizeRemoteUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

export function normalizeRouter9Models(raw: unknown): Router9Models {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pick = (key: keyof Router9Models) =>
    typeof source[key] === 'string' ? (source[key] as string).trim() : ''
  return { opus: pick('opus'), sonnet: pick('sonnet'), haiku: pick('haiku'), codex: pick('codex') }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The key and every prompt travel to this URL, so cleartext is only allowed on loopback. */
export function router9RemoteUrlAllowed(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)
}

export type Router9RemoteChecks = {
  url: 'ok' | 'missing' | 'invalid'
  key: 'saved' | 'missing'
  models: number
}

/** What a remote setup still lacks; whether the keychain holds a key comes from the backend. */
export function router9RemoteChecks(
  config: Router9Preferences,
  keySaved: boolean,
): Router9RemoteChecks {
  const url = normalizeRemoteUrl(config.remoteUrl)
  return {
    url: !url ? 'missing' : router9RemoteUrlAllowed(url) ? 'ok' : 'invalid',
    key: keySaved ? 'saved' : 'missing',
    models: Object.values(config.models).filter((id) => id.trim()).length,
  }
}

/** Normalized gateway base, or empty when the URL is refused. */
function remoteBase(config: Router9Preferences): string {
  const url = normalizeRemoteUrl(config.remoteUrl)
  return router9RemoteUrlAllowed(url) ? url : ''
}

/** Env var Codex reads the key from in remote mode, named by the provider in `router9ArgsFor`. */
const CODEX_KEY_ENV = 'ALETHE_ROUTER9_KEY'
const CODEX_PROVIDER = 'alethe_router9'

/** True when the new-terminal toggle can actually route this agent. */
export function router9RoutingReady(
  config: Router9Preferences,
  agent: AgentType,
  hasInstall: boolean,
  remoteKeySaved = false,
): boolean {
  if (!config.enabled || !router9SupportsAgent(agent)) return false
  if (config.mode === 'remote') return Boolean(remoteBase(config) && remoteKeySaved)
  return Boolean(config.apiKey.trim() && hasInstall)
}

/** Env vars that route one agent; empty when routing must not apply. Remote keys are never here. */
export function router9EnvFor(
  agent: AgentType,
  config: Router9Preferences | undefined,
): Record<string, string> {
  if (!config?.enabled) return {}
  const dialect = AGENT_DIALECT[agent]
  if (!dialect) return {}

  if (config.mode === 'remote') {
    const baseUrl = remoteBase(config)
    if (!baseUrl) return {}
    if (dialect === 'anthropic') {
      return { ANTHROPIC_BASE_URL: baseUrl, ...claudeModelEnv(config.models) }
    }
    return agent === 'codex' ? {} : { OPENAI_BASE_URL: `${baseUrl}/v1` }
  }

  const key = config.apiKey.trim()
  if (!key) return {}
  const baseUrl = router9BaseUrl(config.port)
  if (dialect === 'anthropic') return { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: key }
  return { OPENAI_BASE_URL: `${baseUrl}/v1`, OPENAI_API_KEY: key }
}

/** Env var names the backend fills with the remote key from the OS keychain at spawn time. */
export function router9KeyEnvFor(
  agent: AgentType,
  config: Router9Preferences | undefined,
): string[] {
  if (!config?.enabled || config.mode !== 'remote' || !remoteBase(config)) return []
  const dialect = AGENT_DIALECT[agent]
  if (!dialect) return []
  if (dialect === 'anthropic') return ['ANTHROPIC_AUTH_TOKEN']
  return [agent === 'codex' ? CODEX_KEY_ENV : 'OPENAI_API_KEY']
}

function claudeModelEnv(models: Router9Models): Record<string, string> {
  const env: Record<string, string> = {}
  if (models.opus) {
    env.ANTHROPIC_MODEL = models.opus
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = models.opus
  }
  if (models.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = models.sonnet
  if (models.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = models.haiku
  return env
}

/**
 * Extra CLI args for remote routing. Codex ignores OPENAI_BASE_URL when signed in with ChatGPT, so
 * the gateway is declared as its own provider through `-c` overrides instead.
 */
export function router9ArgsFor(agent: AgentType, config: Router9Preferences | undefined): string[] {
  if (!config?.enabled || config.mode !== 'remote' || agent !== 'codex') return []
  const baseUrl = remoteBase(config)
  if (!baseUrl) return []
  const provider = `model_providers.${CODEX_PROVIDER}`
  // JSON string escaping is valid TOML basic-string escaping.
  const value = (text: string) => JSON.stringify(text)
  const overrides = [
    `model_provider=${value(CODEX_PROVIDER)}`,
    `${provider}.name=${value('9router')}`,
    `${provider}.base_url=${value(`${baseUrl}/v1`)}`,
    `${provider}.env_key=${value(CODEX_KEY_ENV)}`,
    `${provider}.wire_api=${value('responses')}`,
  ]
  if (config.models.codex) overrides.push(`model=${value(config.models.codex)}`)
  return overrides.flatMap((override) => ['-c', override])
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
