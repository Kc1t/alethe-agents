import { recordConsoleLog } from './tauri'

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const
type ConsoleLevel = (typeof LEVELS)[number]

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack || arg.message
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

/**
 * Mirrors every devtools console call to `logs/frontend.log` (repo root) without
 * changing devtools output, so it can be tailed side by side with the terminal
 * (`logs/backend.log`) during a live cross-device debugging session.
 */
export function installDebugTrace(): void {
  for (const level of LEVELS) {
    const original = console[level as ConsoleLevel].bind(console)
    console[level as ConsoleLevel] = (...args: unknown[]) => {
      original(...args)
      void recordConsoleLog(level, args.map(stringifyArg).join(' '))
    }
  }
}
