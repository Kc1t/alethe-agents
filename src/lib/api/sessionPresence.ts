import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv, webApiFetch } from './transport'

/**
 * Whether a stored session id can actually be resumed.
 *
 * `unknown` is not a failure and must not be treated as one: it means this agent's storage is not
 * something the app can read, so the id is used as-is. Answering `absent` there would discard
 * resumes that would have worked — trading a visible error for silent data loss.
 */
export type SessionPresence = 'present' | 'absent' | 'unknown'

export async function agentSessionPresence(
  agent: string,
  cwd: string,
  sessionId: string,
): Promise<SessionPresence> {
  if (isTauriEnv()) {
    return invoke<SessionPresence>('agent_session_presence', { agent, cwd, sessionId })
  }
  const query = `agent=${encodeURIComponent(agent)}&cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}`
  return webApiFetch<SessionPresence>(`/api/sessions/presence?${query}`)
}

/**
 * The session id to actually launch with, given what is stored.
 *
 * Returns `undefined` when the stored id refers to a session that is not there, so the agent starts
 * a fresh one instead of being handed an id it will reject. That rejection is what the user saw:
 * `No conversation found with session ID: …`, in red, on a first launch that had stopped at the
 * trust prompt before any conversation file was written — the id had been saved from the intent to
 * create a session, never from evidence that one existed.
 *
 * A failed check keeps the id. The point is to avoid resuming a session known to be gone, not to
 * refuse to resume whenever the check itself has a problem.
 */
export async function resolveResumeId(
  agent: string,
  cwd: string,
  storedId: string | null | undefined,
): Promise<string | undefined> {
  if (!storedId) return undefined
  try {
    const presence = await agentSessionPresence(agent, cwd, storedId)
    if (presence === 'absent') {
      console.info(
        `[session-resume] dropping ${agent} session ${storedId}: no conversation exists for ${cwd || 'this folder'} — starting a fresh one`,
      )
      return undefined
    }
    return storedId
  } catch (error) {
    console.warn(
      `[session-resume] could not verify ${agent} session ${storedId}; resuming anyway:`,
      error,
    )
    return storedId
  }
}
