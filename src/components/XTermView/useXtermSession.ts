import { getCurrentWebview } from '@tauri-apps/api/webview'
import { CanvasAddon } from '@xterm/addon-canvas'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useEffect, useRef } from 'react'

import { recordAgentActivityInput } from '../../lib/activityTracker'
import { cliPathMatchesAgent } from '../../lib/agentCliPath'
import { AgentCompletionMonitor } from '../../lib/agentCompletionMonitor'
import { deliverOpenCodePrompt } from '../../lib/agentPromptDelivery'
import { preparePtyRuntimeLaunch } from '../../lib/agentRuntimeAdapter'
import { watchAndPersistDiscoveredSession } from '../../lib/agentSessionDiscovery'
import { isTauriEnv } from '../../lib/api/transport'
import { getLocale, translate } from '../../lib/i18n'
import { isLinux, isWindows } from '../../lib/platform'
import { usePtyPanelVisible } from '../../lib/ptyVisibility'
import { createTerminalResizePolicy } from '../../lib/terminalResizePolicy'
import {
  claimMostRecentSession,
  isSessionClaimed,
  registerSessionClaim,
} from '../../lib/sessionDiscovery'
import { buildAgentLaunch } from '../../lib/sessionLaunch'
import {
  peekSession,
  removeSession,
  savedConversationIdFor,
  saveSession,
} from '../../lib/sessionResume'
import { acquireSpawnSlot, releaseSpawnSlot } from '../../lib/spawnQueue'
import {
  aiMemoryCodexConfigWrite,
  aiMemoryDetect,
  aiMemoryMcpConfigPath,
  aiMemoryOpenCodeConfigWrite,
  attachPty,
  agentConfigRoot,
  attachPtySnapshot,
  chunksAfterPtySnapshot,
  clearPtyScrollback,
  findCliLauncher,
  getPtySize,
  killPty,
  listenPtyActivity,
  listenPtyData,
  listenPtyExit,
  listenPtyResized,
  listenPtyResync,
  orchestratorMcpConfigPath,
  playwrightMcpConfigPath,
  ptyExists,
  type PtyResyncReason,
  readClipboardPayload,
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
import {
  findSafeChunkBoundary,
  TERMINAL_WRITE_FRAME_BUDGET,
  trimPendingWrites,
  writePtyChunked,
  writePtyWithTimeout,
} from './terminalWrite'
import { getXtermTheme, type LinkActionState } from './xtermThemes'

/**
 * SessionIds já pertencentes a outras abas (de qualquer projeto) pro mesmo
 * tipo de agente — nunca podem virar candidato de claim aqui, mesmo que
 * `claimedIds` (em memória, reseta a cada restart do app) ainda não saiba
 * deles nesta execução. Lido direto de `useProjectsStore.getState()`, que já
 * reflete o `projects.json` carregado do disco desde o boot, antes de
 * qualquer terminal montar/spawnar — não depende de ordem de montagem.
 */
function reservedSessionIdsFor(agent: AgentType, selfKey: string | undefined): Set<string> {
  const reserved = new Set<string>()
  for (const project of useProjectsStore.getState().projects) {
    for (const terminal of project.terminals) {
      for (const tab of terminal.tabs) {
        if (tab.type !== agent || !tab.sessionId) continue
        if (selfKey && tab.ptyId === selfKey) continue
        reserved.add(tab.sessionId)
      }
    }
  }
  return reserved
}

// Early exits trigger a single fresh-session retry.
const EARLY_EXIT_MS = 4000

const PANEL_RESYNC_DEBOUNCE_MS = 80

function isBrowserInputPending(): boolean {
  const scheduling = (
    navigator as Navigator & {
      scheduling?: { isInputPending?: (opts?: { includeContinuous?: boolean }) => boolean }
    }
  ).scheduling
  return scheduling?.isInputPending?.() ?? false
}

let aiMemoryMissingWarned = false

// Patch defensivo de UMA VEZ por app (não por terminal) num bug real do
// próprio xterm.js: `RenderService` interno dispara `onDimensionsChange`
// sempre que troca de renderer (ex.: `CanvasAddon.activate()`), e o
// `Viewport` reage chamando `syncScrollArea()` — que lê
// `this._renderer.value.dimensions` sem checar se `_renderer.value` já foi
// atribuído. Se esse evento disparar durante a própria troca (antes do
// renderer novo ser atribuído), `syncScrollArea()` lança
// `TypeError: undefined is not an object (evaluating
// 'this._renderer.value.dimensions')` — de dentro de um listener interno do
// xterm.js, fora de qualquer call-stack nosso, então nenhum try/catch em
// código nosso (fit, focus, etc.) consegue interceptar. Confirmado ao vivo,
// reproduzindo consistentemente mesmo depois de duas tentativas de mitigar
// por fora (fit/refresh adiado, remedição forçada no resize) — o problema
// realmente está nesse método interno, não em quando/como chamamos a API
// pública. `terminal._core` é privado (sem tipagem oficial), mas é o mesmo
// acesso que os próprios addons oficiais (`@xterm/addon-canvas`) usam
// internamente — aceitável aqui como workaround pontual de um bug de
// terceiros, não como padrão geral de acesso à API do xterm.js.
// Marcador na própria função (não numa flag de módulo) — o HMR do Vite
// reexecuta o topo deste módulo a cada edit salvo durante o dev, o que
// reatribuiria uma flag `let` pra `false` de novo mesmo com o Viewport.prototype
// (objeto do pacote xterm.js, não deste módulo) já embrulhado por uma rodada
// anterior. Sem esse marcador sobrevivendo ao HMR, cada edit salvo durante uma
// sessão de dev longa empilhava mais uma camada de try/catch por cima da
// anterior — confirmado ao vivo (stack de `proto.syncScrollArea` crescendo a
// cada re-render, um nível por HMR), inofensivo em si (cada camada só repassa
// pro original), mas custo de CPU crescente sem limite pro resto da sessão.
const VIEWPORT_SYNC_GUARD_MARK = '__aletheViewportSyncGuarded'
function patchXtermViewportSyncGuard(terminal: Terminal): void {
  try {
    const viewport = (terminal as unknown as { _core?: { viewport?: object } })._core?.viewport
    if (!viewport) return
    const proto = Object.getPrototypeOf(viewport) as {
      syncScrollArea?: ((...args: unknown[]) => void) & { [VIEWPORT_SYNC_GUARD_MARK]?: boolean }
    }
    const original = proto.syncScrollArea
    if (typeof original !== 'function' || original[VIEWPORT_SYNC_GUARD_MARK]) return
    const guarded = function (this: unknown, ...args: unknown[]) {
      try {
        return original.apply(this, args)
      } catch {
        window.requestAnimationFrame(() => {
          try {
            original.apply(this, args)
          } catch {
            /* The renderer can still be detached during the next frame. */
          }
        })
        return undefined
      }
    }
    guarded[VIEWPORT_SYNC_GUARD_MARK] = true
    proto.syncScrollArea = guarded
  } catch {
    /* acesso a internals falhou (versão do xterm.js mudou a forma?) — segue
       sem o patch, o bug volta a se manifestar mas nada quebra por causa
       da tentativa. */
  }
}

type BootPhase = 'preparing' | 'queued' | 'spawning' | 'attaching' | 'ready'

/** Tamanho de fonte de quem é dono da grade — renderiza sempre nativo, sem escala. */
const BASE_FONT_SIZE = 14

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


  trustSessionId?: boolean

  readOnly?: boolean
  /**
   * `true` só na primeira montagem de uma tab recém-criada — impede o
   * fallback de "reivindicar a conversa OpenCode mais recente ainda não
   * pega nesse cwd" (mais abaixo) de herdar sem querer uma sessão de
   * outro projeto/uso anterior da mesma pasta. Consumido via
   * `onSessionClaimSkippedRef` no primeiro spawn.
   */
  skipSessionClaim?: boolean
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
  onSessionClaimSkippedRef: MutableRefObject<(() => void) | undefined>
  onExitRef: MutableRefObject<((code: number | null) => void) | undefined>
  onLaunchErrorRef: MutableRefObject<((error: unknown) => void) | undefined>
  onAgentCompleteRef: MutableRefObject<(() => void) | undefined>
  setBootPhase: Dispatch<SetStateAction<BootPhase>>
  setCommandNotFound: Dispatch<SetStateAction<string | null>>
  setLinkActions: Dispatch<SetStateAction<LinkActionState | null>>
  setRetryKey: Dispatch<SetStateAction<number>>
  setDropActive: Dispatch<SetStateAction<boolean>>
  showLinkActionsMenu: (event: MouseEvent, link: DetectedTerminalLink) => void
  recordPromptInput: (data: string) => boolean
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
    trustSessionId,
    readOnly,
    skipSessionClaim,
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
    onSessionClaimSkippedRef,
    onExitRef,
    onLaunchErrorRef,
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

  const isPanelVisible = usePtyPanelVisible(ptyId)
  const activeProfileId = useProjectsStore((state) => state.activeProfileId)
  const isPanelVisibleRef = useRef(isPanelVisible)
  const wasPanelVisibleRef = useRef(isPanelVisible)

  const isFirstVisibilityRunRef = useRef(true)
  // Preenchido dentro do efeito de mount com a função que refaz o replay do
  // scrollback (attachPty + reset) — chamado pelo efeito de visibilidade
  // abaixo quando o painel volta a ficar visível.
  const resyncTerminalRef = useRef<((reason?: PtyResyncReason) => Promise<void>) | null>(null)
  // Referência viva do `CanvasAddon` (nunca guardada antes — bug real,
  // confirmado ao vivo: com o app minimizado por muito tempo, o WebView2
  // descarta o backing store 2D do canvas de páginas ocultas, mas o cache
  // interno de glifos do addon (módulo-level, compartilhado entre painéis)
  // continua achando que estão lá — texto volta com letras faltando/soltas
  // ao restaurar a janela, e sobrevive até a um "Reiniciar" do terminal
  // porque esta instância nunca é recriada nesse fluxo). Usada pelo efeito
  // de visibilidade abaixo pra chamar `clearTextureAtlas()` + forçar redraw
  // quando a janela volta a ficar visível.
  const canvasAddonRef = useRef<CanvasAddon | null>(null)
  // Bounds automatic recovery when a replacement core no longer owns the PTY.
  const missingPtyRecoveryRef = useRef<{ id: string; attemptedAt: number } | null>(null)
  // Conta quantos auto-restarts por crash do Bun já foram tentados NESTE
  // painel — precisa ser um ref (sobrevive a remounts do efeito via
  // `retryKey`, ao contrário de uma variável local dele) pra não entrar em
  // loop se o processo continuar crashando repetidamente.
  const bunCrashAutoRestartCountRef = useRef(0)
  /** lastIoAt captured when the panel went hidden; null until it has been hidden once. */
  const lastIoWhenHiddenRef = useRef<number | null>(null)

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
    let unlistenResync: (() => void) | null = null
    let unlistenResize: (() => void) | null = null
    let unlistenDragDrop: (() => void) | null = null
    let resizeTimer: number | null = null
    let settleTimer: number | null = null
    let settleCols = 0
    let settleRows = 0
    let writeFrame: number | null = null
    let pendingWrites: string[] = []
    let pendingWriteLength = 0
    let pendingWriteDrainResolvers: Array<() => void> = []
    let resumeErrorBuffer = ''
    // Não-nulo só durante o await do snapshot em `doResync`: coleta os chunks
    // de `data` que chegarem nessa janela pra reaplicá-los depois do replay,
    // em vez de perdê-los no clear da fila.
    let resyncCaptureRef: Array<{ chunk: string; cursor?: number }> | null = null
    let resyncInFlight: Promise<void> | null = null
    // Detecta o texto do próprio crash-reporter do runtime Bun no stream de
    // saída ("oh no: Bun has crashed. This indicates a bug in Bun, not your
    // code."/"panic(main thread): Segmentation fault..."). Confirmado ao
    // vivo nesta sessão como um bug real do Bun (não do Alethe/OpenCode) —
    // sem causa raiz corrigível do nosso lado (ver docs/CHANGELOG.md), então
    // a única resposta útil é reconhecer o padrão e recuperar sozinho: o
    // usuário não devia precisar entender um dump de crash técnico só pra
    // saber que precisa clicar em "Reiniciar".
    const BUN_CRASH_SIGNATURE = /Bun has crashed|panic\(main thread\)/i
    let bunCrashBuffer = ''
    // Confirmado ao vivo por vídeo (frame a frame): um painel ainda na tela
    // inicial (sem ter produzido nenhuma resposta/conteúdo de verdade ainda)
    // é muito mais frágil a resize — texto compactado/sobreposto e mais
    // propenso a crashar — do que um painel que já tem conteúdo renderizado
    // na tela. Consistente com o renderer nativo do opentui só terminar de
    // inicializar seus buffers depois do primeiro paint real. Contagem
    // aproximada de bytes de saída já recebidos (dos dois canais, `data` e
    // `activity`) usada só pra decidir a folga de cooldown abaixo — não
    // precisa ser exata.
    let outputByteCount = 0
    let bunCrashDetected = false
    let lastCols = 0
    let lastRows = 0
    const usesPinnedLinuxAgentGrid = isLinux() && Boolean(command && command !== 'shell')
    const resizePolicy = createTerminalResizePolicy(command, usesPinnedLinuxAgentGrid)
    let forceNextResize = false
    // true quando este mount se tornou "observador" da grade compartilhada —
    // adota o `cols x rows` vigente sem reivindicar uma grade nova. Vale pra
    // QUALQUER cliente que anexa a uma sessão existente, desktop ou web: a
    // regra é "quem cria a sessão é dono da grade", sem privilegiar nenhum dos
    // dois lados. Um observador volta a ser dono assim que o próprio container
    // muda de tamanho de verdade (ver runResize/observerBaseRect).
    let isGridObserver = false
    let lastRemoteSyncAt = 0
    // Retângulo do container no momento em que este mount virou observador.
    // Serve pra separar um resize genuíno do usuário (que reivindica a grade)
    // do ruído de boot — initialFitTimer, primeiro tick do ResizeObserver — e
    // de um layout aplicado remotamente (que só deve reescalar a fonte).
    let observerBaseRect: { width: number; height: number } | null = null
    let completionMonitor: AgentCompletionMonitor | null = null
    let linkProviderDisposable: { dispose: () => void } | null = null
    let linkScrollDisposable: { dispose: () => void } | null = null
    let writeRecoveryPending = false
    let queuedInput = ''
    let inputFlushScheduled = false
    let inputWriteChain = Promise.resolve()
    // true enquanto `sendInitialInput` está digitando/confirmando/mandando
    // Enter pro prompt inicial (ver `start()` mais abaixo). Confirmado ao
    // vivo: uma falha de escrita QUALQUER durante essa janela disparava a
    // recuperação automática de `flushInput` (mais abaixo), que reinicia o
    // PTY — e reiniciar bem no meio da entrega do prompt inicial mata o
    // processo recém-nascido e perde a sessão que ele tinha acabado de
    // começar, sem chance de resume (ainda não tinha sessionId nenhum).
    let initialInputInFlight = false
    let lastPasteBlock = ''
    let currentLineBuffer = ''
    // These agent CLIs read the OS clipboard themselves on Ctrl+V and render
    // their own compact placeholder (e.g. "[image 1]") for pasted images.
    // Intercepting the keystroke here would force us to fake that rendering
    // locally while the CLI's own redraw shows the real bytes it received,
    // producing a mismatched/garbled display.
    // Claude Code is deliberately NOT in this set: its CLI has no image-paste
    // support at all over the terminal (unlike the three below), so leaving
    // it here would silently drop every pasted image. It falls through to
    // the default path instead, which resolves an image clipboard payload to
    // its file path and types that — the same fallback already used for
    // dropping a file onto the terminal (see `onDragDropEvent` below), which
    // Claude Code reads from disk just fine.
    const NATIVE_CLIPBOARD_IMAGE_AGENTS = new Set(['opencode', 'codex', 'antigravity'])

    const resourcePolicy = useProjectsStore.getState().preferences.resourcePolicy
    const terminal = new Terminal({
      cursorBlink: !readOnly,

      disableStdin: Boolean(readOnly),
      convertEol: false,
      allowProposedApi: true,
      scrollback: getTerminalScrollbackRows({
        agent: command != null && command !== 'shell',
        memoryBudgetMb: resourcePolicy.memoryBudgetMb,
      }),

      // xterm.js passa a assumir que o backend redesenha a tela sozinho
      // (como o ConPTY faz), o que corrompe o repaint de TUIs densas que

      ...(isWindows() ? { windowsPty: { backend: 'conpty' as const, buildNumber: 22000 } } : {}),
      // Nerd Font embutida no app (ver @font-face em theme.css) como
      // primeira opção — cobertura de glyph completa (incluindo símbolos
      // estilo Powerline que TUIs modernas como o `opentui` do OpenCode
      // usam), garantida em todo SO, sem depender de fallback do sistema
      // que pode trocar de fonte por caractere e quebrar o grid de largura
      // fixa do renderer Canvas (causa raiz confirmada do bug de
      // letras/símbolos sobrepondo no Linux). Cascadia Mono/Consolas
      // seguem como fallback pra quem já tem no sistema, por via das
      // dúvidas; `monospace` genérico é o último recurso de verdade.
      fontFamily:
        '"Caskaydia Cove Nerd Font Mono", "Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: BASE_FONT_SIZE,
      theme: getXtermTheme(terminalTheme),
    })
    // Dispara o carregamento da fonte embutida o quanto antes (é local,
    // deve resolver quase instantâneo) — aguardada mais abaixo, antes da
    // primeira medição real de célula, pra nunca deixar o xterm.js medir em
    // cima do fallback do sistema por uma corrida de carregamento.
    const terminalFontReady = document.fonts
      .load('400 14px "Caskaydia Cove Nerd Font Mono"')
      .catch(() => {})
    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(searchAddon)
    terminal.loadAddon(new Unicode11Addon())
    terminal.unicode.activeVersion = '11'
    try {
      const canvasAddon = new CanvasAddon()
      terminal.loadAddon(canvasAddon)
      canvasAddonRef.current = canvasAddon
    } catch {
      /* addon indisponivel — o xterm cai sozinho no renderer DOM */
    }

    terminal.open(container)
    patchXtermViewportSyncGuard(terminal)
    terminalRef.current = terminal

    // Hook de debug só pra e2e (Parte 5 — sincronização cross-client):
    // expõe `cols`/`rows` renderizados de verdade por PTY, já que não há
    // nenhum outro jeito de inspecionar a grade real do xterm.js de fora via
    // WebDriver. Somente leitura, sem entrada não confiável — seguro deixar
    // sempre presente (não é gateado por env var em runtime porque o build
    // de e2e usa `vite build` normal, sem `import.meta.env.DEV`).
    const syncDebugTerminalHook = () => {
      const id = ptyIdRef.current
      if (!id) return
      const w = window as unknown as {
        __ALETHE_DEBUG_TERMINALS__?: Record<string, { cols: number; rows: number }>
      }
      w.__ALETHE_DEBUG_TERMINALS__ ??= {}
      w.__ALETHE_DEBUG_TERMINALS__[id] = { cols: terminal.cols, rows: terminal.rows }
    }

    const restoreBaseFontSize = () => {
      if (terminal.options.fontSize === BASE_FONT_SIZE) return
      terminal.options.fontSize = BASE_FONT_SIZE
    }

    const setHorizontalViewport = (enabled: boolean) => {
      container.toggleAttribute('data-horizontal-terminal-viewport', enabled)
    }

    const resolveStableGrid = (cols: number, rows: number, adopt = false) => {
      return resizePolicy.resolve(cols, rows, adopt)
    }

    const applyGridAtBaseScale = (targetCols: number, targetRows: number) => {
      if (targetCols <= 0 || targetRows <= 0) return
      const stableGrid = resolveStableGrid(targetCols, targetRows)
      const buffer = terminal.buffer.active
      const wasAtBottom = buffer.viewportY >= buffer.baseY
      restoreBaseFontSize()
      setHorizontalViewport(stableGrid.horizontalViewport)
      if (terminal.cols !== stableGrid.cols || terminal.rows !== stableGrid.rows) {
        terminal.resize(stableGrid.cols, stableGrid.rows)
      }
      try {
        canvasAddonRef.current?.clearTextureAtlas?.()
        terminal.refresh(0, Math.max(0, terminal.rows - 1))
      } catch {
        /* renderer may be between canvas generations; the next frame retries */
      }
      if (wasAtBottom) terminal.scrollToBottom()
      syncDebugTerminalHook()
    }

    const clampHorizontalScroll = () => {
      if (container.hasAttribute('data-horizontal-terminal-viewport')) return
      container.scrollLeft = 0
      const xterm = container.querySelector<HTMLElement>('.xterm')
      const viewport = container.querySelector<HTMLElement>('.xterm-viewport')
      const screen = container.querySelector<HTMLElement>('.xterm-screen')
      if (xterm) xterm.scrollLeft = 0
      if (viewport) viewport.scrollLeft = 0
      if (screen) screen.style.maxWidth = '100%'
    }

    const fitStableGrid = () => {
      // `fit()` mutates the xterm buffer immediately. On Linux agent TUIs that
      // temporary mutation can corrupt the alternate screen even if
      // we restore the pinned grid in the same task. Measure without applying
      // first, then resize at most once to the resolved stable grid.
      const proposed = usesPinnedLinuxAgentGrid ? fitAddon.proposeDimensions() : undefined
      if (!usesPinnedLinuxAgentGrid) fitAddon.fit()
      const stableGrid = resolveStableGrid(
        proposed?.cols ?? terminal.cols,
        proposed?.rows ?? terminal.rows,
      )
      setHorizontalViewport(stableGrid.horizontalViewport)
      if (terminal.cols !== stableGrid.cols || terminal.rows !== stableGrid.rows) {
        terminal.resize(stableGrid.cols, stableGrid.rows)
      }
      return stableGrid
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

    linkScrollDisposable = terminal.onScroll(() => {
      if (linkActionsRef.current) setLinkActions(null)
    })

    // `CanvasAddon.activate()` adia a própria montagem via `onWillOpen` se
    // `terminal.element` ainda não estiver pronto (ver addon-canvas), e o
    // getter `dimensions` do `RenderService` interno do xterm.js não tem
    // NENHUMA proteção contra o renderer ainda não estar anexado nesse
    // meio-tempo (`this._renderer.value.dimensions`, sem checar
    // `_renderer.value`) — qualquer coisa que dispare `syncScrollArea`
    // (scroll, foco, resize) nessa janela lança
    // `TypeError: undefined is not an object (evaluating
    // 'this._renderer.value.dimensions')`, capturado só pelo error handler
    // global (main.tsx) — silencioso, mas deixa o cálculo de cols/rows
    // daquele pane pra trás, sem nada que refaça sozinho depois (por isso
    // resize manual não corrige: o próximo fit roda sobre o mesmo estado já
    // corrompido). Mesmo padrão de proteção já usado no fallback de perda de
    // contexto do WebGL logo acima — um fit/refresh extra, adiado por um
    // frame (dá tempo do addon assentar de verdade), garante que pelo menos
    // uma medição válida aconteça mesmo que a primeira tenha sido perdida.
    window.requestAnimationFrame(() => {
      void (async () => {
        if (disposed) return
        // Espera a fonte embutida terminar de carregar (deve ser quase
        // instantâneo, é um arquivo local) antes da primeira medição real —
        // sem isso, essa medição podia rodar em cima do fallback do sistema
        // por uma corrida de carregamento, com métricas de célula erradas
        // que nenhum resize/fit posterior corrige sozinho (só relê cache).
        await terminalFontReady
        if (disposed) return
        if (import.meta.env.DEV) {
          console.debug(
            `[Alethe][xterm] fonte do terminal pronta — carregada? ${document.fonts.check('14px "Caskaydia Cove Nerd Font Mono"')}`,
          )
        }
        try {
          const rect = container.getBoundingClientRect()
          if (rect.width < 50 || rect.height < 30) return
          // `fitAddon.fit()` sozinho só LÊ o cache interno de dimensões de
          // célula do xterm.js — não força remedição (mesmo motivo do truque
          // em `onZoomChanged` mais abaixo). Se a primeiríssima medição saiu
          // errada (renderer recém-anexado, fonte ainda não pronta), todo
          // `fit()` seguinte — incluindo o `initialFitTimer` de 150ms e o
          // ResizeObserver — recalcula em cima do MESMO cache errado pra
          // sempre, nunca remede de verdade. Reatribuir `fontFamily` (não só
          // `fontSize`) é o que realmente importa aqui: confirmado ao vivo
          // que `document.fonts.load()` da fonte embutida FUNCIONA e
          // resolve — mas o cache de métricas de célula do xterm.js só é
          // invalidado quando a opção que ele está de olho muda de valor
          // (reatribuir o MESMO fontFamily ainda conta como mudança pro
          // xterm.js, dispara remedição). Sem isso, mesmo com a fonte já
          // disponível em `document.fonts`, a medição de célula continuava
          // presa na já feita com o fallback do sistema antes da fonte
          // carregar — exatamente o sintoma visto ao vivo (fonte carrega,
          // mas nada muda visualmente).
          // Reatribuir o MESMO valor é proposital (ver comentário acima) —
          // o setter do xterm.js invalida o cache de métricas de célula ao
          // detectar uma mudança na option observada, então isso não é um
          // no-op de verdade.
          // eslint-disable-next-line no-self-assign
          terminal.options.fontFamily = terminal.options.fontFamily
          fitStableGrid()
          terminal.refresh(0, Math.max(0, terminal.rows - 1))
        } catch {
          /* renderer ainda não pronto neste frame — o initialFitTimer (150ms)
             e o ResizeObserver cobrem tentativas seguintes. */
        }
      })()
    })

    // Isolado em try/catch: se `focus()` disparar internamente o mesmo
    // `syncScrollArea` sem proteção descrito acima, uma exceção sem catch
    // aqui abortaria o resto desta função — cancelando o registro dos
    // listeners de resize/zoom e do ResizeObserver logo abaixo, o que por si
    // só já explicaria um terminal que nunca mais se redimensiona direito.
    try {
      terminal.focus()
    } catch (error) {
      if (import.meta.env.DEV) console.error('[Alethe][xterm] focus inicial falhou', error)
    }

    const flushPendingWrite = () => {
      writeFrame = null
      if (disposed) return
      if (pendingWriteLength === 0) return

      let budget = TERMINAL_WRITE_FRAME_BUDGET
      let output = ''
      while (budget > 0 && pendingWrites.length > 0) {
        if (output && isBrowserInputPending()) break
        const head = pendingWrites[0]
        const rawTake = Math.min(budget, head.length)
        const take = findSafeChunkBoundary(head, rawTake)
        output += head.slice(0, take)
        budget -= take
        pendingWriteLength -= take
        if (take === head.length) pendingWrites.shift()
        else pendingWrites[0] = head.slice(take)
      }

      if (output) {
        try {
          const isLastQueuedWrite = pendingWriteLength === 0
          terminal.write(
            output,
            isLastQueuedWrite
              ? () => {
                  if (disposed || pendingWriteLength > 0 || writeFrame !== null) return
                  const resolvers = pendingWriteDrainResolvers
                  pendingWriteDrainResolvers = []
                  resolvers.forEach((resolve) => resolve())
                }
              : undefined,
          )
          clampHorizontalScroll()
        } catch (error) {
          // Bug real, confirmado ao vivo: com a janela minimizada por muito
          // tempo, `pendingWrites` cresce sem teto (o rAF que drena isto não
          // roda com a página oculta) — se passar dos 50MB internos do
          // próprio xterm.js, `terminal.write()` LANÇA de propósito (flow
          // control). `output` já tinha sido retirado de `pendingWrites`
          // antes desta chamada — engolir o erro aqui perdia até
          // `TERMINAL_WRITE_FRAME_BUDGET` bytes NO MEIO do stream pra
          // sempre, cortando uma sequência CSI/OSC ao meio e desalinhando o
          // parser dali em diante (a corrupção visual "letras soltas na
          // tela" já vista ao vivo). Em vez de fingir que só esse pedaço
          // sumiu e seguir escrevendo por cima de um parser já desalinhado,
          // descarta o resto do backlog acumulado (não dá pra confiar na
          // ordem/alinhamento dele de qualquer jeito) e força uma
          // ressincronização de verdade (mesmo caminho usado num
          // reconnect) — bounded e visível, em vez de silenciosa.
          console.warn('[Alethe][xterm] terminal.write() falhou, ressincronizando', error)
          pendingWrites = []
          pendingWriteLength = 0
          void resyncTerminalRef.current?.('reconnect').catch(() => {})
          return
        }
      }
      if (pendingWriteLength > 0) {
        writeFrame = window.requestAnimationFrame(flushPendingWrite)
      }
    }

    const MAX_PENDING_WRITE_BYTES = 2 * 1024 * 1024

    const queueTerminalWrite = (chunk: string) => {
      if (!chunk) return
      // Proteção de segurança contra acúmulo infinito em background:
      // Se a fila passar de 2MB (ex: janela minimizada por muito tempo),
      // purga o backlog e força um resync limpo ao reativar para não estourar o parser do xterm.
      if (pendingWriteLength + chunk.length > MAX_PENDING_WRITE_BYTES) {
        pendingWrites = []
        pendingWriteLength = 0
        void resyncTerminalRef.current?.('reconnect').catch(() => {})
        return
      }
      pendingWrites.push(chunk)
      pendingWriteLength += chunk.length
      pendingWriteLength = trimPendingWrites(pendingWrites, pendingWriteLength).length
      if (writeFrame !== null) return
      writeFrame = window.requestAnimationFrame(flushPendingWrite)
    }

    const queueTerminalWriteAndWait = (chunk: string): Promise<void> => {
      if (!chunk) return Promise.resolve()
      return new Promise((resolve) => {
        pendingWriteDrainResolvers.push(resolve)
        queueTerminalWrite(chunk)
      })
    }

    // Scrollback replays go straight to xterm instead of through the frame
    // budget: a few MB of history split into 16 KB slices costs one rendered
    // frame each, which is what made switching panes crawl from the top of the
    // buffer down to the prompt.
    const writeReplayAtOnce = (replay: string): Promise<void> =>
      new Promise((resolve) => {
        try {
          terminal.write(replay, () => {
            try {
              terminal.scrollToBottom()
            } catch {
              /* internals do xterm.js podem ter mudado de forma — ignora */
            }
            resolve()
          })
        } catch {
          resolve()
        }
      })

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

    const requestWriteRecovery = (id: string, source: 'input' | 'paste', error: unknown) => {
      console.warn(`[pty-${source}] write failed for ${id}; requesting recovery`, error)
      if (disposed || writeRecoveryPending || id !== ptyIdRef.current) return
      if (source === 'input' && initialInputInFlight) {
        // Reiniciar agora mataria o processo bem no meio da entrega do
        // prompt inicial, perdendo a sessão sem chance de resume — deixa
        // `sendInitialInput` lidar com a falha (loga e desiste) em vez
        // de disparar essa recuperação destrutiva.
        console.warn(
          `[pty-input] recuperação automática SUPRIMIDA em ${id}: entrega do prompt inicial ainda em andamento`,
        )
        return
      }
      writeRecoveryPending = true
      window.dispatchEvent(
        new CustomEvent('alethe:terminal-restart-request', { detail: { ptyId: id } }),
      )
      window.setTimeout(() => {
        writeRecoveryPending = false
      }, 5_000)
    }

    const pasteText = (raw: string) => {
      try {
        if (!raw) return
        const id = ptyIdRef.current
        if (!id) return
        if (writeRecoveryPending) return
        const text = normalizePastedText(raw)
        currentLineBuffer += text
        lastPasteBlock = text
        useTerminalsStore.getState().recordIo(id)
        recordPromptInput(text)
        // A paste must go out wrapped in the bracketed-paste markers whenever
        // the app asked for them (DECSET 2004). Sent raw, every internal CR of
        // the pasted text arrives as a plain Enter, so a TUI prompt (Claude,
        // Codex, a REPL) submits the first line instead of inserting the block
        // — the paste "typed and sent the message" rather than pasting it.
        // `writePtyChunked` also splits very large pastes without breaking
        // surrogate pairs, which the plain queued write did not do.
        const bracketed = terminal.modes.bracketedPasteMode
        // In bracketed mode the app redraws the prompt itself; echoing locally
        // would paint raw characters underneath its own rendering.
        if (!bracketed) terminal.write(text)
        // Flush anything typed in this same tick first, so the paste can never
        // overtake it in the write chain.
        if (queuedInput) flushInput()
        inputWriteChain = inputWriteChain
          .then(() => writePtyChunked(id, text, bracketed))
          .catch((error) => requestWriteRecovery(id, 'paste', error))
      } catch (err) {
        console.warn('[pty-paste] ignored invalid clipboard payload:', err)
      }
    }

    const resolveClipboardPaste = async (): Promise<string> => {
      const payload = await readClipboardPayload()
      switch (payload.kind) {
        case 'text':
          return payload.text
        case 'paths':
          return formatDroppedPaths(payload.paths)
        case 'image':
          return `${formatDroppedPaths([payload.path]).trim()} `
        case 'empty':
          return ''
      }
    }

    const isOverThisPane = (pos: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1
      const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr)
      return !!el && container.contains(el)
    }
    // `getCurrentWebview()` lança síncrono (não rejeita a promise) fora de um
    // runtime Tauri de verdade — lê `window.__TAURI_INTERNALS__.metadata`,
    // que não existe no navegador puro. O `.catch()` abaixo nunca chegava a
    // rodar nesse caso (a exceção acontece ANTES do `.onDragDropEvent(...)`
    // poder ser encadeado), travando o efeito inteiro e derrubando o
    // `<XTermView>` via ErrorBoundary a cada remount — o modo web nem tenta
    // esse recurso (arrastar arquivo do SO não é algo que a API de
    // drag-and-drop do próprio browser cobre da mesma forma).
    if (isTauriEnv()) {
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
    }

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
          void killPty(id, activeProfileId)
          return false
        }
        lastCtrlCRef.current = now
      }

      if (event.key === 'Backspace' && !readOnly) {
        if (currentLineBuffer.length > 0) {
          if (lastPasteBlock && currentLineBuffer.endsWith(lastPasteBlock)) {
            event.preventDefault()
            const deleteCount = lastPasteBlock.length
            currentLineBuffer = currentLineBuffer.slice(0, -deleteCount)
            lastPasteBlock = ''
            // Send backspace sequence for each deleted character
            const backspaces = '\b \b'.repeat(deleteCount)
            terminal.write(backspaces)
            const id = ptyIdRef.current
            if (id) {
              inputWriteChain = inputWriteChain.then(() =>
                writePtyChunked(id, '\x7f'.repeat(deleteCount), false),
              )
            }
            return false
          }
          currentLineBuffer = currentLineBuffer.slice(0, -1)
          lastPasteBlock = ''
        }
      }

      if (key === 'v' && !readOnly) {
        if (!!command && NATIVE_CLIPBOARD_IMAGE_AGENTS.has(command)) {
          return true
        }
        event.preventDefault()
        void resolveClipboardPaste()
          .catch(() => navigator.clipboard?.readText() ?? '')
          .then(pasteText)
          .catch(() => {
            terminal.focus()
          })
        return false
      }

      // Ctrl+B toggles the left sidebar; the shell must not also receive it.
      if (key === 'b' && !event.shiftKey) return false

      if (!readOnly && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        navigateHistory(event.key === 'ArrowUp' ? 'up' : 'down')
        return false
      }
      return true
    })

    const restoreHoveredFocus = () => {
      if (document.visibilityState === 'hidden' || !container.matches(':hover')) return
      terminal.focus()
    }
    let shouldRestoreTerminalFocus = false
    const rememberTerminalFocus = () => {
      shouldRestoreTerminalFocus = true
    }
    const rememberPointerFocusIntent = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node) {
        shouldRestoreTerminalFocus = container.contains(target)
      }
    }
    const forgetTerminalFocus = (event: FocusEvent) => {
      const nextTarget = event.relatedTarget
      if (nextTarget instanceof Node && !container.contains(nextTarget)) {
        shouldRestoreTerminalFocus = false
      }
    }
    const restoreLastTerminalFocus = () => {
      if (document.visibilityState === 'hidden' || !shouldRestoreTerminalFocus) return
      terminal.focus()
    }
    // Corrige o atlas de glifos do `CanvasAddon` ao voltar a ficar visível
    // (ex. restaurar a janela depois de minimizada por muito tempo) — sem
    // gate de hover, ao contrário de `restoreHoveredFocus` acima: aqui não é
    // sobre foco, é sobre corrigir pixels errados em QUALQUER painel que
    // volte a ficar visível, hovered ou não. `clearTextureAtlas()` já
    // dispara o redraw sozinho.
    const clearCanvasAtlasOnRestore = () => {
      if (document.visibilityState !== 'visible') return
      try {
        canvasAddonRef.current?.clearTextureAtlas()
      } catch {
        /* addon já disposed nesse meio-tempo — nada a fazer */
      }
    }
    const focusTerminal = () => {
      terminal.focus()
      if (isGridObserver && performance.now() - lastRemoteSyncAt > 300) {
        isGridObserver = false
        observerBaseRect = null
        restoreBaseFontSize()
        scheduleResize(true)
      }
    }
    const onWindowFocus = () => {
      restoreHoveredFocus()
      if (isGridObserver && performance.now() - lastRemoteSyncAt > 300) {
        isGridObserver = false
        observerBaseRect = null
        restoreBaseFontSize()
        scheduleResize(true)
      }
    }
    container.addEventListener('pointerdown', focusTerminal, true)
    container.addEventListener('click', focusTerminal)
    container.addEventListener('focusin', rememberTerminalFocus)
    container.addEventListener('focusout', forgetTerminalFocus)
    document.addEventListener('pointerdown', rememberPointerFocusIntent, true)
    window.addEventListener('focus', onWindowFocus)
    window.addEventListener('focus', restoreLastTerminalFocus)
    document.addEventListener('visibilitychange', restoreHoveredFocus)
    document.addEventListener('visibilitychange', clearCanvasAtlasOnRestore)
    const onPaste = (event: ClipboardEvent) => {
      if (!!command && NATIVE_CLIPBOARD_IMAGE_AGENTS.has(command)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const raw = event.clipboardData?.getData('text/plain') ?? ''
      const hasImageOrFile = Array.from(event.clipboardData?.items ?? []).some(
        (item) => item.type.startsWith('image/') || item.kind === 'file',
      )

      if (hasImageOrFile) {
        void resolveClipboardPaste()
          .catch(() => raw)
          .then(pasteText)
          .catch(() => {
            terminal.focus()
          })
        return
      }

      if (raw) {
        pasteText(raw)
        return
      }
      void resolveClipboardPaste()
        .catch(() => raw)
        .then(pasteText)
        .catch(() => {
          terminal.focus()
        })
    }
    container.addEventListener('paste', onPaste)

    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (readOnly) return

      if (terminal.hasSelection()) {
        const selection = terminal.getSelection()
        if (selection) {
          void writeClipboardText(selection).catch(() => navigator.clipboard?.writeText(selection))
          terminal.clearSelection()
        }
      } else {
        void resolveClipboardPaste()
          .catch(() => navigator.clipboard?.readText() ?? '')
          .then(pasteText)
          .catch(() => {
            terminal.focus()
          })
      }
    }
    container.addEventListener('contextmenu', onContextMenu)

    const flushInput = () => {
      inputFlushScheduled = false
      if (disposed || !queuedInput) return
      const id = ptyIdRef.current
      if (!id) return
      const chunk = queuedInput
      queuedInput = ''

      inputWriteChain = inputWriteChain
        .then(() => writePtyWithTimeout(id, chunk))
        .catch((error) => requestWriteRecovery(id, 'input', error))
    }
    const queueInput = (id: string, data: string) => {
      if (id !== ptyIdRef.current || !data || writeRecoveryPending) return
      queuedInput += data
      if (inputFlushScheduled) return
      inputFlushScheduled = true
      queueMicrotask(flushInput)
    }

    const runResize = () => {
      resizeTimer = null
      const id = ptyIdRef.current
      if (!id) return

      const rect = container.getBoundingClientRect()
      if (rect.width < 50 || rect.height < 30) return
      // Observador da grade compartilhada (ver attachExistingPty). Enquanto o
      // container tiver o mesmo tamanho de quando anexou, isto é só ruído de
      // boot ou um layout aplicado remotamente — reescala a fonte e sai, sem
      // reivindicar a grade. Se o container mudou de verdade, foi o usuário
      // redimensionando ESTE cliente: aí volta a ser dono (fonte nativa) e
      // segue o fluxo normal de fit/settle/commit. É isso que mantém o
      // comportamento simétrico entre desktop e web e evita que um cliente
      // fique preso como observador pra sempre (ex. depois de um reload).
      if (isGridObserver) {
        const isRemoteSyncPeriod = performance.now() - lastRemoteSyncAt < 800
        if (isRemoteSyncPeriod || !document.hasFocus()) {
          observerBaseRect = { width: rect.width, height: rect.height }
          applyGridAtBaseScale(terminal.cols, terminal.rows)
          return
        }
        const base = observerBaseRect
        const moved =
          !base || Math.abs(rect.width - base.width) > 6 || Math.abs(rect.height - base.height) > 6
        if (!moved) {
          applyGridAtBaseScale(terminal.cols, terminal.rows)
          return
        }
        isGridObserver = false
        observerBaseRect = null
        restoreBaseFontSize()
      }
      const activeBuffer = terminal.buffer.active
      const distanceFromBottom = Math.max(0, activeBuffer.baseY - activeBuffer.viewportY)
      try {
        // Remedição forçada (reatribuir `fontSize`) a cada resize foi
        // testada e revertida: força xterm.js a redespachar internamente o
        // mesmo evento `onDimensionsChange` que causa o crash de
        // `syncScrollArea` (ver `patchXtermViewportSyncGuard` acima) — em
        // arrastos contínuos e rápidos, repetir isso a cada tick do resize
        // aumentava a frequência dessa troca de renderer/remedição, e
        // coincidiu com um segfault real do runtime Bun do processo
        // OpenCode (crash reportado pelo próprio Bun como bug interno
        // dele, não do Alethe/OpenCode) — bate com hardening insuficiente
        // do lado do Bun/opentui pra rajadas de resize, não algo que o
        // Alethe deva provocar com mais frequência do que o necessário. A
        // remedição forçada continua só na montagem inicial (mais acima),
        // que é onde a causa raiz documentada de fato mora; aqui é só um
        // `fit()` normal — mais barato, e o patch do Viewport já neutraliza
        // com segurança qualquer `syncScrollArea` que falhe de qualquer
        // jeito.
        fitStableGrid()
      } catch (error) {
        if (import.meta.env.DEV) console.error('[Alethe][xterm] fit failed', error)

        return
      }
      const resizedBuffer = terminal.buffer.active
      if (distanceFromBottom === 0) terminal.scrollToBottom()
      else terminal.scrollToLine(Math.max(0, resizedBuffer.baseY - distanceFromBottom))
      try {
        terminal.refresh(0, Math.max(0, terminal.rows - 1))
      } catch (error) {
        if (import.meta.env.DEV) console.error('[Alethe][xterm] refresh failed', error)
      }
      clampHorizontalScroll()
      const force = forceNextResize
      forceNextResize = false
      if (!force && terminal.cols === lastCols && terminal.rows === lastRows) {
        // Voltou pro último valor já confirmado — qualquer settle-check
        // pendente de um valor intermediário fica obsoleto.
        if (settleTimer !== null) {
          window.clearTimeout(settleTimer)
          settleTimer = null
        }
        return
      }
      // Não manda `resizePty` direto aqui. `fitAddon.fit()`/`refresh()` acima
      // já redesenharam o terminal localmente (sem lag visual pro usuário) —
      // mas o valor de cols/rows calculado durante um arrasto contínuo do
      // divisor pode ser só "de passagem" (visto ao vivo oscilando entre
      // valores bem diferentes pro MESMO painel, ex. 46→79→44→79→73, com o
      // painel vizinho variando de forma complementar). Mandar cada valor de
      // passagem pro backend (SIGWINCH real pro processo do OpenCode/Bun) é
      // o que gera o texto sobreposto/compactado — o OpenCode tenta redesenhar
      // pra um tamanho que já mudou de novo antes do redraw terminar. Só
      // confirma (`resizePty`) quando o MESMO valor aparecer em duas leituras
      // seguidas (~130ms de intervalo) — se estiver assentado, uma leitura já
      // repete o valor; se ainda estiver em movimento, o settle-check adia de
      // novo sozinho até realmente parar.
      scheduleSettleCheck(terminal.cols, terminal.rows)
    }
    // Confirmado ao vivo: reajuste grande do painel não crasha o processo do
    // OpenCode, mas reajustes PEQUENOS e seguidos (cada um já "assentado"
    // isoladamente pelo settle-check acima) continuam derrubando o Bun com
    // um segfault nativo — indício de que o processo ainda está absorvendo
    // o SIGWINCH anterior quando chega outro logo em seguida. Esse cooldown
    // é uma segunda camada, por CIMA do settle-check: mesmo um valor já
    // assentado só é de fato mandado (`resizePty`, que dispara o SIGWINCH
    // real) se já tiver passado um intervalo mínimo desde o último envio.
    const RESIZE_COMMIT_COOLDOWN_MS = 150
    // Cooldown estendido enquanto o painel ainda não produziu saída de
    // verdade (ver `outputByteCount` acima) — janela mais frágil a resize.
    const FRESH_TERMINAL_COOLDOWN_MS = 400
    const FRESH_TERMINAL_OUTPUT_THRESHOLD = 4000
    let lastCommitAt = 0
    const commitResize = (cols: number, rows: number) => {
      lastCols = cols
      lastRows = rows
      lastCommitAt = performance.now()
      const id = ptyIdRef.current
      if (!id) return
      const stableGrid = resolveStableGrid(cols, rows)
      void resizePty(id, stableGrid.cols, stableGrid.rows, activeProfileId).catch(() => {})
      // O dono acabou de medir o próprio container via fitAddon.fit(), então
      // renderiza sempre na fonte nativa — sem escala de observador.
      restoreBaseFontSize()
      syncDebugTerminalHook()
    }
    // Aplica um resize que outro cliente (Desktop ou Web) fez no MESMO PTY.
    // Sem isso, este cliente nunca sabia que a grade mudou — os bytes que
    // chegam pelo canal `data` já vêm redesenhados pro tamanho novo, mas o
    // xterm.js local continuava pintando num grid com o tamanho antigo,
    // corrompendo TUIs multi-painel (OpenCode/Antigravity).
    const applyRemoteResize = (cols: number, rows: number) => {
      if (disposed || cols <= 0 || rows <= 0) return
      const stableGrid = resolveStableGrid(cols, rows, true)
      // Eco do próprio resize voltando (o cliente que iniciou também recebe
      // o broadcast) — já está neste tamanho e na fonte nativa, no-op.
      const isOurRecentCommit =
        !isGridObserver &&
        lastCols === cols &&
        lastRows === rows &&
        performance.now() - lastCommitAt < 1000
      if (isOurRecentCommit) return

      try {
        lastRemoteSyncAt = performance.now()
        isGridObserver = true
        const rect = container.getBoundingClientRect()
        observerBaseRect = { width: rect.width, height: rect.height }
        applyGridAtBaseScale(cols, rows)
      } catch {
        return
      }
      try {
        terminal.refresh(0, Math.max(0, terminal.rows - 1))
      } catch {
        /* refresh pode falhar durante teardown/layout invisível */
      }
      clampHorizontalScroll()
      // Trata o tamanho remoto como a nova baseline local, pra um fit()
      // genuíno subsequente comparar contra ele, não contra o valor antigo
      // pré-resize-remoto (ver o guard de `lastCols`/`lastRows` em
      // `scheduleResize`, logo acima). Não chama `fitAddon.fit()` aqui de
      // propósito — `fit()` mede o container LOCAL e sobrescreveria o
      // tamanho remoto de volta pro tamanho natural deste cliente,
      // anulando o propósito.
      lastCols = stableGrid.cols
      lastRows = stableGrid.rows
    }
    const checkSettled = () => {
      settleTimer = null
      if (disposed) return
      try {
        fitStableGrid()
      } catch {
        return
      }
      if (terminal.cols !== settleCols || terminal.rows !== settleRows) {
        // Ainda mudando — adia de novo em cima do valor mais recente, sem
        // nunca mandar nada pro backend enquanto não assentar.
        scheduleSettleCheck(terminal.cols, terminal.rows)
        return
      }
      if (dragActive) {
        // Assentou momentaneamente, mas o divisor ainda está sendo
        // arrastado — não commita ainda. O listener de
        // `data-resize-handle-active` (abaixo) dispara uma checagem final
        // assim que o usuário soltar.
        return
      }
      // Painel ainda sem conteúdo real na tela (só a splash/prompt inicial)
      // — confirmado por vídeo como o estado mais frágil a resize pro
      // opentui (ver comentário em `outputByteCount` acima). Usa um cooldown
      // maior só nessa janela inicial; depois que já produziu saída de
      // verdade, volta pro cooldown normal.
      const cooldownMs =
        command === 'opencode' && outputByteCount < FRESH_TERMINAL_OUTPUT_THRESHOLD
          ? FRESH_TERMINAL_COOLDOWN_MS
          : RESIZE_COMMIT_COOLDOWN_MS
      const elapsedSinceCommit = performance.now() - lastCommitAt
      if (elapsedSinceCommit < cooldownMs) {
        // Assentou, mas ainda dentro do cooldown do último envio real —
        // espera o restante e reconfirma (o valor pode ter mudado de novo
        // nesse meio-tempo, daí o re-`fit()` no início desta função).
        settleTimer = window.setTimeout(checkSettled, cooldownMs - elapsedSinceCommit)
        return
      }
      commitResize(terminal.cols, terminal.rows)
    }
    const scheduleSettleCheck = (cols: number, rows: number) => {
      settleCols = cols
      settleRows = rows
      if (settleTimer !== null) window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(checkSettled, 60)
    }
    const scheduleResize = (force = false) => {
      // Guard de unmount: neutraliza os setTimeout(120/320ms) de onResizeRequest

      if (disposed) return
      forceNextResize ||= force
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(runResize, 50)
    }
    const scheduleObservedResize = () => scheduleResize()
    const onResizeRequest = (event: Event) => {
      const targetPtyId = (event as CustomEvent<{ ptyId?: string }>).detail?.ptyId
      if (targetPtyId && targetPtyId !== ptyIdRef.current) return
      if (document.hasFocus()) {
        isGridObserver = false
        observerBaseRect = null
        restoreBaseFontSize()
      }
      scheduleResize(true)
      window.setTimeout(() => scheduleResize(true), 120)
      window.setTimeout(() => scheduleResize(true), 320)
    }
    const ro = new ResizeObserver(scheduleObservedResize)
    ro.observe(container)

    // `react-resizable-panels` marca o divisor sendo arrastado com
    // `data-separator="active"`; o grupo ancestral só tem o marcador
    // estático `data-group` (ver App.module.css). Reusa esse sinal aqui:
    // durante o arrasto, `checkSettled` (acima) segue rodando localmente
    // (fit()/refresh() continuam redesenhando o xterm.js sem lag visual),
    // mas o commit real (`resizePty`, que dispara o SIGWINCH pro processo do
    // agente) fica suspenso — só dispara quando o usuário efetivamente solta
    // o divisor. O settle-check + cooldown sozinhos (Extremo 1) reduziram a
    // frequência mas não eliminaram os envios intermediários durante um
    // arrasto contínuo; isso ataca o mesmo sintoma (texto
    // sobreposto/compactado) de um jeito determinístico — atrelado ao
    // evento real de soltar o mouse, não a uma heurística de tempo parado.
    let dragActive = false
    const panelGroupEl = container.closest('[data-group]')
    let dragObserver: MutationObserver | null = null
    const isDragActive = () => panelGroupEl?.querySelector('[data-separator="active"]') != null
    if (panelGroupEl) {
      dragActive = isDragActive()
      dragObserver = new MutationObserver(() => {
        const wasDragging = dragActive
        dragActive = isDragActive()
        if (!wasDragging && dragActive) {
          // An active divider is stronger evidence of a local resize than
          // document.hasFocus(), which can flicker or remain false while a
          // Wayland compositor transfers pointer/keyboard focus. Claim the
          // grid immediately and measure with the native font throughout the
          // drag; the settle guard still prevents intermediate SIGWINCH calls.
          isGridObserver = false
          observerBaseRect = null
          restoreBaseFontSize()
          scheduleResize(true)
        }
        if (wasDragging && !dragActive) {
          // Re-measure after release. Intermediate measurements were local
          // previews only; this schedules the single settled PTY resize.
          scheduleResize(true)
        }
      })
      dragObserver.observe(panelGroupEl, {
        attributes: true,
        attributeFilter: ['data-separator'],
        subtree: true,
      })
    }
    const onZoomChanged = () => {
      const currentFontSize = terminal.options.fontSize
      terminal.options.fontSize = currentFontSize
      scheduleResize(true)
    }
    // A barra divisória foi movida por OUTRO cliente e o layout acabou de ser
    // aplicado aqui (ver SyncedPanelGroup). O painel muda de tamanho, mas isso
    // não é o usuário redimensionando ESTE cliente — re-basear evita que um
    // observador confunda a sincronização com um resize genuíno e saia
    // reivindicando a grade compartilhada de volta.
    const onPaneLayoutSynced = () => {
      lastRemoteSyncAt = performance.now()
      window.requestAnimationFrame(() => {
        if (disposed) return
        const rect = container.getBoundingClientRect()
        if (rect.width < 50 || rect.height < 30) return
        observerBaseRect = { width: rect.width, height: rect.height }
        if (isGridObserver) {
          applyGridAtBaseScale(terminal.cols, terminal.rows)
        }
      })
    }
    // Proteção contra MemReduct e limpezas externas de memória RAM do sistema:
    // Quando a memória do sistema é liberada bruscamente, o canvas atlas do xterm.js
    // pode ser descartado pelo SO. Disparamos um refresh determinístico para
    // reconstruir o buffer e manter o terminal íntegro sem perda de dados.
    const onMemoryPressureRecover = () => {
      try {
        canvasAddonRef.current?.clearTextureAtlas?.()
        terminal.refresh(0, Math.max(0, terminal.rows - 1))
      } catch {
        /* se o canvas falhar, cai no refresh seguro */
        terminal.refresh(0, Math.max(0, terminal.rows - 1))
      }
    }
    window.addEventListener('alethe:memory-pressure-recover', onMemoryPressureRecover)
    window.addEventListener('alethe:zoom-changed', onZoomChanged)
    window.addEventListener('alethe:terminal-resize-request', onResizeRequest)
    window.addEventListener('alethe:pane-layout-synced', onPaneLayoutSynced)

    const initialFitTimer = window.setTimeout(() => {
      if (document.hasFocus()) {
        isGridObserver = false
        observerBaseRect = null
        restoreBaseFontSize()
      }
      scheduleResize(true)
    }, 150)
    const secondFitTimer = window.setTimeout(() => {
      if (document.hasFocus()) {
        isGridObserver = false
        observerBaseRect = null
        restoreBaseFontSize()
      }
      scheduleResize(true)
    }, 400)

    // zero em vez de tentar reconciliar incrementalmente. `reset()` + replay
    // total elimina qualquer risco de duplicação: não importa quanto foi
    // perdido, o snapshot final devolvido por `attachPty` é a verdade.
    const doResync = (reason: PtyResyncReason = 'initial'): Promise<void> => {
      if (resyncInFlight) return resyncInFlight
      resyncInFlight = (async () => {
        const id = ptyIdRef.current
        if (!id || disposed) return
        try {
          if (reason === 'reconnect' || reason === 'missing') {
            const exists = await ptyExists(id, activeProfileId)
            if (!exists) {
              const now = Date.now()
              const previous = missingPtyRecoveryRef.current
              const recentlyAttempted = previous?.id === id && now - previous.attemptedAt < 10_000
              useTerminalsStore.getState().markExited(id)
              completionMonitor?.dispose()
              completionMonitor = null
              if (!recentlyAttempted && !disposed) {
                missingPtyRecoveryRef.current = { id, attemptedAt: now }
                setRetryKey((value) => value + 1)
              }
              return
            }
          }
          // Chunks that arrive while the snapshot is loading must be replayed
          // after the reset so reconnect recovery never creates a data gap.
          const arrivedDuringFetch: Array<{ chunk: string; cursor?: number }> = []
          resyncCaptureRef = arrivedDuringFetch
          const snapshot = await attachPtySnapshot(id, 512 * 1024, activeProfileId)
          resyncCaptureRef = null
          if (disposed) return
          terminal.reset()
          pendingWrites = []
          pendingWriteLength = 0
          if (writeFrame !== null) {
            window.cancelAnimationFrame(writeFrame)
            writeFrame = null
          }
          if (snapshot.content) queueTerminalWrite(snapshot.content)
          for (const chunk of chunksAfterPtySnapshot(snapshot.cursor, arrivedDuringFetch)) {
            queueTerminalWrite(chunk)
          }
        } catch {
          resyncCaptureRef = null
          // A later reconnect or visibility transition retries the snapshot.
        }
      })().finally(() => {
        resyncInFlight = null
      })
      return resyncInFlight
    }
    resyncTerminalRef.current = doResync

    // Registra os dois listeners de streaming: `data` (canal caro — escreve

    // chunk ser processado em duplicidade.
    // `inspectChunk` roda nos DOIS canais: um pane em segundo plano só recebe
    // `activity`, e a detecção de conflito de resume do Codex não pode
    // depender de o pane estar visível.
    const watchForBunCrash = (chunk: string) => {
      if (command !== 'opencode') return
      outputByteCount += chunk.length
      if (bunCrashDetected) return
      // Chunks de PTY podem partir o texto do crash-reporter no meio —
      // mesmo padrão de buffer circular limitado do `resumeErrorBuffer`.
      bunCrashBuffer = `${bunCrashBuffer}${chunk}`.slice(-4096)
      if (BUN_CRASH_SIGNATURE.test(bunCrashBuffer)) bunCrashDetected = true
    }
    const registerPtyStreamListeners = async (
      id: string,
      inspectChunk?: (chunk: string) => void,
    ): Promise<boolean> => {
      const dataUnlisten = await listenPtyData(
        id,
        (chunk, cursor) => {
          useTerminalsStore.getState().recordIo(id)
          if (resyncCaptureRef) resyncCaptureRef.push({ chunk, cursor })
          queueTerminalWrite(chunk)
          completionMonitor?.handleOutput(chunk)
          inspectChunk?.(chunk)
          watchForBunCrash(chunk)
        },
        activeProfileId,
      )
      if (disposed) {
        dataUnlisten()
        return false
      }
      unlistenData = dataUnlisten

      const activityUnlisten = await listenPtyActivity(
        id,
        (chunk, cursor) => {
          useTerminalsStore.getState().recordIo(id)
          // Visibility is process-global in the PTY core. If another client hid
          // the same terminal, this locally visible pane receives the coalesced
          // activity channel and must still render it.
          if (isPanelVisibleRef.current) {
            if (resyncCaptureRef) resyncCaptureRef.push({ chunk, cursor })
            queueTerminalWrite(chunk)
          }
          completionMonitor?.handleOutput(chunk)
          inspectChunk?.(chunk)
          watchForBunCrash(chunk)
        },
        activeProfileId,
      )
      if (disposed) {
        activityUnlisten()
        return false
      }
      unlistenActivity = activityUnlisten

      const resyncUnlisten = await listenPtyResync(
        id,
        (reason) => {
          void doResync(reason)
        },
        activeProfileId,
      )
      if (disposed) {
        resyncUnlisten()
        return false
      }
      unlistenResync = resyncUnlisten

      const resizeUnlisten = await listenPtyResized(
        id,
        ({ cols, rows }) => applyRemoteResize(cols, rows),
        activeProfileId,
      )
      if (disposed) {
        resizeUnlisten()
        return false
      }
      unlistenResize = resizeUnlisten
      return true
    }
    // Só um auto-restart por crash detectado nesta sessão de mount, com um
    // teto total pro painel (`bunCrashAutoRestartCountRef`) — se o processo
    // continuar crashando repetidamente mesmo depois de reiniciar, para de
    // insistir sozinho e deixa o estado "saiu" normal assumir (usuário reinicia
    // manualmente), em vez de entrar num loop de restart infinito.
    const BUN_CRASH_AUTO_RESTART_MAX = 2
    const tryAutoRestartOnBunCrash = (): boolean => {
      if (!bunCrashDetected) return false
      if (bunCrashAutoRestartCountRef.current >= BUN_CRASH_AUTO_RESTART_MAX) return false
      bunCrashAutoRestartCountRef.current += 1
      bunCrashDetected = false
      bunCrashBuffer = ''
      terminal.write(
        '\r\n\x1b[33m[alethe] o agente travou por um bug conhecido do runtime Bun (não do seu projeto ou do Alethe) — reiniciando a sessão…\x1b[0m\r\n',
      )
      setRetryKey((value) => value + 1)
      return true
    }

    const attachExistingPty = async (existingId: string) => {
      setBootPhase('attaching')
      ptyIdRef.current = existingId
      // Anexar a uma sessão já existente entra como observador da grade
      // compartilhada — vale igual pra desktop e pra web, sem privilegiar
      // nenhum dos dois ("quem cria a sessão é dono da grade"). Setado antes
      // de qualquer `await` pra já valer no primeiro tick de
      // ResizeObserver/initialFitTimer que dispare enquanto isto ainda está em
      // andamento; volta a ser dono no primeiro resize genuíno do próprio
      // container (ver runResize).
      isGridObserver = true
      const attachRect = container.getBoundingClientRect()
      observerBaseRect = { width: attachRect.width, height: attachRect.height }
      useTerminalsStore.getState().registerPty(existingId)
      onSpawnedRef.current?.(existingId)
      // Sessão pode já existir de antes deste mount (reload do app, etc.) —
      // estabelece a visibilidade correta no backend desde já.
      void setPtyVisible(existingId, isPanelVisibleRef.current, activeProfileId).catch(() => {})

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

      // gastar o burst de write mais pesado (TUIs como o OpenCode) enquanto

      if (isPanelVisibleRef.current) {
        const replay = await attachPty(existingId, 512 * 1024, activeProfileId)
        if (disposed) return
        if (replay) await writeReplayAtOnce(replay)
        if (disposed) return
      }

      if (!(await registerPtyStreamListeners(existingId))) return

      const exitUnlisten = await listenPtyExit(
        existingId,
        (payload) => {
          console.info(
            `[pty-launch] ${command ?? 'shell'} EXIT (attach) id=${existingId} code=${payload.code ?? '—'} reason=${payload.reason ?? '—'}`,
          )
          if (payload.reason === 'restarted') {
            useTerminalsStore.getState().beginRestart(existingId)
            void doResync('reconnect')
            return
          }
          if (payload.reason === 'suspended') {
            useTerminalsStore.getState().markSuspended(existingId)
            completionMonitor?.dispose()
            completionMonitor = null
            return
          }
          if (tryAutoRestartOnBunCrash()) {
            useTerminalsStore.getState().markExited(existingId)
            completionMonitor?.dispose()
            completionMonitor = null
            return
          }
          useTerminalsStore.getState().markExited(existingId)
          completionMonitor?.dispose()
          completionMonitor = null
          removeSession(sessionPersistenceKey)
          onExitRef.current?.(payload.code)
        },
        activeProfileId,
      )
      if (disposed) {
        exitUnlisten()
        return
      }
      unlistenExit = exitUnlisten

      // Adota a grade vigente do PTY compartilhado, adaptando a fonte local a
      // ela (applyRemoteResize → applyGridAtBaseScale). Sem commit: anexar nunca
      // reivindica a grade, só um resize genuíno deste cliente faz isso.
      try {
        const { cols, rows } = await getPtySize(existingId, activeProfileId)
        if (!disposed && cols > 0 && rows > 0) {
          const proposed = fitAddon.proposeDimensions()
          if (
            document.hasFocus() &&
            proposed &&
            proposed.cols > 0 &&
            proposed.rows > 0 &&
            (proposed.cols !== cols || proposed.rows !== rows)
          ) {
            isGridObserver = false
            observerBaseRect = null
            restoreBaseFontSize()
            scheduleResize(true)
          } else {
            applyRemoteResize(cols, rows)
          }
        }
      } catch {
        /* consulta falhou (PTY novo pro backend, rede) — sem adoção de grade;
           o primeiro resize genuíno reivindica normalmente. */
      }
      if (!disposed) setBootPhase('ready')
    }

    terminal.onData((data) => {
      if (readOnly) return
      const id = ptyIdRef.current
      if (!id) return
      if (isGridObserver) {
        isGridObserver = false
        observerBaseRect = null
        restoreBaseFontSize()
        scheduleResize(true)
      }
      useTerminalsStore.getState().recordIo(id)
      const startsNewSession = recordPromptInput(data)
      completionMonitor?.handleInput(data)
      const trackedPtyId = ptyIdRef.current
      if (trackedPtyId) recordAgentActivityInput(trackedPtyId, data)
      if (data === '\r' || data === '\n') {
        currentLineBuffer = ''
        lastPasteBlock = ''
      } else if (data === '\x7f' || data === '\b') {
        currentLineBuffer = currentLineBuffer.slice(0, -1)
        lastPasteBlock = ''
      } else if (data.length === 1 && data >= ' ') {
        currentLineBuffer += data
        lastPasteBlock = ''
      }
      queueInput(id, data)
      if (startsNewSession && command && command !== 'shell') {
        if (writeFrame !== null) {
          window.cancelAnimationFrame(writeFrame)
          writeFrame = null
        }
        pendingWrites = []
        pendingWriteLength = 0
        terminal.clear()
        terminal.scrollToBottom()
        // queueInput schedules its flush first, so this runs only after /new
        // reaches the agent and before its fresh-session output is persisted.
        queueMicrotask(() => {
          inputWriteChain = inputWriteChain
            .then(() => clearPtyScrollback(id))
            .catch((error) => console.warn('[pty-scrollback] failed to clear after /new:', error))
        })
      }
    })

    const RESUMABLE_AGENTS = ['claude', 'codex', 'opencode', 'antigravity']

    async function start() {
      try {
        // Skip zero-sized panes; the observer retries after layout settles.
        try {
          const rect = container?.getBoundingClientRect()
          if (rect && rect.width >= 50 && rect.height >= 30) fitStableGrid()
        } catch {
          // Renderer ainda não montou — o próximo resize tenta de novo.
        }
        setCommandNotFound(null)
        setBootPhase('preparing')

        const existingRuntime = useTerminalsStore.getState().byPtyId[ptyId]
        if (existingRuntime?.alive && !existingRuntime.parked) {
          await attachExistingPty(ptyId)
          return
        }
        const backendHasPty = await ptyExists(ptyId, activeProfileId).catch(() => false)
        if (backendHasPty) {
          await attachExistingPty(ptyId)
          return
        }

        let launcherOverride: string | undefined
        if (command && command !== 'shell') {
          if (cliPathOverride) {
            if (cliPathMatchesAgent(command, cliPathOverride)) {
              launcherOverride = cliPathOverride
              console.info(`[pty-launch] ${command} using override: ${cliPathOverride}`)
            } else {
              useProjectsStore.getState().setCliPath(command, null)
              useUiStore.getState().pushToast({
                title: translate(getLocale(), 'prefs.cliPathMismatch'),
                body: translate(getLocale(), 'prefs.cliPathMismatchBody', {
                  agent: command,
                  command: agentCliCommand(command) ?? command,
                }),
              })
            }
          }
          if (!launcherOverride) {
            const auto = await findCliLauncher(agentCliCommand(command) ?? command)
            console.info(`[pty-launch] ${command} findCliLauncher → ${auto ?? 'null (NOT FOUND)'}`)
            if (!auto) {
              console.warn(
                `[pty-launch] ${command} unresolved — showing the not-found overlay and staying offline`,
              )
              setCommandNotFound(command)
              useTerminalsStore.getState().setStatus(ptyId, 'offline')
              return
            }
          }
        }

        const savedSession =
          command && RESUMABLE_AGENTS.includes(command) ? peekSession(sessionPersistenceKey) : null
        const savedConversationId = savedConversationIdFor(savedSession, command, cwd)
        let resumeId = sessionId ?? savedConversationId
        // A session id read from a file that was badly merged can carry real conflict markers
        // inside the value, and that raw text became the `--session` argument of the spawn
        // verbatim. Never trust a resumeId containing a line break or a conflict marker —
        // treat it as "no previous session" instead of passing garbage to the CLI.
        if (resumeId && (/[\r\n]/.test(resumeId) || /^(<{7}|={7}|>{7})/m.test(resumeId))) {
          console.warn(
            `[pty-launch] ${command} discarded a malformed resumeId (conflict marker?): ${JSON.stringify(resumeId.slice(0, 120))}`,
          )
          resumeId = undefined
        }
        // Fallback: se a tentativa anterior morreu no nascimento usando resume,

        if (forceFreshRef.current) {
          console.warn(`[pty-launch] ${command} reabrindo SEM resume (fallback de early-exit)`)
          resumeId = undefined
        }
        if (
          resumeId &&
          cwd &&
          command &&
          isSessionClaimed(command, cwd, resumeId, sessionPersistenceKey)
        ) {
          console.warn(
            `[pty-launch] ${command} session ${resumeId} is already claimed; starting a fresh writer`,
          )
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

        // `trustSessionId` pula essa checagem — confirmado empiricamente que

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

            if (notListed && command !== 'opencode') {
              console.warn(`[pty-launch] ${command} ignorando sessão órfã ${resumeId}`)
              resumeId = undefined
              removeSession(sessionPersistenceKey)
              onSessionIdRef.current?.(undefined)
            }
          } catch {
            // Falha ao checar a sessão — segue com o resumeId que já tinha.
          }
          if (disposed) return
        }
        // OpenCode não permite escolher o ID no nascimento (ao contrário do
        // Claude) — sem um ID salvo válido, reivindicamos aqui a conversa mais
        // recente ainda não pega por outro pane (ex.: reabrir o app depois de
        // fechado). `!forceFreshRef.current` é essencial: no fallback de
        // early-exit (abaixo) o resumeId acabou de ser zerado de propósito
        // porque a sessão órfã matou o agente no nascimento — reivindicar de
        // novo aqui recriaria o mesmo loop. `!skipSessionClaim`: numa tab
        // RECÉM-CRIADA (nunca spawnada antes) esse fallback não deve rodar —
        // sem essa checagem, um projeto novo apontando pra uma pasta com
        // histórico OpenCode de outro projeto/uso anterior herdava a
        // conversa antiga sem o usuário pedir (bug real, reportado ao vivo).
        if (
          command === 'opencode' &&
          !resumeId &&
          cwd &&
          !forceFreshRef.current &&
          !skipSessionClaim
        ) {
          try {
            const sessions = await snapshotOpenCodeSessions(cwd)
            const reserved = reservedSessionIdsFor('opencode', sessionPersistenceKey)
            const claimed = claimMostRecentSession('opencode', cwd, sessions, undefined, reserved)
            if (claimed) resumeId = claimed.id
          } catch {
            // Falha ao listar sessões — segue sem reivindicar nenhuma.
          }
          if (disposed) return
        }
        const preparedRuntime = command
          ? preparePtyRuntimeLaunch(command, runtimeProfile, extraArgs ?? [], env)
          : { args: extraArgs ?? [], env }

        // o spawn.
        const mcpConfigPaths: string[] = []

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

        // Claude only: it takes an ephemeral --mcp-config, so nothing is left behind pointing at a
        // dead endpoint. Codex and OpenCode need in-repo config writes.
        //
        // This must never start a browser. The config points at the shared browser when one is
        // already running and otherwise leaves Playwright on its default, which opens a browser
        // only once the agent reaches for one.
        const playwrightEnabled = useProjectsStore.getState().preferences.enabledFeatures.playwright
        if (playwrightEnabled && command === 'claude') {
          const p = await playwrightMcpConfigPath().catch(() => undefined)
          if (p) mcpConfigPaths.push(p)
          if (disposed) return
        }

        const orchestratorEnabled =
          useProjectsStore.getState().preferences.enabledFeatures.orchestrator
        if (orchestratorEnabled && command === 'claude') {
          const p = await orchestratorMcpConfigPath().catch(() => undefined)
          if (p) mcpConfigPaths.push(p)
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
        if (command && cwd) {
          registerSessionClaim(command, cwd, launch.sessionId, sessionPersistenceKey)
        }

        // Claude gets its id up front through --session-id, but /new and /resume
        // typed inside the CLI move it to another conversation. Baselining the
        // directory here lets the watcher below adopt whatever it moves to.
        const discoveredSessionsBeforePromise =
          cwd && (!launch.sessionId || command === 'claude')
            ? command === 'codex'
              ? snapshotCodexSessions(cwd).catch(() => [])
              : command === 'antigravity'
                ? snapshotAntigravitySessions(cwd).catch(() => [])
                : command === 'opencode'
                  ? snapshotOpenCodeSessions(cwd).catch(() => [])
                  : command === 'claude'
                    ? snapshotClaudeSessions(cwd).catch(() => [])
                    : null
            : null

        // Too many parallel PTY spawns can stall the app.
        setBootPhase('queued')
        const acquiredSpawnSlot = await acquireSpawnSlot(spawnQueueAbort.signal)
        if (!acquiredSpawnSlot) return
        if (disposed) {
          releaseSpawnSlot()
          return
        }
        setBootPhase('spawning')
        // OpenCode reads its configuration from `XDG_CONFIG_HOME`, so pointing that at Alethe's own
        // directory gives the agent a clean environment Alethe manages instead of whatever the
        // machine happens to have. Only configuration moves: sessions, credentials and snapshots
        // live in OpenCode's separate data directory, so history and login are unaffected.
        let spawnEnv = preparedRuntime.env
        if (command === 'opencode') {
          const configRoot = await agentConfigRoot().catch((error) => {
            // Falling back to the ambient config is better than refusing to start, but it has to be
            // visible: the agent then reads a different file from the one the MCP manager edits.
            console.error('[pty-launch] could not resolve the agent config root:', error)
            return null
          })
          if (configRoot) spawnEnv = { ...(spawnEnv ?? {}), XDG_CONFIG_HOME: configRoot }
          if (disposed) return
        }

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
            env: spawnEnv,
            profileId: activeProfileId,
          })
        } finally {
          releaseSpawnSlot()
        }
        // The spawned PTY already owns this exact grid. Baseline it here so
        // the first ResizeObserver tick does not emit a redundant SIGWINCH —
        // especially important for Linux agent sessions whose grid stays
        // pinned for their lifetime.
        lastCols = terminal.cols
        lastRows = terminal.rows
        console.info(`[pty-launch] ${command ?? 'shell'} spawn OK id=${response.id}`)
        spawnedAtRef.current = Date.now()
        usedResumeRef.current = Boolean(resumeId)
        if (disposed) return
        setBootPhase('attaching')
        ptyIdRef.current = response.id
        useTerminalsStore.getState().registerPty(response.id)
        onSpawnedRef.current?.(response.id)

        // visibilidade correta desde o primeiro lote (ex.: pane aberto num
        // grupo/aba já invisível não deve gastar render à toa).
        void setPtyVisible(response.id, isPanelVisibleRef.current, activeProfileId).catch(() => {})
        if (command && cwd && launch.sessionId) {
          // Owned by the tab as well as the PTY: the PTY id changes on every
          // respawn, and a claim only reachable through a dead PTY id would make
          // the tab treat its own conversation as taken and start a fresh one.
          registerSessionClaim(command, cwd, launch.sessionId, sessionPersistenceKey)
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

          if (
            (command === 'codex' || command === 'antigravity' || command === 'opencode') &&
            cwd &&
            discoveredSessionsBeforePromise
          ) {
            void watchAndPersistDiscoveredSession({
              agent: command,
              cwd,
              sessionPersistenceKey,
              spawnedPtyId: response.id,
              discoveredSessionsBeforePromise,
              isCancelled: () => disposed,
              onSessionId: (id) => onSessionIdRef.current?.(id),
              reservedIds: reservedSessionIdsFor(command, sessionPersistenceKey),
            })
          }
        }

        let resumeConflictHandled = false
        const handleResumeConflict = () => {
          resumeConflictHandled = true
          earlyExitRetriedRef.current = true
          forceFreshRef.current = true
          removeSession(sessionPersistenceKey)
          onSessionIdRef.current?.(undefined)
          terminal.write(
            '\r\n\x1b[33m[alethe] Codex session is busy — opening a fresh session…\x1b[0m\r\n',
          )
          void killPty(response.id, activeProfileId).catch(() => {})
          setRetryKey((value) => value + 1)
        }

        // Codex writes the bootstrap error and exits before the stream listeners below
        // exist, so a hidden pane would never see it: it does not read the replay, and by
        // the time it is shown the process is long gone. `attach_pty` only reads the
        // scrollback, so asking for it early costs nothing and consumes nothing.
        if (command === 'codex' && usedResumeRef.current && !isPanelVisibleRef.current) {
          const early = await attachPty(response.id).catch(() => '')
          if (disposed) return
          if (early && /already has an active writer|thread\/resume failed/i.test(early)) {
            handleResumeConflict()
            return
          }
        }

        // registrado logo abaixo, que roda nos dois canais de streaming.
        if (isPanelVisibleRef.current) {
          const replay = await attachPty(response.id, 512 * 1024, activeProfileId)
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
          if (replay) await queueTerminalWriteAndWait(replay)
          if (disposed) return
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

        const exitUnlisten = await listenPtyExit(
          response.id,
          (payload) => {
            // unlistenExit só roda na cleanup do effect, depois de dispose() — um exit
            // que chega no meio dessa janela ainda dispara este callback contra um
            // terminal já disposed (renderer removido), daí o guard antes de qualquer write.
            if (disposed) return
            console.info(
              `[pty-launch] ${command ?? 'shell'} EXIT id=${response.id} code=${payload.code ?? '—'} reason=${payload.reason ?? '—'}`,
            )
            if (payload.reason === 'restarted') {
              useTerminalsStore.getState().beginRestart(response.id)
              void doResync('reconnect')
              return
            }
            if (payload.reason === 'suspended') {
              useTerminalsStore.getState().markSuspended(response.id)
              completionMonitor?.dispose()
              completionMonitor = null
              return
            }
            if (tryAutoRestartOnBunCrash()) {
              useTerminalsStore.getState().markExited(response.id)
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
          },
          activeProfileId,
        )
        if (disposed) {
          exitUnlisten()
          return
        }
        unlistenExit = exitUnlisten

        // Consome a flag de "tab recém-criada" agora que o primeiro spawn de
        // verdade aconteceu — a partir daqui essa tab já existe de verdade,
        // e um restart/reload futuro deve voltar a poder reivindicar sessão
        // normalmente (recuperação após reiniciar o app).
        if (skipSessionClaim) onSessionClaimSkippedRef.current?.()

        const prompt = initialInput?.trim()
        if (prompt) {
          const sendInitialInput = async () => {
            console.info(
              `[pty-launch] ${command ?? 'shell'} aguardando pra enviar o prompt inicial id=${response.id}`,
            )
            // "Saída quieta por 700ms" é o sinal ERRADO pro OpenCode —
            // confirmado ao vivo, repetidas vezes: ele fica quieto assim que a
            // tela de boas-vindas termina de desenhar, bem antes de terminar
            // de conectar nos servidores MCP (o rodapé mostra "4 MCP" —
            // provavelmente é essa conexão, não a UI, que demora de verdade).
            // Uma espera mínima fixa também não resolveu (confirmado ao vivo:
            // mandou rápido e a tela continuou vazia). Pro OpenCode a
            // "prontidão" agora é verificada de outro jeito, lendo a TELA
            // renderizada de verdade (ver bloco isOpencode mais abaixo) em vez
            // de adivinhar por tempo — só uma espera curta aqui pra não digitar
            // em cima do primeiro paint. Pros outros providers mantém o
            // critério antigo, que nunca deu esse problema.
            const isOpencode = command === 'opencode'
            const earliestSendAt = Date.now() + (isOpencode ? 4_000 : 1_500)
            const timedSendAt = Date.now() + (isOpencode ? 4_000 : 4_000)
            // Deadline bem maior que o mínimo, como rede de segurança: com um
            // painel pesado (outro terminal TUI) aberto ao lado, a thread
            // principal da WebView pode ficar congestionada o bastante pra
            // atrasar até os próprios setTimeout deste loop — testado ao vivo,
            // só um teto bem maior (2min) garante tempo de calendário
            // suficiente mesmo com os ticks atrasados.
            const deadline = Date.now() + 120_000
            let readyToSend = false
            while (!disposed && Date.now() < deadline) {
              await new Promise((resolve) => window.setTimeout(resolve, 250))
              const runtime = useTerminalsStore.getState().byPtyId[response.id]
              const quietFor = runtime ? Date.now() - runtime.lastIoAt : 0
              // OpenCode: só a espera mínima fixa importa (earliestSendAt já
              // cobre isso). Outros providers: mantém o critério antigo de
              // "saída quieta", que nunca deu esse problema.
              const settled = isOpencode || quietFor >= 700 || Date.now() >= timedSendAt
              if (Date.now() >= earliestSendAt && runtime?.alive && settled) {
                readyToSend = true
                break
              }
            }
            if (disposed) {
              console.info(
                `[pty-launch] ${command ?? 'shell'} pane desmontado antes de enviar o prompt inicial id=${response.id}`,
              )
              return
            }
            if (!readyToSend) {
              console.warn(
                `[pty-launch] ${command ?? 'shell'} deadline vencido sem enviar o prompt inicial id=${response.id}`,
              )
              return
            }

            try {
              if (ptyIdRef.current !== response.id) {
                console.warn(
                  `[pty-launch] ${command ?? 'shell'} ptyId DIVERGENTE na hora de enviar! response.id=${response.id} ptyIdRef.current=${ptyIdRef.current} — escrevendo no id errado explicaria "enviado sem erro, nunca aparece"`,
                )
              }
              // Foca o painel bem antes de escrever: se o app já ligou
              // "focus reporting" (DECSET 1004) depois do focus() automático
              // do mount, ele nunca mais recebia o sinal de foco de novo —
              // só clique/pointerdown real disparavam isso. Algumas TUIs só
              // aceitam entrada de teclado depois de um focus-in confirmado.
              // Barato e inofensivo mesmo se não for isso.
              try {
                terminal.focus()
              } catch {
                /* painel pode já estar desmontando — ignora */
              }
              // Lê a TELA já renderizada pelo próprio xterm.js — o mesmo
              // buffer que ele usa pra desenhar, já com todos os códigos
              // ANSI aplicados e resolvidos em texto puro. Usado tanto pela
              // confirmação de digitação do OpenCode (`agentPromptDelivery.ts`)
              // quanto pela confirmação mínima de Enter dos outros providers
              // logo abaixo.
              const readVisibleScreenText = (rows = 200): string => {
                const buffer = terminal.buffer.active
                const start = Math.max(0, buffer.length - rows)
                const lines: string[] = []
                for (let y = start; y < buffer.length; y++) {
                  const line = buffer.getLine(y)
                  if (line) lines.push(line.translateToString(true))
                }
                return lines.join('\n')
              }
              if (isOpencode) {
                // Lógica de digitação/confirmação em si mora em
                // `agentPromptDelivery.ts` (extraída pra ser reaproveitada
                // fora deste componente, ex. pela suíte e2e — ver
                // `e2e/support/openCodePrompt.ts` — sem duplicar nem
                // reinventar algo já testado ao vivo).
                const delivered = await deliverOpenCodePrompt(prompt, deadline, {
                  readScreenText: readVisibleScreenText,
                  write: (data) => writePty(response.id, data, activeProfileId),
                  sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
                  isCancelled: () => disposed,
                })
                if (!delivered) {
                  console.warn(
                    `[pty-launch] opencode não confirmou o texto digitado na tela antes do prazo id=${response.id}`,
                  )
                  return
                }
              } else {
                // Bracketed paste (marcadores 200~/201~) só faz sentido se o
                // processo já ligou o modo (DECSET 2004) — mandar `true`
                // fixo aqui, ignorando o estado real do terminal, fazia
                // CLIs que ainda não ligaram esse modo receberem os
                // marcadores como ruído em vez de tratar como colagem.
                // Mesmo critério já usado pela colagem normal (pasteText,
                // mais acima neste arquivo).
                await writePtyChunked(response.id, prompt, terminal.modes.bracketedPasteMode)
                await new Promise((resolve) => window.setTimeout(resolve, 150))
                await writePty(response.id, '\r', activeProfileId)
                // Mesmo critério de segurança já usado pelo OpenCode em
                // `agentPromptDelivery.ts`: nunca reenviar Enter às cegas.
                // Compara a tela antes/depois — só reenvia se ficar
                // EXATAMENTE igual (o primeiro Enter não registrou). Sem
                // isso, um segundo `\r` sempre disparava 1200ms depois
                // mesmo quando o primeiro já tinha funcionado, arriscando
                // confirmar um envio em cima de uma resposta que o agente
                // já tinha começado a escrever.
                await new Promise((resolve) => window.setTimeout(resolve, 1_200))
                if (!disposed && ptyIdRef.current === response.id) {
                  const beforeRetry = readVisibleScreenText()
                  await new Promise((resolve) => window.setTimeout(resolve, 300))
                  const stillUnchanged = !disposed && readVisibleScreenText() === beforeRetry
                  if (stillUnchanged) {
                    void writePty(response.id, '\r', activeProfileId).catch(() => {})
                  }
                }
              }
              console.info(
                `[pty-launch] ${command ?? 'shell'} prompt inicial enviado id=${response.id}`,
              )
              onInitialInputSentRef.current?.()
            } catch (error) {
              console.warn('[pty-launch] não foi possível enviar o prompt inicial:', error)
            }
          }
          initialInputInFlight = true
          void sendInitialInput().finally(() => {
            initialInputInFlight = false
          })
        }

        scheduleResize()
        if (!disposed) setBootPhase('ready')
      } catch (err) {
        console.error(`[pty-launch] ${command ?? 'shell'} FALHOU ao iniciar PTY:`, err)
        onLaunchErrorRef.current?.(err)
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
      container.removeEventListener('focusin', rememberTerminalFocus)
      container.removeEventListener('focusout', forgetTerminalFocus)
      document.removeEventListener('pointerdown', rememberPointerFocusIntent, true)
      window.removeEventListener('focus', restoreLastTerminalFocus)
      document.removeEventListener('visibilitychange', restoreLastTerminalFocus)
      container.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', restoreHoveredFocus)
      document.removeEventListener('visibilitychange', clearCanvasAtlasOnRestore)
      window.removeEventListener('alethe:memory-pressure-recover', onMemoryPressureRecover)
      window.removeEventListener('alethe:zoom-changed', onZoomChanged)
      window.removeEventListener('alethe:terminal-resize-request', onResizeRequest)
      window.removeEventListener('alethe:pane-layout-synced', onPaneLayoutSynced)
      ro.disconnect()
      dragObserver?.disconnect()
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      if (settleTimer !== null) window.clearTimeout(settleTimer)
      if (writeFrame !== null) window.cancelAnimationFrame(writeFrame)
      pendingWrites = []
      pendingWriteLength = 0
      pendingWriteDrainResolvers = []
      queuedInput = ''
      window.clearTimeout(initialFitTimer)
      window.clearTimeout(secondFitTimer)
      unlistenData?.()
      unlistenActivity?.()
      unlistenExit?.()
      unlistenResync?.()
      unlistenResize?.()
      unlistenDragDrop?.()
      linkProviderDisposable?.dispose()
      linkScrollDisposable?.dispose()
      completionMonitor?.dispose()
      completionMonitor = null
      setLinkActions(null)
      if (terminalRef.current === terminal) terminalRef.current = null
      ptyIdRef.current = null
      if (resyncTerminalRef.current === doResync) resyncTerminalRef.current = null
      canvasAddonRef.current = null
      terminal.dispose()
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPersistenceKey, retryKey, activeProfileId])

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

    // While hidden the PTY still reports activity, so lastIoAt tells us whether anything was
    // produced. If nothing was, the buffer on screen is already correct and resyncing would only
    // clear the terminal and rewrite identical bytes — a visible flash for no reason.
    const ioAtNow = () => useTerminalsStore.getState().byPtyId[ptyId]?.lastIoAt ?? 0
    if (!isPanelVisible) lastIoWhenHiddenRef.current = ioAtNow()

    void setPtyVisible(ptyId, isPanelVisible, activeProfileId)
      .catch(() => {})
      .then(() => {
        if (cancelled || !isPanelVisible || wasVisible) return
        if (lastIoWhenHiddenRef.current !== null && ioAtNow() === lastIoWhenHiddenRef.current)
          return
        resyncTimer = window.setTimeout(() => {
          if (!cancelled) void resyncTerminalRef.current?.()
        }, PANEL_RESYNC_DEBOUNCE_MS)
      })

    return () => {
      cancelled = true
      if (resyncTimer !== null) window.clearTimeout(resyncTimer)
    }
  }, [ptyId, isPanelVisible, activeProfileId])
}
