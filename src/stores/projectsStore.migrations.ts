import { nanoid } from 'nanoid'

import { normalizeEnabledFeatures } from '../lib/features'
import { normalizeAppIconTheme } from '../lib/themeIcons'
import { normalizeTodoTags, normalizeTodoTitle } from '../lib/todos'
import {
  DEFAULT_PREFERENCES,
  EMPTY_PROJECTS_FILE,
  type Group,
  GROUP_COLORS,
  type Preferences,
  type Project,
  type ProjectsFile,
  type TodoItem,
  type WorkspaceContainer,
  type WorkspaceRecentTab,
  type WorkspaceTab,
} from '../lib/types'
import {
  captureWorkspaceSnapshot,
  cloneWorkspaceSnapshot,
  MAX_WORKSPACE_TABS,
  sanitizeWorkspaceSnapshot,
} from '../lib/workspaceNavigation'
import {
  clampSpawnConcurrency,
  clampUiZoom,
  MAX_RECENT_PROJECT_TABS,
} from './projectsStore.constants'

type LegacyPreferences = Partial<Preferences> & { showGitControl?: boolean }

function normalizeStoredAccent(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== 'string') return fallback
  return /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) ? value : fallback
}

function normalizeStoredAccents(file: ProjectsFile): ProjectsFile {
  const normalizeTab = (tab: WorkspaceTab): WorkspaceTab => ({
    ...tab,
    color: normalizeStoredAccent(tab.color),
  })

  return {
    ...file,
    groups: file.groups.map((group) => ({
      ...group,
      color: normalizeStoredAccent(group.color, GROUP_COLORS[0])!,
    })),
    projects: file.projects.map((project) => ({
      ...project,
      color: normalizeStoredAccent(project.color),
    })),
    workspace: {
      ...file.workspace,
      tabs: file.workspace.tabs.map(normalizeTab),
      closedTabs: file.workspace.closedTabs?.map(normalizeTab),
    },
  }
}

export function normalizePreferences(raw: LegacyPreferences | undefined): Preferences {
  const preferences = {
    ...DEFAULT_PREFERENCES,
    ...(raw ?? {}),
  } as Preferences & { showGitControl?: boolean }
  delete preferences.showGitControl
  const rawResourcePolicy = raw?.resourcePolicy
  const resourcePolicy = {
    ...DEFAULT_PREFERENCES.resourcePolicy,
    ...(rawResourcePolicy ?? {}),
  }
  const memoryBudgetMb = Math.min(8192, Math.max(768, Math.round(resourcePolicy.memoryBudgetMb)))
  const warningThresholdMb = Math.min(
    memoryBudgetMb - 64,
    Math.max(512, Math.round(resourcePolicy.warningThresholdMb)),
  )
  const recoveryTargetMb = Math.min(
    warningThresholdMb - 64,
    Math.max(384, Math.round(resourcePolicy.recoveryTargetMb)),
  )
  const legacyAccountCreated =
    raw?.accountCreated ??
    Boolean(raw?.onboardingDone && raw?.displayName && raw.displayName.trim().length > 0)
  const rawWindowOpacity = Number(raw?.windowOpacity ?? 1)
  return {
    ...preferences,
    windowOpacity: Number.isFinite(rawWindowOpacity)
      ? Math.min(1, Math.max(0.6, rawWindowOpacity))
      : 1,

    enabledAgents: { ...DEFAULT_PREFERENCES.enabledAgents, ...preferences.enabledAgents },

    enabledFeatures: normalizeEnabledFeatures(raw),
    leftSidebarVisible: raw?.leftSidebarVisible ?? true,
    rightSidebarVisible: raw?.rightSidebarVisible ?? true,
    leftSidebarWidth: Math.min(380, Math.max(220, Math.round(raw?.leftSidebarWidth ?? 286))),
    rightSidebarWidth: Math.min(420, Math.max(260, Math.round(raw?.rightSidebarWidth ?? 300))),
    language: preferences.language === 'pt-BR' ? 'pt-BR' : 'en',
    visualStyle: raw?.visualStyle === 'clean' ? 'clean' : 'normal',
    motionPreference: raw?.motionPreference === 'reduced' ? 'reduced' : 'animated',
    accountCreated: legacyAccountCreated,
    topbarStyle: preferences.topbarStyle === 'three-areas' ? 'three-areas' : 'classic',
    gitControlPlacement: preferences.gitControlPlacement === 'right' ? 'right' : 'left',
    mcpDefaultScope: preferences.mcpDefaultScope === 'project' ? 'project' : 'global',
    mcpOnboardingSeen: Boolean(preferences.mcpOnboardingSeen),
    displayName: preferences.displayName.trim(),
    profileImageUrl: preferences.profileImageUrl.trim(),
    todoStoragePath: preferences.todoStoragePath.trim(),
    spotifyClientId: preferences.spotifyClientId.trim(),
    spotifyClientSecret: preferences.spotifyClientSecret.trim(),
    uiZoom: clampUiZoom(preferences.uiZoom),
    appIconTheme: normalizeAppIconTheme(preferences.appIconTheme),
    spawnConcurrency: clampSpawnConcurrency(preferences.spawnConcurrency),
    resourcePolicy: {
      // Automatic parking was removed. Keep the legacy shape for file
      // compatibility, but normalize every installation to monitoring only.
      mode: 'manual',
      automaticParkingOptIn: false,
      memoryBudgetMb,
      warningThresholdMb,
      recoveryTargetMb,
      hiddenAgentIdleMinutes: Math.min(
        240,
        Math.max(5, Math.round(resourcePolicy.hiddenAgentIdleMinutes)),
      ),
      hiddenShellIdleMinutes: Math.min(
        480,
        Math.max(5, Math.round(resourcePolicy.hiddenShellIdleMinutes)),
      ),
      spawnGraceSeconds: Math.min(900, Math.max(30, Math.round(resourcePolicy.spawnGraceSeconds))),
    },
  }
}

export function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: TodoItem[] = []
  for (const item of raw) {
    const id = typeof item?.id === 'string' ? item.id : ''
    const title = normalizeTodoTitle(item?.title)
    if (!id || !title || seen.has(id)) continue
    seen.add(id)
    result.push({
      id,
      title,
      completed: Boolean(item?.completed),
      tags: normalizeTodoTags(item?.tags),
      ...(typeof item?.projectId === 'string' && item.projectId
        ? { projectId: item.projectId }
        : {}),
    })
  }
  return [...result.filter((item) => !item.completed), ...result.filter((item) => item.completed)]
}

export function migrateWorkspaceNavigation(base: {
  workspace?: any
  projects: Project[]
  groups: Group[]
  activeProjectId: string | null
  preferences: Preferences
}) {
  const rawWorkspace = base.workspace ?? {}
  const containers = rawWorkspace.containers ?? []
  const currentSnapshot = sanitizeWorkspaceSnapshot(
    captureWorkspaceSnapshot({
      containers,
      activeProjectId: base.activeProjectId,
      activeGroupId: rawWorkspace.activeGroupId ?? null,
      focusedTerminalId: rawWorkspace.focusedTerminalId ?? null,
      preferences: base.preferences,
    }),
    base.projects,
  )

  if (Array.isArray(rawWorkspace.tabs)) {
    const tabs: WorkspaceTab[] = rawWorkspace.tabs
      .slice(0, MAX_WORKSPACE_TABS)
      .map((tab: WorkspaceTab) => ({
        ...tab,
        snapshot: sanitizeWorkspaceSnapshot(tab.snapshot ?? currentSnapshot, base.projects),
      }))
    const tabIds = new Set(tabs.map((tab) => tab.id))
    const history = (rawWorkspace.history ?? [])
      .filter((entry: any) => entry?.snapshot)
      .map((entry: any) => ({
        ...entry,
        snapshot: sanitizeWorkspaceSnapshot(entry.snapshot, base.projects),
      }))
      .slice(-50)
    return {
      ...rawWorkspace,
      containers: currentSnapshot.containers,
      tabs,
      closedTabs: Array.isArray(rawWorkspace.closedTabs)
        ? rawWorkspace.closedTabs
            .map((tab: WorkspaceTab) => ({
              ...tab,
              snapshot: sanitizeWorkspaceSnapshot(tab.snapshot ?? currentSnapshot, base.projects),
            }))
            .slice(0, MAX_WORKSPACE_TABS)
        : [],
      activeTabId: tabIds.has(rawWorkspace.activeTabId)
        ? rawWorkspace.activeTabId
        : (tabs[0]?.id ?? null),
      activeGroupId: rawWorkspace.activeGroupId ?? null,
      focusedTerminalId: rawWorkspace.focusedTerminalId ?? null,
      history,
      historyIndex: Math.min(rawWorkspace.historyIndex ?? history.length - 1, history.length - 1),
    }
  }

  const recentTabs: WorkspaceRecentTab[] =
    rawWorkspace.recentTabs ??
    (rawWorkspace.recentProjectIds ?? []).map((id: string) => ({ kind: 'project', id }))
  const now = Date.now()
  const tabs = recentTabs
    .map<WorkspaceTab | null>((recent, index) => {
      if (recent.kind === 'group') {
        const group = base.groups.find((item) => item.id === recent.id)
        if (!group) return null
        return {
          id: nanoid(),
          kind: 'group' as const,
          sourceId: group.id,
          label: group.name,
          color: group.color,
          iconUrl: group.iconUrl,
          snapshot: cloneWorkspaceSnapshot(currentSnapshot),
          createdAt: now + index,
          updatedAt: now + index,
        }
      }
      const project = base.projects.find((item) => item.id === recent.id)
      if (!project) return null
      const container = containers.find((item: WorkspaceContainer) => item.projectId === project.id)
      const snapshot = container
        ? {
            ...cloneWorkspaceSnapshot(currentSnapshot),
            containers: [{ ...container, paneIds: [...container.paneIds] }],
            activeProjectId: project.id,
            activeGroupId: null,
          }
        : currentSnapshot
      return {
        id: nanoid(),
        kind: 'project' as const,
        sourceId: project.id,
        label: project.name,
        color: project.color,
        iconUrl: project.iconUrl,
        snapshot,
        createdAt: now + index,
        updatedAt: now + index,
      }
    })
    .filter((tab): tab is WorkspaceTab => tab !== null)
    .slice(0, MAX_WORKSPACE_TABS)
  const activeTab = tabs.find((tab) => tab.sourceId === base.activeProjectId) ?? tabs[0] ?? null
  const history = activeTab
    ? [
        {
          id: nanoid(),
          tabId: activeTab.id,
          label: activeTab.label,
          snapshot: cloneWorkspaceSnapshot(currentSnapshot),
          visitedAt: now,
        },
      ]
    : []
  return {
    ...rawWorkspace,
    containers: currentSnapshot.containers,
    recentProjectIds: (rawWorkspace.recentProjectIds ?? []).slice(0, MAX_RECENT_PROJECT_TABS),
    recentTabs: recentTabs.slice(0, MAX_RECENT_PROJECT_TABS),
    tabs,
    closedTabs: [],
    activeTabId: activeTab?.id ?? null,
    activeGroupId: activeTab?.snapshot.activeGroupId ?? null,
    focusedTerminalId: activeTab?.snapshot.focusedTerminalId ?? null,
    history,
    historyIndex: history.length - 1,
  }
}

function migrateToV7(parsed: any): ProjectsFile {
  return normalizeStoredAccents({
    ...parsed,
    version: 7,
    projects: (parsed.projects ?? []).map((project: any) => ({
      ...project,
      gridLayoutHistory: project.gridLayoutHistory ?? [],
    })),
    groups: (parsed.groups ?? []).map((group: any) => ({
      ...group,
      gridLayoutHistory: group.gridLayoutHistory ?? [],
    })),
    preferences: {
      ...normalizePreferences(parsed.preferences),
      workspaceGridLayoutHistory: parsed.preferences?.workspaceGridLayoutHistory ?? [],
    },
  })
}

/** Migrates older files and normalizes restorable snapshots. */
export function migrate(parsed: any): ProjectsFile {
  if (parsed.version === 7) return migrateToV7(parsed)
  if (parsed.version === 6) return migrateToV7(parsed)

  const v5Result = parsed.version === 5 ? parsed : migrateToV5(parsed)

  // Migrate v5 -> v6: track worktrees whose cleanup did not finish.
  const v6Projects = (v5Result.projects ?? []).map((p: any) => ({
    ...p,
    orphanWorktrees: p.orphanWorktrees ?? [],
  }))

  return migrateToV7({
    ...v5Result,
    version: 6,
    projects: v6Projects,
    preferences: normalizePreferences(v5Result.preferences),
  })
}

function migrateToV5(parsed: any): any {
  let v4Result: any
  if (parsed.version === 2 || parsed.version === 3 || parsed.version === 4) {
    // backfill parentGroupId (v2.1) — grupos antigos viram raiz.
    const groups = (parsed.groups ?? []).map((g: any) => ({
      ...g,
      parentGroupId: g.parentGroupId ?? null,
    }))
    const preferences = normalizePreferences(parsed.preferences)
    const base = {
      ...EMPTY_PROJECTS_FILE,
      ...parsed,
      version: 6 as const,
      preferences,
      groups,
      ungroupedOrder: parsed.ungroupedOrder ?? [],
      todos: normalizeTodos(parsed.todos),
    }
    v4Result = {
      ...base,
      workspace: migrateWorkspaceNavigation({
        workspace: parsed.workspace,
        projects: base.projects,
        groups,
        activeProjectId: base.activeProjectId,
        preferences,
      }),
    }
  } else {
    // legacy v1 -> v4
    const oldProjects: any[] = parsed.projects ?? []
    const projects: Project[] = oldProjects.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      groupId: null,
      terminals: p.terminals ?? [],
      layoutMode: p.layoutMode ?? 'auto',
      collapsed: p.collapsed ?? false,
      createdAt: p.createdAt ?? Date.now(),
    }))

    const containers: WorkspaceContainer[] = oldProjects
      .filter((p) => Array.isArray(p.activeTerminalIds) && p.activeTerminalIds.length > 0)
      .map((p) => ({
        projectId: p.id,
        paneIds: p.activeTerminalIds,
        size: 0,
        internalLayout: p.layoutMode ?? 'auto',
        collapsed: false,
      }))

    v4Result = {
      version: 4,
      groups: [],
      ungroupedOrder: projects.map((p) => p.id),
      projects,
      todos: [],
      activeProjectId: parsed.activeProjectId ?? projects[0]?.id ?? null,
      workspace: migrateWorkspaceNavigation({
        workspace: {
          containers,
          recentProjectIds: containers.map((c) => c.projectId).slice(0, MAX_RECENT_PROJECT_TABS),
          recentTabs: containers
            .map((c) => ({ kind: 'project' as const, id: c.projectId }))
            .slice(0, MAX_RECENT_PROJECT_TABS),
        },
        projects,
        groups: [],
        activeProjectId: parsed.activeProjectId ?? projects[0]?.id ?? null,
        preferences: normalizePreferences(parsed.preferences),
      }),
      preferences: normalizePreferences(parsed.preferences),
      cliPaths: parsed.cliPaths ?? {},
    }
  }

  // Migrate v4 -> v5
  const projects = (v4Result.projects ?? []).map((p: any) => ({
    ...p,
    worktreeMode: p.worktreeMode ?? 'gitWorktree',
    validationCommands: p.validationCommands ?? [],
    gsdWatcherEnabled: p.gsdWatcherEnabled ?? false,
    conflictAgentProvider: p.conflictAgentProvider ?? 'claude',
  }))

  return {
    ...v4Result,
    version: 5,
    projects,
  }
}

export function collectGroupProjectIds(groupId: string, groups: Group[]): Set<string> {
  const result = new Set<string>()
  const queue = [groupId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    const g = groups.find((gr) => gr.id === cur)
    if (!g) continue
    for (const pid of g.projectIds) result.add(pid)
    for (const sg of groups) {
      if (sg.parentGroupId === cur) queue.push(sg.id)
    }
  }
  return result
}
