import { realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Where the local Alethe Core is expected to answer.
 *
 * `ALETHE_SERVER_PORT` is what pins the Core to a different port when 1423 is taken (see
 * `bind_server_listener` in `server_main/mod.rs`), and both `vite.config.ts` and the launcher
 * honour it. Ignoring it here meant `--diagnose` probed 1423 regardless and reported "no Core
 * found" about a Core that was running perfectly well one port over.
 */
export const CORE_PORT = Number(process.env.ALETHE_SERVER_PORT) || 1423
export const CORE_URL = `http://127.0.0.1:${CORE_PORT}`
export const CORE_API_VERSION = 1

export function expectedAppIdentifier(env = process.env) {
  return env.ALETHE_APP_IDENTIFIER?.trim() || 'com.kc1t.alethe.dev'
}

export async function dataRootFingerprint(dataRoot) {
  const canonical = await realpath(path.resolve(dataRoot)).catch(() => path.resolve(dataRoot))
  const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(normalized)) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

export async function expectedCoreIdentity(env = process.env) {
  const identity = { appIdentifier: expectedAppIdentifier(env) }
  const explicitRoot = env.ALETHE_APP_DATA_DIR
  if (explicitRoot && !path.isAbsolute(explicitRoot)) {
    throw new Error('ALETHE_APP_DATA_DIR must be an absolute path')
  }
  const defaultBase =
    process.platform === 'win32'
      ? env.LOCALAPPDATA
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  const dataRoot = explicitRoot || (defaultBase && path.join(defaultBase, identity.appIdentifier))
  if (!dataRoot) throw new Error('Unable to resolve the expected Alethe data root')
  identity.dataRootId = await dataRootFingerprint(dataRoot)
  return identity
}

export function classifyCoreHealth(payload, expected) {
  const runtime = payload?.runtime ?? payload
  if (payload?.status !== 'ok' || (payload?.service ?? runtime?.service) !== 'alethe-core') {
    return { status: 'incompatible', reason: 'The listener is not an Alethe Core' }
  }
  if (runtime?.apiVersion !== CORE_API_VERSION) {
    return {
      status: 'incompatible',
      reason: `Core API ${String(runtime?.apiVersion ?? 'unknown')} is incompatible`,
    }
  }
  if (runtime?.appIdentifier !== expected.appIdentifier) {
    return {
      status: 'incompatible',
      reason: `Core identifier ${String(runtime?.appIdentifier ?? 'unknown')} does not match ${expected.appIdentifier}`,
    }
  }
  if (expected.dataRootId && runtime?.dataRootId !== expected.dataRootId) {
    return { status: 'incompatible', reason: 'Core storage identity does not match' }
  }
  if (!runtime?.instanceId) {
    return { status: 'incompatible', reason: 'Core instance identity is missing' }
  }
  return { status: 'compatible', runtime }
}

export async function probeCore({ fetchImpl = fetch, env = process.env, timeoutMs = 500 } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${CORE_URL}/api/health`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) {
      return { status: 'incompatible', reason: `Core health returned HTTP ${response.status}` }
    }
    return classifyCoreHealth(await response.json(), await expectedCoreIdentity(env))
  } catch (error) {
    if (error?.name === 'AbortError' || error instanceof TypeError) return { status: 'absent' }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
