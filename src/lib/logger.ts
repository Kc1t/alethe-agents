/**
 * Sistema de logging centralizado do Alethe.
 * Permite registrar logs estruturados no frontend e expô-los para o painel de diagnósticos/dev.
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

export function log(level: LogLevel, category: string, message: string, details?: unknown) {
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
