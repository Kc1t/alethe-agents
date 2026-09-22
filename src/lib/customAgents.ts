import { ALL_AGENT_TYPES, type CustomAgentDefinition, type CustomAgentIconSpec } from './types'

export const CUSTOM_AGENT_ID_RE = /^[a-z0-9-]{2,32}$/

export const CUSTOM_AGENT_ICON_MAX_BYTES = 512 * 1024

export const CUSTOM_AGENT_ICON_URL_MAX_LENGTH = 512

export const CUSTOM_AGENT_ACCENT_TOKENS = [
  '--agent-shell',
  '--agent-claude',
  '--agent-codex',
  '--agent-opencode',
  '--agent-cursor',
  '--agent-copilot',
  '--agent-antigravity',
  '--agent-kiro',
  '--agent-freebuff',
  '--agent-mimo',
] as const

export type CustomAgentAccentToken = (typeof CUSTOM_AGENT_ACCENT_TOKENS)[number]

export const CUSTOM_AGENT_ICON_KEYS = [
  'bot',
  'shell',
  'wsl',
  'claude',
  'codex',
  'copilot',
  'cursor',
  'opencode',
  'antigravity',
  'kiro',
  'mimo',
  'freebuff',
] as const

export type CustomAgentIconKey = (typeof CUSTOM_AGENT_ICON_KEYS)[number]

const BUILTIN_IDS = new Set<string>(ALL_AGENT_TYPES)

const FORBIDDEN_CLI_CHARS = new Set([';', '&', '|', '`', '$', '(', ')', '>', '<', '\n', '\r', '\0'])

export type CustomAgentInput = {
  id: string
  label: string
  cliCommand: string
  unrestrictedFlag?: string | null
  accentToken?: string
  icon?: string
  iconSpec?: CustomAgentIconSpec
}

export function isValidImageIconUrl(raw: string): boolean {
  const value = raw.trim()
  if (!value || value.length > CUSTOM_AGENT_ICON_URL_MAX_LENGTH) return false
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password || !parsed.hostname) return false
  const path = parsed.pathname.toLowerCase()
  return path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg')
}

export type IcoBytesVerdict = 'ok' | 'tooLarge' | 'badMagic'

export function validateIcoBytes(bytes: Uint8Array): IcoBytesVerdict {
  if (bytes.length > CUSTOM_AGENT_ICON_MAX_BYTES) return 'tooLarge'
  if (bytes.length < 4) return 'badMagic'
  if (bytes[0] !== 0x00 || bytes[1] !== 0x00 || bytes[2] !== 0x01 || bytes[3] !== 0x00) {
    return 'badMagic'
  }
  return 'ok'
}

export function legacyIconToSpec(icon: string | undefined): CustomAgentIconSpec {
  const key = (icon ?? '').trim()
  if ((CUSTOM_AGENT_ICON_KEYS as readonly string[]).includes(key)) {
    return { kind: 'preset', key }
  }
  return { kind: 'preset', key: 'bot' }
}

export function iconSpecToLegacyKey(spec: CustomAgentIconSpec | undefined): string {
  if (spec?.kind === 'preset') return spec.key
  return 'bot'
}

export function normalizeIconSpec(
  spec: CustomAgentIconSpec | undefined,
  legacyIcon: string | undefined,
): CustomAgentIconSpec {
  if (!spec) return legacyIconToSpec(legacyIcon)
  if (spec.kind === 'preset') return legacyIconToSpec(spec.key)
  if (spec.kind === 'file') {
    const assetId = spec.assetId.trim().toLowerCase()
    if (CUSTOM_AGENT_ID_RE.test(assetId)) return { kind: 'file', assetId }
    return { kind: 'preset', key: 'bot' }
  }
  if (isValidImageIconUrl(spec.href)) return { kind: 'url', href: spec.href.trim() }
  return { kind: 'preset', key: 'bot' }
}

export function normalizeCustomAgentId(raw: string): string {
  return raw.trim().toLowerCase()
}

export function splitCustomCliCommand(raw: string): { binary: string; args: string[] } | null {
  const tokens = tokenizeCommandLine(raw)
  if (!tokens || tokens.length === 0) return null
  for (const token of tokens) {
    for (const char of token) {
      if (FORBIDDEN_CLI_CHARS.has(char)) return null
    }
  }
  const [binary, ...args] = tokens
  if (!isValidBinaryName(binary)) return null
  for (const arg of args) {
    if (arg.length === 0 || arg.length > 256) return null
  }
  return { binary, args }
}

function tokenizeCommandLine(raw: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let hasToken = false
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      hasToken = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      hasToken = true
      continue
    }
    if (char === ' ' || char === '\t') {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += char
    hasToken = true
  }
  if (quote) return null
  if (hasToken) tokens.push(current)
  return tokens
}

function isValidBinaryName(binary: string): boolean {
  if (!binary || binary.length > 128) return false
  const base = binary.split(/[\\/]/).at(-1) ?? binary
  return /^[A-Za-z0-9._-]+(\.exe|\.cmd|\.bat|\.ps1)?$/.test(base)
}

export type CustomAgentValidationError =
  | 'idFormat'
  | 'idTaken'
  | 'idBuiltin'
  | 'labelEmpty'
  | 'cliEmpty'
  | 'cliUnsafe'
  | 'iconFile'
  | 'iconFileTooLarge'
  | 'iconFileNotSquare'
  | 'iconFileInvalid'
  | 'iconUrl'

// Substrings match the Rust literals in src-tauri/src/custom_agent_icons.rs.
export function iconFileImportError(message: unknown): CustomAgentValidationError {
  const text = String(message ?? '').toLowerCase()
  if (text.includes('exceeds') || text.includes('too large')) return 'iconFileTooLarge'
  if (text.includes('square')) return 'iconFileNotSquare'
  if (
    text.includes('not a valid') ||
    text.includes('only .ico') ||
    text.includes('invalid agent id')
  ) {
    return 'iconFileInvalid'
  }
  return 'iconFile'
}

export function isIconValidationError(error: CustomAgentValidationError): boolean {
  return (
    error === 'iconFile' ||
    error === 'iconFileTooLarge' ||
    error === 'iconFileNotSquare' ||
    error === 'iconFileInvalid' ||
    error === 'iconUrl'
  )
}

export function validateCustomAgent(
  input: CustomAgentInput,
  existingIds: readonly string[],
  excludeId?: string,
): CustomAgentValidationError | null {
  const id = normalizeCustomAgentId(input.id)
  if (!CUSTOM_AGENT_ID_RE.test(id)) return 'idFormat'
  if (BUILTIN_IDS.has(id)) return 'idBuiltin'
  const collision = existingIds.some((other) => other.toLowerCase() === id && other.toLowerCase() !== excludeId?.toLowerCase())
  if (collision) return 'idTaken'
  if (!input.label.trim() || input.label.trim().length > 48) return 'labelEmpty'
  if (!input.cliCommand.trim()) return 'cliEmpty'
  if (!splitCustomCliCommand(input.cliCommand.trim())) return 'cliUnsafe'
  const flag = input.unrestrictedFlag?.trim() ?? ''
  if (flag) {
    if (flag.length > 64 || !flag.startsWith('-')) return 'cliUnsafe'
    for (const char of flag) {
      if (FORBIDDEN_CLI_CHARS.has(char) || char === ' ' || char === '\t') return 'cliUnsafe'
    }
  }
  if (input.accentToken && !isAllowedAccentToken(input.accentToken)) return 'cliUnsafe'
  if (input.icon && !(CUSTOM_AGENT_ICON_KEYS as readonly string[]).includes(input.icon)) {
    return 'cliUnsafe'
  }
  const spec = input.iconSpec
  if (spec?.kind === 'preset' && !(CUSTOM_AGENT_ICON_KEYS as readonly string[]).includes(spec.key)) {
    return 'cliUnsafe'
  }
  if (spec?.kind === 'file' && !CUSTOM_AGENT_ID_RE.test(spec.assetId.trim().toLowerCase())) {
    return 'iconFile'
  }
  if (spec?.kind === 'url' && !isValidImageIconUrl(spec.href)) return 'iconUrl'
  return null
}

function isAllowedAccentToken(token: string): boolean {
  return (CUSTOM_AGENT_ACCENT_TOKENS as readonly string[]).includes(token)
}

function asIconSpec(raw: unknown): CustomAgentIconSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const candidate = raw as Partial<CustomAgentIconSpec> & { key?: unknown; assetId?: unknown; href?: unknown }
  if (candidate.kind === 'preset' && typeof candidate.key === 'string') {
    return { kind: 'preset', key: candidate.key }
  }
  if (candidate.kind === 'file' && typeof candidate.assetId === 'string') {
    return { kind: 'file', assetId: candidate.assetId }
  }
  if (candidate.kind === 'url' && typeof candidate.href === 'string') {
    return { kind: 'url', href: candidate.href }
  }
  return undefined
}

export function sanitizeCustomAgents(raw: unknown): CustomAgentDefinition[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: CustomAgentDefinition[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as Partial<CustomAgentDefinition>
    const id = typeof candidate.id === 'string' ? normalizeCustomAgentId(candidate.id) : ''
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : ''
    const cliCommand = typeof candidate.cliCommand === 'string' ? candidate.cliCommand.trim() : ''
    if (seen.has(id)) continue
    const error = validateCustomAgent(
      {
        id,
        label,
        cliCommand,
        unrestrictedFlag: typeof candidate.unrestrictedFlag === 'string' ? candidate.unrestrictedFlag : null,
        accentToken: typeof candidate.accentToken === 'string' ? candidate.accentToken : undefined,
        icon: typeof candidate.icon === 'string' ? candidate.icon : undefined,
        iconSpec: asIconSpec(candidate.iconSpec),
      },
      [...seen],
    )
    if (error && isIconValidationError(error)) {
      // A stale icon reference must never delete the agent; fall back to bot.
    } else if (error) {
      continue
    }
    seen.add(id)
    const split = splitCustomCliCommand(cliCommand)
    if (!split) continue
    const iconSpec = normalizeIconSpec(
      asIconSpec(candidate.iconSpec),
      typeof candidate.icon === 'string' ? candidate.icon : undefined,
    )
    result.push({
      id,
      label,
      cliCommand,
      unrestrictedFlag: normalizeFlag(candidate.unrestrictedFlag),
      accentToken: isAllowedAccentToken(candidate.accentToken ?? '')
        ? candidate.accentToken
        : '--agent-shell',
      icon: iconSpecToLegacyKey(iconSpec),
      iconSpec,
    })
    if (result.length >= 24) break
  }
  return result
}

function normalizeFlag(flag: unknown): string | null {
  if (typeof flag !== 'string') return null
  const trimmed = flag.trim()
  return trimmed ? trimmed : null
}

export function toCustomAgentDefinition(input: CustomAgentInput): CustomAgentDefinition {
  const iconSpec = normalizeIconSpec(input.iconSpec, input.icon)
  return {
    id: normalizeCustomAgentId(input.id),
    label: input.label.trim(),
    cliCommand: input.cliCommand.trim(),
    unrestrictedFlag: normalizeFlag(input.unrestrictedFlag),
    accentToken: input.accentToken?.trim() || '--agent-shell',
    icon: iconSpecToLegacyKey(iconSpec),
    iconSpec,
  }
}
