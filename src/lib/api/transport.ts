// Este foi feito para ajustar o transport.ts usando caminhos relativos /api no navegador, permitindo que o proxy do Vite trate a comunicação com o alethe-server sem erros de ERR_CONNECTION_REFUSED.

import { log } from '../logger'

/**
 * Detecta se a aplicação está rodando dentro da Webview do Tauri ou no Navegador Web puro.
 */
export function isTauriEnv(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean(
    // Check Tauri 2 internals or global __TAURI__ / __TAURI_INTERNALS__
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ ||
    (window as unknown as Record<string, unknown>).__TAURI__ ||
    (window as unknown as Record<string, unknown>).__TAURI_METADATA__,
  )
}

const getTargetServerUrl = (): string => {
  if (typeof window === 'undefined') return 'http://127.0.0.1:1423'
  // No navegador Web (Vite dev server na porta 1424), usamos o proxy nativo do Vite para /api
  if (window.location.port === '1424') return ''
  return window.location.origin
}

const SERVER_BASE_URL = getTargetServerUrl()

/**
 * Função utilitária para requisições REST ao backend Web (Axum).
 */
export async function webApiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${SERVER_BASE_URL}${path}`
  log('debug', 'HTTP', `${options?.method || 'GET'} ${path}`)

  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    })
    if (!res.ok) {
      const errText = await res.text()
      log('error', 'HTTP', `Falha ${res.status} em ${path}: ${errText}`)
      throw new Error(`HTTP ${res.status}: ${errText}`)
    }
    const contentType = res.headers.get('content-type')
    if (contentType && contentType.includes('application/json')) {
      const data = await res.json()
      return data as T
    }
    const text = await res.text()
    return text as unknown as T
  } catch (err) {
    log('error', 'HTTP', `Erro na requisição ${path}`, err)
    throw err
  }
}

/**
 * Estabelece uma conexão WebSocket bi-direcional com o backend Web.
 */
export function createWebSocketStream(path: string): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = typeof window !== 'undefined' ? window.location.host : '127.0.0.1:1423'
  const wsUrl = `${protocol}//${host}${path}`
  log('info', 'WS', `Conectando WebSocket a ${wsUrl}`)
  return new WebSocket(wsUrl)
}
