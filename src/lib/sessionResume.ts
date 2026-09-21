/**
 * Session Resume — persiste sessions ativas no localStorage para
 * retomar agentes automaticamente ao reabrir o app.
 */

import { normalizeCwd } from './platform'
import { readScopedStorage, writeScopedStorage } from './storageNamespace'

const STORAGE_KEY = 'active-sessions'

export type SavedSession = {
  sessionId: string
  /** Claude conversation ID (nome do JSONL, ex: "abc123-def456"). */
  claudeSessionId?: string
  /** Codex conversation ID (payload.id do session_meta em ~/.codex/sessions). */
  codexSessionId?: string
  /** OpenCode session ID (ses_... do opencode session list). */
  opencodeSessionId?: string
  /** Antigravity conversation ID (conversation_metadata.json). */
  antigravitySessionId?: string
  /** Cursor chat ID (`cursor-agent create-chat`). */
  cursorSessionId?: string
  cwd: string
  agent: string
  timestamp: number
}

export type ActiveSessions = Record<string, SavedSession>

/** Field each agent's conversation ID is stored under. */
const CONVERSATION_FIELD = {
  claude: 'claudeSessionId',
  codex: 'codexSessionId',
  opencode: 'opencodeSessionId',
  antigravity: 'antigravitySessionId',
  cursor: 'cursorSessionId',
} as const satisfies Record<string, keyof SavedSession>

/**
 * The conversation half of a `SavedSession`, filled in for the one agent that owns it. Callers
 * spread it into the record so a new provider never means touching every save site.
 */
export function conversationFields(
  agent: string,
  conversationId: string | undefined,
): Partial<SavedSession> {
  const field = CONVERSATION_FIELD[agent as keyof typeof CONVERSATION_FIELD]
  if (!field || !conversationId) return {}
  return { [field]: conversationId }
}

export function savedConversationIdFor(
  session: SavedSession | null,
  agent: string | null | undefined,
  cwd: string | null | undefined,
): string | undefined {
  if (!session || !agent || !cwd) return undefined
  if (session.agent !== agent) return undefined
  if (normalizeCwd(session.cwd) !== normalizeCwd(cwd)) return undefined
  const field = CONVERSATION_FIELD[agent as keyof typeof CONVERSATION_FIELD]
  return field ? session[field] : undefined
}

export function getActiveSessions(): ActiveSessions {
  try {
    const raw = readScopedStorage(STORAGE_KEY, true)
    if (!raw) return {}
    const sessions = JSON.parse(raw) as ActiveSessions
    return sessions
  } catch {
    return {}
  }
}

export function saveSession(ptyId: string, session: SavedSession): void {
  const current = getActiveSessions()
  current[ptyId] = session
  writeScopedStorage(STORAGE_KEY, JSON.stringify(current))
}

export function removeSession(ptyId: string): void {
  const current = getActiveSessions()
  delete current[ptyId]
  writeScopedStorage(STORAGE_KEY, JSON.stringify(current))
}

/**
 * Reads the saved session without dropping it. The record must survive a launch that never
 * reaches `saveSession` — an aborted spawn would otherwise leave the pane with no conversation to
 * resume. Callers that decide the resume is unusable remove it explicitly.
 */
export function peekSession(ptyId: string): SavedSession | null {
  return getActiveSessions()[ptyId] ?? null
}
