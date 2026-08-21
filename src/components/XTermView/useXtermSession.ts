import { getCurrentWebview } from '@tauri-apps/api/webview'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useEffect, useRef } from 'react'

import { recordAgentActivityInput } from '../../lib/activityTracker'
import { cliPathMatchesAgent } from '../../lib/agentCliPath'
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
  peekSession,
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
  clearPtyScrollback,
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
  orchestratorMcpConfigPath,
  playwrightMcpConfigPath,
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
import {
  TERMINAL_WRITE_FRAME_BUDGET,
  trimPendingWrites,
  writePtyChunked,
  writePtyWithTimeout,
} from './terminalWrite'
import { getXtermTheme, type LinkActionState } from './xtermThemes'

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

type BootPhase = 'preparing' | 'queued' | 'spawning' | 'attaching' | 'ready'

export function useXtermSession(params: {
  ptyId: string
  command?: AgentType | null
  cwd?: string | null
  extraArgs?: string[]
  initialInput?: string
  sessionId?: string
  env?: Record<string, string>
  graphifyRepo?: string | null

  gsdWatcherEnabled?: boolean

  trustSessionId?: boolean

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
  const isPanelVisibleRef = useRef(isPanelVisible)
  const wasPanelVisibleRef = useRef(isPanelVisible)

  const isFirstVisibilityRunRef = useRef(true)
  /** lastIoAt captured when the panel went hidden; null until it has been hidden once. */
  const lastIoWhenHiddenRef = useRef<number | null>(null)

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
    let pendingWriteDrainResolvers: Array<() => void> = []
    let resumeErrorBuffer = ''

    let resyncCaptureRef: string[] | null = null
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
      fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
      fontSize: 14,
      theme: getXtermTheme(terminalTheme),
    })
    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(searchAddon)

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

    linkScrollDisposable = terminal.onScroll(() => {
      if (linkActionsRef.current) setLinkActions(null)
    })

    terminal.focus()

    const flushPendingWrite = () => {
      writeFrame = null
      if (disposed) return
      if (pendingWriteLength === 0) return

      let budget = TERMINAL_WRITE_FRAME_BUDGET
      let output = ''
      while (budget > 0 && pendingWrites.length > 0) {
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
        } catch {}
      }
      if (pendingWriteLength > 0) {
        writeFrame = window.requestAnimationFrame(flushPendingWrite)
      }
    }

    const queueTerminalWrite = (chunk: string) => {
      if (!chunk) return
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
            } catch {}
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

      // interceptasse o wheel (preventDefault), o evento sumia e nem o host nem

      if (!shouldScrollHostScrollback(terminal.buffer.active.type, event.shiftKey)) return
      const lines = getWheelScrollLines(event, getTerminalLineHeight())
      if (lines === 0) return
      event.preventDefault()
      event.stopPropagation()
      try {
        terminal.scrollLines(lines)
      } catch {}
    }
    container.addEventListener('wheel', onWheel, { passive: false, capture: true })

    const requestWriteRecovery = (id: string, source: 'input' | 'paste', error: unknown) => {
      console.warn(`[pty-${source}] write failed for ${id}; requesting recovery`, error)
      if (disposed || writeRecoveryPending || id !== ptyIdRef.current) return
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
        const text = normalizePastedText(raw)
        useTerminalsStore.getState().recordIo(id)
        recordPromptInput(text)
        inputWriteChain = inputWriteChain
          .then(() => writePtyChunked(id, text, terminal.modes.bracketedPasteMode))
          .catch((error) => requestWriteRecovery(id, 'paste', error))
      } catch (err) {
        console.warn('[pty-paste] ignored invalid clipboard payload:', err)
      }
    }

    // texto puro; arquivos do Explorer (CF_HDROP) e imagens cruas (CF_DIB /

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
      .catch(() => {})

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

      // Ctrl+B toggles the left sidebar; the shell must not also receive it.
      if (key === 'b' && !event.shiftKey) return false

      if (!readOnly && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        navigateHistory(event.key === 'ArrowUp' ? 'up' : 'down')
        return false
      }
      return true
    })

    let shouldRestoreTerminalFocus = false
    const focusTerminal = () => {
      shouldRestoreTerminalFocus = true
      terminal.focus()
    }
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
    container.addEventListener('pointerdown', focusTerminal, true)
    container.addEventListener('click', focusTerminal)
    container.addEventListener('focusin', rememberTerminalFocus)
    container.addEventListener('focusout', forgetTerminalFocus)
    document.addEventListener('pointerdown', rememberPointerFocusIntent, true)
    window.addEventListener('focus', restoreLastTerminalFocus)
    document.addEventListener('visibilitychange', restoreLastTerminalFocus)

    const onPaste = (event: ClipboardEvent) => {
      const raw = event.clipboardData?.getData('text/plain') ?? ''
      event.preventDefault()
      event.stopPropagation()
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
      const activeBuffer = terminal.buffer.active
      const distanceFromBottom = Math.max(0, activeBuffer.baseY - activeBuffer.viewportY)
      try {
        fitAddon.fit()
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
      const currentFontSize = terminal.options.fontSize
      terminal.options.fontSize = currentFontSize
      scheduleResize(true)
    }
    window.addEventListener('alethe:zoom-changed', onZoomChanged)
    window.addEventListener('alethe:terminal-resize-request', onResizeRequest)

    const initialFitTimer = window.setTimeout(() => {
      scheduleResize()
    }, 150)

    // zero em vez de tentar reconciliar incrementalmente. `reset()` + replay

    const doResync = async () => {
      const id = ptyIdRef.current
      if (!id || disposed) return
      try {
        const arrivedDuringFetch: string[] = []
        resyncCaptureRef = arrivedDuringFetch
        const replay = await attachPty(id)
        resyncCaptureRef = null
        if (disposed) return
        terminal.reset()
        pendingWrites = []
        pendingWriteLength = 0
        if (writeFrame !== null) {
          window.cancelAnimationFrame(writeFrame)
          writeFrame = null
        }
        if (replay) void writeReplayAtOnce(replay)
        for (const chunk of arrivedDuringFetch) queueTerminalWrite(chunk)
      } catch {
        resyncCaptureRef = null
      }
    }
    resyncTerminalRef.current = doResync

    // Registra os dois listeners de streaming: `data` (canal caro — escreve

    // chunk ser processado em duplicidade.

    const registerPtyStreamListeners = async (
      id: string,
      inspectChunk?: (chunk: string) => void,
    ): Promise<boolean> => {
      const dataUnlisten = await listenPtyData(id, (chunk) => {
        useTerminalsStore.getState().recordIo(id)
        if (resyncCaptureRef) resyncCaptureRef.push(chunk)
        queueTerminalWrite(chunk)
        completionMonitor?.handleOutput(chunk)
        inspectChunk?.(chunk)
      })
      if (disposed) {
        dataUnlisten()
        return false
      }
      unlistenData = dataUnlisten

      const activityUnlisten = await listenPtyActivity(id, (chunk) => {
        useTerminalsStore.getState().recordIo(id)
        completionMonitor?.handleOutput(chunk)
        inspectChunk?.(chunk)
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

      // gastar o burst de write mais pesado (TUIs como o OpenCode) enquanto

      if (isPanelVisibleRef.current) {
        const replay = await attachPty(existingId)
        if (disposed) return
        if (replay) await writeReplayAtOnce(replay)
        if (disposed) return
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
      const startsNewSession = recordPromptInput(data)
      completionMonitor?.handleInput(data)
      const trackedPtyId = ptyIdRef.current
      if (trackedPtyId) recordAgentActivityInput(trackedPtyId, data)
      if (container.scrollWidth > container.clientWidth + 2) scheduleResize(true)
      clampHorizontalScroll()
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
          if (rect && rect.width >= 50 && rect.height >= 30) fitAddon.fit()
        } catch {}
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
          } catch {}
          if (disposed) return
        }

        if (command === 'opencode' && !resumeId && cwd && !forceFreshRef.current) {
          try {
            const sessions = await snapshotOpenCodeSessions(cwd)

            // — e como `useGsdSyncSessions` acha o terminal certo justamente

            // escondendo/fechando a pane dele.

            // `.gsd-child-session` em algum momento (spawn anterior com o

            const gsdChildId = await readGsdChildSession(cwd).catch(() => null)
            const candidates = gsdChildId ? sessions.filter((s) => s.id !== gsdChildId) : sessions
            const claimed = claimMostRecentSession('opencode', cwd, candidates)
            if (claimed) resumeId = claimed.id
          } catch {}
          if (disposed) return
        }
        const preparedRuntime = command
          ? preparePtyRuntimeLaunch(command, runtimeProfile, extraArgs ?? [], env)
          : { args: extraArgs ?? [], env }

        // o spawn.
        const mcpConfigPaths: string[] = []

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

        if (command === 'opencode' && cwd && gsdWatcherEnabled) {
          const modelChain = useProjectsStore.getState().preferences.gsdSyncModelChain ?? []

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

        // visibilidade correta desde o primeiro lote (ex.: pane aberto num

        void setPtyVisible(response.id, isPanelVisibleRef.current).catch(() => {})
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
            (command === 'codex' ||
              command === 'antigravity' ||
              command === 'opencode' ||
              command === 'claude') &&
            cwd &&
            discoveredSessionsBeforePromise
          ) {
            const detectCreatedSession = async () => {
              const before = new Set((await discoveredSessionsBeforePromise).map((s) => s.id))
              if (launch.sessionId) before.add(launch.sessionId)

              // reivindicada/persistida (perdia resume ao reabrir o pane). Primeiras

              let attempt = 0
              while (!disposed) {
                const delayMs = attempt < 10 ? 3000 : 15000
                if (command === 'codex' || command === 'claude') {
                  await Promise.race([
                    new Promise((resolve) => setTimeout(resolve, delayMs)),
                    waitForSessionHint(command),
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
                      : command === 'claude'
                        ? await snapshotClaudeSessions(cwd).catch(() => [])
                        : await snapshotOpenCodeSessions(cwd).catch(() => [])

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
                  sessionPersistenceKey,
                )
                if (newSession) {
                  saveSession(sessionPersistenceKey, {
                    sessionId: response.id,
                    claudeSessionId: command === 'claude' ? newSession.id : undefined,
                    codexSessionId: command === 'codex' ? newSession.id : undefined,
                    antigravitySessionId: command === 'antigravity' ? newSession.id : undefined,
                    opencodeSessionId: command === 'opencode' ? newSession.id : undefined,
                    cwd: cwd ?? '',
                    agent: command,
                    timestamp: Date.now(),
                  })
                  onSessionIdRef.current?.(newSession.id)
                  if (command !== 'claude') return
                  // Claude can switch conversation again through /new or /resume,
                  // so the watcher stays alive for the life of the pane.
                  before.add(newSession.id)
                  attempt = 0
                  continue
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
          terminal.write(
            '\r\n\x1b[33m[alethe] Codex session is busy — opening a fresh session…\x1b[0m\r\n',
          )
          void killPty(response.id).catch(() => {})
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
          if (replay) await queueTerminalWriteAndWait(replay)
          if (disposed) return
        }

        const inspectResumeConflict = (chunk: string) => {
          if (command !== 'codex' || !usedResumeRef.current || resumeConflictHandled) return
          // PTY events can split the bootstrap error between chunks, so keep
          // a bounded rolling buffer instead of matching each chunk alone.
          resumeErrorBuffer = `${resumeErrorBuffer}${chunk}`.slice(-8192)
          if (/already has an active writer|thread\/resume failed/i.test(resumeErrorBuffer)) {
            handleResumeConflict()
          }
        }
        if (!(await registerPtyStreamListeners(response.id, inspectResumeConflict))) return

        const exitUnlisten = await listenPtyExit(response.id, (payload) => {
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
              )
                break
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
      window.removeEventListener('alethe:zoom-changed', onZoomChanged)
      window.removeEventListener('alethe:terminal-resize-request', onResizeRequest)
      ro.disconnect()
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      if (writeFrame !== null) window.cancelAnimationFrame(writeFrame)
      pendingWrites = []
      pendingWriteLength = 0
      pendingWriteDrainResolvers = []
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
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPersistenceKey, retryKey])

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

    void setPtyVisible(ptyId, isPanelVisible)
      .catch(() => false)
      .then((applied) => {
        if (!applied && isPanelVisible) {
          console.warn(
            `[pty-visibility] ${ptyId} was not registered when the panel became visible; ` +
              'the resource sampler will reconcile it',
          )
        }
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
  }, [ptyId, isPanelVisible])
}
