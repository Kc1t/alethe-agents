import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Identifier fixo do binário Tauri de e2e: `test:e2e:build` roda
 * `tauri build --debug --no-bundle` SEM `--config tauri.dev.json`, então usa
 * o `identifier` de `src-tauri/tauri.conf.json` tal como está — nunca o
 * sufixo `.dev` que o `alethe-server` resolveria sozinho em build debug.
 * Precisa bater EXATO com o `appIdentifier` que o app desktop reporta em
 * `/api/health`, senão `matchesCoreIdentity` recusa o core compartilhado
 * (ver `src/lib/api/transport.ts`) e as duas sessões nunca compartilham PTY.
 */
const SHARED_APP_IDENTIFIER = 'com.kc1t.alethe'

function tauriBinaryPath(): string {
  const name = process.platform === 'win32' ? 'alethe.exe' : 'alethe'
  return join(ROOT, 'src-tauri', 'target-e2e', 'debug', name)
}

function aletheServerBinaryPath(): string {
  const name = process.platform === 'win32' ? 'alethe-server.exe' : 'alethe-server'
  return join(ROOT, 'src-tauri', 'target-e2e', 'debug', name)
}

/**
 * Isola os dois processos (app Tauri de e2e + `alethe-server`) do
 * `%APPDATA%/Alethe` real E garante que os dois apontem pro MESMO data root
 * — condição pra `canUseSharedCoreTransport()` aceitar o core do outro
 * processo como o mesmo core (`matchesCoreIdentity` compara
 * `appIdentifier`+`dataRootId`; `dataRootId` é derivado do caminho real do
 * data root, então bastam os dois processos apontarem pra pasta idêntica).
 */
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

/** Faz polling de `/api/health` até responder `status: "ok"` ou estourar o timeout. */
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
    `waitForCoreHealth: ${baseUrl}/api/health não respondeu "ok" em ${timeoutMs}ms` +
      (lastError ? ` (último erro: ${String(lastError)})` : ''),
  )
}
