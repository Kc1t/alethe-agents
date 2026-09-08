import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The E2E binary uses the identifier from `tauri.conf.json`, without the
 * development suffix. It must exactly match the standalone Core identity.
 */
const SHARED_APP_IDENTIFIER = 'com.kc1t.alethe'

function tauriBinaryPath(): string {
  const name = process.platform === 'win32' ? 'alethe.exe' : 'alethe'
  return join(ROOT, 'target-e2e', 'debug', name)
}

function aletheServerBinaryPath(): string {
  const name = process.platform === 'win32' ? 'alethe-server.exe' : 'alethe-server'
  return join(ROOT, 'target-e2e', 'debug', name)
}

/** Isolates both E2E processes while giving them the same temporary data root. */
export function prepareSharedCoreLaunch(): {
  tauriApplicationPath: string
  tauriEnv: Record<string, string>
  serverBinaryPath: string
  serverEnv: Record<string, string>
  cleanup: () => void
} {
  const dataDir = process.env.ALETHE_SHARED_SYNC_DIR || join(tmpdir(), 'alethe-e2e-shared-sync')
  mkdirSync(dataDir, { recursive: true })
  return {
    tauriApplicationPath: tauriBinaryPath(),
    tauriEnv: { ALETHE_E2E: '1', ALETHE_APP_DATA_DIR: dataDir },
    serverBinaryPath: aletheServerBinaryPath(),
    serverEnv: {
      ALETHE_APP_DATA_DIR: dataDir,
      ALETHE_APP_IDENTIFIER: SHARED_APP_IDENTIFIER,
    },
    cleanup: () => {
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** Polls `/api/health` until it reports `status: "ok"` or times out. */
export async function waitForCoreHealth(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`)
      if (res.ok) {
        const body = (await res.json()) as { status?: string }
        if (body.status === 'ok') return
      }
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(
    `waitForCoreHealth: ${baseUrl}/api/health did not report "ok" within ${timeoutMs}ms` +
      (lastError ? ` (last error: ${String(lastError)})` : ''),
  )
}
