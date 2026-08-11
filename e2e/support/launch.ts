import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function realBinaryPath(): string {
  const name = process.platform === 'win32' ? 'alethe.exe' : 'alethe'
  // target-e2e, não target/: build isolada, nunca compartilha o binário nem o
  // lock de build com a sessão interativa de `tauri dev` do dono (ver
  // CARGO_TARGET_DIR no script `test:e2e:build` do package.json).
  return join(ROOT, 'src-tauri', 'target-e2e', 'debug', name)
}

/**
 * Isola o data dir do SO (HOME/XDG_DATA_HOME no Linux/macOS, APPDATA no
 * Windows) numa pasta temporária, pra garantir zero contato com
 * `%APPDATA%/Alethe` de verdade — sem precisar de nenhum código novo no lado
 * Rust (o data dir do Alethe vem de `app.path().app_local_data_dir()`, que
 * segue o padrão do SO).
 *
 * O binário real é apontado direto em `application` (nunca um wrapper
 * `.cmd`/`.sh`): `@wdio/tauri-service` spawna com `child_process.spawn(path,
 * args, {...})` sem `shell: true` (confirmado lendo o pacote) — no Windows,
 * spawnar um `.cmd` sem shell falha com `EINVAL` (não é um executável nativo
 * pro `CreateProcess`), então um wrapper batch quebrava o E2E de propósito.
 * As variáveis de ambiente de isolamento vão via
 * `wdio:tauriServiceOptions.env` (opção documentada da própria lib, que
 * chega intacta no spawn final — `mergeOptions` faz um spread simples, sem
 * whitelist), não via wrapper.
 */
export function prepareIsolatedLaunch(): {
  applicationPath: string
  env: Record<string, string>
  cleanup: () => void
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'alethe-e2e-'))
  const env: Record<string, string> =
    process.platform === 'win32'
      ? { ALETHE_E2E: '1', APPDATA: dataDir }
      : { ALETHE_E2E: '1', HOME: dataDir, XDG_DATA_HOME: join(dataDir, '.local', 'share') }

  return {
    applicationPath: realBinaryPath(),
    env,
    cleanup: () => {
      // Só apaga a pasta temporária. Matar o processo é responsabilidade do
      // @wdio/tauri-service (dono do ciclo de vida do app que ele mesmo
      // spawnou) — um pkill por nome/caminho aqui arriscaria acertar o
      // `target/debug/alethe` do `tauri dev` interativo do dono, que usa o
      // MESMO binário. Nunca vale esse risco só pra limpeza de teste.
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
