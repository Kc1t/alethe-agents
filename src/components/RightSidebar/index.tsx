import { getCurrentWebview } from '@tauri-apps/api/webview'
import {
  ArrowLeft,
  ClipboardCopy,
  FileText,
  GitBranch,
  ListTodo,
  Maximize2,
  PanelRightClose,
  Plug,
  RefreshCw,
  Settings,
  X,
} from 'lucide-react'
import {
  type DragEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { hasFileDragPayload, readFileDragPayload } from '../../lib/fileDrag'
import { useT } from '../../lib/i18n'
import { isMarkdownPath } from '../../lib/markdownSidebarHistory'
import { basename } from '../../lib/paths'
import { readTextFile, writeClipboardText } from '../../lib/tauri'
import type { Project, SubTab, Terminal } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { EmptyState } from '../EmptyState'

const MarkdownRenderer = lazy(() => import('../MarkdownPane/MarkdownRenderer').then(m => ({ default: m.MarkdownRenderer })))
import { McpPanel } from '../McpPanel'
import { GitControl } from '../ProjectSidebar/GitControl'
import { TodoSidebar } from '../TodoSidebar'
import styles from './RightSidebar.module.css'

const markdownScrollPositions = new Map<string, number>()

export function RightSidebar() {
  const t = useT()
  const mode = useUiStore((state) => state.rightSidebarMode)
  const setMode = useUiStore((state) => state.showTodoSidebar)
  const openMarkdown = useUiStore((state) => state.showMarkdownSidebar)
  const showGit = useUiStore((state) => state.showGitSidebar)
  const showMcp = useUiStore((state) => state.showMcpSidebar)
  const openModal = useUiStore((state) => state.openModal_)
  const preferences = useProjectsStore((state) => state.preferences)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const activeProjectId = useProjectsStore((state) => state.activeProjectId)
  const projects = useProjectsStore((state) => state.projects)
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0]
  const sidebarTerminal = activeProject
    ? [...activeProject.terminals]
        .filter((terminal) => !terminal.kind)
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0]
    : null
  const sidebarSubTab = sidebarTerminal?.tabs.find((tab) => tab.id === sidebarTerminal.activeTabId)
    ?? sidebarTerminal?.tabs[0]

  const todoEnabled = preferences.enabledFeatures.todos
  const gitEnabled =
    preferences.enabledFeatures.git && preferences.gitControlPlacement === 'right'
  const mcpEnabled = preferences.enabledFeatures.mcp
  // The panel now survives its features being turned off one by one, so a mode whose
  // feature was disabled has to fall back instead of rendering a hidden feature.
  useEffect(() => {
    const modeStillEnabled =
      mode === 'markdown' ||
      (mode === 'todo' && todoEnabled) ||
      (mode === 'git' && gitEnabled) ||
      (mode === 'mcp' && mcpEnabled)
    if (modeStillEnabled) return
    if (todoEnabled) setMode()
    else openMarkdown()
  }, [gitEnabled, mcpEnabled, mode, openMarkdown, setMode, todoEnabled])

  return (
    <aside className={styles.sidebar} aria-label={t('rightSidebar.navigation')}>
      <div className={styles.sidebarTabs} role="tablist" aria-label={t('rightSidebar.navigation')}>
        {todoEnabled ? (
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'todo'}
            className={`${styles.sidebarTab} ${mode === 'todo' ? styles.sidebarTabActive : ''}`}
            onClick={setMode}
            title={t('todo.title')}
          >
            <ListTodo size={14} />
            <span>{t('rightSidebar.todoTab')}</span>
          </button>
        ) : null}
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'markdown'}
          className={`${styles.sidebarTab} ${mode === 'markdown' ? styles.sidebarTabActive : ''}`}
          onClick={openMarkdown}
          title={t('rightSidebar.markdownTab')}
        >
          <FileText size={14} />
          <span>{t('rightSidebar.markdownTab')}</span>
        </button>
        {gitEnabled ? (
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'git'}
            className={`${styles.sidebarTab} ${mode === 'git' ? styles.sidebarTabActive : ''}`}
            onClick={showGit}
            title={t('ui.sidebar.git')}
          >
            <GitBranch size={14} />
            <span>{t('ui.sidebar.git')}</span>
          </button>
        ) : null}
        {mcpEnabled ? (
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'mcp'}
            className={`${styles.sidebarTab} ${mode === 'mcp' ? styles.sidebarTabActive : ''}`}
            onClick={showMcp}
            title={t('mcp.tab')}
          >
            <Plug size={14} />
            <span>{t('mcp.tab')}</span>
          </button>
        ) : null}
        <span className={styles.toolbarSpacer} />
        {mode === 'todo' && todoEnabled ? (
          <button
            type="button"
            className={styles.toolbarUtility}
            onClick={() => openModal('todoSettings')}
            title={t('todo.openSettings')}
            aria-label={t('todo.openSettings')}
          >
            <Settings size={14} />
          </button>
        ) : null}
        {mode === 'mcp' && mcpEnabled ? (
          <button
            type="button"
            className={styles.toolbarUtility}
            onClick={() => openModal('mcpManager')}
            title={t('mcp.expand')}
            aria-label={t('mcp.expand')}
          >
            <Maximize2 size={14} />
          </button>
        ) : null}
        <span className={styles.toolbarDivider} />
        <button
          type="button"
          className={styles.toolbarUtility}
          onClick={() => setPreferences({ rightSidebarVisible: false })}
          title={t('todo.closeSidebar')}
          aria-label={t('todo.closeSidebar')}
        >
          <PanelRightClose size={14} />
        </button>
      </div>
      <div className={styles.tabContent}>
        {mode === 'markdown' ? <MarkdownSidebarViewer /> : null}
        {mode === 'todo' && todoEnabled ? <TodoSidebar /> : null}
        {mode === 'mcp' && mcpEnabled ? <McpPanel /> : null}
        {mode === 'git' && gitEnabled ? (
          <GitSidebarContent
            activeProject={activeProject}
            sidebarTerminal={sidebarTerminal}
            sidebarSubTab={sidebarSubTab}
          />
        ) : null}
      </div>
    </aside>
  )
}

function GitSidebarContent({
  activeProject,
  sidebarTerminal,
  sidebarSubTab,
}: {
  activeProject: Project | undefined
  sidebarTerminal: Terminal | null
  sidebarSubTab: SubTab | undefined
}) {
  const t = useT()
  return (
    <section className={styles.gitPanel}>
      <header className={styles.panelHeader}>
        <GitBranch size={15} />
        <span>{t('ui.sidebar.sourceControl')}</span>
      </header>
      {activeProject && sidebarTerminal && sidebarSubTab ? (
        <GitControl
          projectId={activeProject.id}
          cwd={sidebarSubTab.cwd || sidebarTerminal.cwd}
          ptyId={sidebarSubTab.ptyId}
          terminalName={sidebarTerminal.name}
        />
      ) : (
        <div className={styles.gitEmpty}>
          <EmptyState
            compact
            icon={<GitBranch size={18} />}
            title={t('git.empty.noTerminal')}
            description={t('git.empty.noTerminalDesc')}
          />
        </div>
      )}
    </section>
  )
}

function MarkdownSidebarViewer() {
  const t = useT()
  const markdown = useUiStore((state) => state.rightSidebarMarkdown)
  const markdownTabs = useUiStore((state) => state.rightSidebarMarkdownTabs)
  const openMarkdownSidebar = useUiStore((state) => state.openMarkdownSidebar)
  const closeMarkdownSidebarTab = useUiStore((state) => state.closeMarkdownSidebarTab)
  const showTodoSidebar = useUiStore((state) => state.showTodoSidebar)
  const pushToast = useUiStore((state) => state.pushToast)
  const activeProjectId = useProjectsStore((state) => state.activeProjectId)
  const projects = useProjectsStore((state) => state.projects)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const dark = useProjectsStore(
    (state) => state.preferences.uiTheme !== 'light' && state.preferences.uiTheme !== 'min-light',
  )
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [selectedPath, setSelectedPath] = useState(markdown?.path ?? '')
  const panelRef = useRef<HTMLElement | null>(null)
  const nativeDragHasMarkdownRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const markdownRef = useRef<HTMLDivElement | null>(null)

  const readmeTabs = useMemo(() => {
    const project = projects.find((item) => item.id === activeProjectId)
    const projectTabs = (project?.terminals ?? [])
      .filter((terminal) => terminal.kind === 'markdown' && terminal.filePath)
      .map((terminal) => ({ path: terminal.filePath!, title: terminal.name }))
    const merged = new Map<string, { path: string; title: string; closable: boolean }>()
    for (const tab of projectTabs) merged.set(tab.path, { ...tab, closable: false })
    for (const tab of markdownTabs) merged.set(tab.path, { ...tab, closable: true })
    return [...merged.values()]
  }, [activeProjectId, markdownTabs, projects])
  const selected =
    readmeTabs.find((tab) => tab.path === selectedPath) ??
    (markdown ? { path: markdown.path, title: markdown.title } : null)

  const load = async () => {
    if (!selected?.path) return
    try {
      setContent(await readTextFile(selected.path))
      setError(null)
    } catch (err) {
      setError(String(err))
      setContent(null)
    }
  }

  useEffect(() => {
    setContent(null)
    setError(null)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown?.path, selectedPath])

  useEffect(() => {
    if (!selected?.path || content === null) return
    const frame = window.requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = markdownScrollPositions.get(selected.path) ?? 0
    })
    return () => window.cancelAnimationFrame(frame)
  }, [content, selected?.path])

  useEffect(() => {
    if (markdown?.path) setSelectedPath(markdown.path)
  }, [markdown?.path])

  const openDroppedMarkdownPaths = useCallback(
    (paths: string[]) => {
      for (const path of paths.filter(isMarkdownPath)) {
        openMarkdownSidebar(path, basename(path) || path)
      }
    },
    [openMarkdownSidebar],
  )

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    const isOverViewer = (position: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1
      const element = document.elementFromPoint(position.x / dpr, position.y / dpr)
      return Boolean(element && panelRef.current?.contains(element))
    }
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload
        if (payload.type === 'enter') {
          nativeDragHasMarkdownRef.current = payload.paths.some(isMarkdownPath)
          setDropActive(
            nativeDragHasMarkdownRef.current && isOverViewer(payload.position),
          )
        } else if (payload.type === 'over') {
          setDropActive(
            nativeDragHasMarkdownRef.current && isOverViewer(payload.position),
          )
        } else if (payload.type === 'leave') {
          nativeDragHasMarkdownRef.current = false
          setDropActive(false)
        } else {
          const overViewer = isOverViewer(payload.position)
          nativeDragHasMarkdownRef.current = false
          setDropActive(false)
          if (overViewer) openDroppedMarkdownPaths(payload.paths)
        }
      })
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [openDroppedMarkdownPaths])

  const onInternalDragOver = (event: DragEvent<HTMLElement>) => {
    if (!hasFileDragPayload(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  const onInternalDragLeave = (event: DragEvent<HTMLElement>) => {
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget as Node)) return
    setDropActive(false)
  }

  const onInternalDrop = (event: DragEvent<HTMLElement>) => {
    const payload = readFileDragPayload(event.dataTransfer)
    if (!payload) return
    event.preventDefault()
    event.stopPropagation()
    setDropActive(false)
    openDroppedMarkdownPaths([payload.path])
  }

  const copyMarkdown = async () => {
    if (content === null) return
    try {
      await writeClipboardText(content)
      setCopied(true)
      pushToast({ title: t('ui.markdown.copied'), body: '' })
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  if (!markdown) {
    return (
      <section
        ref={panelRef}
        className={`${styles.emptyMarkdown} ${dropActive ? styles.markdownDropActive : ''}`}
        onDragEnter={onInternalDragOver}
        onDragOver={onInternalDragOver}
        onDragLeave={onInternalDragLeave}
        onDrop={onInternalDrop}
      >
        <FileText size={20} />
        <strong>{t('rightSidebar.markdownEmptyTitle')}</strong>
        <span>{t('rightSidebar.markdownEmptyDesc')}</span>
        {dropActive ? (
          <div className={styles.markdownDropOverlay}>{t('rightSidebar.dropMarkdown')}</div>
        ) : null}
      </section>
    )
  }

  return (
    <section
      ref={panelRef}
      className={`${styles.markdownPanel} ${dropActive ? styles.markdownDropActive : ''}`}
      aria-label={t('rightSidebar.markdownViewer')}
      onDragEnter={onInternalDragOver}
      onDragOver={onInternalDragOver}
      onDragLeave={onInternalDragLeave}
      onDrop={onInternalDrop}
    >
      {dropActive ? (
        <div className={styles.markdownDropOverlay}>{t('rightSidebar.dropMarkdown')}</div>
      ) : null}
      <header className={styles.header}>
        <div className={styles.heading}>
          <FileText size={15} />
          <span title={selected?.title ?? markdown.title}>{selected?.title ?? markdown.title}</span>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.headerAction}
            onClick={() => void load()}
            title={t('ui.markdown.refresh')}
            aria-label={t('ui.markdown.refresh')}
          >
            <RefreshCw size={15} />
          </button>
          <button
            type="button"
            className={styles.headerAction}
            onClick={() => void copyMarkdown()}
            disabled={content === null}
            title={copied ? t('ui.markdown.copied') : t('ui.markdown.copySource')}
            aria-label={copied ? t('ui.markdown.copied') : t('ui.markdown.copySource')}
          >
            <ClipboardCopy size={15} />
          </button>
          <button
            type="button"
            className={`${styles.headerAction} ${styles.cleanRedundantAction}`}
            onClick={showTodoSidebar}
            title={t('rightSidebar.backToTodo')}
            aria-label={t('rightSidebar.backToTodo')}
          >
            <ArrowLeft size={15} />
          </button>
          <button
            type="button"
            className={`${styles.headerAction} ${styles.cleanRedundantAction}`}
            onClick={() => setPreferences({ rightSidebarVisible: false })}
            title={t('todo.closeSidebar')}
            aria-label={t('todo.closeSidebar')}
          >
            <PanelRightClose size={15} />
          </button>
        </div>
      </header>
      {readmeTabs.length > 1 ? (
        <div
          className={styles.readmeTabs}
          role="tablist"
          aria-label={t('rightSidebar.markdownTabs')}
        >
          {readmeTabs.map((tab) => (
            <div
              key={tab.path}
              role="tab"
              aria-selected={selected?.path === tab.path}
              className={`${styles.readmeTab} ${selected?.path === tab.path ? styles.readmeTabActive : ''}`}
              title={tab.path}
            >
              <button
                type="button"
                className={styles.readmeTabSelect}
                onClick={() => {
                  setSelectedPath(tab.path)
                  openMarkdownSidebar(tab.path, tab.title)
                }}
              >
                <FileText size={11} />
                <span>{tab.title}</span>
              </button>
              {tab.closable ? (
                <button
                  type="button"
                  className={styles.readmeTabClose}
                  onClick={() => closeMarkdownSidebarTab(tab.path)}
                  title={t('rightSidebar.closeMarkdownTab')}
                  aria-label={t('rightSidebar.closeMarkdownTab')}
                >
                  <X size={10} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className={styles.path} title={selected?.path ?? markdown.path}>
        {selected?.path ?? markdown.path}
      </div>
      <div className={styles.contentLayout}>
        <div
          ref={scrollRef}
          className={styles.content}
          onScroll={(event) => {
            if (selected?.path) markdownScrollPositions.set(selected.path, event.currentTarget.scrollTop)
          }}
        >
        {error ? (
          <div className={styles.empty}>
            <FileText size={20} />
            <strong>{t('rightSidebar.markdownError')}</strong>
            <span>{error}</span>
          </div>
        ) : content === null ? (
          <div className={styles.empty}>
            <span>{t('ui.markdown.loading')}</span>
          </div>
        ) : (
          <div ref={markdownRef} className={styles.commentableMarkdown}>
            <Suspense fallback={<span>{t('ui.markdown.loading')}</span>}>
              <MarkdownRenderer content={content} dark={dark} />
            </Suspense>
          </div>
        )}
        </div>
      </div>
    </section>
  )
}
