import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import type { ILink } from '@xterm/xterm'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { Copy, ExternalLink, FolderOpen, LayoutGrid, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'

import { pickFile } from '../../lib/dialog'
import { AgentCompletionMonitor } from '../../lib/agentCompletionMonitor'
import { recordAgentActivityInput } from '../../lib/activityTracker'
import { buildAgentLaunch } from '../../lib/sessionLaunch'
import { claimDiscoveredSession, registerSessionClaim } from '../../lib/sessionDiscovery'
import { consumeSession, removeSession, saveSession } from '../../lib/sessionResume'
import { waitForSessionHint } from '../../lib/sessionWatch'
import { acquireSpawnSlot, releaseSpawnSlot } from '../../lib/spawnQueue'
import { readScopedStorage, writeScopedStorage } from '../../lib/storageNamespace'
import {
  attachPty,
  findCliLauncher,
  killPty,
  listenPtyData,
  listenPtyExit,
  openInBrowser,
  openInFileExplorer,
  readClipboardText,
  resizePty,
  spawnPty,
  snapshotClaudeSessions,
  snapshotCodexSessions,
  writeClipboardText,
  writePty,
} from '../../lib/tauri'
import { getLocale, translate, useT } from '../../lib/i18n'
import type { AgentType, Theme } from '../../lib/types'
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
import styles from './XTermView.module.css'

type DetectedLink = {
  text: string
  index: number
  kind: 'url' | 'path'
  /** True quando o path aponta para um arquivo .md/.markdown. */
  isMarkdown?: boolean
}

type LinkActionState = {
  text: string
  kind: 'url' | 'path'
  isMarkdown?: boolean
  x: number
  y: number
}

const MARKDOWN_PATH_PATTERN = /\.(md|markdown)$/i

const TERMINAL_LINK_PATTERN =
  /https?:\/\/[^\s<>"'`]+|(?:[A-Za-z]:\\|\\\\)[^\s<>"'`|]+|(?:~|\/)[^\s<>"'`|]+/g
const LINK_TRAILING_PUNCTUATION = /[),.;:]+$/

const DARK_THEME = {
  background: '#101114',
  foreground: '#f3f4f6',
  cursor: '#f3f4f6',
  selectionBackground: '#3b82f666',
} as const
const LIGHT_THEME = {
  background: '#fafafa',
  foreground: '#18181b',
  cursor: '#18181b',
  selectionBackground: '#3b82f655',
} as const
const DRACULA_THEME = {
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  selectionBackground: '#44475a',
  black: '#21222c',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
  brightBlack: '#6272a4',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff',
} as const
const NORD_THEME = {
  background: '#2e3440',
  foreground: '#eceff4',
  cursor: '#eceff4',
  selectionBackground: '#4c566a',
} as const
const GRUVBOX_THEME = {
  background: '#282828',
  foreground: '#fbf1c7',
  cursor: '#fbf1c7',
  selectionBackground: '#665c54',
} as const
const SOLARIZED_THEME = {
  background: '#002b36',
  foreground: '#fdf6e3',
  cursor: '#fdf6e3',
  selectionBackground: '#073642',
} as const
const TOKYO_NIGHT_THEME = {
  background: '#1a1b26',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  selectionBackground: '#414868',
} as const
const VSCODE_THEME = {
  background: '#1e1e1e',
  foreground: '#cccccc',
  cursor: '#cccccc',
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5',
} as const
const MIN_DARK_THEME = {
  background: '#1f1f1f',
  foreground: '#fafafa',
  cursor: '#fafafa',
  selectionBackground: '#383838',
  black: '#1a1a1a',
  red: '#f97583',
  green: '#fafafa',
  yellow: '#ff9800',
  blue: '#d0d0d0',
  magenta: '#bdbdbd',
  cyan: '#9db1c5',
  white: '#bbbbbb',
  brightBlack: '#6b737c',
  brightRed: '#ff7a84',
  brightGreen: '#ffffff',
  brightYellow: '#ffab70',
  brightBlue: '#e0e0e0',
  brightMagenta: '#d0d0d0',
  brightCyan: '#9db1c5',
  brightWhite: '#fafafa',
} as const
const DARK_LEMON_THEME = {
  background: '#141414',
  foreground: '#ffffff',
  cursor: '#ffff50',
  selectionBackground: '#ffff5028',
  black: '#1a1a1a',
  red: '#ff5370',
  green: '#c3e88d',
  yellow: '#ffcb6b',
  blue: '#82aaff',
  magenta: '#c792ea',
  cyan: '#89ddff',
  white: '#cfcfcf',
  brightBlack: '#5a5a5a',
  brightRed: '#ff5370',
  brightGreen: '#c3e88d',
  brightYellow: '#ffff50',
  brightBlue: '#82aaff',
  brightMagenta: '#c792ea',
  brightCyan: '#89ddff',
  brightWhite: '#ffffff',
} as const
const MIN_LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#212121',
  cursor: '#212121',
  selectionBackground: '#eeeeee',
  black: '#212121',
  red: '#d32f2f',
  green: '#22863a',
  yellow: '#ff9800',
  blue: '#1976d2',
  magenta: '#6f42c1',
  cyan: '#2b5581',
  white: '#e0e0e0',
  brightBlack: '#757575',
  brightRed: '#d32f2f',
  brightGreen: '#22863a',
  brightYellow: '#ff9800',
  brightBlue: '#1976d2',
  brightMagenta: '#6f42c1',
  brightCyan: '#2b5581',
  brightWhite: '#ffffff',
} as const

function getXtermTheme(theme: Theme) {
  if (theme === 'light') return LIGHT_THEME
  if (theme === 'dracula') return DRACULA_THEME
  if (theme === 'nord') return NORD_THEME
  if (theme === 'gruvbox') return GRUVBOX_THEME
  if (theme === 'solarized') return SOLARIZED_THEME
  if (theme === 'tokyo-night') return TOKYO_NIGHT_THEME
  if (theme === 'vscode') return VSCODE_THEME
  if (theme === 'min-dark') return MIN_DARK_THEME
  if (theme === 'min-light') return MIN_LIGHT_THEME
  if (theme === 'dark-lemon') return DARK_LEMON_THEME
  return DARK_THEME
}

function detectTerminalLinks(line: string): DetectedLink[] {
  const links: DetectedLink[] = []
  for (const match of line.matchAll(TERMINAL_LINK_PATTERN)) {
    const raw = match[0]
    const text = raw.replace(LINK_TRAILING_PUNCTUATION, '')
    if (!text) continue
    const kind = text.startsWith('http://') || text.startsWith('https://') ? 'url' : 'path'
    links.push({
      text,
      index: match.index ?? 0,
      kind,
      isMarkdown: kind === 'path' && MARKDOWN_PATH_PATTERN.test(text),
    })
  }
  return links
}

function makeXtermLink(
  bufferLineNumber: number,
  link: DetectedLink,
  handlers: {
    open: (text: string) => void
    hover: (event: MouseEvent, link: DetectedLink) => void
    leave: () => void
  },
): ILink {
  return {
    text: link.text,
    range: {
      start: { x: link.index + 1, y: bufferLineNumber },
      end: { x: link.index + link.text.length, y: bufferLineNumber },
    },
    decorations: { pointerCursor: true, underline: true },
    activate: (_event: MouseEvent, text: string) => handlers.open(text),
    hover: (event: MouseEvent) => handlers.hover(event, link),
    leave: handlers.leave,
  }
}

export type XTermViewProps = {
  ptyId: string
  /** Projeto dono deste terminal — usado pra "abrir .md no grid" via hover. */
  projectId?: string
  /** Tipo do agent (claude/codex/opencode) ou null pra shell. */
  command?: AgentType | null
  cwd?: string | null
  extraArgs?: string[]
  /** Identidade persistida da conversa deste pane. */
  sessionId?: string
  /** Env extra só deste PTY. */
  env?: Record<string, string>
  terminalTheme?: Theme
  onSpawned?: (id: string) => void
  onSessionId?: (id: string) => void
  onExit?: (code: number | null) => void
  onAgentComplete?: () => void
}

const PROMPT_HISTORY_KEY = (id: string) => `prompt-history:${id}`
const PASTE_CHUNK_SIZE = 1024
const PASTE_CHUNK_DELAY_MS = 8

function loadPromptHistory(ptyId: string): string[] {
  const raw = readScopedStorage(PROMPT_HISTORY_KEY(ptyId), true)
  if (!raw) return []
  const history = JSON.parse(raw) as string[]
  return history
}

async function writePtyChunked(
  id: string,
  text: string,
  bracketed: boolean,
): Promise<void> {
  // Bracketed paste (DECSET 2004): quando a app liga, envolvemos a colagem
  // inteira nos marcadores 200~/201~ pra ela tratar como um bloco único. Sem
  // isso, cada \r interno vira Enter e TUIs como o Claude submetem só a
  // primeira linha — a colagem grande chegava cortada. Os marcadores ficam
  // FORA do chunking pra nunca serem partidos no meio.
  const open = bracketed ? '\x1b[200~' : ''
  const close = bracketed ? '\x1b[201~' : ''

  if (text.length <= PASTE_CHUNK_SIZE) {
    await writePty(id, `${open}${text}${close}`)
    return
  }

  if (open) await writePty(id, open)
  for (let index = 0; index < text.length; index += PASTE_CHUNK_SIZE) {
    await writePty(id, text.slice(index, index + PASTE_CHUNK_SIZE))
    await new Promise((resolve) => window.setTimeout(resolve, PASTE_CHUNK_DELAY_MS))
  }
  if (close) await writePty(id, close)
}

export function XTermView({
  ptyId,
  projectId,
  command,
  cwd,
  extraArgs,
  sessionId,
  env,
  terminalTheme = 'dark',
  onSpawned,
  onSessionId,
  onExit,
  onAgentComplete,
}: XTermViewProps) {
  const t = useT()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const lastCtrlCRef = useRef(0)
  const linkTooltipHideTimerRef = useRef<number | null>(null)

  const cliPathOverride = useProjectsStore((s) =>
    command && command !== 'shell' ? s.cliPaths[command] ?? null : null,
  )
  const setCliPath = useProjectsStore((s) => s.setCliPath)

  const onSpawnedRef = useRef(onSpawned)
  const onSessionIdRef = useRef(onSessionId)
  const onExitRef = useRef(onExit)
  const onAgentCompleteRef = useRef(onAgentComplete)
  useEffect(() => {
    onSpawnedRef.current = onSpawned
    onSessionIdRef.current = onSessionId
    onExitRef.current = onExit
    onAgentCompleteRef.current = onAgentComplete
  })

  const promptHistoryRef = useRef<string[]>([])
  const historyCursorRef = useRef(-1)
  const currentLineRef = useRef('')

  const [commandNotFound, setCommandNotFound] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [bootPhase, setBootPhase] = useState<'queued' | 'spawning' | 'attaching' | 'ready'>('queued')
  const [linkActions, setLinkActions] = useState<LinkActionState | null>(null)
  const [dropActive, setDropActive] = useState(false)

  const clearLinkTooltipHideTimer = useCallback(() => {
    if (linkTooltipHideTimerRef.current === null) return
    window.clearTimeout(linkTooltipHideTimerRef.current)
    linkTooltipHideTimerRef.current = null
  }, [])

  const hideLinkActions = useCallback(() => {
    clearLinkTooltipHideTimer()
    setLinkActions(null)
  }, [clearLinkTooltipHideTimer])

  const scheduleHideLinkActions = useCallback(() => {
    clearLinkTooltipHideTimer()
    linkTooltipHideTimerRef.current = window.setTimeout(() => {
      linkTooltipHideTimerRef.current = null
      setLinkActions(null)
    }, 180)
  }, [clearLinkTooltipHideTimer])

  const showLinkActions = useCallback(
    (event: MouseEvent, link: DetectedLink) => {
      clearLinkTooltipHideTimer()
      setLinkActions({
        text: link.text,
        kind: link.kind,
        isMarkdown: link.isMarkdown,
        x: Math.min(Math.max(event.clientX, 180), window.innerWidth - 180),
        y: Math.max(event.clientY, 72),
      })
    },
    [clearLinkTooltipHideTimer],
  )

  const openMarkdownInGrid = useCallback(
    (target: string) => {
      if (!projectId) return
      useProjectsStore.getState().createMarkdownPane(projectId, { filePath: target })
    },
    [projectId],
  )

  const openLinkInBrowser = useCallback(async (target: string) => {
    try {
      await openInBrowser(target)
    } catch (err) {
      useUiStore.getState().pushToast({
        title: translate(getLocale(), 'xterm.toastOpenBrowserFail'),
        body: String(err),
      })
    }
  }, [])

  const openLinkInFolder = useCallback(async (target: string) => {
    try {
      await openInFileExplorer(target)
    } catch (err) {
      useUiStore.getState().pushToast({
        title: translate(getLocale(), 'xterm.toastOpenFolderFail'),
        body: String(err),
      })
    }
  }, [])

  const copyLinkText = useCallback(async (target: string) => {
    try {
      await writeClipboardText(target)
      useUiStore.getState().pushToast({
        title: translate(getLocale(), 'xterm.toastCopied'),
        body: target,
      })
    } catch (err) {
      useUiStore.getState().pushToast({
        title: translate(getLocale(), 'xterm.toastCopyFail'),
        body: String(err),
      })
    }
  }, [])

  useEffect(() => {
    try {
      promptHistoryRef.current = loadPromptHistory(ptyId)
    } catch {
      promptHistoryRef.current = []
    }
    historyCursorRef.current = -1
    currentLineRef.current = ''
  }, [ptyId])

  const recordPromptInput = (data: string) => {
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const line = currentLineRef.current.trim()
        currentLineRef.current = ''
        historyCursorRef.current = -1
        if (line.length < 2) continue
        const history = promptHistoryRef.current
        if (history[history.length - 1] === line) continue
        history.push(line)
        if (history.length > 50) history.shift()
        try {
          writeScopedStorage(PROMPT_HISTORY_KEY(ptyId), JSON.stringify(history))
        } catch {
          /* localStorage cheio — ignora */
        }
      } else if (ch === '\b' || ch === '\x7f') {
        currentLineRef.current = currentLineRef.current.slice(0, -1)
      } else if (ch >= ' ') {
        currentLineRef.current += ch
      }
    }
  }

  const navigateHistory = (direction: 'up' | 'down') => {
    const history = promptHistoryRef.current
    const id = ptyIdRef.current
    if (history.length === 0 || !id) return
    let cursor = historyCursorRef.current
    if (cursor === -1) cursor = direction === 'up' ? history.length - 1 : history.length
    else cursor = direction === 'up' ? cursor - 1 : cursor + 1
    cursor = Math.max(0, Math.min(history.length, cursor))
    historyCursorRef.current = cursor
    const entry = history[cursor] ?? ''
    void writePty(id, `\x15${entry}`)
    currentLineRef.current = entry
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false
    let unlistenData: (() => void) | null = null
    let unlistenExit: (() => void) | null = null
    let unlistenDragDrop: (() => void) | null = null
    let resizeTimer: number | null = null
    let writeFrame: number | null = null
    let pendingWrite = ''
    let lastCols = 0
    let lastRows = 0
    let forceNextResize = false
    let completionMonitor: AgentCompletionMonitor | null = null
    let linkProviderDisposable: { dispose: () => void } | null = null

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      allowProposedApi: true,
      scrollback: getTerminalScrollbackRows(),
      windowsPty: { backend: 'conpty', buildNumber: 22000 },
      fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
      fontSize: 14,
      theme: getXtermTheme(terminalTheme),
    })
    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(searchAddon)
    terminal.open(container)
    terminalRef.current = terminal
    linkProviderDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const line = terminal.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true)
        if (!line) {
          callback(undefined)
          return
        }
        const links = detectTerminalLinks(line).map((link) =>
          makeXtermLink(bufferLineNumber, link, {
            open: (text) => void openLinkInBrowser(text),
            hover: showLinkActions,
            leave: scheduleHideLinkActions,
          }),
        )
        callback(links.length > 0 ? links : undefined)
      },
    })

    // Renderer WebGL (GPU) — o renderer DOM padrão trava a digitação,
    // principalmente com zoom da WebView ≠ 100%. Fallback: DOM renderer.
    let webglAddon: WebglAddon | null = null
    try {
      webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        // Perda de contexto GL (ex.: muitos terminais estouram o limite de
        // contextos da WebView, ou soluço do processo de GPU). Descarta o addon
        // (o xterm volta pro renderer DOM) e NÃO recria — evita thrash.
        webglAddon?.dispose()
        webglAddon = null
        // Um syncScrollArea assíncrono já agendado pode ler `dimensions` de um
        // renderer morto e lançar ("Cannot read properties of undefined
        // (reading 'dimensions')"), o que cascateia e derruba a render. Força um
        // re-fit/refresh no próximo frame pra reestabelecer as dimensões — só se
        // o container tiver tamanho válido, e sempre dentro de try/catch.
        window.requestAnimationFrame(() => {
          try {
            const rect = container.getBoundingClientRect()
            if (rect.width < 50 || rect.height < 30) return
            fitAddon.fit()
            terminal.refresh(0, Math.max(0, terminal.rows - 1))
          } catch {
            /* container invisível / em teardown — ignora */
          }
        })
      })
      terminal.loadAddon(webglAddon)
    } catch {
      webglAddon?.dispose()
      webglAddon = null
    }

    terminal.focus()

    const flushPendingWrite = () => {
      writeFrame = null
      if (!pendingWrite) return
      const chunk = pendingWrite
      pendingWrite = ''
      terminal.write(chunk)
    }

    const queueTerminalWrite = (chunk: string) => {
      if (!chunk) return
      pendingWrite += chunk
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
      terminal.scrollLines(lines)
    }
    container.addEventListener('wheel', onWheel, { passive: false, capture: true })

    const pasteText = (raw: string) => {
      if (!raw) return
      const id = ptyIdRef.current
      if (!id) return
      const text = normalizePastedText(raw)
      recordPromptInput(text)
      void writePtyChunked(id, text, terminal.modes.bracketedPasteMode)
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
      if (key === 'c') {
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

      if (key === 'v') {
        event.preventDefault()
        void readClipboardText()
          .catch(() => navigator.clipboard?.readText() ?? '')
          .then(pasteText)
          .catch(() => {
            terminal.focus()
          })
        return false
      }

      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        navigateHistory(event.key === 'ArrowUp' ? 'up' : 'down')
        return false
      }
      return true
    })

    const focusTerminal = () => terminal.focus()
    container.addEventListener('click', focusTerminal)

    const onPaste = (event: ClipboardEvent) => {
      const raw = event.clipboardData?.getData('text/plain') ?? ''
      event.preventDefault()
      event.stopPropagation()
      void readClipboardText()
        .catch(() => raw)
        .then(pasteText)
        .catch(() => {
          terminal.focus()
        })
    }
    container.addEventListener('paste', onPaste)

    const runResize = () => {
      resizeTimer = null
      const id = ptyIdRef.current
      if (!id) return
      // Só faz fit se o container tiver dimensões válidas (evita 0x0)
      const rect = container.getBoundingClientRect()
      if (rect.width < 50 || rect.height < 30) return
      try {
        fitAddon.fit()
      } catch {
        // fit() pode falhar se o container não estiver visível
        return
      }
      try {
        terminal.refresh(0, Math.max(0, terminal.rows - 1))
      } catch {
        /* refresh pode falhar durante teardown/layout invisível */
      }
      const force = forceNextResize
      forceNextResize = false
      if (!force && terminal.cols === lastCols && terminal.rows === lastRows) return
      lastCols = terminal.cols
      lastRows = terminal.rows
      void resizePty(id, terminal.cols, terminal.rows)
    }
    const scheduleResize = (force = false) => {
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
    window.addEventListener('alethe:zoom-changed', scheduleObservedResize)
    window.addEventListener('alethe:terminal-resize-request', onResizeRequest)

    // Fit adicional com delay pra garantir que o layout estabilizou
    const initialFitTimer = window.setTimeout(() => {
      scheduleResize()
    }, 150)

    terminal.onData((data) => {
      const id = ptyIdRef.current
      if (!id) return
      recordPromptInput(data)
      completionMonitor?.handleInput(data)
      const trackedPtyId = ptyIdRef.current
      if (trackedPtyId) recordAgentActivityInput(trackedPtyId, data)
      void writePty(id, data)
    })

    const RESUMABLE_AGENTS = ['claude', 'codex', 'opencode']

    async function start() {
      try {
        // Fit inicial só com dimensões válidas. Um fit em container 0×0 (pane
        // recém-montado/colapsado) deixa o renderer sem dimensões e o
        // syncScrollArea assíncrono do xterm estoura depois com "Cannot read
        // properties of undefined (reading 'dimensions')". Se ainda não tem
        // layout, o ResizeObserver + initialFitTimer refazem o fit quando estabiliza.
        try {
          const rect = container?.getBoundingClientRect()
          if (rect && rect.width >= 50 && rect.height >= 30) fitAddon.fit()
        } catch {
          /* sem layout ainda — o resize agendado cobre */
        }
        setCommandNotFound(null)
        setBootPhase('queued')

        // Pré-resolve CLI: se for agent, precisa achar override OU launcher
        // auto-detectado antes de spawnar. Sem isso, o pwsh executa `& 'claude'`
        // e mostra erro CommandNotFound dentro do terminal — UX feia.
        let launcherOverride: string | undefined
        if (command && command !== 'shell') {
          if (cliPathOverride) {
            launcherOverride = cliPathOverride
          } else {
            const auto = await findCliLauncher(command)
            if (!auto) {
              setCommandNotFound(command)
              useTerminalsStore.getState().setStatus(ptyId, 'offline')
              return
            }
          }
        }

        // projects.json é a fonte principal. O marcador de crash no localStorage
        // serve apenas de fallback para arquivos antigos que ainda não tinham ID.
        const savedSession = command && RESUMABLE_AGENTS.includes(command) ? consumeSession(ptyId) : null
        const savedConversationId = command === 'claude'
          ? savedSession?.claudeSessionId
          : command === 'codex'
            ? savedSession?.codexSessionId
            : undefined
        let resumeId = sessionId ?? savedConversationId
        // Claude: valida que a conversa ainda existe no cwd antes de passar
        // --resume. Se o id ficou órfão (conversa apagada, cwd diferente de onde
        // nasceu, ou o --session-id forçado nunca virou transcript), o CLI aborta
        // com "No conversation found" — mesmo havendo conversas reais ali (que o
        // /resume interativo mostraria). Em vez de quebrar ou começar em branco,
        // RECUPERAMOS a sessão mais recente daquele cwd (snapshot vem ordenado
        // recent-first). O id recuperado é persistido logo abaixo, então se
        // auto-cura pras próximas aberturas. Só agimos quando o snapshot SUCEDE;
        // erro/timeout mantém o resume original (evita falso negativo).
        // Ressalva: com 2+ panes Claude no MESMO cwd, ambos podem cair na mesma
        // conversa mais recente — aceitável pro caso comum (1 Claude por pasta).
        if (command === 'claude' && resumeId && cwd) {
          try {
            const existing = await snapshotClaudeSessions(cwd)
            if (!existing.some((s) => s.id === resumeId)) {
              resumeId = existing[0]?.id
            }
          } catch {
            /* mantém o resume — não arrisca falso negativo */
          }
          if (disposed) return
        }
        const launch = command
          ? buildAgentLaunch(command, extraArgs ?? [], resumeId)
          : { args: extraArgs ?? [], sessionId: undefined, createdSession: false }
        const spawnArgs = launch.args.length > 0 ? launch.args : undefined
        if (launch.sessionId && launch.sessionId !== sessionId) {
          onSessionIdRef.current?.(launch.sessionId)
        }
        if (command && cwd) registerSessionClaim(command, cwd, launch.sessionId)

        // Snapshot leve das sessões Codex existentes antes do spawn para
        // identificar e persistir o ID novo sem usar `resume --last`.
        const codexSessionsBeforePromise = (command === 'codex' && cwd && !launch.sessionId)
          ? snapshotCodexSessions(cwd).catch(() => [])
          : null

        // Serializa spawns globalmente — sem isso, abrir grupo com N×M terminais
        // dispara muitos spawn_pty em paralelo e trava o app.
        await acquireSpawnSlot()
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
            command: command ?? undefined,
            cwd: cwd ?? undefined,
            extraArgs: spawnArgs,
            launcherOverride,
            env,
          })
        } finally {
          releaseSpawnSlot()
        }
        if (disposed) return
        setBootPhase('attaching')
        ptyIdRef.current = response.id
        useTerminalsStore.getState().registerPty(response.id)
        onSpawnedRef.current?.(response.id)

        if (command === 'claude' || command === 'codex' || command === 'opencode') {
          completionMonitor = new AgentCompletionMonitor({
            ptyId: response.id,
            agent: command,
            label: command,
            cwd,
            onStatusChange: (status) =>
              useTerminalsStore.getState().setStatus(response.id, status),
            onComplete: () => onAgentCompleteRef.current?.(),
          })
        }

        // Marca sessão como ativa — se o app fechar abruptamente, o próximo
        // spawn vai consumir essa entrada e injetar o resume adequado da CLI.
        if (command && RESUMABLE_AGENTS.includes(command)) {
          saveSession(ptyId, {
            sessionId: response.id,
            claudeSessionId: command === 'claude' ? launch.sessionId : undefined,
            codexSessionId: command === 'codex' ? launch.sessionId : undefined,
            cwd: cwd ?? '',
            agent: command,
            timestamp: Date.now(),
          })

          // Codex precisa do ID especifico; `resume --last` junta terminais
          // diferentes na mesma conversa quando existem 2+ Codex abertos.
          if (command === 'codex' && cwd && codexSessionsBeforePromise) {
            const detectCodexSession = async () => {
              const before = new Set((await codexSessionsBeforePromise).map((s) => s.id))
              for (let attempt = 0; attempt < 4; attempt++) {
                // Acorda no hint do watcher (session://new) ou no teto de 3s.
                await Promise.race([
                  new Promise((r) => setTimeout(r, 3000)),
                  waitForSessionHint('codex'),
                ])
                if (disposed) return
                const sessions = await snapshotCodexSessions(cwd).catch(() => [])
                const newSession = claimDiscoveredSession('codex', cwd, before, sessions)
                if (newSession) {
                  saveSession(ptyId, {
                    sessionId: response.id,
                    codexSessionId: newSession.id,
                    cwd: cwd ?? '',
                    agent: command,
                    timestamp: Date.now(),
                  })
                  onSessionIdRef.current?.(newSession.id)
                  return
                }
              }
            }
            void detectCodexSession()
          }
        }

        const replay = await attachPty(response.id)
        if (disposed) return
        if (replay) queueTerminalWrite(replay)

        // Race fix: se o componente desmontar entre o await e a atribuição,
        // a cleanup function já rodou com unlistenData/unlistenExit ainda
        // undefined — chamamos manualmente pra evitar listener órfão.
        const dataUnlisten = await listenPtyData(response.id, (chunk) => {
          queueTerminalWrite(chunk)
          completionMonitor?.handleOutput(chunk)
        })
        if (disposed) {
          dataUnlisten()
          return
        }
        unlistenData = dataUnlisten

        const exitUnlisten = await listenPtyExit(response.id, (code) => {
          useTerminalsStore.getState().markExited(response.id)
          completionMonitor?.dispose()
          completionMonitor = null
          // Clean exit → não resume na próxima vez
          removeSession(ptyId)
          onExitRef.current?.(code)
        })
        if (disposed) {
          exitUnlisten()
          return
        }
        unlistenExit = exitUnlisten

        scheduleResize()
        if (!disposed) setBootPhase('ready')
      } catch (err) {
        terminal.writeln(`Failed to start PTY: ${String(err)}`)
        if (!disposed) setBootPhase('ready')
      }
    }
    void start()

    return () => {
      disposed = true
      container.removeEventListener('wheel', onWheel, true)
      container.removeEventListener('click', focusTerminal)
      container.removeEventListener('paste', onPaste)
      window.removeEventListener('alethe:zoom-changed', scheduleObservedResize)
      window.removeEventListener('alethe:terminal-resize-request', onResizeRequest)
      ro.disconnect()
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      if (writeFrame !== null) window.cancelAnimationFrame(writeFrame)
      pendingWrite = ''
      window.clearTimeout(initialFitTimer)
      unlistenData?.()
      unlistenExit?.()
      unlistenDragDrop?.()
      linkProviderDisposable?.dispose()
      completionMonitor?.dispose()
      completionMonitor = null
      clearLinkTooltipHideTimer()
      setLinkActions(null)
      if (terminalRef.current === terminal) terminalRef.current = null
      ptyIdRef.current = null
      terminal.dispose()
    }
    // ptyId/retryKey são as chaves de identidade. Outros props lidos via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId, retryKey])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.theme = getXtermTheme(terminalTheme)
  }, [terminalTheme])

  const configurePath = useCallback(
    async (agent: AgentType) => {
      const picked = await pickFile({
        title: `Selecione o executável do ${agent}`,
        filters: [
          { name: 'Executável', extensions: ['cmd', 'exe', 'bat', 'ps1'] },
          { name: 'Todos', extensions: ['*'] },
        ],
      })
      if (!picked) return
      setCliPath(agent, picked)
      setCommandNotFound(null)
      setRetryKey((v) => v + 1)
    },
    [setCliPath],
  )

  const bootLabel =
    bootPhase === 'queued'
      ? 'Aguardando vez na fila…'
      : bootPhase === 'spawning'
        ? 'Iniciando processo…'
        : bootPhase === 'attaching'
          ? 'Conectando ao terminal…'
          : null

  return (
    <>
      <div
        ref={containerRef}
        className={`${styles.host} ${dropActive ? styles.dropActive : ''}`}
        style={{ background: getXtermTheme(terminalTheme).background }}
      />
      {bootLabel && !commandNotFound ? (
        <div className={styles.bootOverlay}>
          <div className={styles.bootSpinner} aria-hidden />
          <div className={styles.bootLabel}>{bootLabel}</div>
        </div>
      ) : null}
      {commandNotFound ? (
        <div className={styles.overlay}>
          <div className={styles.overlayText}>
            <strong>{commandNotFound}</strong> não encontrado nesta máquina.
          </div>
          <button
            type="button"
            className={styles.overlayBtn}
            onClick={() => void configurePath(commandNotFound as AgentType)}
          >
            Configure path…
          </button>
        </div>
      ) : null}
      {linkActions ? (
        <div
          className={`${styles.linkActions} xterm-hover`}
          style={{ left: linkActions.x, top: linkActions.y }}
          onMouseEnter={clearLinkTooltipHideTimer}
          onMouseLeave={scheduleHideLinkActions}
        >
          <span className={styles.linkActionsText} title={linkActions.text}>
            {linkActions.text}
          </span>
          <div className={styles.linkActionsButtons}>
            {linkActions.isMarkdown && projectId ? (
              <button
                type="button"
                className={styles.linkActionBtn}
                onClick={() => {
                  openMarkdownInGrid(linkActions.text)
                  hideLinkActions()
                }}
                title={t('xterm.openInGrid')}
                aria-label={t('xterm.openInGrid')}
              >
                <LayoutGrid size={14} />
              </button>
            ) : null}
            <button
              type="button"
              className={styles.linkActionBtn}
              onClick={() => {
                void openLinkInFolder(linkActions.text)
                hideLinkActions()
              }}
              disabled={linkActions.kind === 'url'}
              title={t('xterm.openInFolder')}
              aria-label={t('xterm.openInFolder')}
            >
              <FolderOpen size={14} />
            </button>
            <button
              type="button"
              className={styles.linkActionBtn}
              onClick={() => {
                void copyLinkText(linkActions.text)
                hideLinkActions()
              }}
              title={t('xterm.copy')}
              aria-label={t('xterm.copy')}
            >
              <Copy size={14} />
            </button>
            <button
              type="button"
              className={styles.linkActionBtn}
              onClick={() => {
                void openLinkInBrowser(linkActions.text)
                hideLinkActions()
              }}
              title={t(linkActions.kind === 'url' ? 'xterm.openInBrowser' : 'xterm.openInDefaultApp')}
              aria-label={t(linkActions.kind === 'url' ? 'xterm.openInBrowser' : 'xterm.openInDefaultApp')}
            >
              <ExternalLink size={14} />
            </button>
            <button
              type="button"
              className={styles.linkActionBtn}
              onClick={hideLinkActions}
              title={t('common.close')}
              aria-label={t('common.close')}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}
