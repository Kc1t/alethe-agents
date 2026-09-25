/** Shared Agent Canvas configuration without React or DOM dependencies. */

/** Cores fixas por tipo de agente conhecido (tokens do tema). */
export const AGENT_COLORS: Record<string, string> = {
  explore: 'var(--agent-codex)',
  plan: '#a78bfa',
  'general-purpose': 'var(--agent-claude)',
}

/** Example prompt shown when the canvas is empty. */
export const TEST_PROMPT =
  'Analise esta codebase com 3 subagents Explore em paralelo: um pro código-fonte principal, ' +
  'um pra configs/build e um pra docs/testes. Cada um mapeia os arquivos do seu escopo e devolve um resumo curto.'

/** Number of events shown in each card's mini-feed. */
export const MINI_FEED_SIZE = 3

// Enable Agent Teams only for this PTY and prevent mid-session CLI updates.
export const PTY_ENV = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  DISABLE_AUTOUPDATER: '1',
}

export const USAGE_FALLBACK_THRESHOLD = 80

export const USAGE_POLL_MS = 60_000

export const COST_POLL_MS = 4_000

export const ZOOM_MIN = 0.4
export const ZOOM_MAX = 1.4
export const ZOOM_STEP = 0.1

export const MAX_LIVE_WORKERS = 3

export const FAMILY_RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3 }

export const CORE_AGENTS = [
  'orchestrator',
  'frontend-dev',
  'backend-dev',
  'qa-reviewer',
  'docs-writer',
]
