/**
 * Alethe's centralised frontend logging.
 *
 * Records structured entries and exposes them to the diagnostics/dev panel. Entries also reach the
 * unified log stream through the console mirror in `debugTrace.ts`, tagged with the correlation id
 * of the gesture in effect, so a frontend entry and the Rust decision records it caused can be read
 * as one sequence.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  id: string
  timestamp: string
  level: LogLevel
  category: string
  message: string
  details?: unknown
}

const MAX_LOGS = 500
const logsBuffer: LogEntry[] = []
const logListeners = new Set<(logs: LogEntry[]) => void>()

const SEVERITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/**
 * The lowest level that gets recorded.
 *
 * `LogLevel` existed from the start but nothing ever filtered on it, so every `debug` call did the
 * full buffer-and-notify work and then went to the console regardless of whether anyone wanted it.
 */
let minimumLevel: LogLevel = 'debug'

export function setLogLevel(level: LogLevel): void {
  minimumLevel = level
}

export function getLogLevel(): LogLevel {
  return minimumLevel
}

export function log(level: LogLevel, category: string, message: string, details?: unknown) {
  if (SEVERITY[level] < SEVERITY[minimumLevel]) return
  const entry: LogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    details,
  }

  logsBuffer.unshift(entry)
  if (logsBuffer.length > MAX_LOGS) {
    logsBuffer.pop()
  }

  const formattedMsg = `[Alethe ${level.toUpperCase()}] [${category}] ${message}`
  if (level === 'error') {
    console.error(formattedMsg, details ?? '')
  } else if (level === 'warn') {
    console.warn(formattedMsg, details ?? '')
  } else if (level === 'info') {
    console.info(formattedMsg, details ?? '')
  } else {
    console.debug(formattedMsg, details ?? '')
  }

  logListeners.forEach((listener) => listener([...logsBuffer]))
}

export function getLogHistory(): LogEntry[] {
  return [...logsBuffer]
}

export function subscribeLogs(listener: (logs: LogEntry[]) => void): () => void {
  logListeners.add(listener)
  listener([...logsBuffer])
  return () => {
    logListeners.delete(listener)
  }
}
