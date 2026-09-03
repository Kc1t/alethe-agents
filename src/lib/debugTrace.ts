import { currentCorrelation } from './correlation'
import { recordConsoleLog } from './tauri'

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const
type ConsoleLevel = (typeof LEVELS)[number]

/** Console levels in increasing severity, for the mirroring threshold. */
const SEVERITY: Record<ConsoleLevel, number> = { debug: 0, log: 1, info: 1, warn: 2, error: 3 }

/**
 * How much console output reaches the log file.
 *
 * This used to mirror *everything*, unconditionally — an IPC round trip per `console.debug` in a UI
 * that logs freely. `ALETHE_TRACE` (or `localStorage.aletheTrace`) raises or lowers it; `warn` is
 * the default because a warning or an error is what someone reading the log afterwards is looking
 * for, and the debug chatter is available live in devtools anyway.
 */
function threshold(): number {
  const raw =
    (import.meta.env?.VITE_ALETHE_TRACE as string | undefined) ??
    (() => {
      try {
        return localStorage.getItem('aletheTrace') ?? undefined
      } catch {
        // Storage can be blocked outright (private mode, disabled site data); that is not a
        // reason to lose console mirroring.
        return undefined
      }
    })()
  const level = raw?.trim().toLowerCase() as ConsoleLevel | undefined
  if (level && level in SEVERITY) return SEVERITY[level]
  return SEVERITY.warn
}

let installed = false

/**
 * Mirrors devtools console calls into the unified log stream, tagged with the correlation id of the
 * gesture in effect, so a UI line and the Rust records it caused can be read as one sequence.
 *
 * The original console call always happens first and is never replaced, so devtools output is
 * unchanged whatever the threshold is.
 */
export function installDebugTrace(): void {
  if (installed) return
  installed = true
  const minimum = threshold()
  for (const level of LEVELS) {
    const original = console[level as ConsoleLevel].bind(console)
    console[level as ConsoleLevel] = (...args: unknown[]) => {
      original(...args)
      if (SEVERITY[level] < minimum) return
      void recordConsoleLog(level, args.map(stringifyArg).join(' '), currentCorrelation())
    }
  }
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack || arg.message
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}
