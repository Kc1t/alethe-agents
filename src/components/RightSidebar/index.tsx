import {
  ArrowLeft,
  ClipboardCopy,
  FileText,
  GitBranch,
  ListTodo,
  PanelRightClose,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { type GsdSyncSession, useGsdSyncSessions } from '../../hooks/useGsdSyncSessions'
import { useT } from '../../lib/i18n'
import { basename } from '../../lib/paths'
import {
  type PlanningStatus,
  readPlanningStatus,
  readTextFile,
  writeClipboardText,
} from '../../lib/tauri'
import type { Project, SubTab, Terminal } from '../../lib/types'
import { selectActiveProject, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { EmptyState } from '../EmptyState'
import { MarkdownRenderer } from '../MarkdownPane/MarkdownRenderer'
import { GitControl } from '../ProjectSidebar/GitControl'
import { TodoSidebar } from '../TodoSidebar'
import { DotmCircular2 } from '../ui/dotm-circular-2'
import styles from './RightSidebar.module.css'

const markdownScrollPositions = new Map<string, number>()

export function RightSidebar() {
  const t = useT()
  const mode = useUiStore((state) => state.rightSidebarMode)
  const setMode = useUiStore((state) => state.showTodoSidebar)
  const openMarkdown = useUiStore((state) => state.showMarkdownSidebar)
  const showGit = useUiStore((state) => state.showGitSidebar)
  const showGsdSyncSidebar = useUiStore((state) => state.showGsdSyncSidebar)
  const preferences = useProjectsStore((state) => state.preferences)
  const activeProjectId = useProjectsStore((state) => state.activeProjectId)
  const projects = useProjectsStore((state) => state.projects)
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0]
  const sidebarTerminal = activeProject
    ? [...activeProject.terminals]
        .filter((terminal) => !terminal.kind)
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0]
    : null
  const sidebarSubTab =
    sidebarTerminal?.tabs.find((tab) => tab.id === sidebarTerminal.activeTabId) ??
    sidebarTerminal?.tabs[0]

  return (
    <aside className={styles.sidebar} aria-label={t('rightSidebar.navigation')}>
      <div className={styles.sidebarTabs} role="tablist" aria-label={t('rightSidebar.navigation')}>
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
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'gsdSync'}
          className={`${styles.sidebarTab} ${mode === 'gsdSync' ? styles.sidebarTabActive : ''}`}
          onClick={showGsdSyncSidebar}
          title={t('rightSidebar.gsdSyncTab')}
        >
          <Sparkles size={14} />
          <span>{t('rightSidebar.gsdSyncTab')}</span>
        </button>
        {preferences.enabledFeatures.git ? (
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
      </div>
      <div className={styles.tabContent}>
        {mode === 'markdown' ? <MarkdownSidebarViewer /> : null}
        {mode === 'todo' ? <TodoSidebar /> : null}
        {mode === 'gsdSync' ? <GsdSyncSidebarContent /> : null}
        {mode === 'git' ? (
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

function GsdSyncSidebarContent() {
  const t = useT()
  const activeProject = useProjectsStore(selectActiveProject)
  const setGsdSyncActivityView = useUiStore((state) => state.setGsdSyncActivityView)
  const sessions = useGsdSyncSessions()
  const projectSessions = activeProject
    ? sessions.filter((session) => session.projectId === activeProject.id)
    : []

  if (!activeProject || projectSessions.length === 0) {
    return (
      <div className={styles.empty}>
        <Sparkles size={20} />
        <strong>{t('rightSidebar.gsdSyncEmptyTitle')}</strong>
        <span>{t('rightSidebar.gsdSyncEmptyDesc')}</span>
      </div>
    )
  }

  return (
    <div className={styles.gsdPanel}>
      <div className={styles.gsdList}>
        {projectSessions.map((session) => (
          <GsdSyncRow
            key={session.id}
            session={session}
            onOpen={() => {
              const title = basename(session.worktreePath) || session.worktreePath
              setGsdSyncActivityView({
                worktreePath: session.worktreePath,
                sessionId: session.childId,
                title,
              })
            }}
          />
        ))}
      </div>
    </div>
  )
}

function GsdSyncRow({ session, onOpen }: { session: GsdSyncSession; onOpen: () => void }) {
  const t = useT()
  const [status, setStatus] = useState<PlanningStatus | null>(null)
  const name = basename(session.worktreePath) || session.worktreePath

  useEffect(() => {
    if (!session.worktreePath) return
    let cancelled = false
    readPlanningStatus(session.worktreePath)
      .then((result) => {
        if (!cancelled) setStatus(result)
      })
      .catch(() => {
        if (!cancelled) setStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [session.worktreePath, session.busy])

  const statusLabel = session.hasError
    ? t('todo.gsdError')
    : session.busy
      ? t('todo.gsdBusy')
      : t('todo.gsdIdle')
  const progressLabel =
    status?.roadmapTotalCount != null && status.roadmapPendingCount != null
      ? t('todo.gsdProgress', {
          done: status.roadmapTotalCount - status.roadmapPendingCount,
          total: status.roadmapTotalCount,
        })
      : null

  return (
    <button type="button" className={styles.gsdRow} onClick={onOpen} title={name}>
      <span className={styles.gsdRowState}>
        {session.hasError ? (
          <span className={styles.gsdErrorDot} />
        ) : session.busy ? (
          <DotmCircular2
            size={13}
            dotSize={2}
            cellPadding={1}
            speed={1.2}
            bloom
            ariaLabel={statusLabel}
          />
        ) : (
          <span className={styles.gsdIdleDot} />
        )}
      </span>
      <span className={styles.gsdRowBody}>
        <span className={styles.gsdRowName}>{name}</span>
        <span className={styles.gsdRowMeta}>{progressLabel ?? statusLabel}</span>
      </span>
    </button>
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
  // Prefere o cwd do terminal/sub-tab vivo quando existir (mais preciso —
  // cobre worktree/subpasta) — mas o Controle de Versão sempre deveria
  // funcionar com o projeto SELECIONADO, não exigir um terminal aberto. Sem
  // esse fallback, um projeto sem nenhum terminal aberto nunca mostrava git
  // nenhum mesmo estando selecionado.
  const cwd = sidebarSubTab?.cwd || sidebarTerminal?.cwd || activeProject?.defaultCwd
  const ptyId = sidebarSubTab && sidebarTerminal ? sidebarSubTab.ptyId : null
  const terminalName = sidebarTerminal?.name ?? activeProject?.name ?? ''
  return (
    <section className={styles.gitPanel}>
      <header className={styles.panelHeader}>
        <GitBranch size={15} />
        <span>{t('ui.sidebar.sourceControl')}</span>
      </header>
      {activeProject && cwd ? (
        <GitControl
          projectId={activeProject.id}
          cwd={cwd}
          ptyId={ptyId}
          terminalName={terminalName}
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
  const [selectedPath, setSelectedPath] = useState(markdown?.path ?? '')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const markdownRef = useRef<HTMLDivElement | null>(null)

  const readmeTabs = useMemo(() => {
    const project = projects.find((item) => item.id === activeProjectId)
    return (project?.terminals ?? [])
      .filter((terminal) => terminal.kind === 'markdown' && terminal.filePath)
      .map((terminal) => ({ path: terminal.filePath!, title: terminal.name }))
  }, [activeProjectId, projects])
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
      if (scrollRef.current)
        scrollRef.current.scrollTop = markdownScrollPositions.get(selected.path) ?? 0
    })
    return () => window.cancelAnimationFrame(frame)
  }, [content, selected?.path])

  useEffect(() => {
    if (markdown?.path) setSelectedPath(markdown.path)
  }, [markdown?.path])

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
      <section className={styles.emptyMarkdown}>
        <FileText size={20} />
        <strong>{t('rightSidebar.markdownEmptyTitle')}</strong>
        <span>{t('rightSidebar.markdownEmptyDesc')}</span>
      </section>
    )
  }

  return (
    <section className={styles.markdownPanel} aria-label={t('rightSidebar.markdownViewer')}>
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
            className={styles.headerAction}
            onClick={showTodoSidebar}
            title={t('rightSidebar.backToTodo')}
            aria-label={t('rightSidebar.backToTodo')}
          >
            <ArrowLeft size={15} />
          </button>
          <button
            type="button"
            className={styles.headerAction}
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
            <button
              key={tab.path}
              type="button"
              role="tab"
              aria-selected={selected?.path === tab.path}
              className={`${styles.readmeTab} ${selected?.path === tab.path ? styles.readmeTabActive : ''}`}
              onClick={() => setSelectedPath(tab.path)}
              title={tab.path}
            >
              <FileText size={11} />
              <span>{tab.title}</span>
            </button>
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
            if (selected?.path)
              markdownScrollPositions.set(selected.path, event.currentTarget.scrollTop)
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
              <MarkdownRenderer content={content} dark={dark} />
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
