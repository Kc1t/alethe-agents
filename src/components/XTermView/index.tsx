import '@xterm/xterm/css/xterm.css'

import type { Terminal } from '@xterm/xterm'
import { AppWindow, Copy, ExternalLink, FolderOpen, LayoutGrid, Maximize2, PanelRight, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { pickFile } from '../../lib/dialog'
import { getLocale, translate, useT } from '../../lib/i18n'
import { writeScopedStorage } from '../../lib/storageNamespace'
import { openInBrowser, openInFileExplorer, writeClipboardText, writePty } from '../../lib/tauri'
import { type AgentRuntimeProfile, type AgentType, type Theme } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { type DetectedTerminalLink } from './terminalLinks'
import { loadPromptHistory, PROMPT_HISTORY_KEY } from './terminalWrite'
import { useXtermSession } from './useXtermSession'
import { getXtermTheme, type LinkActionState } from './xtermThemes'
import styles from './XTermView.module.css'

export type XTermViewProps = {
  ptyId: string
  /** Projeto dono deste terminal — usado pra "abrir .md no grid" via hover. */
  projectId?: string
  /** Tipo do agent (claude/codex/opencode) ou null pra shell. */
  command?: AgentType | null
  cwd?: string | null
  extraArgs?: string[]
  /** Prompt opcional enviado uma única vez após o boot do processo. */
  initialInput?: string
  /** Identidade persistida da conversa deste pane. */
  sessionId?: string
  /** Identidade estável da sub-tab, independente das trocas de PTY. */
  sessionKey?: string
  /** Env extra só deste PTY. */
  env?: Record<string, string>
  /** RFC-004 — raiz do repo quando o projeto tem Graphify habilitado. Presente:
   * o spawn injeta o MCP do grafo (Claude via `--mcp-config`, Codex/OpenCode via
   * merge no config do projeto) e garante o bootstrap do grafo. */
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
  /** Sessão-filha do GSD Sync: visão de subagente, só leitura — nunca deve
   * aceitar digitação/colar/atalhos que escrevem na PTY. */
  readOnly?: boolean
  /**
   * `true` só na primeira montagem de uma tab recém-criada — impede o
   * fallback de "reivindicar a conversa OpenCode mais recente ainda não
   * pega nesse cwd" (pensado pra recuperação após reiniciar o app) de
   * herdar sem querer uma sessão de outro projeto/uso anterior da mesma
   * pasta. Consumido via `onSessionClaimSkipped` no primeiro spawn — a
   * partir daí a tab já existe de verdade e o fallback normal passa a valer.
   */
  skipSessionClaim?: boolean
  runtimeProfile?: AgentRuntimeProfile
  terminalTheme?: Theme
  onSpawned?: (id: string) => void
  onSessionId?: (id: string | undefined) => void
  onInitialInputSent?: () => void
  onSessionClaimSkipped?: () => void
  onExit?: (code: number | null) => void
  onAgentComplete?: () => void
}

const LINK_MENU_WIDTH = 272
const LINK_MENU_MAX_HEIGHT = 276
const LINK_MENU_MARGIN = 10
const LINK_MENU_OFFSET = 6

export function XTermView({
  ptyId,
  projectId,
  command,
  cwd,
  extraArgs,
  initialInput,
  sessionId,
  sessionKey,
  env,
  graphifyRepo,
  gsdWatcherEnabled,
  trustSessionId,
  readOnly,
  skipSessionClaim,
  // Terminais antigos sem perfil persistido entram no modo lean para não
  // iniciar Claude com concorrência/MCP ilimitados por acidente. `full` segue
  // disponível quando o usuário escolhe explicitamente no modal.
  runtimeProfile = 'lean',
  terminalTheme = 'dark',
  onSpawned,
  onSessionId,
  onInitialInputSent,
  onSessionClaimSkipped,
  onExit,
  onAgentComplete,
}: XTermViewProps) {
  const t = useT()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const lastCtrlCRef = useRef(0)
  const linkMenuRef = useRef<HTMLDivElement | null>(null)
  const linkActionsRef = useRef<LinkActionState | null>(null)

  const cliPathOverride = useProjectsStore((s) =>
    command && command !== 'shell' ? (s.cliPaths[command] ?? null) : null,
  )
  const setCliPath = useProjectsStore((s) => s.setCliPath)

  const onSpawnedRef = useRef(onSpawned)
  const onSessionIdRef = useRef(onSessionId)
  const onInitialInputSentRef = useRef(onInitialInputSent)
  const onSessionClaimSkippedRef = useRef(onSessionClaimSkipped)
  const onExitRef = useRef(onExit)
  const onAgentCompleteRef = useRef(onAgentComplete)
  useEffect(() => {
    onSpawnedRef.current = onSpawned
    onSessionIdRef.current = onSessionId
    onInitialInputSentRef.current = onInitialInputSent
    onSessionClaimSkippedRef.current = onSessionClaimSkipped
    onExitRef.current = onExit
    onAgentCompleteRef.current = onAgentComplete
  })

  const promptHistoryRef = useRef<string[]>([])
  const historyCursorRef = useRef(-1)
  const currentLineRef = useRef('')

  const spawnedAtRef = useRef(0)
  const usedResumeRef = useRef(false)
  const earlyExitRetriedRef = useRef(false)
  const forceFreshRef = useRef(false)

  const [commandNotFound, setCommandNotFound] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [bootPhase, setBootPhase] = useState<
    'preparing' | 'queued' | 'spawning' | 'attaching' | 'ready'
  >('preparing')
  const [linkActions, setLinkActions] = useState<LinkActionState | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const sessionPersistenceKey = sessionKey ?? ptyId

  const hideLinkActions = useCallback(() => {
    setLinkActions(null)
  }, [])

  // Clique no link abre um menu compacto junto ao cursor. A posição usa uma
  // estimativa conservadora do tamanho para nunca cortar o menu na viewport.
  const showLinkActionsMenu = useCallback((event: MouseEvent, link: DetectedTerminalLink) => {
    event.preventDefault()
    event.stopPropagation()
    // O xterm inicia seleção no pointerdown antes de chamar `activate` no
    // clique. Limpa esse gesto residual para o menu não parecer estar
    // "segurando" e selecionando o conteúdo que ficou atrás dele.
    terminalRef.current?.clearSelection()
    window.getSelection()?.removeAllRanges()

    const maxLeft = window.innerWidth - LINK_MENU_WIDTH - LINK_MENU_MARGIN
    const x = Math.max(LINK_MENU_MARGIN, Math.min(event.clientX + LINK_MENU_OFFSET, maxLeft))
    const below = event.clientY + LINK_MENU_OFFSET
    const y =
      below + LINK_MENU_MAX_HEIGHT <= window.innerHeight - LINK_MENU_MARGIN
        ? below
        : Math.max(LINK_MENU_MARGIN, event.clientY - LINK_MENU_MAX_HEIGHT - LINK_MENU_OFFSET)

    setLinkActions({
      text: link.text,
      kind: link.kind,
      fileKind: link.fileKind,
      x,
      y,
    })
  }, [])

  // Espelha o estado num ref pro listener do xterm, criado uma vez por PTY.
  useEffect(() => {
    linkActionsRef.current = linkActions
  }, [linkActions])

  useEffect(() => {
    if (!linkActions) return

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!linkMenuRef.current?.contains(event.target as Node)) hideLinkActions()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hideLinkActions()
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer, true)
    window.addEventListener('keydown', closeOnEscape, true)
    window.addEventListener('blur', hideLinkActions)
    window.addEventListener('resize', hideLinkActions)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true)
      window.removeEventListener('keydown', closeOnEscape, true)
      window.removeEventListener('blur', hideLinkActions)
      window.removeEventListener('resize', hideLinkActions)
    }
  }, [hideLinkActions, linkActions])

  const openFileInGrid = useCallback(
    (target: string) => {
      if (!projectId) return
      useProjectsStore.getState().createFilePane(projectId, { filePath: target })
    },
    [projectId],
  )

  const openLinkInAppViewer = useCallback((target: string) => {
    useUiStore.getState().openLinkViewer(target)
  }, [])

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

  useXtermSession({
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
    onAgentCompleteRef,
    setBootPhase,
    setCommandNotFound,
    setLinkActions,
    setRetryKey,
    setDropActive,
    showLinkActionsMenu,
    recordPromptInput,
    navigateHistory,
  })

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.theme = getXtermTheme(terminalTheme)
  }, [terminalTheme])

  const configurePath = useCallback(
    async (agent: AgentType) => {
      const picked = await pickFile({
        title: `Select the ${agent} executable`,
        filters: [
          { name: 'Executable', extensions: ['cmd', 'exe', 'bat', 'ps1'] },
          { name: 'All files', extensions: ['*'] },
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
    bootPhase === 'preparing'
      ? t('term.bootPreparing')
      : bootPhase === 'queued'
        ? t('term.bootQueued')
        : bootPhase === 'spawning'
          ? t('term.bootSpawning')
          : bootPhase === 'attaching'
            ? t('term.bootAttaching')
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
            <strong>{commandNotFound}</strong> was not found on this machine.
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
          ref={linkMenuRef}
          className={styles.linkMenu}
          style={{ left: linkActions.x, top: linkActions.y }}
          role="menu"
          aria-label={t('xterm.linkMenu')}
          onPointerDown={(event) => {
            event.stopPropagation()
            if (event.target === event.currentTarget) event.preventDefault()
          }}
        >
          <div className={styles.linkMenuHeader}>
            <span className={styles.linkMenuText} title={linkActions.text}>
              {linkActions.text}
            </span>
            <button
              type="button"
              className={styles.linkMenuClose}
              onClick={hideLinkActions}
              title={t('common.close')}
              aria-label={t('common.close')}
            >
              <X size={14} />
            </button>
          </div>
          <div className={styles.linkMenuItems}>
            {(linkActions.fileKind === 'markdown' ||
              linkActions.fileKind === 'text' ||
              linkActions.fileKind === 'video') &&
            projectId ? (
              <button
                type="button"
                className={styles.linkMenuItem}
                role="menuitem"
                onClick={() => {
                  openFileInGrid(linkActions.text)
                  hideLinkActions()
                }}
              >
                <LayoutGrid size={15} />
                <span>{t('xterm.openInGrid')}</span>
              </button>
            ) : null}
            {linkActions.kind === 'url' || linkActions.fileKind === 'video' ? (
              <button
                type="button"
                className={styles.linkMenuItem}
                role="menuitem"
                onClick={() => {
                  openLinkInAppViewer(linkActions.text)
                  hideLinkActions()
                }}
              >
                <AppWindow size={15} />
                <span>
                  {t(linkActions.fileKind === 'video' ? 'xterm.playInApp' : 'xterm.openInApp')}
                </span>
              </button>
            ) : null}
            {linkActions.fileKind === 'markdown' ? (
              <>
                <button
                  type="button"
                  className={styles.linkMenuItem}
                  role="menuitem"
                  onClick={() => {
                    openLinkInAppViewer(linkActions.text)
                    hideLinkActions()
                  }}
                >
                  <Maximize2 size={15} />
                  <span>{t('xterm.openMarkdownFullscreen')}</span>
                </button>
                <button
                  type="button"
                  className={styles.linkMenuItem}
                  role="menuitem"
                  onClick={() => {
                    useUiStore.getState().openMarkdownSidebar(
                      linkActions.text,
                      linkActions.text.split(/[\\/]/).pop(),
                    )
                    useProjectsStore.getState().setPreferences({ rightSidebarVisible: true })
                    hideLinkActions()
                  }}
                >
                  <PanelRight size={15} />
                  <span>{t('xterm.openMarkdownSidebar')}</span>
                </button>
              </>
            ) : null}
            <button
              type="button"
              className={styles.linkMenuItem}
              role="menuitem"
              onClick={() => {
                void openLinkInBrowser(linkActions.text)
                hideLinkActions()
              }}
            >
              <ExternalLink size={15} />
              <span>
                {t(linkActions.kind === 'url' ? 'xterm.openInBrowser' : 'xterm.openInDefaultApp')}
              </span>
            </button>
            {linkActions.kind === 'path' ? (
              <button
                type="button"
                className={styles.linkMenuItem}
                role="menuitem"
                onClick={() => {
                  void openLinkInFolder(linkActions.text)
                  hideLinkActions()
                }}
              >
                <FolderOpen size={15} />
                <span>{t('xterm.openInFolder')}</span>
              </button>
            ) : null}
            <button
              type="button"
              className={styles.linkMenuItem}
              role="menuitem"
              onClick={() => {
                void copyLinkText(linkActions.text)
                hideLinkActions()
              }}
            >
              <Copy size={15} />
              <span>{t('xterm.copy')}</span>
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}
