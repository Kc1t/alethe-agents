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
 * Isola o data dir numa pasta temporária, pra garantir ZERO contato com o
 * perfil real do dono (`%LOCALAPPDATA%\Alethe` no Windows, `~/.local/share`
 * no Linux, etc.).
 *
 * BUG REAL CONFIRMADO NESTA SESSÃO (achado pelo dono, rodando ao vivo): a
 * versão anterior deste arquivo sobrescrevia `APPDATA` (pasta Roaming) no
 * Windows, mas `app.path().app_local_data_dir()` do Tauri resolve por
 * `%LOCALAPPDATA%` (pasta Local) — uma variável DIFERENTE, nunca tocada. O
 * isolamento nunca funcionou de verdade no Windows: todo run de e2e abria
 * contra o perfil real do dono, com projetos/repositórios reais. Confirmado
 * empiricamente (`%APPDATA%\Alethe` nem existe; `%LOCALAPPDATA%\Alethe` é
 * onde os dados de verdade ficam).
 *
 * Correção: usa `ALETHE_APP_DATA_DIR`, o override explícito que TANTO
 * `resolve_tauri_data_root` (desktop) QUANTO `resolve_standalone_data_root`
 * (`alethe-server`) checam ANTES de qualquer resolução por SO
 * (`src-tauri/src/profiles.rs`) — não depende de adivinhar qual variável de
 * ambiente o SO/Tauri realmente consulta em cada plataforma. Mantém
 * `HOME`/`APPDATA`/`XDG_DATA_HOME` como isolamento de reforço (nunca fazem
 * mal, só não são mais a proteção principal).
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
export function prepareIsolatedLaunch(dataDir = mkdtempSync(join(tmpdir(), 'alethe-e2e-'))): {
  applicationPath: string
  dataDir: string
  env: Record<string, string>
  cleanup: () => void
} {
  const env: Record<string, string> = {
    ALETHE_E2E: '1',
    ALETHE_APP_DATA_DIR: dataDir,
    ...(process.platform === 'win32'
      ? { APPDATA: dataDir, LOCALAPPDATA: dataDir }
      : { HOME: dataDir, XDG_DATA_HOME: join(dataDir, '.local', 'share') }),
  }

  return {
    applicationPath: realBinaryPath(),
    dataDir,
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
