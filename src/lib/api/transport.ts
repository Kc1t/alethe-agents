import { invoke } from '@tauri-apps/api/core'

import { log } from '../logger'

/**
 * Detect whether the frontend is running inside a Tauri webview.
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
  // Native-only capabilities still use IPC, but shared core domains use the
  // same loopback authority as browser clients.
  if (isTauriEnv()) return 'http://127.0.0.1:1423'
  // Both Vite entry points proxy /api, including WebSocket upgrades.
  if (window.location.port === '1422' || window.location.port === '1424') return ''
  return window.location.origin
}

const SERVER_BASE_URL = getTargetServerUrl()
let coreAvailability: { available: boolean; expiresAt: number } | null = null
let coreAvailabilityRequest: Promise<boolean> | null = null
let coreSessionToken: string | null = null
let coreSessionExpiresAt = 0
let coreSessionRefreshAfter = 0
let coreSessionRequest: Promise<string> | null = null
let verifiedCoreInstanceId: string | null = null
// Once a probe confirms the shared HTTP core is real, authority stays sticky
// for the rest of the session: a later transient failure must surface as an
// error, never silently reroute a Tauri client back to IPC (that would split
// write authority between two transports and drop events).
let httpAuthorityEstablished = false
export const CORE_IDENTITY_MISMATCH = 'alethe_core_identity_mismatch'
export const CORE_UNAVAILABLE = 'alethe_core_unavailable'
export const CORE_TRANSIENT_ERROR = 'alethe_core_transient_error'

export type CoreStorageIdentity = {
  app_identifier: string
  data_root_id: string
}

export type CoreRuntimePayload = {
  service?: string
  appIdentifier?: string
  dataRootId?: string
  instanceId?: string
  eventStream?: string
}

type CoreHealthPayload = CoreRuntimePayload & {
  status?: string
  runtime?: CoreRuntimePayload
}

export function matchesCoreIdentity(
  localIdentity: CoreStorageIdentity,
  payload: CoreHealthPayload,
): boolean {
  const runtime = payload.runtime ?? payload
  return (
    payload.status === 'ok' &&
    (payload.service ?? runtime.service) === 'alethe-core' &&
    runtime.appIdentifier === localIdentity.app_identifier &&
    runtime.dataRootId === localIdentity.data_root_id
  )
}

export async function canUseSharedCoreTransport(): Promise<boolean> {
  const now = Date.now()
  if (coreAvailability && coreAvailability.expiresAt > now) return coreAvailability.available
  if (coreAvailabilityRequest) return coreAvailabilityRequest

  coreAvailabilityRequest = (async () => {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 750)
    // Only usable before authority is established: during initial discovery
    // a failed probe just means "no HTTP core found yet" (Tauri may fall
    // back to IPC). After establishment the same failure must never be
    // swallowed into `false` — it has to throw so callers see a visible,
    // retryable error instead of silently switching transports.
    const unavailableOrThrow = (): false => {
      if (httpAuthorityEstablished) throw new Error(CORE_TRANSIENT_ERROR)
      return false
    }
    try {
      const [localIdentity, response] = await Promise.all([
        isTauriEnv()
          ? invoke<CoreStorageIdentity>('get_core_storage_identity')
          : Promise.resolve<CoreStorageIdentity | null>(null),
        fetch(`${SERVER_BASE_URL}/api/health`, { signal: controller.signal, cache: 'no-store' }),
      ])
      if (!response.ok) return unavailableOrThrow()
      const payload = (await response.json()) as CoreHealthPayload
      const runtime = payload.runtime ?? payload
      const isAletheCore = (payload.service ?? runtime.service) === 'alethe-core'
      const expectedIdentifier =
        import.meta.env.VITE_ALETHE_APP_IDENTIFIER ??
        (import.meta.env.DEV ? 'com.kc1t.alethe.dev' : 'com.kc1t.alethe')
      const identityMatches = localIdentity
        ? matchesCoreIdentity(localIdentity, payload)
        : payload.status === 'ok' && isAletheCore && runtime.appIdentifier === expectedIdentifier
      if (identityMatches) {
        if (
          verifiedCoreInstanceId &&
          runtime.instanceId &&
          verifiedCoreInstanceId !== runtime.instanceId
        ) {
          coreSessionToken = null
          coreSessionExpiresAt = 0
          coreSessionRefreshAfter = 0
        }
        verifiedCoreInstanceId = runtime.instanceId ?? null
        httpAuthorityEstablished = true
        return true
      }
      if (isAletheCore) {
        log(
          'error',
          'Core',
          `Refusing a core with a different storage identity (${runtime.appIdentifier ?? 'unknown'}, ${runtime.dataRootId ?? 'unknown'})`,
        )
        throw new Error(CORE_IDENTITY_MISMATCH)
      }
      return unavailableOrThrow()
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === CORE_IDENTITY_MISMATCH || error.message === CORE_TRANSIENT_ERROR)
      ) {
        throw error
      }
      return unavailableOrThrow()
    } finally {
      window.clearTimeout(timeout)
    }
  })()

  try {
    const available = await coreAvailabilityRequest
    coreAvailability = { available, expiresAt: Date.now() + (available ? 5000 : 1000) }
    return available
  } finally {
    coreAvailabilityRequest = null
  }
}

async function getCoreSessionToken(): Promise<string> {
  const now = Date.now()
  if (coreSessionToken && now < coreSessionRefreshAfter && now < coreSessionExpiresAt) {
    return coreSessionToken
  }
  if (coreSessionRequest) return coreSessionRequest

  coreSessionRequest = (async () => {
    // Refreshing credentials always revalidates the storage identity first. A
    // restarted core can own the same port while pointing at another data root.
    if (coreSessionToken) {
      coreAvailability = null
      if (!(await canUseSharedCoreTransport())) throw new Error(CORE_UNAVAILABLE)
    }
    const response = await fetch(`${SERVER_BASE_URL}/api/session`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
    const payload = (await response.json()) as {
      token?: string
      expiresAtMs?: number
      refreshAfterMs?: number
      generation?: number
      instanceId?: string
    }
    if (!payload.token) throw new Error('Alethe Core did not issue a session token')
    if (
      verifiedCoreInstanceId &&
      payload.instanceId &&
      payload.instanceId !== verifiedCoreInstanceId
    ) {
      coreAvailability = null
      verifiedCoreInstanceId = null
      if (!(await canUseSharedCoreTransport()) || verifiedCoreInstanceId !== payload.instanceId) {
        invalidateCoreSessionToken()
        throw new Error(CORE_UNAVAILABLE)
      }
    }
    const fallbackExpiry = Date.now() + 5 * 60_000
    const expiresAt =
      typeof payload.expiresAtMs === 'number' && payload.expiresAtMs > Date.now()
        ? payload.expiresAtMs
        : fallbackExpiry
    const refreshAfter =
      typeof payload.refreshAfterMs === 'number' && payload.refreshAfterMs < expiresAt
        ? payload.refreshAfterMs
        : expiresAt - 60_000
    coreSessionToken = payload.token
    coreSessionExpiresAt = expiresAt
    coreSessionRefreshAfter = Math.max(Date.now(), refreshAfter)
    return payload.token
  })()

  try {
    return await coreSessionRequest
  } finally {
    coreSessionRequest = null
  }
}

export function invalidateCoreSessionToken(): void {
  coreSessionToken = null
  coreSessionExpiresAt = 0
  coreSessionRefreshAfter = 0
  coreSessionRequest = null
  coreAvailability = null
  verifiedCoreInstanceId = null
}

/** Test-only: clears sticky authority state between unrelated test cases. */
export function resetCoreTransportStateForTests(): void {
  invalidateCoreSessionToken()
  coreAvailabilityRequest = null
  httpAuthorityEstablished = false
}

/**
 * Send a REST request to the shared Axum core.
 */
export async function webApiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  if (!(await canUseSharedCoreTransport())) throw new Error(CORE_UNAVAILABLE)
  const url = `${SERVER_BASE_URL}${path}`
  log('debug', 'HTTP', `${options?.method || 'GET'} ${path}`)

  try {
    const send = async () => {
      const token = await getCoreSessionToken()
      return fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...options?.headers,
        },
      })
    }
    let res = await send()
    if (res.status === 401) {
      invalidateCoreSessionToken()
      if (!(await canUseSharedCoreTransport())) throw new Error(CORE_UNAVAILABLE)
      res = await send()
    }
    if (!res.ok) {
      const errText = await res.text()
      if (res.status === 503) {
        log('debug', 'HTTP', `Backend is not ready at ${path}: ${errText}`)
      } else {
        log('error', 'HTTP', `Request failed with ${res.status} at ${path}: ${errText}`)
      }
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
    if (err instanceof Error && err.message.includes('503')) {
      log('debug', 'HTTP', `Retrying connection to ${path}...`)
    } else {
      log('error', 'HTTP', `Request error at ${path}`, err)
    }
    throw err
  }
}

/**
 * Open a bidirectional WebSocket connection to the shared core.
 */
export async function createWebSocketStream(path: string): Promise<WebSocket> {
  if (!(await canUseSharedCoreTransport())) throw new Error(CORE_UNAVAILABLE)
  const throughVite = window.location.port === '1422' || window.location.port === '1424'
  const directCore = isTauriEnv()
  const protocol = !directCore && window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = directCore
    ? '127.0.0.1:1423'
    : throughVite
      ? window.location.host
      : window.location.host || '127.0.0.1:1423'
  const wsUrl = `${protocol}//${host}${path}`
  log('info', 'WS', `Connecting WebSocket to ${wsUrl}`)
  const token = await getCoreSessionToken()
  return new WebSocket(wsUrl, [`alethe-auth.${token}`])
}
