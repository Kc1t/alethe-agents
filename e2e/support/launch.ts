import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
 * Gera um wrapper (não o binário direto) que seta `ALETHE_E2E=1` + redireciona
 * o data dir do SO (HOME/XDG_DATA_HOME no Linux/macOS, APPDATA no Windows)
 * pra uma pasta temporária isolada, antes de executar o binário real. O
 * data dir do Alethe vem de `app.path().app_local_data_dir()` (Tauri), que por
 * sua vez segue o padrão do SO — redirecionar essas variáveis é o jeito mais
 * simples de garantir zero contato com `%APPDATA%/Alethe` de verdade, sem
 * precisar de nenhum código novo no lado Rust.
 *
 * `@wdio/tauri-service` não expõe um campo `env` em `tauri:options`, só
 * `application`/`args` — por isso o wrapper, e não variáveis passadas direto
 * na capability.
 */
export function prepareIsolatedLaunch(): { applicationPath: string; cleanup: () => void } {
  const binary = realBinaryPath()
  const dataDir = mkdtempSync(join(tmpdir(), 'alethe-e2e-'))

  const wrapperPath =
    process.platform === 'win32' ? join(dataDir, 'launch.cmd') : join(dataDir, 'launch.sh')

  if (process.platform === 'win32') {
    writeFileSync(
      wrapperPath,
      `@echo off\r\nset ALETHE_E2E=1\r\nset APPDATA=${dataDir}\r\n"${binary}" %*\r\n`,
    )
  } else {
    writeFileSync(
      wrapperPath,
      `#!/usr/bin/env bash\nset -e\nexport ALETHE_E2E=1\nexport HOME="${dataDir}"\nexport XDG_DATA_HOME="${dataDir}/.local/share"\nexec "${binary}" "$@"\n`,
    )
    chmodSync(wrapperPath, 0o755)
  }

  return {
    applicationPath: wrapperPath,
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
