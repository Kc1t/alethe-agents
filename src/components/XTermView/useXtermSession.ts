import { getCurrentWebview } from '@tauri-apps/api/webview'
import { CanvasAddon } from '@xterm/addon-canvas'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useEffect, useRef } from 'react'

import { recordAgentActivityInput } from '../../lib/activityTracker'
import { AgentCompletionMonitor } from '../../lib/agentCompletionMonitor'
import { preparePtyRuntimeLaunch } from '../../lib/agentRuntimeAdapter'
import { getLocale, translate } from '../../lib/i18n'
import { isWindows } from '../../lib/platform'
import { usePtyPanelVisible } from '../../lib/ptyVisibility'
import {
  claimDiscoveredSession,
  claimMostRecentSession,
  isSessionClaimed,
  registerSessionClaim,
} from '../../lib/sessionDiscovery'
import { buildAgentLaunch } from '../../lib/sessionLaunch'
import {
  consumeSession,
  removeSession,
  savedConversationIdFor,
  saveSession,
} from '../../lib/sessionResume'
import { waitForSessionHint } from '../../lib/sessionWatch'
import { acquireSpawnSlot, releaseSpawnSlot } from '../../lib/spawnQueue'
import {
  aiMemoryCodexConfigWrite,
  aiMemoryDetect,
  aiMemoryMcpConfigPath,
  aiMemoryOpenCodeConfigWrite,
  attachPty,
  findCliLauncher,
  graphifyCodexConfigWrite,
  graphifyEnsureGraph,
  graphifyMcpConfigPath,
  graphifyOpenCodeConfigWrite,
  gsdOpenCodePluginWrite,
  killPty,
  listenPtyActivity,
  listenPtyData,
  listenPtyExit,
  ptyExists,
  readClipboardPayload,
  readGsdChildSession,
  resizePty,
  setPtyVisible,
  snapshotAntigravitySessions,
  snapshotClaudeSessions,
  snapshotCodexSessions,
  snapshotOpenCodeSessions,
  spawnPty,
  writeClipboardText,
  writePty,
} from '../../lib/tauri'
import {
  agentCliCommand,
  type AgentRuntimeProfile,
  type AgentType,
  type Theme,
} from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import {
  formatDroppedPaths,
  getTerminalScrollbackRows,
  getWheelScrollLines,
  normalizePastedText,
  shouldScrollHostScrollback,
} from './terminalInput'
import {
  type DetectedTerminalLink,
  detectTerminalLinks,
  getLogicalTerminalLine,
  makeXtermLink,
} from './terminalLinks'
import { TERMINAL_WRITE_FRAME_BUDGET, writePtyChunked } from './terminalWrite'
import { getXtermTheme, type LinkActionState } from './xtermThemes'

// Early exits trigger a single fresh-session retry.
const EARLY_EXIT_MS = 4000
// Troca rápida de abas não deve disparar um resync completo (attachPty +
// terminal.reset()) a cada toggle transitório invisível→visível→invisível.
const PANEL_RESYNC_DEBOUNCE_MS = 80

/** Scheduling API (Chromium/WebView2 recente) — sem tipagem estável no
 * lib.dom.d.ts ainda. Ausente em runtimes mais antigos: retorna `false` e
 * `flushPendingWrite` segue no budget de bytes normal, sem regressão. */
function isBrowserInputPending(): boolean {
  const scheduling = (
    navigator as Navigator & {
      scheduling?: { isInputPending?: (opts?: { includeContinuous?: boolean }) => boolean }
    }
  ).scheduling
  return scheduling?.isInputPending?.() ?? false
}

// Avisa uma única vez por sessão do app quando a feature "AI Memory" está ligada
// mas o binário ai-memory não foi encontrado — não bloqueia o spawn do agente.
let aiMemoryMissingWarned = false

type BootPhase = 'preparing' | 'queued' | 'spawning' | 'attaching' | 'ready'

/**
 * Sessão do terminal xterm + PTY. É o coração do XTermView: cria o terminal,
 * conecta o streaming de dados/exit, resize, buffer de escrita, links e
 * drag-drop. Extraído VERBATIM do XTermView (mesmo corpo, mesma ordem de
 * setup/teardown, mesmas deps `[sessionPersistenceKey, retryKey]`) para reduzir
 * o index.tsx sem reescrever a lógica sensível — os valores do componente
 * (refs, setters de estado e helpers) são passados como argumentos.
 */
export function useXtermSession(params: {
  ptyId: string
  command?: AgentType | null
  cwd?: string | null
  extraArgs?: string[]
  initialInput?: string
  sessionId?: string
  env?: Record<string, string>
  graphifyRepo?: string | null
  /** Gate de Conclusão de Planejamento GSD: projeto com o monitoramento
   * ligado. Presente + `command === 'opencode'`: instala automaticamente o
   * plugin que mantém `.planning/` sincronizado sozinho antes do spawn. */
  gsdWatcherEnabled?: boolean
  /**
   * Pula a validação de "sessão órfã" (checagem contra `opencode session
   * list`) pro `sessionId` recebido — usado pelo terminal "viewer" da gaveta
   * GSD Sync. Confirmado empiricamente: `opencode session list` nunca lista
   * sessões-filha (têm `parent_id` setado pelo próprio servidor do OpenCode,
   * mesmo sem o cliente pedir isso), então a validação normal sempre trata
   * essa sessão como órfã, descarta o resume e apaga `sessionId` do tab —
   * era a causa real do "resume abre em branco".
   */
  trustSessionId?: boolean
  /**
   * Sessão-filha do GSD Sync: é a visão de subagente do próprio OpenCode,
   * não um terminal independente — nunca deve aceitar entrada (digitar,
   * colar, atalhos de force-kill/histórico), só leitura. Sem isso, a
   * sessão-filha nascia indistinguível de um terminal principal de verdade,
   * e dava pra digitar/corromper o subagente sem querer.
   */
  readOnly?: boolean
  runtimeProfile: AgentRuntimeProfile
  terminalTheme: Theme
  cliPathOverride: string | null
  sessionPersistenceKey: string
  retryKey: number
  containerRef: MutableRefObject<HTMLDivElement | null>
  terminalRef: MutableRefObject<Terminal | null>
  ptyIdRef: MutableRefObject<string | null>
  lastCtrlCRef: MutableRefObject<number>
  linkActionsRef: MutableRefObject<LinkActionState | null>
  spawnedAtRef: MutableRefObject<number>
  usedResumeRef: MutableRefObject<boolean>
  earlyExitRetriedRef: MutableRefObject<boolean>
  forceFreshRef: MutableRefObject<boolean>
  onSpawnedRef: MutableRefObject<((id: string) => void) | undefined>
  onSessionIdRef: MutableRefObject<((id: string | undefined) => void) | undefined>
  onInitialInputSentRef: MutableRefObject<(() => void) | undefined>
  onExitRef: MutableRefObject<((code: number | null) => void) | undefined>
  onAgentCompleteRef: MutableRefObject<(() => void) | undefined>
  setBootPhase: Dispatch<SetStateAction<BootPhase>>
  setCommandNotFound: Dispatch<SetStateAction<string | null>>
  setLinkActions: Dispatch<SetStateAction<LinkActionState | null>>
  setRetryKey: Dispatch<SetStateAction<number>>
  setDropActive: Dispatch<SetStateAction<boolean>>
  showLinkActionsMenu: (event: MouseEvent, link: DetectedTerminalLink) => void
  recordPromptInput: (data: string) => void
  navigateHistory: (direction: 'up' | 'down') => void
}) {
  const {
    ptyId,
    command,
    cwd,
    extraArgs,
    initialInput,
    sessionId,
    env,
    graphifyRepo,
    gsdWatcherEnabled,
    trustSessionId,
    readOnly,
    runtimeProfile,
    terminalTheme,
    cliPathOverride,
    sessionPersistenceKey,
    retryKey,
    containerRef,
    terminalRef,
    ptyIdRef,
    lastCtrlCRef,
    linkActionsRef,
    spawnedAtRef,
    usedResumeRef,
    earlyExitRetriedRef,
    forceFreshRef,
    onSpawnedRef,
    onSessionIdRef,
    onInitialInputSentRef,
    onExitRef,
    onAgentCompleteRef,
    setBootPhase,
    setCommandNotFound,
    setLinkActions,
    setRetryKey,
    setDropActive,
    showLinkActionsMenu,
    recordPromptInput,
    navigateHistory,
  } = params

  // Gate de visibilidade (ver plano de otimização de terminais paralelos):
  // painel fora da aba/grupo ativo não recebe mais escrita full-rate no
  // xterm — o backend passa a mandar só o canal `activity` (throttlado).
  const isPanelVisible = usePtyPanelVisible(ptyId)
  const isPanelVisibleRef = useRef(isPanelVisible)
  const wasPanelVisibleRef = useRef(isPanelVisible)
  // Primeira rodada do efeito de visibilidade (mount) não precisa chamar
  // setPtyVisible — attachExistingPty/start() já fazem essa chamada assim
  // que o id existe no backend. Evita um invoke concorrente extra bem no
  // meio da janela sensível de spawn de cada terminal.
  const isFirstVisibilityRunRef = useRef(true)
  // Preenchido dentro do efeito de mount com a função que refaz o replay do
  // scrollback (attachPty + reset) — chamado pelo efeito de visibilidade
  // abaixo quando o painel volta a ficar visível.
  const resyncTerminalRef = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    if (import.meta.env.DEV) {
      console.debug('[Alethe][xterm] mount', {
        sessionPersistenceKey,
        retryKey,
        ptyId: ptyIdRef.current,
      })
    }

    let disposed = false
    const spawnQueueAbort = new AbortController()
    let unlistenData: (() => void) | null = null
    let unlistenActivity: (() => void) | null = null
    let unlistenExit: (() => void) | null = null
    let unlistenDragDrop: (() => void) | null = null
    let resizeTimer: number | null = null
    let writeFrame: number | null = null
    let pendingWrites: string[] = []
    let pendingWriteLength = 0
    let resumeErrorBuffer = ''
    let lastCols = 0
    let lastRows = 0
    let forceNextResize = false
    let completionMonitor: AgentCompletionMonitor | null = null
    let linkProviderDisposable: { dispose: () => void } | null = null
    let linkScrollDisposable: { dispose: () => void } | null = null
    let writeRecoveryPending = false
    let queuedInput = ''
    let inputFlushScheduled = false
    let inputWriteChain = Promise.resolve()

    const resourcePolicy = useProjectsStore.getState().preferences.resourcePolicy
    const terminal = new Terminal({
      cursorBlink: !readOnly,
      // Bloqueia o pipeline interno de teclado→onData do xterm.js pra
      // sessões-filha do GSD Sync — visão de subagente, nunca um terminal
      // digitável. `onData` e os atalhos custom (Ctrl+V, histórico,
      // force-kill) abaixo também são gateados por segurança extra, já que
      // `disableStdin` sozinho não cobre `attachCustomKeyEventHandler`.
      disableStdin: Boolean(readOnly),
      convertEol: false,
      allowProposedApi: true,
      scrollback: getTerminalScrollbackRows({
        agent: command != null && command !== 'shell',
        memoryBudgetMb: resourcePolicy.memoryBudgetMb,
      }),
      // Só faz sentido com o backend ConPTY real do Windows. Aplicado sem
      // checagem, muda a semântica interna de reflow/resize do buffer do
      // xterm.js mesmo sobre um PTY Unix de verdade (Linux/macOS) — o
      // xterm.js passa a assumir que o backend redesenha a tela sozinho
      // (como o ConPTY faz), o que corrompe o repaint de TUIs densas que
      // não se redesenham por conta própria (ex: OpenCode).
      ...(isWindows() ? { windowsPty: { backend: 'conpty' as const, buildNumber: 22000 } } : {}),
      fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
      fontSize: 14,
      theme: getXtermTheme(terminalTheme),
    })
    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(searchAddon)
    // Sem isso, o xterm.js usa as tabelas de largura Unicode 6 (default) pra
    // decidir quantas colunas cada caractere ocupa — emojis e símbolos largos
    // (usados no TUI do OpenCode, ex. status bar) ficam com largura diferente
    // da que o próprio CLI assume, desalinhando toda linha que os contém de
    // forma permanente (não é um problema de redraw — nenhuma tecla conserta).
    terminal.loadAddon(new Unicode11Addon())
    terminal.unicode.activeVersion = '11'
    terminal.open(container)
    terminalRef.current = terminal
    const clampHorizontalScroll = () => {
      container.scrollLeft = 0
      const xterm = container.querySelector<HTMLElement>('.xterm')
      const viewport = container.querySelector<HTMLElement>('.xterm-viewport')
      const screen = container.querySelector<HTMLElement>('.xterm-screen')
      if (xterm) xterm.scrollLeft = 0
      if (viewport) viewport.scrollLeft = 0
      if (screen) screen.style.maxWidth = '100%'
    }
    linkProviderDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const logicalLine = getLogicalTerminalLine(terminal.buffer.active, bufferLineNumber)
        if (!logicalLine?.text) {
          callback(undefined)
          return
        }
        const links = detectTerminalLinks(logicalLine.text).map((link) =>
          makeXtermLink(logicalLine.startLine, terminal.cols, link, {
            openMenu: showLinkActionsMenu,
          }),
        )
        callback(links.length > 0 ? links : undefined)
      },
    })

    // Se a tela rola (stream do agente), o menu — ancorado no ponto do clique —
    // apontaria pro vazio; fecha junto pra não virar fantasma.
    linkScrollDisposable = terminal.onScroll(() => {
      if (linkActionsRef.current) setLinkActions(null)
    })

    // Renderer WebGL (GPU) — o renderer DOM padrão trava a digitação,
    // principalmente com zoom da WebView ≠ 100%. Fallback em camadas:
    // WebGL → Canvas 2D (bem mais rápido que DOM sob saída pesada, addon já
    // instalado mas até aqui nunca usado) → DOM puro como último recurso.
    let webglAddon: WebglAddon | null = null
    let canvasAddon: CanvasAddon | null = null
    const loadCanvasFallback = () => {
      if (canvasAddon) return
      try {
        canvasAddon = new CanvasAddon()
        terminal.loadAddon(canvasAddon)
      } catch {
        canvasAddon = null
      }
    }
    // WebGL desligado de propósito: perda de contexto pode derrubar um
    // syncScrollArea assíncrono interno do próprio xterm.js (fora do alcance
    // do onContextLoss/try-catch abaixo) e crashar o pane. Canvas 2D
    // (loadCanvasFallback, branch `else`) é o renderer real em uso — ainda
    // bem mais rápido que o DOM puro, sem esse risco de instabilidade.
    let releaseWebglContext: (() => void) | null = null
    if (releaseWebglContext) {
      try {
        webglAddon = new WebglAddon()
        webglAddon.onContextLoss(() => {
          if (disposed) return
          // Perda de contexto GL (ex.: muitos terminais estouram o limite de
          // contextos da WebView, ou soluço do processo de GPU). Descarta o
          // addon e NÃO recria — evita thrash — mas cai pro Canvas 2D antes
          // do DOM puro. `dispose()`/`loadAddon()` num renderer já quebrado
          // podem lançar sincronamente — sem o try/catch, isso aborta a troca
          // de renderer no meio e deixa o terminal sem WebGL nem Canvas.
          try {
            webglAddon?.dispose()
          } catch {
            /* renderer já inválido — segue o descarte mesmo assim */
          }
          webglAddon = null
          releaseWebglContext?.()
          releaseWebglContext = null
          loadCanvasFallback()
          // Um syncScrollArea assíncrono já agendado (nosso ou interno do
          // próprio xterm.js) pode ler `dimensions` de um renderer morto e
          // lançar ("Cannot read properties of undefined (reading
          // 'dimensions')"), o que cascateia e derruba a render. Força um
          // re-fit/refresh no próximo frame pra reestabelecer as dimensões —
          // só se o pane ainda não foi desmontado, o container tiver tamanho
          // válido, e sempre dentro de try/catch.
          window.requestAnimationFrame(() => {
            if (disposed) return
            try {
              const rect = container.getBoundingClientRect()
              if (rect.width < 50 || rect.height < 30) return
              fitAddon.fit()
              terminal.refresh(0, Math.max(0, terminal.rows - 1))
              terminal.focus()
            } catch {
              /* container invisível / em teardown — ignora */
            }
          })
        })
        terminal.loadAddon(webglAddon)
      } catch {
        webglAddon?.dispose()
        webglAddon = null
        loadCanvasFallback()
      }
    } else {
      // Budget de WebGL esgotado (outros terminais já usam os contextos
      // disponíveis) — Canvas 2D em vez de cair direto pro DOM.
      loadCanvasFallback()
    }

    terminal.focus()

    const flushPendingWrite = () => {
      writeFrame = null
      if (disposed) return
      if (pendingWriteLength === 0) return

      let budget = TERMINAL_WRITE_FRAME_BUDGET
      let output = ''
      while (budget > 0 && pendingWrites.length > 0) {
        // Digitação/clique pendente — corta o lote aqui em vez de gastar o
        // budget inteiro de bytes; o resto continua no próximo frame (rAF já
        // agendado abaixo). Sem suporte à Scheduling API, isInputPending()
        // devolve false e o comportamento é o de sempre (budget de bytes).
        if (output && isBrowserInputPending()) break
        const head = pendingWrites[0]
        const take = Math.min(budget, head.length)
        output += head.slice(0, take)
        budget -= take
        pendingWriteLength -= take
        if (take === head.length) pendingWrites.shift()
        else pendingWrites[0] = head.slice(take)
      }

      if (output) {
        try {
          terminal.write(output)
          clampHorizontalScroll()
        } catch {
          /* renderer quebrado (ex.: perda de contexto WebGL em andamento) —
           * não deixa uma escrita falha travar o loop de flush pro resto da
           * vida do pane; o próximo frame tenta de novo. */
        }
      }
      if (pendingWriteLength > 0) {
        writeFrame = window.requestAnimationFrame(flushPendingWrite)
      }
    }

    const queueTerminalWrite = (chunk: string) => {
      if (!chunk) return
      pendingWrites.push(chunk)
      pendingWriteLength += chunk.length
      if (writeFrame !== null) return
      writeFrame = window.requestAnimationFrame(flushPendingWrite)
    }

    const getTerminalLineHeight = () => {
      const row = container.querySelector<HTMLElement>('.xterm-rows > div')
      return row?.getBoundingClientRect().height || terminal.options.fontSize || 18
    }

    const onWheel = (event: WheelEvent) => {
      // TUIs (claude/codex) entram no buffer `alternate` e ligam mouse tracking.
      // Lá não há scrollback do host, então scrollLines() é no-op: se a gente
      // interceptasse o wheel (preventDefault), o evento sumia e nem o host nem
      // a app rolavam. Deixamos seguir pro xterm, que repassa o wheel pra app.
      // Shift força o scrollback do host (convenção iTerm2 / Windows Terminal).
      if (!shouldScrollHostScrollback(terminal.buffer.active.type, event.shiftKey)) return
      const lines = getWheelScrollLines(event, getTerminalLineHeight())
      if (lines === 0) return
      event.preventDefault()
      event.stopPropagation()
      try {
        terminal.scrollLines(lines)
      } catch {
        /* renderer quebrado — não deixa o scroll travar o handler */
      }
    }
    container.addEventListener('wheel', onWheel, { passive: false, capture: true })

    const pasteText = (raw: string) => {
      // Colar NUNCA pode quebrar o pane: qualquer erro (normalização, PTY morto,
      // invoke falhando) é engolido e só logado. Sem terminal vivo, ignora.
      try {
        if (!raw) return
        const id = ptyIdRef.current
        if (!id) return
        const text = normalizePastedText(raw)
        useTerminalsStore.getState().recordIo(id)
        recordPromptInput(text)
        void writePtyChunked(id, text, terminal.modes.bracketedPasteMode).catch((err) => {
          console.warn('[pty-paste] falha ao escrever colagem no PTY (ignorado):', err)
        })
      } catch (err) {
        console.warn('[pty-paste] colagem ignorada (erro):', err)
      }
    }

    // Resolve o clipboard do SO pra uma string colável no PTY: texto vira
    // texto puro; arquivos do Explorer (CF_HDROP) e imagens cruas (CF_DIB /
    // formato "PNG" registrado, já salvas como PNG temporário pelo backend)
    // reaproveitam formatDroppedPaths — o mesmo formato usado no drag-and-drop.
    const resolveClipboardPaste = async (): Promise<string> => {
      const payload = await readClipboardPayload()
      switch (payload.kind) {
        case 'text':
          return payload.text
        case 'paths':
          return formatDroppedPaths(payload.paths)
        case 'image':
          return formatDroppedPaths([payload.path])
        case 'empty':
          return ''
      }
    }

    // Arrastar arquivo do SO pro terminal: o onDragDropEvent do Tauri é global,
    // então todo pane recebe o evento — cada um filtra pelo hit-test da posição
    // (física → CSS via devicePixelRatio) e só reage quando o cursor está sobre
    // o seu próprio container. Reaproveita pasteText (bracketed-paste).
    const isOverThisPane = (pos: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1
      const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr)
      return !!el && container.contains(el)
    }
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload
        if (p.type === 'enter' || p.type === 'over') {
          setDropActive(isOverThisPane(p.position))
        } else if (p.type === 'leave') {
          setDropActive(false)
        } else if (p.type === 'drop') {
          setDropActive(false)
          if (isOverThisPane(p.position) && p.paths.length > 0) {
            pasteText(formatDroppedPaths(p.paths))
            terminal.focus()
          }
        }
      })
      .then((un) => {
        if (disposed) un()
        else unlistenDragDrop = un
      })
      .catch(() => {
        /* onDragDropEvent exige runtime Tauri; em browser puro/testes falha. */
      })

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const ctrl = event.ctrlKey || event.metaKey
      if (!ctrl || event.altKey) return true

      const key = event.key.toLowerCase()

      if (
        key === '+' ||
        key === '=' ||
        key === '-' ||
        key === '_' ||
        key === '0' ||
        event.code === 'NumpadAdd' ||
        event.code === 'NumpadSubtract' ||
        event.code === 'Numpad0'
      ) {
        return false
      }

      // Ctrl+C: copia se tem seleção, senão envia SIGINT pro PTY
      if (key === 'c' && terminal.hasSelection()) {
        const selection = terminal.getSelection()
        if (selection) {
          void writeClipboardText(selection).catch(() => navigator.clipboard?.writeText(selection))
          terminal.clearSelection()
          return false
        }
      }
      if (key === 'c' && !readOnly) {
        const now = Date.now()
        const id = ptyIdRef.current
        if (id && now - lastCtrlCRef.current < 1500) {
          lastCtrlCRef.current = 0
          terminal.write('\r\n\x1b[33m[force kill — PTY terminated]\x1b[0m\r\n')
          void killPty(id)
          return false
        }
        lastCtrlCRef.current = now
      }

      if (key === 'v' && !readOnly) {
        event.preventDefault()
        void resolveClipboardPaste()
          .catch(() => navigator.clipboard?.readText() ?? '')
          .then(pasteText)
          .catch(() => {
            terminal.focus()
          })
        return false
      }

      if (!readOnly && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        navigateHistory(event.key === 'ArrowUp' ? 'up' : 'down')
        return false
      }
      return true
    })

    const focusTerminal = () => terminal.focus()
    const restoreHoveredFocus = () => {
      if (document.visibilityState === 'hidden' || !container.matches(':hover')) return
      terminal.focus()
    }
    container.addEventListener('pointerdown', focusTerminal, true)
    container.addEventListener('click', focusTerminal)
    window.addEventListener('focus', restoreHoveredFocus)
    document.addEventListener('visibilitychange', restoreHoveredFocus)

    const onPaste = (event: ClipboardEvent) => {
      const raw = event.clipboardData?.getData('text/plain') ?? ''
      event.preventDefault()
      event.stopPropagation()
      void resolveClipboardPaste()
        .catch(() => raw)
        .then(pasteText)
        .catch(() => {
          terminal.focus()
        })
    }
    container.addEventListener('paste', onPaste)

    const flushInput = () => {
      inputFlushScheduled = false
      if (disposed || !queuedInput) return
      const id = ptyIdRef.current
      if (!id) return
      const chunk = queuedInput
      queuedInput = ''
      inputWriteChain = inputWriteChain
        .then(() => writePty(id, chunk))
        .catch((error) => {
          console.warn(`[pty-input] falha ao escrever em ${id}; solicitando recuperaÃ§Ã£o`, error)
          if (disposed || writeRecoveryPending) return
          writeRecoveryPending = true
          window.dispatchEvent(
            new CustomEvent('alethe:terminal-restart-request', { detail: { ptyId: id } }),
          )
          window.setTimeout(() => {
            writeRecoveryPending = false
          }, 5_000)
        })
    }
    const queueInput = (id: string, data: string) => {
      if (id !== ptyIdRef.current || !data) return
      queuedInput += data
      if (inputFlushScheduled) return
      inputFlushScheduled = true
      queueMicrotask(flushInput)
    }

    const runResize = () => {
      resizeTimer = null
      const id = ptyIdRef.current
      if (!id) return
      // Só faz fit se o container tiver dimensões válidas (evita 0x0)
      const rect = container.getBoundingClientRect()
      if (rect.width < 50 || rect.height < 30) return
      try {
        fitAddon.fit()
      } catch (error) {
        if (import.meta.env.DEV) console.error('[Alethe][xterm] fit failed', error)
        // fit() pode falhar se o container não estiver visível
        return
      }
      try {
        terminal.refresh(0, Math.max(0, terminal.rows - 1))
      } catch (error) {
        if (import.meta.env.DEV) console.error('[Alethe][xterm] refresh failed', error)
        /* refresh pode falhar durante teardown/layout invisível */
      }
      clampHorizontalScroll()
      const force = forceNextResize
      forceNextResize = false
      if (!force && terminal.cols === lastCols && terminal.rows === lastRows) return
      lastCols = terminal.cols
      lastRows = terminal.rows
      if (import.meta.env.DEV) {
        console.debug(`[pty-debug] ${id}: fit() -> resizePty ${terminal.cols}x${terminal.rows}`)
      }
      void resizePty(id, terminal.cols, terminal.rows)
    }
    const scheduleResize = (force = false) => {
      // Guard de unmount: neutraliza os setTimeout(120/320ms) de onResizeRequest
      // e evita re-armar o resizeTimer que o cleanup já limpou.
      if (disposed) return
      forceNextResize ||= force
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(runResize, 80)
    }
    const scheduleObservedResize = () => scheduleResize()
    const onResizeRequest = (event: Event) => {
      const targetPtyId = (event as CustomEvent<{ ptyId?: string }>).detail?.ptyId
      if (targetPtyId && targetPtyId !== ptyIdRef.current) return
      scheduleResize(true)
      window.setTimeout(() => scheduleResize(true), 120)
      window.setTimeout(() => scheduleResize(true), 320)
    }
    const ro = new ResizeObserver(scheduleObservedResize)
    ro.observe(container)
    const onZoomChanged = () => {
      // `fitAddon.fit()` (dentro de runResize) só LÊ o cache interno de
      // dimensões de célula do xterm.js — não força remedição. O xterm.js
      // remede sozinho quando detecta mudança de devicePixelRatio via
      // media query, mas o WebKitGTK nem sempre dispara essa mudança de
      // forma confiável após `setZoom()` do webview. Sem remedir, o cache
      // fica desatualizado e toda detecção de hover/link/clique dentro do
      // terminal aponta pra célula errada (mouse "desalinhado") até o
      // próximo resize real do container. Reatribuir `fontSize` pro mesmo
      // valor é o truque conhecido pra forçar o xterm.js a limpar esse
      // cache e remedir, sem mudar nada visualmente.
      terminal.options.fontSize = terminal.options.fontSize
      scheduleResize(true)
    }
    window.addEventListener('alethe:zoom-changed', onZoomChanged)
    window.addEventListener('alethe:terminal-resize-request', onResizeRequest)

    // Fit adicional com delay pra garantir que o layout estabilizou
    const initialFitTimer = window.setTimeout(() => {
      scheduleResize()
    }, 150)

    // Painel voltou a ficar visível depois de um período mudo (canal `data`
    // suprimido pelo backend) — refaz o replay do scrollback acumulado do
    // zero em vez de tentar reconciliar incrementalmente. `reset()` + replay
    // total elimina qualquer risco de duplicação: não importa quanto foi
    // perdido, o snapshot final devolvido por `attachPty` é a verdade.
    const doResync = async () => {
      const id = ptyIdRef.current
      if (!id || disposed) return
      try {
        const replay = await attachPty(id)
        if (disposed) return
        terminal.reset()
        pendingWrites = []
        pendingWriteLength = 0
        if (writeFrame !== null) {
          window.cancelAnimationFrame(writeFrame)
          writeFrame = null
        }
        if (replay) queueTerminalWrite(replay)
      } catch {
        /* resync best-effort — o próximo lote do canal `data` corrige sozinho */
      }
    }
    resyncTerminalRef.current = doResync

    // Registra os dois listeners de streaming: `data` (canal caro — escreve
    // no xterm) e `activity` (canal barato — só recordIo/completionMonitor,
    // usado pelo backend quando o painel está invisível). O backend decide
    // qual dos dois emitir por lote, nunca os dois — não há risco de um
    // chunk ser processado em duplicidade.
    const registerPtyStreamListeners = async (
      id: string,
      onDataChunk?: (chunk: string) => void,
    ): Promise<boolean> => {
      const dataUnlisten = await listenPtyData(id, (chunk) => {
        useTerminalsStore.getState().recordIo(id)
        queueTerminalWrite(chunk)
        completionMonitor?.handleOutput(chunk)
        onDataChunk?.(chunk)
      })
      if (disposed) {
        dataUnlisten()
        return false
      }
      unlistenData = dataUnlisten

      const activityUnlisten = await listenPtyActivity(id, (chunk) => {
        useTerminalsStore.getState().recordIo(id)
        completionMonitor?.handleOutput(chunk)
      })
      if (disposed) {
        activityUnlisten()
        return false
      }
      unlistenActivity = activityUnlisten
      return true
    }

    const attachExistingPty = async (existingId: string) => {
      setBootPhase('attaching')
      ptyIdRef.current = existingId
      useTerminalsStore.getState().registerPty(existingId)
      onSpawnedRef.current?.(existingId)
      // Sessão pode já existir de antes deste mount (reload do app, etc.) —
      // estabelece a visibilidade correta no backend desde já.
      void setPtyVisible(existingId, isPanelVisibleRef.current).catch(() => {})

      if (command === 'claude' || command === 'codex' || command === 'opencode') {
        completionMonitor = new AgentCompletionMonitor({
          ptyId: existingId,
          agent: command,
          label: command,
          cwd,
          onStatusChange: (status) => useTerminalsStore.getState().setStatus(existingId, status),
          onComplete: () => onAgentCompleteRef.current?.(),
        })
      }

      // Painel fora de tela no boot (aba de grupo inativa, workspace
      // restaurado com vários agentes de uma vez) — pula o fetch+write do
      // replay agora. O backend já grava o scrollback de qualquer jeito;
      // quando o painel virar visível, o efeito de visibilidade dispara
      // `doResync` (attachPty + reset) e traz o conteúdo de uma vez só, sem
      // gastar o burst de write mais pesado (TUIs como o OpenCode) enquanto
      // ninguém está olhando.
      if (isPanelVisibleRef.current) {
        const replay = await attachPty(existingId)
        if (disposed) return
        if (replay) queueTerminalWrite(replay)
      }

      if (!(await registerPtyStreamListeners(existingId))) return

      const exitUnlisten = await listenPtyExit(existingId, (payload) => {
        console.info(
          `[pty-launch] ${command ?? 'shell'} EXIT (attach) id=${existingId} code=${payload.code ?? '—'} reason=${payload.reason ?? '—'}`,
        )
        if (payload.reason === 'restarted') {
          useTerminalsStore.getState().markExited(existingId)
          return
        }
        if (payload.reason === 'suspended') {
          useTerminalsStore.getState().markSuspended(existingId)
          completionMonitor?.dispose()
          completionMonitor = null
          return
        }
        useTerminalsStore.getState().markExited(existingId)
        completionMonitor?.dispose()
        completionMonitor = null
        removeSession(sessionPersistenceKey)
        onExitRef.current?.(payload.code)
      })
      if (disposed) {
        exitUnlisten()
        return
      }
      unlistenExit = exitUnlisten

      scheduleResize()
      if (!disposed) setBootPhase('ready')
    }

    terminal.onData((data) => {
      if (readOnly) return
      const id = ptyIdRef.current
      if (!id) return
      useTerminalsStore.getState().recordIo(id)
      recordPromptInput(data)
      completionMonitor?.handleInput(data)
      const trackedPtyId = ptyIdRef.current
      if (trackedPtyId) recordAgentActivityInput(trackedPtyId, data)
      if (container.scrollWidth > container.clientWidth + 2) scheduleResize(true)
      clampHorizontalScroll()
      queueInput(id, data)
    })

    const RESUMABLE_AGENTS = ['claude', 'codex', 'opencode', 'antigravity']

    async function start() {
      try {
        // Skip zero-sized panes; the observer retries after layout settles.
        try {
          const rect = container?.getBoundingClientRect()
          if (rect && rect.width >= 50 && rect.height >= 30) fitAddon.fit()
        } catch {
          /* sem layout ainda — o resize agendado cobre */
        }
        setCommandNotFound(null)
        setBootPhase('preparing')

        const existingRuntime = useTerminalsStore.getState().byPtyId[ptyId]
        if (existingRuntime?.alive && !existingRuntime.parked) {
          await attachExistingPty(ptyId)
          return
        }
        const backendHasPty = await ptyExists(ptyId).catch(() => false)
        if (backendHasPty) {
          await attachExistingPty(ptyId)
          return
        }

        // Pré-resolve CLI: se for agent, precisa achar override OU launcher
        // auto-detectado antes de spawnar. Sem isso, o pwsh executa `& 'claude'`
        // e mostra erro CommandNotFound dentro do terminal — UX feia.
        let launcherOverride: string | undefined
        if (command && command !== 'shell') {
          if (cliPathOverride) {
            launcherOverride = cliPathOverride
            console.info(`[pty-launch] ${command} usando override: ${cliPathOverride}`)
          } else {
            const auto = await findCliLauncher(agentCliCommand(command) ?? command)
            console.info(
              `[pty-launch] ${command} findCliLauncher → ${auto ?? 'null (NÃO ENCONTRADO)'}`,
            )
            if (!auto) {
              console.warn(
                `[pty-launch] ${command} não resolvido — mostrando overlay "not found" e ficando offline`,
              )
              setCommandNotFound(command)
              useTerminalsStore.getState().setStatus(ptyId, 'offline')
              return
            }
          }
        }

        // projects.json é a fonte principal. O marcador de crash no localStorage
        // serve apenas de fallback para arquivos antigos que ainda não tinham ID.
        const savedSession =
          command && RESUMABLE_AGENTS.includes(command)
            ? consumeSession(sessionPersistenceKey)
            : null
        const savedConversationId = savedConversationIdFor(savedSession, command, cwd)
        let resumeId = sessionId ?? savedConversationId
        // Fallback: se a tentativa anterior morreu no nascimento usando resume,
        // reabre ignorando o id órfão para nascer uma sessão limpa.
        if (forceFreshRef.current) {
          console.warn(`[pty-launch] ${command} reabrindo SEM resume (fallback de early-exit)`)
          resumeId = undefined
        }
        if (resumeId && cwd && command && isSessionClaimed(command, cwd, resumeId, sessionPersistenceKey)) {
          console.warn(`[pty-launch] ${command} session ${resumeId} is already claimed; starting a fresh writer`)
          resumeId = undefined
          removeSession(sessionPersistenceKey)
          onSessionIdRef.current?.(undefined)
        }
        // Reserve the resume ID before creating the PTY. Without this early
        // claim, two panes can pass the check above at the same time and both
        // launch `codex resume`, which makes Codex reject one writer.
        if (resumeId && cwd && command) {
          registerSessionClaim(command, cwd, resumeId, sessionPersistenceKey)
        }
        // Valida a conversa antes de passar o argumento de resume. IDs persistidos
        // podem ficar órfãos após limpeza de histórico ou sincronização entre PCs;
        // nesse caso removemos o vínculo e iniciamos uma conversa limpa.
        // `trustSessionId` pula essa checagem — confirmado empiricamente que
        // `opencode session list` nunca inclui sessões-filha (têm `parent_id`
        // setado pelo próprio servidor do OpenCode), então pra elas essa
        // validação sempre "descobre" uma sessão órfã que não é órfã de
        // verdade e descarta o resume, apagando `sessionId` do tab.
        if (
          !trustSessionId &&
          (command === 'claude' ||
            command === 'codex' ||
            command === 'antigravity' ||
            command === 'opencode') &&
          resumeId &&
          cwd
        ) {
          try {
            const existing =
              command === 'claude'
                ? await snapshotClaudeSessions(cwd)
                : command === 'codex'
                  ? await snapshotCodexSessions(cwd)
                  : command === 'antigravity'
                    ? await snapshotAntigravitySessions(cwd)
                    : await snapshotOpenCodeSessions(cwd)
            const notListed = !existing.some((session) => session.id === resumeId)
            // Pra `opencode`, "não aparece na listagem" é inconclusivo, não
            // prova de órfã — `opencode session list` nunca inclui sessões
            // com `parent_id` setado pelo próprio servidor, então uma sessão
            // válida (não necessariamente uma sub-sessão explícita) pode
            // sumir da listagem sem estar de fato órfã. Só descarta o resume
            // pros outros CLIs, cuja listagem já se mostrou confiável.
            if (notListed && command !== 'opencode') {
              console.warn(`[pty-launch] ${command} ignorando sessão órfã ${resumeId}`)
              resumeId = undefined
              removeSession(sessionPersistenceKey)
              onSessionIdRef.current?.(undefined)
            }
          } catch {
            /* mantém o resume — não arrisca falso negativo */
          }
          if (disposed) return
        }
        // OpenCode não permite escolher o ID no nascimento (ao contrário do
        // Claude) — sem um ID salvo válido, reivindicamos aqui a conversa mais
        // recente ainda não pega por outro pane (ex.: reabrir o app depois de
        // fechado). `!forceFreshRef.current` é essencial: no fallback de
        // early-exit (abaixo) o resumeId acabou de ser zerado de propósito
        // porque a sessão órfã matou o agente no nascimento — reivindicar de
        // novo aqui recriaria o mesmo loop.
        if (command === 'opencode' && !resumeId && cwd && !forceFreshRef.current) {
          try {
            const sessions = await snapshotOpenCodeSessions(cwd)
            // A sessão-filha do GSD Sync (ver alethe-gsd-state.ts) é criada
            // DE PROPÓSITO sem `parentID` — sem isso ela não resumia com
            // histórico visível na TUI — então, ao contrário de sub-sessões
            // internas do próprio OpenCode, ELA APARECE em `opencode session
            // list` como uma sessão de verdade, e fica "mais recente" que a
            // conversa real a cada ciclo GSD. Sem excluir aqui, um terminal
            // normal sem sessionId salvo podia reivindicar a sessão-filha
            // (cheia de instruções internas do GSD) como se fosse a própria
            // — e como `useGsdSyncSessions` acha o terminal certo justamente
            // procurando quem tem esse sessionId, ele então tratava o
            // terminal normal como se fosse o viewer da sessão-filha,
            // escondendo/fechando a pane dele.
            // Gateado só em `gsdWatcherEnabled` (o toggle atual da UI) e não
            // na existência real do sentinel: se o plugin já escreveu
            // `.gsd-child-session` em algum momento (spawn anterior com o
            // toggle ligado, worktree que herdou o arquivo do commit-base) e
            // depois o toggle foi desligado, esse trecho passava a tratar a
            // sessão-filha como candidata válida de novo — um terminal
            // normal sem sessionId salvo podia reivindicá-la mesmo com o
            // watcher desligado. A exclusão agora depende só do sentinel
            // existir em disco, não do estado atual do toggle.
            const gsdChildId = await readGsdChildSession(cwd).catch(() => null)
            const candidates = gsdChildId ? sessions.filter((s) => s.id !== gsdChildId) : sessions
            const claimed = claimMostRecentSession('opencode', cwd, candidates)
            if (claimed) resumeId = claimed.id
          } catch {
            /* sem sessão prévia — segue pro nível 3 (CLI cria uma nova) */
          }
          if (disposed) return
        }
        const preparedRuntime = command
          ? preparePtyRuntimeLaunch(command, runtimeProfile, extraArgs ?? [], env)
          : { args: extraArgs ?? [], env }
        // RFC-004 — Graphify por projeto: garante o bootstrap do grafo e injeta o
        // MCP nos 3 CLIs. Best-effort — falha do Graphify NUNCA bloqueia o spawn.
        // Claude recebe `--mcp-config`; Codex/OpenCode recebem por merge no config
        // do projeto (não têm flag), escrito antes do spawn.
        // Servidores MCP gerenciados pelo Alethe. Claude aceita `--mcp-config`
        // repetido, então acumulamos os paths numa lista (Graphify + ai-memory
        // coexistem sem um sobrescrever o outro). Codex/OpenCode recebem por merge
        // no config do projeto (não têm flag). Tudo best-effort — nunca bloqueia
        // o spawn.
        const mcpConfigPaths: string[] = []
        // RFC-004 — Graphify por projeto (flag em `project.graphifyEnabled`).
        if (
          graphifyRepo &&
          (command === 'claude' || command === 'codex' || command === 'opencode')
        ) {
          void graphifyEnsureGraph(graphifyRepo).catch(() => undefined)
          if (command === 'claude') {
            const p = await graphifyMcpConfigPath(graphifyRepo).catch(() => undefined)
            if (p) mcpConfigPaths.push(p)
          } else if (command === 'opencode') {
            await graphifyOpenCodeConfigWrite(graphifyRepo).catch(() => {})
          } else if (command === 'codex') {
            await graphifyCodexConfigWrite(graphifyRepo).catch(() => {})
          }
          if (disposed) return
        }
        // ai-memory — feature GLOBAL (preference `enabledFeatures.aiMemory`), não
        // por-projeto. O servidor roteia o projeto pela cwd do agente. Só injeta
        // se o binário estiver instalado; senão avisa uma vez e segue sem memória.
        const aiMemoryEnabled = useProjectsStore.getState().preferences.enabledFeatures.aiMemory
        if (
          aiMemoryEnabled &&
          cwd &&
          (command === 'claude' || command === 'codex' || command === 'opencode')
        ) {
          const status = await aiMemoryDetect().catch(() => undefined)
          if (status?.installed) {
            if (command === 'claude') {
              const p = await aiMemoryMcpConfigPath(cwd).catch(() => undefined)
              if (p) mcpConfigPaths.push(p)
            } else if (command === 'opencode') {
              await aiMemoryOpenCodeConfigWrite(cwd).catch(() => {})
            } else if (command === 'codex') {
              await aiMemoryCodexConfigWrite(cwd).catch(() => {})
            }
          } else if (!aiMemoryMissingWarned) {
            aiMemoryMissingWarned = true
            useUiStore.getState().pushToast({
              title: translate(getLocale(), 'aiMemory.notInstalledTitle'),
              body: translate(getLocale(), 'aiMemory.notInstalledBody'),
            })
          }
          if (disposed) return
        }

        // Gate de Conclusão de Planejamento GSD — instala o plugin OpenCode
        // que mantém .planning/ sincronizado sozinho a partir do todowrite,
        // sem depender do modelo lembrar. Independente do Graphify (usa
        // `cwd`, não `graphifyRepo`); best-effort, nunca bloqueia o spawn.
        if (command === 'opencode' && cwd && gsdWatcherEnabled) {
          const modelChain = useProjectsStore.getState().preferences.gsdSyncModelChain ?? []
          // Best-effort de propósito — nunca bloqueia o spawn — mas sem log
          // uma falha aqui deixa `.planning/` nunca populado e o Gate de
          // Merge preso em "checking" sem nenhuma pista da causa real.
          await gsdOpenCodePluginWrite(cwd, modelChain).catch((error) => {
            console.error(`[pty-launch] gsdOpenCodePluginWrite falhou pra ${cwd}:`, error)
          })
          if (disposed) return
        }

        const launch = command
          ? buildAgentLaunch(command, preparedRuntime.args, resumeId, undefined, mcpConfigPaths)
          : { args: preparedRuntime.args, sessionId: undefined, createdSession: false }
        const spawnArgs = launch.args.length > 0 ? launch.args : undefined
        if (command && command !== 'shell') {
          console.info(
            `[pty-launch] ${command} args=${JSON.stringify(spawnArgs ?? [])} resumeId=${resumeId ?? '—'} launcherOverride=${launcherOverride ?? '(auto/PATH)'}`,
          )
        }
        if (launch.sessionId && launch.sessionId !== sessionId) {
          onSessionIdRef.current?.(launch.sessionId)
        }
        if (command && cwd) registerSessionClaim(command, cwd, launch.sessionId)

        // Snapshot leve antes do spawn para identificar e persistir o ID novo
        // de agentes que não permitem escolher o ID no nascimento.
        const discoveredSessionsBeforePromise =
          cwd && !launch.sessionId
            ? command === 'codex'
              ? snapshotCodexSessions(cwd).catch(() => [])
              : command === 'antigravity'
                ? snapshotAntigravitySessions(cwd).catch(() => [])
                : command === 'opencode'
                  ? snapshotOpenCodeSessions(cwd).catch(() => [])
                  : null
            : null

        // Serializa spawns globalmente — sem isso, abrir grupo com N×M terminais
        // dispara muitos spawn_pty em paralelo e trava o app.
        setBootPhase('queued')
        const acquiredSpawnSlot = await acquireSpawnSlot(spawnQueueAbort.signal)
        if (!acquiredSpawnSlot) return
        if (disposed) {
          releaseSpawnSlot()
          return
        }
        setBootPhase('spawning')
        let response: { id: string }
        try {
          response = await spawnPty({
            cols: terminal.cols,
            rows: terminal.rows,
            id: ptyId,
            command: command ? agentCliCommand(command) : undefined,
            cwd: cwd ?? undefined,
            extraArgs: spawnArgs,
            launcherOverride,
            env: preparedRuntime.env,
          })
        } finally {
          releaseSpawnSlot()
        }
        console.info(`[pty-launch] ${command ?? 'shell'} spawn OK id=${response.id}`)
        spawnedAtRef.current = Date.now()
        usedResumeRef.current = Boolean(resumeId)
        if (disposed) return
        setBootPhase('attaching')
        ptyIdRef.current = response.id
        useTerminalsStore.getState().registerPty(response.id)
        onSpawnedRef.current?.(response.id)
        // Sessão acabou de nascer no backend agora — estabelece a
        // visibilidade correta desde o primeiro lote (ex.: pane aberto num
        // grupo/aba já invisível não deve gastar render à toa).
        void setPtyVisible(response.id, isPanelVisibleRef.current).catch(() => {})
        if (command && cwd && launch.sessionId) {
          registerSessionClaim(command, cwd, launch.sessionId, response.id)
        }

        if (command === 'claude' || command === 'codex' || command === 'opencode') {
          completionMonitor = new AgentCompletionMonitor({
            ptyId: response.id,
            agent: command,
            label: command,
            cwd,
            onStatusChange: (status) => useTerminalsStore.getState().setStatus(response.id, status),
            onComplete: () => onAgentCompleteRef.current?.(),
          })
        }

        // Marca sessão como ativa — se o app fechar abruptamente, o próximo
        // spawn vai consumir essa entrada e injetar o resume adequado da CLI.
        if (command && RESUMABLE_AGENTS.includes(command)) {
          saveSession(sessionPersistenceKey, {
            sessionId: response.id,
            claudeSessionId: command === 'claude' ? launch.sessionId : undefined,
            codexSessionId: command === 'codex' ? launch.sessionId : undefined,
            opencodeSessionId: command === 'opencode' ? launch.sessionId : undefined,
            antigravitySessionId: command === 'antigravity' ? launch.sessionId : undefined,
            cwd: cwd ?? '',
            agent: command,
            timestamp: Date.now(),
          })

          // Codex, Antigravity e OpenCode não permitem escolher o ID no
          // nascimento — precisam do ID específico descoberto depois do spawn
          // pra não misturar conversas de panes diferentes no próximo boot.
          if (
            (command === 'codex' || command === 'antigravity' || command === 'opencode') &&
            cwd &&
            discoveredSessionsBeforePromise
          ) {
            const detectCreatedSession = async () => {
              const before = new Set((await discoveredSessionsBeforePromise).map((s) => s.id))
              // Sem prazo fixo amarrado ao SPAWN: o que decide quando o arquivo de
              // sessão do CLI existe é quando o usuário manda a primeira mensagem e
              // o agente termina de responder — não quando o processo nasceu. Um
              // modelo lento (ou um usuário que demora pra digitar) facilmente
              // passa dos ~30s que essa janela costumava ter, e a sessão nunca era
              // reivindicada/persistida (perdia resume ao reabrir o pane). Primeiras
              // tentativas rápidas (3s) pra não atrasar o caso comum; depois de ~30s
              // sem achar, passa a checar mais espaçado (15s) enquanto o pane
              // continuar aberto — só para quando acha ou o componente desmonta.
              let attempt = 0
              while (!disposed) {
                const delayMs = attempt < 10 ? 3000 : 15000
                if (command === 'codex') {
                  await Promise.race([
                    new Promise((resolve) => setTimeout(resolve, delayMs)),
                    waitForSessionHint('codex'),
                  ])
                } else {
                  await new Promise((resolve) => setTimeout(resolve, delayMs))
                }
                if (disposed) return
                const sessions =
                  command === 'codex'
                    ? await snapshotCodexSessions(cwd).catch(() => [])
                    : command === 'antigravity'
                      ? await snapshotAntigravitySessions(cwd).catch(() => [])
                      : await snapshotOpenCodeSessions(cwd).catch(() => [])
                // Mesma exclusão do bloco de resume acima: a sessão-filha do
                // GSD Sync aparece em `opencode session list` como sessão de
                // verdade (sem parentID, de propósito) — sem excluir, ela
                // podia ser confundida com a sessão real recém-criada deste
                // terminal se surgisse na mesma janela de detecção.
                // Exclusão depende só do sentinel existir em disco, não do
                // toggle atual de `gsdWatcherEnabled` — ver comentário
                // equivalente no bloco de resume acima.
                let filteredSessions = sessions
                if (command === 'opencode') {
                  const gsdChildId = await readGsdChildSession(cwd).catch(() => null)
                  if (gsdChildId) filteredSessions = sessions.filter((s) => s.id !== gsdChildId)
                }
                const newSession = claimDiscoveredSession(
                  command,
                  cwd,
                  before,
                  filteredSessions,
                  response.id,
                )
                if (newSession) {
                  saveSession(sessionPersistenceKey, {
                    sessionId: response.id,
                    codexSessionId: command === 'codex' ? newSession.id : undefined,
                    antigravitySessionId: command === 'antigravity' ? newSession.id : undefined,
                    opencodeSessionId: command === 'opencode' ? newSession.id : undefined,
                    cwd: cwd ?? '',
                    agent: command,
                    timestamp: Date.now(),
                  })
                  onSessionIdRef.current?.(newSession.id)
                  return
                }
                attempt += 1
              }
            }
            void detectCreatedSession()
          }
        }

        let resumeConflictHandled = false
        const handleResumeConflict = () => {
          resumeConflictHandled = true
          earlyExitRetriedRef.current = true
          forceFreshRef.current = true
          removeSession(sessionPersistenceKey)
          onSessionIdRef.current?.(undefined)
          terminal.write('\r\n\x1b[33m[alethe] Codex session is busy — opening a fresh session…\x1b[0m\r\n')
          void killPty(response.id).catch(() => {})
          setRetryKey((value) => value + 1)
        }

        // Painel fora de tela no boot — mesma lógica de attachExistingPty:
        // pula o replay agora, `doResync` traz tudo quando ficar visível.
        if (isPanelVisibleRef.current) {
          const replay = await attachPty(response.id)
          if (disposed) return
          if (
            replay &&
            command === 'codex' &&
            usedResumeRef.current &&
            /already has an active writer|thread\/resume failed/i.test(replay)
          ) {
            handleResumeConflict()
            return
          }
          if (replay) queueTerminalWrite(replay)
        }

        // Race fix: se o componente desmontar entre o await e a atribuição,
        // a cleanup function já rodou com unlistenData/unlistenExit ainda
        // undefined — chamamos manualmente pra evitar listener órfão.
        const handled = await registerPtyStreamListeners(response.id, (chunk) => {
          if (command !== 'codex' || !usedResumeRef.current || resumeConflictHandled) return
          // PTY events can split the bootstrap error between chunks, so keep
          // a bounded rolling buffer instead of matching each chunk alone.
          resumeErrorBuffer = `${resumeErrorBuffer}${chunk}`.slice(-8192)
          if (/already has an active writer|thread\/resume failed/i.test(resumeErrorBuffer)) {
            handleResumeConflict()
          }
        })
        if (!handled) return

        const exitUnlisten = await listenPtyExit(response.id, (payload) => {
          // unlistenExit só roda na cleanup do effect, depois de dispose() — um exit
          // que chega no meio dessa janela ainda dispara este callback contra um
          // terminal já disposed (renderer removido), daí o guard antes de qualquer write.
          if (disposed) return
          console.info(
            `[pty-launch] ${command ?? 'shell'} EXIT id=${response.id} code=${payload.code ?? '—'} reason=${payload.reason ?? '—'}`,
          )
          if (payload.reason === 'restarted') {
            useTerminalsStore.getState().markExited(response.id)
            return
          }
          if (payload.reason === 'suspended') {
            useTerminalsStore.getState().markSuspended(response.id)
            completionMonitor?.dispose()
            completionMonitor = null
            return
          }
          const isAgent =
            command === 'claude' ||
            command === 'codex' ||
            command === 'opencode' ||
            command === 'antigravity'
          const elapsed = Date.now() - spawnedAtRef.current
          // Fallback 1: agent morreu no nascimento COM resume → sessão órfã.
          // Limpa e reabre uma vez com sessão nova, em vez de deixar o pane cinza.
          if (
            isAgent &&
            elapsed < EARLY_EXIT_MS &&
            usedResumeRef.current &&
            !earlyExitRetriedRef.current
          ) {
            earlyExitRetriedRef.current = true
            forceFreshRef.current = true
            console.warn(
              `[pty-launch] ${command} saiu em ${elapsed}ms com resume — reabrindo sessão nova (fallback)`,
            )
            useTerminalsStore.getState().markExited(response.id)
            completionMonitor?.dispose()
            completionMonitor = null
            removeSession(sessionPersistenceKey)
            onSessionIdRef.current?.(undefined)
            terminal.write(
              '\r\n\x1b[33m[alethe] sessão anterior indisponível — reabrindo sessão nova…\x1b[0m\r\n',
            )
            setRetryKey((v) => v + 1)
            return
          }
          // Fallback 2: agent morreu no nascimento SEM resume (binário/instalação
          // quebrada). Não relança em loop; deixa um aviso visível em vez de cinza.
          if (isAgent && elapsed < EARLY_EXIT_MS) {
            console.warn(
              `[pty-launch] ${command} saiu em ${elapsed}ms (code ${payload.code ?? '—'}) — sem retry`,
            )
            terminal.write(
              `\r\n\x1b[31m[alethe] ${command} encerrou imediatamente (code ${payload.code ?? '—'}).\x1b[0m\r\n` +
                '\x1b[90mVerifique a instalação do CLI ou configure o caminho nas preferências.\x1b[0m\r\n',
            )
          }
          useTerminalsStore.getState().markExited(response.id)
          completionMonitor?.dispose()
          completionMonitor = null
          // Clean exit → não resume na próxima vez
          removeSession(sessionPersistenceKey)
          onExitRef.current?.(payload.code)
        })
        if (disposed) {
          exitUnlisten()
          return
        }
        unlistenExit = exitUnlisten

        const prompt = initialInput?.trim()
        if (prompt) {
          const sendInitialInput = async () => {
            const earliestSendAt = Date.now() + 1_500
            const timedSendAt = Date.now() + 4_000
            const deadline = Date.now() + 10_000
            while (!disposed && Date.now() < deadline) {
              await new Promise((resolve) => window.setTimeout(resolve, 250))
              const runtime = useTerminalsStore.getState().byPtyId[response.id]
              const quietFor = runtime ? Date.now() - runtime.lastIoAt : 0
              if (
                Date.now() >= earliestSendAt &&
                runtime?.alive &&
                (quietFor >= 700 || Date.now() >= timedSendAt)
              ) break
            }
            if (disposed) return
            try {
              await writePtyChunked(response.id, prompt, true)
              await new Promise((resolve) => window.setTimeout(resolve, 150))
              await writePty(response.id, '\r')
              window.setTimeout(() => void writePty(response.id, '\r').catch(() => {}), 1_200)
              onInitialInputSentRef.current?.()
            } catch (error) {
              console.warn('[pty-launch] não foi possível enviar o prompt inicial:', error)
            }
          }
          void sendInitialInput()
        }

        scheduleResize()
        if (!disposed) setBootPhase('ready')
      } catch (err) {
        console.error(`[pty-launch] ${command ?? 'shell'} FALHOU ao iniciar PTY:`, err)
        if (!disposed) terminal.writeln(`Failed to start PTY: ${String(err)}`)
        if (!disposed) setBootPhase('ready')
      }
    }
    void start()

    return () => {
      if (import.meta.env.DEV) {
        console.debug('[Alethe][xterm] unmount', {
          sessionPersistenceKey,
          retryKey,
          ptyId: ptyIdRef.current,
        })
      }
      disposed = true
      spawnQueueAbort.abort()
      container.removeEventListener('wheel', onWheel, true)
      container.removeEventListener('pointerdown', focusTerminal, true)
      container.removeEventListener('click', focusTerminal)
      container.removeEventListener('paste', onPaste)
      window.removeEventListener('focus', restoreHoveredFocus)
      document.removeEventListener('visibilitychange', restoreHoveredFocus)
      window.removeEventListener('alethe:zoom-changed', onZoomChanged)
      window.removeEventListener('alethe:terminal-resize-request', onResizeRequest)
      ro.disconnect()
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      if (writeFrame !== null) window.cancelAnimationFrame(writeFrame)
      pendingWrites = []
      pendingWriteLength = 0
      queuedInput = ''
      window.clearTimeout(initialFitTimer)
      unlistenData?.()
      unlistenActivity?.()
      unlistenExit?.()
      unlistenDragDrop?.()
      linkProviderDisposable?.dispose()
      linkScrollDisposable?.dispose()
      completionMonitor?.dispose()
      completionMonitor = null
      setLinkActions(null)
      if (terminalRef.current === terminal) terminalRef.current = null
      ptyIdRef.current = null
      if (resyncTerminalRef.current === doResync) resyncTerminalRef.current = null
      terminal.dispose()
      releaseWebglContext?.()
      releaseWebglContext = null
      canvasAddon = null
    }
    // A identidade estável da sub-tab evita remontar assim que o spawn troca o
    // ptyId temporário pelo ID real; isso também deixa a descoberta assíncrona
    // da conversa terminar e persistir o ID antes de um reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPersistenceKey, retryKey])

  // Propaga a visibilidade lógica do painel pro backend (gate do canal
  // `data`) e, só na transição invisível→visível, refaz o resync do
  // scrollback. Efeito leve e independente do mount do terminal — não deve
  // disparar um respawn/reattach completo, só o `AtomicBool` no backend.
  useEffect(() => {
    isPanelVisibleRef.current = isPanelVisible
    const wasVisible = wasPanelVisibleRef.current
    wasPanelVisibleRef.current = isPanelVisible

    if (isFirstVisibilityRunRef.current) {
      isFirstVisibilityRunRef.current = false
      return
    }

    let cancelled = false
    let resyncTimer: number | null = null

    void setPtyVisible(ptyId, isPanelVisible)
      .catch(() => {})
      .then(() => {
        if (cancelled || !isPanelVisible || wasVisible) return
        resyncTimer = window.setTimeout(() => {
          if (!cancelled) void resyncTerminalRef.current?.()
        }, PANEL_RESYNC_DEBOUNCE_MS)
      })

    return () => {
      cancelled = true
      if (resyncTimer !== null) window.clearTimeout(resyncTimer)
    }
  }, [ptyId, isPanelVisible])
}
