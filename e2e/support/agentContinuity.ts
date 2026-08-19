import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensureAgentReady, readPtyScrollback, sendPtyLine, waitUntil } from './ptyAgent'
import { sendOpenCodePrompt } from './openCodePrompt'

const RULE_PREFIX = 'ALETHE_E2E_RULE: '

export type ContinuityResult = {
  file1Path: string
  file2Path: string
  file1Exists: boolean
  file2Exists: boolean
  file2FollowsRule: boolean
  /**
   * Verdadeiro só quando os dois arquivos existem E o segundo seguiu a regra
   * do primeiro sem ela ter sido repetida no segundo prompt — prova de que a
   * MESMA sessão de agente manteve contexto real entre os dois turnos, não
   * só que o CLI consegue mexer em arquivo. Se o arquivo 2 existe mas não
   * segue a regra, a conclusão é que não era a mesma sessão — ela "nasceu
   * vazia" e só criou um arquivo novo sem memória do que veio antes.
   */
  sessionLikelyContinuous: boolean
}

/**
 * Cenário de continuidade de sessão pedido explicitamente nesta tarefa:
 * prompt 1 manda o agente criar um arquivo com uma regra explícita; prompt 2
 * pede um SEGUNDO arquivo "seguindo a mesma regra" sem repeti-la. O sistema
 * verifica os dois fatos direto no disco (nunca confiando no que o agente
 * *diz* que fez): o arquivo 1 existe, o arquivo 2 existe, e o conteúdo do
 * arquivo 2 realmente obedece a regra do arquivo 1.
 *
 * Reaproveitado em três cenários do plano: 1 terminal (baseline), 2
 * terminais simultâneos (concorrência), e "terminal volta a subir depois do
 * merge" (roda de novo numa sessão nova, no projeto já integrado).
 */
export async function verifyAgentSessionContinuity(
  ptyId: string,
  worktreePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<ContinuityResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000

  // Pré-checagem defensiva: responde um eventual diálogo de confiança/
  // permissão (visto ao vivo no Antigravity — "Do you trust the contents of
  // this project?") ANTES de mandar qualquer prompt de trabalho. A entrega
  // do prompt em si (`sendOpenCodePrompt`, abaixo) já reaproveita a lógica
  // real de digitação/confirmação do app (`agentPromptDelivery.ts`), que
  // por si só já tolera o CLI ainda estar carregando — isso aqui cobre só a
  // tela ANTERIOR à caixa de prompt, que aquela lógica não conhece.
  await ensureAgentReady(ptyId, { timeoutMs: 60_000 })

  const tag = Math.random().toString(36).slice(2, 8)
  const file1Name = `alethe-e2e-file1-${tag}.txt`
  const file2Name = `alethe-e2e-file2-${tag}.txt`
  const file1Path = join(worktreePath, file1Name)
  const file2Path = join(worktreePath, file2Name)

  const prompt1 =
    `Create a file named "${file1Name}" in the current working directory with exactly 3 lines of ` +
    `plain text. Every single line MUST start with the exact literal prefix "${RULE_PREFIX}" ` +
    `followed by any short unique text of your choice. Do not create any other files, do not add ` +
    'explanation — just create that one file with that exact rule.'
  const delivered1 = await sendOpenCodePrompt(ptyId, prompt1, { timeoutMs })
  if (!delivered1) {
    throw new Error(
      `verifyAgentSessionContinuity: prompt 1 não foi confirmado na tela do OpenCode (pty=${ptyId})`,
    )
  }

  await waitUntil(
    async () => {
      if (existsSync(file1Path)) return true
      const screen = await readPtyScrollback(ptyId).catch(() => '')
      if (/(allow|approve|permission|do you want to|trust|confirm|accept|\[y\/n\]|\[y\/N\]|\[Y\/n\])/i.test(screen)) {
        await sendPtyLine(ptyId, 'y')
      } else if (/(press enter|to continue)/i.test(screen)) {
        await sendPtyLine(ptyId, '')
      }
      return null
    },
    {
      timeoutMs,
      intervalMs: 1000,
    },
  )

  const prompt2 =
    `Now create a second file named "${file2Name}" in the current working directory, with exactly ` +
    '2 lines, following the EXACT SAME rule as the file you just created for me. Do not restate or ' +
    "re-explain the rule back to me — you already know it from what you just did. Just apply it."
  const delivered2 = await sendOpenCodePrompt(ptyId, prompt2, { timeoutMs })
  if (!delivered2) {
    throw new Error(
      `verifyAgentSessionContinuity: prompt 2 não foi confirmado na tela do OpenCode (pty=${ptyId})`,
    )
  }

  await waitUntil(
    async () => {
      if (existsSync(file2Path)) return true
      const screen = await readPtyScrollback(ptyId).catch(() => '')
      if (/(allow|approve|permission|do you want to|trust|confirm|accept|\[y\/n\]|\[y\/N\]|\[Y\/n\])/i.test(screen)) {
        await sendPtyLine(ptyId, 'y')
      } else if (/(press enter|to continue)/i.test(screen)) {
        await sendPtyLine(ptyId, '')
      }
      return null
    },
    {
      timeoutMs,
      intervalMs: 1000,
    },
  )

  const file1Exists = existsSync(file1Path)
  const file2Exists = existsSync(file2Path)
  const file2Lines = file2Exists
    ? readFileSync(file2Path, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    : []
  const file2FollowsRule = file2Lines.length > 0 && file2Lines.every((line) => line.startsWith(RULE_PREFIX))

  return {
    file1Path,
    file2Path,
    file1Exists,
    file2Exists,
    file2FollowsRule,
    sessionLikelyContinuous: file1Exists && file2Exists && file2FollowsRule,
  }
}
