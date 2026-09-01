import '@xterm/xterm/css/xterm.css'

import type { Terminal } from '@xterm/xterm'
import {
  AppWindow,
  Copy,
  ExternalLink,
  FolderOpen,
  LayoutGrid,
  Maximize2,
  PanelRight,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { AgentInstallButton } from '../AgentInstall/AgentInstallButton'
import { DotmCircular2 } from '../ui/dotm-circular-2'
import { cliPathMatchesAgent } from '../../lib/agentCliPath'
import { normalizeBrowserUrl } from '../../lib/browserUrl'
import { pickFile } from '../../lib/dialog'
import { getLocale, translate, useT } from '../../lib/i18n'
import { writeScopedStorage } from '../../lib/storageNamespace'
import { openInBrowser, openInFileExplorer, writeClipboardText, writePty } from '../../lib/tauri'
import {
  AGENT_TYPE_LABELS,
  agentCliCommand,
  type AgentRuntimeProfile,
  type AgentType,
  type Theme,
} from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { type DetectedTerminalLink } from './terminalLinks'
import { applyPromptHistoryInput, loadPromptHistory, PROMPT_HISTORY_KEY } from './terminalWrite'
import { useXtermSession } from './useXtermSession'
import { getXtermTheme, type LinkActionState } from './xtermThemes'
import styles from './XTermView.module.css'

export type XTermViewProps = {
  ptyId: string

  projectId?: string

  command?: AgentType | null
  cwd?: string | null
  extraArgs?: string[]

  initialInput?: string
  /** Identidade persistida da conversa deste pane. */
  sessionId?: string

  sessionKey?: string

  env?: Record<string, string>

  graphifyRepo?: string | null

  gsdWatcherEnabled?: boolean

  trustSessionId?: boolean

  readOnly?: boolean
  runtimeProfile?: AgentRuntimeProfile
  terminalTheme?: Theme
  onSpawned?: (id: string) => void
  onSessionId?: (id: string | undefined) => void
  onInitialInputSent?: () => void
  onExit?: (code: number | null) => void
  onLaunchError?: (error: unknown) => void
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

  runtimeProfile = 'lean',
  terminalTheme = 'dark',
  onSpawned,
  onSessionId,
  onInitialInputSent,
  onExit,
  onLaunchError,
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
  const onExitRef = useRef(onExit)
  const onLaunchErrorRef = useRef(onLaunchError)
  const onAgentCompleteRef = useRef(onAgentComplete)
  useEffect(() => {
    onSpawnedRef.current = onSpawned
    onSessionIdRef.current = onSessionId
    onInitialInputSentRef.current = onInitialInputSent
    onExitRef.current = onExit
    onLaunchErrorRef.current = onLaunchError
    onAgentCompleteRef.current = onAgentComplete
  })

  const promptHistoryRef = useRef<string[]>([])
  const historyCursorRef = useRef(-1)
  const currentLineRef = useRef('')
  const promptHistoryOverflowRef = useRef(false)

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

  // estimativa conservadora do tamanho para nunca cortar o menu na viewport.
  const showLinkActionsMenu = useCallback((event: MouseEvent, link: DetectedTerminalLink) => {
    event.preventDefault()
    event.stopPropagation()

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
      target: link.target,
      kind: link.kind,
      fileKind: link.fileKind,
      x,
      y,
    })
  }, [])

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

  const openUrlInGrid = useCallback(
    (target: string) => {
      if (!projectId) return
      const url = normalizeBrowserUrl(target)
      if (!url) return
      useProjectsStore.getState().createWebPane(projectId, { url })
      useUiStore.getState().setActiveView('workspace')
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
    promptHistoryOverflowRef.current = false
  }, [ptyId])

  const recordPromptInput = (data: string): boolean => {
    const state = {
      currentLine: currentLineRef.current,
      overflow: promptHistoryOverflowRef.current,
      history: promptHistoryRef.current,
    }
    let startsNewSession = false
    const historyChanged = applyPromptHistoryInput(state, data, (line) => {
      if (line === '/new') startsNewSession = true
    })
    currentLineRef.current = state.currentLine
    promptHistoryOverflowRef.current = state.overflow
    if (data.includes('\r') || data.includes('\n')) historyCursorRef.current = -1
    if (!historyChanged) return startsNewSession
    try {
      writeScopedStorage(PROMPT_HISTORY_KEY(ptyId), JSON.stringify(state.history))
    } catch {
      /* Ignore unavailable or full browser storage. */
    }
    return startsNewSession
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
    promptHistoryOverflowRef.current = false
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
  })

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.theme = getXtermTheme(terminalTheme)
    // Swapping the palette alone leaves already-painted rows on the previous colours.
    terminal.refresh(0, terminal.rows - 1)
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
      if (!cliPathMatchesAgent(agent, picked)) {
        useUiStore.getState().pushToast({
          title: translate(getLocale(), 'prefs.cliPathMismatch'),
          body: translate(getLocale(), 'prefs.cliPathMismatchBody', {
            agent,
            command: agentCliCommand(agent) ?? agent,
          }),
        })
        return
      }
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
          <DotmCircular2
            size={26}
            dotSize={2}
            cellPadding={1}
            speed={1.2}
            bloom
            ariaLabel={bootLabel}
            className={styles.bootSpinner}
          />
          <div className={styles.bootLabel}>{bootLabel}</div>
        </div>
      ) : null}
      {commandNotFound ? (
        <div className={styles.overlay}>
          <div className={styles.overlayText}>
            {t('xterm.notFoundTitle', { agent: commandNotFound })}
          </div>
          <AgentInstallButton
            agent={commandNotFound as AgentType}
            label={AGENT_TYPE_LABELS[commandNotFound as AgentType] ?? commandNotFound}
            onInstalled={() => setRetryKey((value) => value + 1)}
          />
          <button
            type="button"
            className={styles.overlayBtn}
            onClick={() => void configurePath(commandNotFound as AgentType)}
          >
            {t('xterm.configurePath')}
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
            {linkActions.kind === 'url' && projectId ? (
              <button
                type="button"
                className={styles.linkMenuItem}
                role="menuitem"
                onClick={() => {
                  openUrlInGrid(linkActions.target)
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
                  openLinkInAppViewer(linkActions.target)
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
                    useUiStore
                      .getState()
                      .openMarkdownSidebar(linkActions.text, linkActions.text.split(/[\\/]/).pop())
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
                void openLinkInBrowser(linkActions.target)
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
