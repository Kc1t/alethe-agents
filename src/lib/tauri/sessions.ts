import { invoke } from '@tauri-apps/api/core'

export type AntigravitySessionSnapshot = {
  id: string
  preview: string
  modified_at_ms: number
}

export async function snapshotAntigravitySessions(
  cwd: string,
): Promise<AntigravitySessionSnapshot[]> {
  return invoke<AntigravitySessionSnapshot[]>('snapshot_antigravity_sessions', { cwd })
}

/** Custo por modelo dentro de uma sessão (tokens + USD). */
export type ModelCost = {
  model: string
  input: number
  output: number
  cache_read: number
  cache_write_5m: number
  cache_write_1h: number
  /** null se o modelo não está na tabela de preço (ex.: GPT do Codex). */
  cost_usd: number | null
}

/** Custo real de uma sessão, parseado do JSONL (Claude/Codex). */
export type SessionCost = {
  session_id: string
  agent: string
  input: number
  output: number
  cache_read: number
  cache_write_5m: number
  cache_write_1h: number
  total_tokens: number
  cost_usd: number | null
  model: string | null
  by_model: ModelCost[]
}

export async function getSessionCost(
  agent: string,
  cwd: string,
  sessionId: string,
): Promise<SessionCost> {
  return invoke<SessionCost>('get_session_cost', { agent, cwd, sessionId })
}

/** Custo de um transcript JSONL do Claude por path — pros nós do agent canvas. */
export async function getTranscriptCost(path: string): Promise<SessionCost> {
  return invoke<SessionCost>('get_transcript_cost', { path })
}

export type ClaudeSessionMeta = {
  id: string
  title: string | null
  first_user_prompt: string | null
  message_count: number
  modified_at_ms: number
  size_bytes: number
}

export type ClaudeSessionSnapshot = {
  id: string
  modified_at_ms: number
  size_bytes: number
}

export type CodexSessionSnapshot = {
  id: string
  cwd: string
  modified_at_ms: number
  size_bytes: number
}

export async function snapshotClaudeSessions(cwd: string): Promise<ClaudeSessionSnapshot[]> {
  return invoke<ClaudeSessionSnapshot[]>('snapshot_claude_sessions', { cwd })
}

export async function snapshotCodexSessions(cwd: string): Promise<CodexSessionSnapshot[]> {
  return invoke<CodexSessionSnapshot[]>('snapshot_codex_sessions', { cwd })
}

export async function listClaudeSessions(cwd: string): Promise<ClaudeSessionMeta[]> {
  return invoke<ClaudeSessionMeta[]>('list_claude_sessions', { cwd })
}

// --- OpenCode Sessions ---

export type OpenCodeSessionSnapshot = {
  id: string
  modified_at_ms: number
}

export async function snapshotOpenCodeSessions(cwd: string): Promise<OpenCodeSessionSnapshot[]> {
  return invoke<OpenCodeSessionSnapshot[]>('snapshot_opencode_sessions', { cwd })
}

/** Histórico estruturado de uma sessão do OpenCode (`opencode export <id>`) —
 *  usado pra renderizar a sessão-filha do GSD Sync como feed de atividade
 *  somente-leitura, sem terminal PTY nenhum no caminho. O schema de `parts`
 *  tem (e provavelmente vai ganhar mais) vários `type`s — os conhecidos hoje
 *  têm tipo próprio pra renderização dedicada; qualquer outro cai no
 *  fallback genérico sem quebrar. */
export type OpenCodeExportPartBase = {
  id: string
  sessionID: string
  messageID: string
}

export type OpenCodeExportTextPart = OpenCodeExportPartBase & { type: 'text'; text: string }

export type OpenCodeExportReasoningPart = OpenCodeExportPartBase & {
  type: 'reasoning'
  text?: string
}

export type OpenCodeExportToolPart = OpenCodeExportPartBase & {
  type: 'tool'
  tool: string
  callID: string
  state: {
    status: string
    input?: Record<string, unknown>
    output?: string
    time?: { start?: number; end?: number }
  }
}

export type OpenCodeExportPatchPart = OpenCodeExportPartBase & {
  type: 'patch'
  hash?: string
  files?: Record<string, unknown>
}

export type OpenCodeExportStepPart = {
  type: 'step-start' | 'step-finish'
  reason?: string
  tokens?: { input?: number; output?: number; total?: number }
}

/** `type`s conhecidos hoje têm variante própria acima (renderização
 *  dedicada); qualquer outro `type` que a API venha a introduzir no futuro
 *  não quebra o typecheck — cai fora da união e o renderizador (que checa
 *  `part.type` em runtime, não confia só no tipo estático) simplesmente
 *  ignora, sem crashar. Não incluímos um membro catch-all `{ type: string }`
 *  aqui de propósito: com `type` amplo como `string` ele nunca é excluído
 *  pelo narrowing do TypeScript nas outras variantes (todas ficam com esse
 *  membro "grudado" na união depois de qualquer `if (part.type === ...)`). */
export type OpenCodeExportPart =
  | OpenCodeExportTextPart
  | OpenCodeExportReasoningPart
  | OpenCodeExportToolPart
  | OpenCodeExportPatchPart
  | OpenCodeExportStepPart

export type OpenCodeExportMessage = {
  info: {
    role: 'user' | 'assistant'
    time: { created: number; completed?: number }
    agent?: string
    model?: { providerID?: string; modelID?: string }
    id: string
    sessionID: string
  }
  parts: OpenCodeExportPart[]
}

export type OpenCodeExportSession = {
  info: {
    id: string
    slug?: string
    title?: string
    agent?: string
    model?: { id?: string; providerID?: string; variant?: string }
    version?: string
    tokens?: {
      input: number
      output: number
      reasoning?: number
      cache?: { read: number; write: number }
    }
    cost?: number
    time: { created: number; updated: number }
  }
  messages: OpenCodeExportMessage[]
}

export async function opencodeExportSession(
  cwd: string,
  sessionId: string,
): Promise<OpenCodeExportSession> {
  return invoke<OpenCodeExportSession>('opencode_export_session', { cwd, sessionId })
}
