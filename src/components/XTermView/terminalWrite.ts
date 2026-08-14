import { readScopedStorage } from '../../lib/storageNamespace'
import { writePty } from '../../lib/tauri'

export const PROMPT_HISTORY_KEY = (id: string) => `prompt-history:${id}`

// Constantes de tuning de escrita/colagem no PTY.
export const PASTE_CHUNK_SIZE = 1024
export const PASTE_CHUNK_DELAY_MS = 8
// Espalha rajadas grandes de saída por frames pra terminal.write não travar a WebView.
// 16 KiB (não 64 KiB): redraws densos de TUI (ex. OpenCode em alternate buffer,
// muita cor/movimento) custam bem mais tempo de parse+render por byte do que
// texto plano — um terminal.write() de 64 KiB desse tipo de conteúdo já foi
// grande o bastante pra travar o frame por si só. Mais frames pro replay
// terminar > qualquer frame individual travando por muito tempo.
export const TERMINAL_WRITE_FRAME_BUDGET = 16 * 1024

export function loadPromptHistory(ptyId: string): string[] {
  const raw = readScopedStorage(PROMPT_HISTORY_KEY(ptyId), true)
  if (!raw) return []
  const history = JSON.parse(raw) as string[]
  return history
}

export async function writePtyChunked(
  id: string,
  text: string,
  bracketed: boolean,
  profileId: string,
): Promise<void> {
  // Bracketed paste (DECSET 2004): quando a app liga, envolvemos a colagem
  // inteira nos marcadores 200~/201~ pra ela tratar como um bloco único. Sem
  // isso, cada \r interno vira Enter e TUIs como o Claude submetem só a
  // primeira linha — a colagem grande chegava cortada. Os marcadores ficam
  // FORA do chunking pra nunca serem partidos no meio.
  const open = bracketed ? '\x1b[200~' : ''
  const close = bracketed ? '\x1b[201~' : ''

  if (text.length <= PASTE_CHUNK_SIZE) {
    await writePty(id, `${open}${text}${close}`, profileId)
    return
  }

  if (open) await writePty(id, open, profileId)
  for (let index = 0; index < text.length; index += PASTE_CHUNK_SIZE) {
    await writePty(id, text.slice(index, index + PASTE_CHUNK_SIZE), profileId)
    await new Promise((resolve) => window.setTimeout(resolve, PASTE_CHUNK_DELAY_MS))
  }
  if (close) await writePty(id, close, profileId)
}
