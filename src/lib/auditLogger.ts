// Este foi feito para criar um sistema de Auditoria e Logs Avançado independente do DevTools, capturando exceções globais, rejeições de promessas e eventos de rede em tempo real.

import { isTauriEnv } from './api/transport'

export type AuditLogLevel = 'error' | 'warn' | 'info' | 'debug'
export type AuditLogCategory =
  'SYSTEM' | 'HTTP' | 'WS' | 'TAURI' | 'REACT' | 'ROUTER' | 'DOM' | 'PTY'

export interface AuditEntry {
  id: string
  timestamp: number
  isoTime: string
  level: AuditLogLevel
  category: AuditLogCategory
  message: string
  stack?: string
  context?: Record<string, unknown>
  env: 'Desktop (Tauri)' | 'Web Browser'
}

type AuditListener = (entries: AuditEntry[]) => void

class AuditSystem {
  private logs: AuditEntry[] = []
  private maxLogs = 300
  private listeners: Set<AuditListener> = new Set()
  private initialized = false

  constructor() {
    this.initGlobalHandlers()
  }

  private initGlobalHandlers() {
    if (typeof window === 'undefined' || this.initialized) return
    this.initialized = true

    // Captura erros JavaScript globais não tratados (window.onerror)
    window.addEventListener('error', (event) => {
      this.log({
        level: 'error',
        category: 'DOM',
        message: event.message || 'Uncaught Error',
        stack: event.error?.stack,
        context: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        },
      })
    })

    // Captura rejeições de Promessas não tratadas (unhandledrejection)
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason
      const message = reason instanceof Error ? reason.message : String(reason)
      const stack = reason instanceof Error ? reason.stack : undefined

      this.log({
        level: 'error',
        category: 'SYSTEM',
        message: `Unhandled Promise Rejection: ${message}`,
        stack,
        context: { reason },
      })
    })

    this.log({
      level: 'info',
      category: 'SYSTEM',
      message: `Central de Auditoria inicializada em modo ${isTauriEnv() ? 'Desktop Tauri' : 'Web Server Browser'}.`,
    })
  }

  public log(params: {
    level: AuditLogLevel
    category: AuditLogCategory
    message: string
    stack?: string
    context?: Record<string, unknown>
  }): AuditEntry {
    const entry: AuditEntry = {
      id: Math.random().toString(36).slice(2, 10),
      timestamp: Date.now(),
      isoTime: new Date().toLocaleTimeString(),
      level: params.level,
      category: params.category,
      message: params.message,
      stack: params.stack,
      context: params.context,
      env: isTauriEnv() ? 'Desktop (Tauri)' : 'Web Browser',
    }

    this.logs.unshift(entry)
    if (this.logs.length > this.maxLogs) {
      this.logs.pop()
    }

    this.notifyListeners()
    return entry
  }

  public getLogs(): AuditEntry[] {
    return [...this.logs]
  }

  public clear() {
    this.logs = []
    this.notifyListeners()
  }

  public subscribe(listener: AuditListener): () => void {
    this.listeners.add(listener)
    listener([...this.logs])
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notifyListeners() {
    const snapshot = [...this.logs]
    this.listeners.forEach((listener) => listener(snapshot))
  }

  public exportReport(): string {
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        environment: isTauriEnv() ? 'Desktop (Tauri 2)' : 'Web Browser',
        url: typeof window !== 'undefined' ? window.location.href : 'N/A',
        totalLogs: this.logs.length,
        logs: this.logs,
      },
      null,
      2,
    )
  }
}

export const auditLogger = new AuditSystem()
