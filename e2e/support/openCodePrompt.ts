import { deliverOpenCodePrompt } from '../../src/lib/agentPromptDelivery'
import { readPtyScrollback, writePtyData, DEFAULT_PROFILE_ID } from './ptyAgent'

/**
 * Padrão de remoção de sequências ANSI (mesmo formato usado pelo pacote
 * `ansi-regex`/`strip-ansi`, reescrito aqui via `RegExp` + escapes unicode
 * explícitos — nunca caracteres de controle literais embutidos no source —
 * em vez de depender de um pacote transitivo não declarado direto em
 * `package.json`). Necessário porque `attach_pty` devolve o scrollback CRU
 * do backend (ANSI ainda embutido) — bem diferente do buffer já renderizado
 * que o app real lê do xterm.js (ver comentário grande em
 * `agentPromptDelivery.ts` sobre por que isso importa pro matching
 * funcionar).
 */
const ANSI_PATTERN = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  ].join('|'),
  'g',
)

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/**
 * Manda um prompt de trabalho pro OpenCode reaproveitando EXATAMENTE a
 * mesma lógica de digitação/confirmação do app real (`deliverOpenCodePrompt`,
 * `src/lib/agentPromptDelivery.ts`) — só troca "ler a tela" (buffer do
 * xterm.js no app; scrollback do backend, limpo de ANSI, aqui) e "escrever"
 * (writePty do app; `write_pty` via Tauri aqui). Pedido explícito: não
 * reinventar uma heurística nova pra algo que já foi testado e aprovado ao
 * vivo — só encaixar no ambiente de teste.
 */
export async function sendOpenCodePrompt(
  ptyId: string,
  prompt: string,
  opts: { timeoutMs?: number; profileId?: string } = {},
): Promise<boolean> {
  const profileId = opts.profileId ?? DEFAULT_PROFILE_ID
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000)
  return deliverOpenCodePrompt(prompt, deadline, {
    readScreenText: async () => stripAnsi(await readPtyScrollback(ptyId, 65536, profileId)),
    write: (data) => writePtyData(ptyId, data, profileId),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isCancelled: () => false,
  })
}
