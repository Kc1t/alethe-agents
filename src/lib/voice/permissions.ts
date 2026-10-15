import type { VoiceApprovalChannel } from '../types'
import { normalizeWord } from './routing'

export type PermissionPayload = {
  tool_name?: string
  tool_input?: Record<string, unknown>
  cwd?: string
}

export type PermissionAnswer =
  { kind: 'allow' } | { kind: 'deny'; message?: string } | { kind: 'defer' }
export type SpokenAnswer = PermissionAnswer | { kind: 'unclear' }

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

/** `tool` is null when the request names none; the caller words that in the person's language. */
export function describeRequest(payload: PermissionPayload): {
  tool: string | null
  subject: string
} {
  const tool = payload.tool_name ?? null
  const input = payload.tool_input ?? {}
  const subject =
    str(input.command) ??
    str(input.file_path) ??
    str(input.notebook_path) ??
    str(input.path) ??
    str(input.url) ??
    str(input.pattern) ??
    JSON.stringify(input).slice(0, 200)
  return { tool, subject }
}

/**
 * Split a command line into simple commands, each as a list of tokens. Quotes, brackets and `$(`
 * become spaces rather than separators, so `"-rf"` stays one token and `bash -c "rm -rf x"` still
 * exposes `rm` to the token scan below.
 */
function simpleCommands(command: string): string[][] {
  return command
    .replace(/\$\(|["'`(){}]/g, ' ')
    .split(/[;&|\n\r]+/)
    .map((part) => part.trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0)
}

const commandName = (token: string): string =>
  token
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/, '')

/** A short-flag cluster such as `-rf`, `-vrf` or `-Rec`-free `-fd`, containing one of `letters`. */
const hasShortFlag = (args: string[], letters: string): boolean =>
  args.some((token) => new RegExp(`^-[a-zA-Z]*[${letters}]`).test(token))

const hasFlag = (args: string[], long: string, letters: string): boolean =>
  args.includes(long) || hasShortFlag(args, letters)

/** Git options placed before the subcommand that take the next token as their value. */
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/** The subcommand and its arguments, past `git -C dir -c k=v --no-pager …`. */
function gitSubcommand(args: string[]): string[] {
  let index = 0
  while (index < args.length && args[index].startsWith('-')) {
    index += GIT_OPTIONS_WITH_VALUE.has(args[index]) ? 2 : 1
  }
  return args.slice(index)
}

/** Pathspecs that cover the whole working tree. */
const WHOLE_TREE = new Set(['.', './', '*', ':/'])

/** Remove-Item and the PowerShell/cmd aliases that reach it (or cmd's own delete commands). */
const REMOVE_ITEM = new Set(['remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir'])
const CMD_DELETE = new Set(['del', 'erase', 'rd', 'rmdir'])

/** The operands of a delete or move: not flags, and not cmd's `/q`-style switches. */
const pathOperands = (args: string[], cmdSwitches: boolean): string[] =>
  args.filter(
    (token) => !token.startsWith('-') && !(cmdSwitches && /^\/[a-z?](?::\S*)?$/i.test(token)),
  )

function isDestructiveGit(args: string[]): boolean {
  const [subcommand = '', ...rest] = gitSubcommand(args)
  const wholeTree = rest.some((token) => WHOLE_TREE.has(token))
  switch (subcommand) {
    case 'push':
      return rest.some(
        (token) =>
          token === '--force' ||
          token === '--force-with-lease' ||
          token.startsWith('--force-with-lease=') ||
          token === '--delete' ||
          token === '--mirror' ||
          /^-[a-zA-Z]*[fd]/.test(token) ||
          token.startsWith('+') ||
          token.startsWith(':'),
      )
    case 'reset':
      return rest.includes('--hard')
    case 'clean':
      return hasFlag(rest, '--force', 'f')
    case 'branch':
      return (
        hasShortFlag(rest, 'D') || (hasFlag(rest, '--delete', 'd') && hasFlag(rest, '--force', 'f'))
      )
    case 'checkout':
      return wholeTree || hasFlag(rest, '--force', 'f')
    case 'restore': {
      // `--staged` alone only unstages; the working tree is touched without it or with `--worktree`.
      const touchesWorktree = !hasFlag(rest, '--staged', 'S') || hasFlag(rest, '--worktree', 'W')
      return wholeTree && touchesWorktree
    }
    default:
      return false
  }
}

/**
 * Commands a misheard "yes" must never run. Each simple command is checked on its tokens, so flag
 * order and position do not matter. The check errs towards flagging: a false positive costs a click.
 */
function isDestructiveCommand(tokens: string[], cwd: string | null): boolean {
  const [head = '', ...args] = tokens
  const name = commandName(head)
  const outside = (cmdSwitches = false) =>
    pathOperands(args, cmdSwitches).some((path) => pointsOutside(path, cwd))
  if (name === 'rm') {
    return (
      args.some(
        (token) => /^-[a-zA-Z]*[rRf]/.test(token) || token === '--recursive' || token === '--force',
      ) || outside()
    )
  }
  if (name === 'mv') return outside()
  if (name === 'git') return isDestructiveGit(args)
  if (REMOVE_ITEM.has(name)) {
    if (args.some((token) => /^-r\w*(?::.*)?$/i.test(token))) return true
    const cmd = CMD_DELETE.has(name)
    if (cmd && args.some((token) => /^\/s$/i.test(token))) return true
    return outside(cmd)
  }
  if (name === 'mkfs' || name.startsWith('mkfs.')) return true
  if (name === 'dd') return args.some((token) => token.startsWith('if='))
  return false
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** Resolve `.` and `..` segments; lowercase drive-letter paths so Windows comparisons ignore case. */
function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const drive = /^[a-z]:/i.test(slashed) ? slashed.slice(0, 2) : ''
  const rest = drive ? slashed.slice(2) : slashed
  const absolute = rest.startsWith('/')
  const parts: string[] = []
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (!absolute) parts.push('..')
      continue
    }
    parts.push(segment)
  }
  const normalized = `${drive}${absolute ? '/' : ''}${parts.join('/')}`
  return drive ? normalized.toLowerCase() : normalized
}

function isInside(path: string, root: string): boolean {
  const file = normalizePath(path)
  const base = normalizePath(root)
  const prefix = base.endsWith('/') ? base : `${base}/`
  return file === base || file.startsWith(prefix)
}

/**
 * True when `path` may lie outside the project. Home and environment-variable paths always do;
 * without a cwd any absolute path does, and a relative one does when it climbs out with `..`.
 */
function pointsOutside(path: string, cwd: string | null): boolean {
  if (/^[~$%]/.test(path)) return true
  if (/^([a-z]:)?[\\/]/i.test(path)) return !cwd || !isInside(path, cwd)
  if (cwd) return !isInside(`${cwd}/${path}`, cwd)
  const normalized = normalizePath(path)
  return normalized === '..' || normalized.startsWith('../')
}

export function isDestructive(payload: PermissionPayload): boolean {
  const input = payload.tool_input ?? {}
  if (payload.tool_name === 'Bash' || payload.tool_name === 'PowerShell') {
    const command = str(input.command) ?? ''
    // SQL is matched on the raw line, so it is caught through pipes and heredocs too.
    if (/\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i.test(command)) return true
    const cwd = str(payload.cwd)
    // Checking from every token lets wrappers (sudo, xargs, time) sit in front of the real command.
    return simpleCommands(command).some((tokens) =>
      tokens.some((_, index) => isDestructiveCommand(tokens.slice(index), cwd)),
    )
  }
  if (payload.tool_name && FILE_TOOLS.has(payload.tool_name)) {
    // Fail closed: without the project directory, or the target path, the write cannot be checked.
    const cwd = str(payload.cwd)
    const file = str(input.file_path) ?? str(input.notebook_path)
    if (!cwd || !file) return true
    return pointsOutside(file, cwd)
  }
  return false
}

const ALLOW_WORDS = new Set([
  'yes',
  'yeah',
  'yep',
  'sure',
  'allow',
  'ok',
  'okay',
  'approve',
  'sim',
  'pode',
  'claro',
  'manda',
  'permite',
  'permitir',
])
const DENY_WORDS = new Set(['no', 'nope', 'deny', 'nao', 'negado', 'nega', 'recusa'])
/** Words that may follow an allow without changing it ("pode sim", "yes please"). */
const ALLOW_FILLERS = new Set([
  ...ALLOW_WORDS,
  'please',
  'go',
  'ahead',
  'do',
  'it',
  'por',
  'favor',
  'vai',
])

export function parseSpokenAnswer(text: string): SpokenAnswer {
  const trimmed = text.trim()
  const [first = '', ...rest] = trimmed.split(/\s+/)
  const word = normalizeWord(first)
  if (DENY_WORDS.has(word)) {
    const message = rest
      .join(' ')
      .replace(/^[\s,.:;!?…-]+/u, '')
      .trim()
    return message ? { kind: 'deny', message } : { kind: 'deny' }
  }
  if (ALLOW_WORDS.has(word)) {
    const extra = rest.map(normalizeWord).filter(Boolean)
    return extra.every((token) => ALLOW_FILLERS.has(token))
      ? { kind: 'allow' }
      : { kind: 'unclear' }
  }
  return { kind: 'unclear' }
}

export function answerAllowed(
  answer: PermissionAnswer,
  destructive: boolean,
  options: { channel: VoiceApprovalChannel; destructiveNeedsHud: boolean },
  source: 'voice' | 'hud',
): boolean {
  if (answer.kind === 'defer') return true
  const guarded = destructive && options.destructiveNeedsHud
  if (source === 'voice') {
    if (options.channel === 'hud') return false
    return !(guarded && answer.kind === 'allow')
  }
  return options.channel !== 'voice' || guarded
}
