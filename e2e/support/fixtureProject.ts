import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * "Uma pasta sem nada" — projeto-fixture pra Parte 4 do plano da Central de
 * Merges. Criada do zero a cada execução (nunca reaproveitada entre runs,
 * nunca commitada no repositório do Alethe): uma pasta verdadeiramente vazia
 * não sobrevive ao git (diretórios vazios não são versionados), e reusar uma
 * pasta fixa acumularia histórico de execuções anteriores, quebrando a
 * premissa de "sempre começa vazio, sem `.git`".
 */
export function createEmptyFixtureProject(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'alethe-e2e-fixture-'))
  return {
    path,
    cleanup: () => {
      try {
        git(path, ['worktree', 'prune'])
      } catch {}
      try {
        rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
      } catch {}
    },
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/**
 * Setup de baixo nível via `git` cru (Node `child_process`, NUNCA via Alethe)
 * — usado só pra preparar o estado inicial que o teste não está verificando
 * (ex. dar ao repo um commit inicial em `main` antes de testar o pipeline de
 * merge). Deliberadamente fora do caminho testado: se isso usasse os mesmos
 * comandos do Alethe, um bug ali poderia mascarar a própria preparação do
 * teste.
 */
export function initRepoWithInitialCommit(repoPath: string, defaultBranch = 'main'): void {
  git(repoPath, ['init', '--initial-branch', defaultBranch])
  git(repoPath, ['config', 'user.email', 'e2e@alethe.test'])
  git(repoPath, ['config', 'user.name', 'Alethe E2E'])
  execFileSync('git', ['commit', '--allow-empty', '-m', 'initial commit'], {
    cwd: repoPath,
    encoding: 'utf8',
  })
}

/**
 * Confirmação INDEPENDENTE de que um `.git` real existe — nunca através de
 * nenhuma API do Alethe. É o contraponto de "o app diz que inicializou";
 * aqui é o sistema de arquivos que decide.
 */
export function hasRealGitDir(repoPath: string): boolean {
  return existsSync(join(repoPath, '.git'))
}

/**
 * Commit direto (fora do Alethe) num branch específico, tocando `filePath`
 * com `content` — usado pra forçar um conflito real e determinístico: o
 * teste escreve uma mudança concorrente na MESMA linha/arquivo que o
 * worktree do agente também alterou, ao invés de esperar o agente "por
 * acaso" conflitar.
 */
export function commitFileOnBranch(
  repoPath: string,
  branch: string,
  filePath: string,
  content: string,
  message: string,
): void {
  const currentBranch = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (currentBranch !== branch) git(repoPath, ['checkout', branch])
  writeFileSync(join(repoPath, filePath), content)
  git(repoPath, ['add', filePath])
  git(repoPath, ['commit', '-m', message])
}

/**
 * Verificação independente pós-merge: lê o `git log`/`git show` DIRETO no
 * repositório (nunca via Alethe) e confirma que o conteúdo esperado está
 * mesmo no HEAD da branch alvo — a asserção que substitui "confiar no que
 * o app diz que aconteceu".
 */
export function fileContentAtBranchHead(
  repoPath: string,
  branch: string,
  filePath: string,
): string | null {
  try {
    return git(repoPath, ['show', `${branch}:${filePath}`])
  } catch {
    return null
  }
}

export function lastCommitSubjectOnBranch(repoPath: string, branch: string): string {
  return git(repoPath, ['log', '-1', '--format=%s', branch])
}
