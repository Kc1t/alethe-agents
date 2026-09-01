import { nanoid } from 'nanoid'

import { MAX_RECENT_PROJECT_TABS } from '../stores/projectsStore.constants'
import { basename } from './paths'
import type {
  AgentHandoffBootstrap,
  AgentRuntimeProfile,
  AgentType,
  BrowserPaneOptions,
  LayoutMode,
  Project,
  SubTab,
  Terminal,
  WorkspaceContainer,
  WorkspaceRecentTab,
} from './types'

export function newContainer(
  projectId: string,
  paneIds: string[],
  layout: LayoutMode,
): WorkspaceContainer {
  return {
    projectId,
    paneIds,
    lastUsedAt: Date.now(),
    size: 0,
    internalLayout: layout,
    collapsed: false,
  }
}

export function rememberProjectTab(
  recentProjectIds: string[] | undefined,
  projectId: string,
): string[] {
  const current = (recentProjectIds ?? []).slice(0, MAX_RECENT_PROJECT_TABS)
  if (current.includes(projectId)) return current
  if (current.length < MAX_RECENT_PROJECT_TABS) return [...current, projectId]
  return [...current.slice(0, MAX_RECENT_PROJECT_TABS - 1), projectId]
}

export function rememberWorkspaceTab(
  recentTabs: WorkspaceRecentTab[] | undefined,
  tab: WorkspaceRecentTab,
): WorkspaceRecentTab[] {
  const current = (recentTabs ?? []).slice(0, MAX_RECENT_PROJECT_TABS)
  if (current.some((item) => item.kind === tab.kind && item.id === tab.id)) return current
  if (current.length < MAX_RECENT_PROJECT_TABS) return [...current, tab]
  return [...current.slice(0, MAX_RECENT_PROJECT_TABS - 1), tab]
}

export function makeDefaultTerminal(args: {
  name: string
  cwd: string
  firstTab: {
    type: AgentType
    cwd: string
    extraArgs?: string[]
    initialInput?: string
    handoff?: AgentHandoffBootstrap
    runtimeProfile?: AgentRuntimeProfile
  }
  worktreeAgentId?: string
  gsdSyncViewer?: boolean
  ephemeralConflictAgent?: boolean
  ephemeralUtility?: boolean
}): Terminal {
  const tabId = nanoid()
  const now = Date.now()
  return {
    id: nanoid(),
    name: args.name,
    cwd: args.cwd,
    activeTabId: tabId,
    disabled: false,
    laneVisible: null,
    lastUsedAt: now,
    worktreeAgentId: args.worktreeAgentId,
    gsdSyncViewer: args.gsdSyncViewer,
    ephemeralConflictAgent: args.ephemeralConflictAgent,
    ephemeralUtility: args.ephemeralUtility,
    tabs: [
      {
        id: tabId,
        type: args.firstTab.type,
        name: args.firstTab.type,
        cwd: args.firstTab.cwd,
        lastUsedAt: now,
        ptyId: null,
        extraArgs: args.firstTab.extraArgs,
        initialInput: args.firstTab.initialInput,
        handoff: args.firstTab.handoff,
        runtimeProfile: args.firstTab.runtimeProfile,
      },
    ],
  }
}

const MARKDOWN_FILE_PATTERN = /\.(md|markdown|mdx)$/i
const VIDEO_FILE_PATTERN = /\.(mp4|m4v|mov|avi|mkv|webm|ogv)$/i

function classifyPaneKind(filePath: string): 'markdown' | 'video' | 'file' {
  if (VIDEO_FILE_PATTERN.test(filePath)) return 'video'
  return MARKDOWN_FILE_PATTERN.test(filePath) ? 'markdown' : 'file'
}

export function makeFilePane(args: { filePath: string; name?: string }): Terminal {
  const filePath = args.filePath.trim().replace(/:\d+(?::\d+)?$/, '')
  return {
    id: nanoid(),
    name: args.name?.trim() || basename(filePath) || filePath,
    cwd: '',
    activeTabId: '',
    disabled: false,
    laneVisible: null,
    lastUsedAt: Date.now(),
    tabs: [],
    kind: classifyPaneKind(filePath),
    filePath,
  }
}

export function makeDiffPane(args: {
  filePath: string
  repoRoot: string
  staged: boolean
  name?: string
}): Terminal {
  const filePath = args.filePath.trim().replace(/:\d+(?::\d+)?$/, '')
  return {
    id: nanoid(),
    name: args.name?.trim() || `Diff: ${basename(filePath) || filePath}`,
    cwd: args.repoRoot,
    activeTabId: '',
    disabled: false,
    laneVisible: null,
    lastUsedAt: Date.now(),
    tabs: [],
    kind: 'diff',
    filePath,
    staged: args.staged,
  }
}

export function makeWebPane(args: BrowserPaneOptions): Terminal {
  const url = args.url.trim()
  let host = url
  try {
    host = new URL(url).hostname
  } catch {
    // Keep the original value as the display name when the URL is incomplete.
  }
  return {
    id: nanoid(),
    name: args.name?.trim() || host,
    cwd: '',
    activeTabId: '',
    disabled: false,
    laneVisible: null,
    lastUsedAt: Date.now(),
    tabs: [],
    kind: 'web',
    url,
    browserConfig: {
      javascriptEnabled: args.javascriptEnabled ?? true,
      zoom: args.zoom ?? 1,
      resourceMode: args.resourceMode ?? 'app-first',
      ...(args.engine ? { engine: args.engine } : {}),
      ...(args.watchTargetId ? { watchTargetId: args.watchTargetId } : {}),
    },
  }
}

export function resolveTerminalCwd(terminal: Terminal | null | undefined): string {
  if (!terminal) return ''
  const activeTab = terminal.tabs.find((t) => t.id === terminal.activeTabId) ?? terminal.tabs[0]
  return activeTab?.cwd?.trim() || terminal.cwd?.trim() || ''
}

export function touchTerminalUsage(terminal: Terminal, tabId = terminal.activeTabId): Terminal {
  const now = Date.now()
  const activeTabId = terminal.tabs.some((tab) => tab.id === tabId) ? tabId : terminal.activeTabId
  return {
    ...terminal,
    lastUsedAt: now,
    activeTabId,
    tabs: terminal.tabs.map((tab) => (tab.id === activeTabId ? { ...tab, lastUsedAt: now } : tab)),
  }
}

export function pickMostRecentTab(terminal: Terminal, excludeTabId?: string): SubTab | null {
  const candidates = terminal.tabs.filter((tab) => tab.id !== excludeTabId)
  if (candidates.length === 0) return null
  return (
    [...candidates].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0] ?? candidates[0]
  )
}

export function collectTerminalPtyIds(terminals: Terminal[]): string[] {
  return terminals.flatMap((terminal) =>
    terminal.tabs.map((tab) => tab.ptyId).filter((ptyId): ptyId is string => Boolean(ptyId)),
  )
}

export function clearTerminalPtyIds(terminal: Terminal): Terminal {
  if (terminal.tabs.length === 0) return terminal
  return {
    ...terminal,
    tabs: terminal.tabs.map((tab) => (tab.ptyId ? { ...tab, ptyId: null } : tab)),
  }
}

export function resetTerminalRuntime(terminal: Terminal): Terminal {
  if (terminal.tabs.length === 0) return terminal
  return {
    ...terminal,
    tabs: terminal.tabs.map((tab) => ({
      ...tab,
      ptyId: null,
      sessionId: undefined,
      completionUnread: false,
    })),
  }
}

export function getProjectDefaultCwd(
  project: Project | null | undefined,
  projects: Project[] = [],
): string {
  if (!project) return ''
  if (project.defaultCwd?.trim()) return project.defaultCwd.trim()
  const candidates = [project]
  if (project.groupId) {
    candidates.push(...projects.filter((p) => p.id !== project.id && p.groupId === project.groupId))
  }

  for (const candidate of candidates) {
    const terminals = [...candidate.terminals].sort(
      (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0),
    )
    for (const terminal of terminals) {
      const cwd = resolveTerminalCwd(terminal)
      if (cwd) return cwd
    }
  }
  return ''
}

/** Matches the `.alethe/worktrees/` OR `.alethe/merge-envs/` segment (Windows or
 *  POSIX) anywhere in the path — including nested worktrees, where the
 *  leftmost match still points at the outermost segment (the real root).
 *  `merge-envs` is the conflict-resolution agent's ephemeral environment
 *  (`conflict_resolution.rs`) — same class of "isolated path that doesn't
 *  represent the project's main folder" as regular worktrees. */
const ALETHE_WORKTREES_SEGMENT = /[\\/]\.alethe[\\/](?:worktrees|merge-envs)[\\/]/i

function deriveRepoRootFromWorktreeCwd(cwd: string): string {
  const match = cwd.match(ALETHE_WORKTREES_SEGMENT)
  if (!match || match.index === undefined) return ''
  return cwd.slice(0, match.index)
}

export function getProjectRepoRoot(project: Project | null | undefined): string {
  if (!project) return ''
  const sorted = [...project.terminals].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))

  // `gsdSyncViewer`/`ephemeralConflictAgent`/`ephemeralUtility` never count as
  // "pure": their cwd IS the agent's worktree (they just lack
  // `worktreeAgentId` because they aren't the isolated agent itself — they're
  // a secondary viewer, the ephemeral conflict agent, or a "Review"/"Test"
  // session). Without this exclusion any of them can become the root
  // reference by mistake, returning the worktree path instead of the real repo.
  const pure = sorted.filter(
    (terminal) =>
      !terminal.worktreeAgentId &&
      !terminal.gsdSyncViewer &&
      !terminal.ephemeralConflictAgent &&
      !terminal.ephemeralUtility,
  )
  for (const terminal of pure) {
    const cwd = resolveTerminalCwd(terminal)
    if (cwd) return cwd
  }

  for (const terminal of sorted) {
    const cwd = resolveTerminalCwd(terminal)
    const derived = cwd && deriveRepoRootFromWorktreeCwd(cwd)
    if (derived) return derived
  }
  return ''
}
