/**
 * Ponte fina pro hook real de e2e exposto pelo app (`window.__ALETHE_E2E__`,
 * ver `src/lib/e2eHooks.ts`) — chamado via `browser.execute()` PADRÃO do
 * WebDriver (não `browser.tauri.execute()`).
 *
 * MUDANÇA DE ABORDAGEM CONFIRMADA AO VIVO NESTA SESSÃO: `browser.tauri
 * .execute()` (a ponte específica de Tauri do `@wdio/tauri-service`) nunca
 * funciona nesse ambiente — todo `tauri.core.invoke(...)` estourava
 * "Tauri core.invoke not available after 5s timeout", reproduzido de forma
 * isolada e determinística. A alternativa óbvia (bater direto no backend
 * via `fetch()` HTTP a partir do Node, contornando o webview) FOI
 * DELIBERADAMENTE REJEITADA: isso testaria só o backend, nunca o FRONTEND —
 * e é exatamente no frontend que bugs reais já apareceram nesta sessão
 * (Parte 1: o gate de validação mentindo; correções de sincronização de
 * terminal). `browser.execute()` padrão FOI confirmado funcionando (alcança
 * `window.location`, `window.__ALETHE_E2E__` etc. na página real) — então
 * cada helper aqui chama, via uma função literal (serialização padrão do
 * WebdriverIO, sem reconstrução manual de string), a função exposta pelo
 * hook — que por sua vez chama a função REAL de `src/lib/api/*` que a UI de
 * verdade usa (mesma decisão `isTauriEnv()`/`canUseSharedCoreTransport()`
 * de sempre).
 */
type AletheE2EWindow = {
  __ALETHE_E2E__?: {
    pty: {
      spawn: (cwd: string, command?: string, cols?: number, rows?: number) => Promise<string>
      write: (id: string, data: string) => Promise<void>
      readScrollback: (id: string, maxBytes?: number) => Promise<string>
      exists: (id: string) => Promise<boolean>
      getSize: (id: string) => Promise<{ cols: number; rows: number }>
      resize: (id: string, cols: number, rows: number) => Promise<void>
      kill: (id: string) => Promise<void>
    }
  }
}

export const DEFAULT_PROFILE_ID = 'default'

export async function spawnPty(opts: {
  cwd: string
  command?: string
  cols?: number
  rows?: number
  profileId?: string
}): Promise<string> {
  const result = await invokeTauri<{ id: string }>('spawn_pty', {
    cwd: opts.cwd,
    command: opts.command,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    profileId: opts.profileId ?? DEFAULT_PROFILE_ID,
  })
  return result.id
}

export async function writePtyData(
  id: string,
  data: string,
  profileId = DEFAULT_PROFILE_ID,
): Promise<void> {
  await invokeTauri('write_pty', { id, data, profileId })
}

/** Manda uma linha de comando (adiciona o Enter certo pro SO). */
export async function sendPtyLine(
  id: string,
  line: string,
  profileId = DEFAULT_PROFILE_ID,
): Promise<void> {
  await writePtyData(id, `${line}\r`, profileId)
}

export async function readPtyScrollback(
  id: string,
  maxBytesOrProfile?: number | string,
  profileId?: string,
): Promise<string> {
  const maxBytes = typeof maxBytesOrProfile === 'number' ? maxBytesOrProfile : 65536
  const profile =
    typeof maxBytesOrProfile === 'string' ? maxBytesOrProfile : (profileId ?? DEFAULT_PROFILE_ID)
  const result = await invokeTauri<string>('attach_pty', { id, maxBytes, profileId: profile })
  return result ?? ''
}

export async function ptyStillExists(id: string, profileId = DEFAULT_PROFILE_ID): Promise<boolean> {
  return invokeTauri<boolean>('pty_exists', { id, profileId })
}

export async function invokeTauri<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  await browser.waitUntil(
    async () => {
      return browser.execute(() => {
        const tauri = window as unknown as {
          __TAURI_INTERNALS__?: { invoke: unknown }
          __TAURI__?: { core?: { invoke: unknown } }
        }
        return Boolean(tauri.__TAURI_INTERNALS__?.invoke ?? tauri.__TAURI__?.core?.invoke)
      })
    },
    { timeout: 15_000, interval: 300, timeoutMsg: 'Tauri invoke não ficou pronto em 15s' },
  )
  const result = await browser.execute(
    (command, invokeArgs) => {
      const tauri = window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        __TAURI__?: { core?: { invoke: (c: string, a?: unknown) => Promise<unknown> } }
      }
      const invokeFn = tauri.__TAURI_INTERNALS__?.invoke ?? tauri.__TAURI__?.core?.invoke
      if (!invokeFn) throw new Error('Tauri invoke function não encontrada em window')
      return invokeFn(command, invokeArgs)
    },
    cmd,
    args,
  )
  return result as unknown as T
}

export async function getPtyGridSize(
  id: string,
  profileId = DEFAULT_PROFILE_ID,
): Promise<{ cols: number; rows: number }> {
  return invokeTauri<{ cols: number; rows: number }>('get_pty_size', { id, profileId })
}

export async function resizePty(
  id: string,
  cols: number,
  rows: number,
  profileId = DEFAULT_PROFILE_ID,
): Promise<void> {
  await invokeTauri('resize_pty', { id, cols, rows, profileId })
}

export async function killPty(id: string, profileId = DEFAULT_PROFILE_ID): Promise<void> {
  await invokeTauri('kill_pty', { id, profileId }).catch(() => {})
}

/**
 * `write_pty` retorna sucesso assim que os bytes chegam no PTY — isso NÃO
 * prova que o processo do outro lado (um CLI de agente ainda inicializando)
 * estava pronto pra interpretar aquilo como um prompt de verdade. É
 * exatamente o tipo de falso positivo raso que motivou essa suíte inteira:
 * a chamada "funciona" (sem erro), mas o texto se perde numa tela de
 * carregamento, splash, ou é mal-interpretado por um diálogo de
 * sim/não ainda aberto. Espera o scrollback "assentar" (parar de mudar por
 * `stableForMs` seguidos) antes de considerar o terminal pronto pra receber
 * entrada de verdade — mesmo princípio já usado no settle-check de resize
 * do app real (`useXtermSession.ts`), aplicado aqui pro conteúdo do CLI.
 */
export async function waitForScrollbackStable(
  id: string,
  {
    timeoutMs = 30_000,
    stableForMs = 1200,
    pollMs = 500,
  }: { timeoutMs?: number; stableForMs?: number; pollMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastContent: string | null = null
  let stableSince = 0
  while (Date.now() < deadline) {
    const content = await readPtyScrollback(id).catch(() => '')
    if (content === lastContent && content.trim().length > 0) {
      if (stableSince === 0) stableSince = Date.now()
      if (Date.now() - stableSince >= stableForMs) return content
    } else {
      lastContent = content
      stableSince = 0
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new Error(`waitForScrollbackStable: PTY ${id} nunca assentou em ${timeoutMs}ms`)
}

/** Padrões de diálogo de confiança/permissão vistos ao vivo nesta sessão
 *  (Antigravity: "Do you trust the contents of this project?") — bloqueiam
 *  o CLI até alguém responder. Heurística deliberadamente ampla (vários
 *  CLIs de agente têm variações desse mesmo tipo de prompt na primeira
 *  execução numa pasta nova). */
const TRUST_OR_PERMISSION_PATTERNS = [
  /do you trust/i,
  /trust the contents/i,
  /trust this (folder|project|directory)/i,
  /requires permission/i,
  /allow .* to (access|read|edit)/i,
]

/**
 * Espera o CLI do agente terminar de subir e, se ele estiver preso num
 * diálogo de confiança/permissão, responde automaticamente (Enter no
 * default, geralmente "Sim") antes de devolver o controle — só DEPOIS disso
 * é seguro mandar um prompt de trabalho de verdade. Sem isso, o primeiro
 * prompt real chegava cedo demais nesse tipo de tela e era engolido sem
 * nenhum erro reportado.
 */
export async function ensureAgentReady(
  id: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  let content = await waitForScrollbackStable(id, opts)
  if (TRUST_OR_PERMISSION_PATTERNS.some((pattern) => pattern.test(content))) {
    await sendPtyLine(id, '')
    content = await waitForScrollbackStable(id, opts)
    // Ainda preso num diálogo depois de um Enter — tenta "y" explícito
    // (padrão comum quando o default não é a opção afirmativa).
    if (TRUST_OR_PERMISSION_PATTERNS.some((pattern) => pattern.test(content))) {
      await sendPtyLine(id, 'y')
      await waitForScrollbackStable(id, opts)
    }
  }
}

/**
 * Espera até que `predicate()` resolva com um valor truthy, ou estoura
 * timeout. Usado no lugar de esperas fixas porque o tempo de um agente real
 * (OpenCode) processar um prompt varia bastante (cold start do CLI, latência
 * do modelo) — um sleep fixo seria ou lento demais no caso comum ou flaky no
 * caso lento.
 */
export async function waitUntil<T>(
  predicate: () => Promise<T | null | undefined | false>,
  { timeoutMs = 30_000, intervalMs = 1000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(
    `waitUntil: timeout após ${timeoutMs}ms${lastError ? ` (último erro: ${String(lastError)})` : ''}`,
  )
}
