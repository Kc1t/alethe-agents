import { create } from 'zustand'
import { nanoid } from 'nanoid'

import {
  EMPTY_PROJECTS_FILE,
  type AgentRuntimeProfile,
  type AgentType,
  type GridLayout,
  type Group,
  type LayoutMode,
  type Locale,
  type OrphanWorktree,
  type Preferences,
  type Project,
  type ProjectsFile,
  type SubTab,
  type Terminal,
  type Theme,
  type TodoItem,
  type WorkspaceContainer,
  type WorkspaceTab,
  type WorkspaceRecentTab,
  type WorkspaceViewSnapshot,
} from '../lib/types'
import {
  MAX_WORKSPACE_TABS,
  captureWorkspaceSnapshot,
  cloneWorkspaceSnapshot,
  compositionLabel,
  pushWorkspaceHistory,
  replaceCurrentHistorySnapshot,
  sanitizeWorkspaceSnapshot,
} from '../lib/workspaceNavigation'
import {
  listProfiles,
  loadProjectsFile,
  saveProjectsFile,
  writeProjectMarker,
  type ProfileMeta,
  type ProfilesState,
} from '../lib/tauri'
import { setStorageNamespace } from '../lib/storageNamespace'
import { getProjectDefaultCwd, getProjectRepoRoot } from '../lib/terminalFactory'
import { migrate } from './projectsStore.migrations'
import { createGroupsSlice, createProjectsSlice } from './projectsStore.projectSlices'
import {
  createPreferencesSlice,
  createSubTabsSlice,
  createTodosSlice,
} from './projectsStore.slices'
import { createContainersSlice, createTerminalsSlice } from './projectsStore.terminalSlices'
import { createWorkspaceSlice } from './projectsStore.workspaceSlices'

// Re-export da API pública deste módulo consumida por outros arquivos.
export { getProjectDefaultCwd, getProjectRepoRoot }
export {
  MAX_RECENT_PROJECT_TABS,
  SPAWN_CONCURRENCY_LIMITS,
  UI_ZOOM_LIMITS,
} from './projectsStore.constants'

const SAVE_DEBOUNCE_MS = 500

export type ProjectsState = ProjectsFile & {
  activeProfileId: string
  profiles: ProfileMeta[]
  hydrated: boolean
  hydrate: () => Promise<void>
  /** true durante uma passada de handleCleanupWorktrees — bloqueia cliques duplos. */
  isCleaningOrphans: boolean

  // groups
  createGroup: (name: string, color?: string, parentGroupId?: string | null) => Group
  moveGroupToParent: (groupId: string, parentGroupId: string | null) => void
  renameGroup: (id: string, name: string) => void
  setGroupColor: (id: string, color: string) => void
  setGroupIconUrl: (id: string, iconUrl: string | undefined) => void
  toggleGroupCollapsed: (id: string) => void
  archiveGroup: (id: string) => void
  unarchiveGroup: (id: string) => void
  /** Suspende grupo: desabilita todos os terminais e fecha containers pra liberar RAM. */
  suspendGroup: (groupId: string) => void
  /** Reativa grupo suspenso: reabilita terminais (PTYs são respawnados pelo XTermView). */
  resumeGroup: (groupId: string) => void
  /** mode 'unassign' = projetos viram Solto; mode 'cascade' = apaga grupo + projetos. */
  deleteGroup: (id: string, mode: 'unassign' | 'cascade') => void
  reorderGroups: (fromIndex: number, toIndex: number) => void
  moveProjectToGroup: (projectId: string, groupId: string | null, atIndex?: number) => void
  reorderProjectInGroup: (projectId: string, fromIndex: number, toIndex: number) => void
  reorderUngrouped: (projectId: string, fromIndex: number, toIndex: number) => void

  // projects
  createProject: (args: {
    name: string
    mode?: Project['mode']
    color?: string
    iconUrl?: string
    groupId?: string | null
    defaultCwd?: string
    githubUrl?: string
    firstBootPending?: boolean
  }) => Project
  /** Cria um projeto novo a partir de um `Project` exportado (arquivo JSON
   *  escolhido pelo usuário) ou detectado em `.alethe/project.json` — gera um
   *  `id` novo (nunca reaproveita o original, pra não colidir com um projeto
   *  já existente) e zera `ptyId` de toda tab (não existe processo vivo pra
   *  reaproveitar), mas preserva `sessionId` — mesma lógica de "tenta resumir
   *  de propósito" do item de migração de worktree. */
  importProjectFromFile: (data: Project, groupId?: string | null) => Project
  renameProject: (id: string, name: string) => void
  archiveProject: (id: string) => void
  unarchiveProject: (id: string) => void
  setProjectColor: (id: string, color: string | undefined) => void
  setProjectIconUrl: (id: string, iconUrl: string | undefined) => void
  addMarkdownComment: (projectId: string, comment: Omit<import('../lib/types').MarkdownComment, 'id' | 'createdAt'>) => void
  removeMarkdownComment: (projectId: string, commentId: string) => void
  setWorktreeMode: (id: string, mode: 'gitWorktree' | 'localCopy') => void
  setValidationCommands: (id: string, commands: string[]) => void
  setGsdWatcherEnabled: (id: string, enabled: boolean) => void
  setConflictAgentProvider: (id: string, provider: AgentType) => void
  setConflictAgentModel: (id: string, model: string) => void
  setReviewAgentProvider: (id: string, provider: AgentType) => void
  setReviewAgentModel: (id: string, model: string) => void
  setGraphifyEnabled: (id: string, enabled: boolean) => void
  setAutoWorktree: (id: string, enabled: boolean) => void
  setMergePostAction: (id: string, action: 'relocateToNewBranch' | 'closeTerminal') => void
  /** Migra terminais existentes (sem `worktreeAgentId`) do projeto pra worktrees
   *  isoladas — ação explícita via botão dedicado, nunca automática (ver
   *  `setAutoWorktree`). Suspende os PTYs antigos em vez de matar. */
  /** `gsdWatcherEnabledOverride`: valor ainda pendente (não salvo) da tela de
   *  edição do projeto — o botão de migrar fica na mesma aba do checkbox GSD
   *  e roda ANTES do "Salvar", então sem isso a migração lia o valor antigo
   *  do store mesmo com a caixinha marcada na tela, e nunca instalava o
   *  plugin GSD na worktree nova. */
  migrateProjectTerminalsToWorktrees: (
    projectId: string,
    gsdWatcherEnabledOverride?: boolean,
  ) => Promise<void>
  /** Upsert por `path` — sobrescreve a entrada existente (limpando `adminLockReason`
   * obsoleto se a nova falha não for lock administrativo) ou adiciona uma nova. */
  addOrphanWorktree: (projectId: string, entry: OrphanWorktree) => void
  removeOrphanWorktree: (projectId: string, path: string) => void
  setCleaningOrphans: (value: boolean) => void
  /** Processa `project.orphanWorktrees` sequencial-com-continuação: cada item
   * falho não interrompe os demais. Aplica a transição requiresRawDeletion →
   * pruneOnly, classifica lock administrativo vs falha de SO, e retorna a
   * taxonomia quadridimensional (X limpos / Y parciais / W aguardando unlock /
   * Z falhas) — a UI usa isso pro toast de resumo. */
  cleanupOrphanWorktrees: (projectId: string) => Promise<{
    cleaned: number
    partial: number
    awaitingUnlock: number
    failed: number
  }>

  deleteProject: (id: string) => void
  setActiveProject: (id: string | null) => void
  setActiveProjectOnly: (id: string | null) => void
  rememberWorkspaceGroupTab: (groupId: string) => void
  closeWorkspaceTab: (tab: WorkspaceRecentTab) => void
  openGroupScope: (groupId: string, mode?: 'append' | 'only') => void
  openProjectWorkspace: (projectId: string) => void
  addProjectToWorkspace: (projectId: string) => void
  openGroupWorkspace: (groupId: string, mode?: 'append' | 'only') => void
  openTerminalWorkspace: (projectId: string, terminalId: string) => void
  addTerminalToWorkspace: (projectId: string, terminalId: string) => void
  addWorkspaceTabToCurrent: (tabId: string) => void
  focusWorkspaceTerminal: (projectId: string, terminalId: string) => void
  activateWorkspaceTab: (tabId: string) => void
  toggleWorkspaceTabPinned: (tabId: string) => void
  closeSavedWorkspaceTab: (tabId: string) => void
  reopenClosedWorkspaceTab: () => void
  navigateWorkspaceHistory: (direction: -1 | 1) => void
  toggleProjectCollapsed: (id: string) => void
  setLayoutMode: (projectId: string, layout: LayoutMode) => void
  setProjectGridLayout: (projectId: string, layout: GridLayout) => void
  setGroupLayoutMode: (groupId: string, mode: LayoutMode) => void
  setGroupGridLayout: (groupId: string, layout: GridLayout) => void
  setWorkspaceGridLayout: (layout: GridLayout | null) => void

  // todos globais
  createTodo: (title: string, tags?: string[], projectId?: string) => TodoItem | null
  renameTodo: (id: string, title: string) => void
  updateTodoTags: (id: string, tags: string[]) => void
  setTodoProject: (id: string, projectId: string | null) => void
  resetTodosToDefault: () => void
  toggleTodo: (id: string) => void
  deleteTodo: (id: string) => void
  reorderTodo: (draggedId: string, targetId: string) => void

  // terminals
  createTerminal: (
    projectId: string,
    args: {
      name: string
      cwd: string
      firstTab: {
        type: AgentType
        cwd: string
        extraArgs?: string[]
        initialInput?: string
        runtimeProfile?: AgentRuntimeProfile
      }
      worktreeAgentId?: string
      gsdSyncViewer?: boolean
    },
  ) => Terminal
  /**
   * RFC-003 — como createTerminal, mas com isolamento automático: se o projeto
   * tem `autoWorktree` e o agente não é shell, provisiona uma worktree e o
   * terminal nasce dentro dela (com `worktreeAgentId` p/ o botão Integrar).
   * Falha do provision NUNCA bloqueia: cai no terminal normal.
   */
  createAgentTerminal: (
    projectId: string,
    args: {
      name: string
      cwd: string
      firstTab: {
        type: AgentType
        cwd: string
        extraArgs?: string[]
        initialInput?: string
        runtimeProfile?: AgentRuntimeProfile
      }
    },
  ) => Promise<Terminal>
  /** Cria um pane viewer (markdown/arquivo) e adiciona ao grid do projeto. */
  createFilePane: (projectId: string, args: { filePath: string; name?: string }) => Terminal
  /** Cria um pane de diff (Git) e adiciona ao grid do projeto. */
  createDiffPane: (
    projectId: string,
    args: { filePath: string; repoRoot: string; staged: boolean; name?: string },
  ) => Terminal
  /** Cria um pane web persistente e adiciona ao grid do projeto. */
  createWebPane: (projectId: string, args: { url: string; name?: string }) => Terminal
  createGraphifyPane: (projectId: string, cwd: string) => Terminal
  renameTerminal: (projectId: string, terminalId: string, name: string) => void
  /** Backfill: liga `Terminal.gsdSyncViewer` num terminal já existente (criado
   *  antes desse campo existir) sem precisar de migração manual de dado. */
  markGsdSyncViewer: (projectId: string, terminalId: string) => void
  deleteTerminal: (projectId: string, terminalId: string) => void
  /** Mesmo teardown de `deleteTerminal`, mas para terminais de agente isolado
   *  (`worktreeAgentId`): mata a árvore de processo e remove a worktree em
   *  disco ANTES de apagar a entrada do terminal. Terminais sem
   *  `worktreeAgentId` caem direto no `deleteTerminal` normal. */
  deleteTerminalWithWorktreeCleanup: (projectId: string, terminalId: string) => Promise<void>
  /** Mata a árvore de processos do terminal + fecha o pane, mas MANTÉM o atalho na
   *  sidebar (descarta sessão/scrollback). O atalho reabre do zero ao ser clicado. */
  killTerminal: (projectId: string, terminalId: string) => void
  moveTerminal: (fromProjectId: string, terminalId: string, toProjectId: string) => void
  setTerminalDisabled: (projectId: string, terminalId: string, disabled: boolean) => void
  /** Desabilita/reabilita todos os terminais de um projeto e fecha/reabre o container. */
  setProjectDisabled: (projectId: string, disabled: boolean) => void
  setLaneVisible: (projectId: string, terminalId: string, visible: boolean | null) => void
  /** Marca um terminal como recentemente usado (atualiza lastUsedAt). */
  markTerminalUsed: (projectId: string, terminalId: string) => void

  // workspace containers (substituem activeTerminalIds)
  /** Abre o container do projeto (cria se não existir) e adiciona pane se não estiver lá. */
  openPane: (projectId: string, terminalId: string) => void
  /** Remove pane do container; se vazio, fecha o container inteiro. */
  closePane: (projectId: string, terminalId: string) => void
  /** Toggle: adiciona se não tem, remove se tem. */
  togglePane: (projectId: string, terminalId: string) => void
  /** Garante que o container do projeto exista com TODOS os panes do projeto. */
  openContainerWithAllPanes: (projectId: string) => void
  /** Remove container inteiro da workspace. */
  closeContainer: (projectId: string) => void
  /** Fecha todos os containers que NÃO são o projectId fornecido. */
  closeOtherContainers: (keepProjectId: string) => void
  reorderContainers: (fromIndex: number, toIndex: number) => void
  reorderPaneInContainer: (projectId: string, fromIndex: number, toIndex: number) => void
  groupPanes: (projectId: string, paneIds: string[]) => void
  ungroupPanes: (projectId: string, groupId: string) => void
  setContainerCollapsed: (projectId: string, collapsed: boolean) => void
  setContainerInternalLayout: (projectId: string, layout: LayoutMode) => void
  setFullscreenContainer: (projectId: string | null) => void
  setFullscreenPane: (terminalId: string | null) => void
  setWorkspaceFlat: (flat: boolean) => void

  // sub-tabs
  createSubTab: (
    projectId: string,
    terminalId: string,
    args: {
      type: AgentType
      cwd: string
      name?: string
      extraArgs?: string[]
      runtimeProfile?: AgentRuntimeProfile
    },
  ) => SubTab
  closeSubTab: (projectId: string, terminalId: string, tabId: string) => void
  setActiveTab: (projectId: string, terminalId: string, tabId: string) => void
  setSubTabPtyId: (
    projectId: string,
    terminalId: string,
    tabId: string,
    ptyId: string | null,
  ) => void
  setSubTabCwd: (projectId: string, terminalId: string, tabId: string, cwd: string) => void
  setSubTabCompletionUnread: (
    projectId: string,
    terminalId: string,
    tabId: string,
    unread: boolean,
  ) => void
  setSubTabSessionId: (
    projectId: string,
    terminalId: string,
    tabId: string,
    sessionId: string | undefined,
  ) => void
  setSubTabInitialInput: (
    projectId: string,
    terminalId: string,
    tabId: string,
    initialInput: string | undefined,
  ) => void

  // preferences / cli
  setLanguage: (language: Locale) => void
  setUiTheme: (theme: Theme) => void
  setUiZoom: (zoom: number) => void
  setTerminalTheme: (theme: Theme | null) => void
  setAgentEnabled: (agent: AgentType, enabled: boolean) => void
  setOnboardingDone: (done: boolean) => void
  setPreferences: (patch: Partial<Preferences>) => void
  setCliPath: (agent: AgentType, path: string | null) => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingSave = false

// Espelho automático de cada projeto em `<repo>/.alethe/project.json` — feito
// de propósito num chokepoint só (`updateProject`, chamado por praticamente
// toda mutação de projeto/terminal/tab) em vez de espalhar chamadas manuais.
// Debounce por projectId (não um só global) pra não perder a escrita de um
// projeto enquanto outro está sendo editado rapidamente.
const MARKER_DEBOUNCE_MS = 1500
const markerTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleProjectMarkerWrite(projectId: string, getState: () => ProjectsState) {
  const existing = markerTimers.get(projectId)
  if (existing) clearTimeout(existing)
  markerTimers.set(
    projectId,
    setTimeout(() => {
      markerTimers.delete(projectId)
      const project = getState().projects.find((p) => p.id === projectId)
      if (!project) return
      const repoRoot = getProjectRepoRoot(project)
      if (!repoRoot) return
      void writeProjectMarker(repoRoot, JSON.stringify(project, null, 2)).catch((error) => {
        console.error(`[projectsStore] falha escrevendo .alethe/project.json de ${project.name}:`, error)
      })
    }, MARKER_DEBOUNCE_MS),
  )
}

// Sequência monotônica enviada a cada gravação (ver SAVE_MUTEX/LAST_WRITE_SEQUENCE
// em src-tauri/src/projects.rs) — garante last-write-wins mesmo se duas chamadas de
// save_projects chegarem fora de ordem no backend (reload concorrente, IPC atrasado).
let lastWriteSequence = Date.now()

function nextWriteSequence(): number {
  lastWriteSequence = Math.max(Date.now(), lastWriteSequence + 1)
  return lastWriteSequence
}

function scheduleSave(getState: () => ProjectsState) {
  if (!getState().hydrated) return
  pendingSave = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (!pendingSave) return
    pendingSave = false
    const state = getState()
    const payload: ProjectsFile = {
      version: 6,
      groups: state.groups,
      ungroupedOrder: state.ungroupedOrder,
      projects: state.projects,
      todos: state.todos,
      activeProjectId: state.activeProjectId,
      workspace: state.workspace,
      preferences: state.preferences,
      cliPaths: state.cliPaths,
    }
    void saveProjectsFile(JSON.stringify(payload, null, 2), nextWriteSequence())
  }, SAVE_DEBOUNCE_MS)
}

export const useProjectsStore = create<ProjectsState>((set, get) => {
  let suppressNavigationSync = false

  const update = (mutator: (state: ProjectsState) => Partial<ProjectsState> | void) => {
    let changed = false
    set((state) => {
      let result = mutator(state)
      if (!result || Object.keys(result).length === 0) return state
      const workspaceChanged = Boolean(result.workspace)
      const visualPreferencesChanged = Boolean(
        result.preferences &&
        (result.preferences.workspaceFlat !== state.preferences.workspaceFlat ||
          result.preferences.fullscreenContainerId !== state.preferences.fullscreenContainerId ||
          result.preferences.workspaceGridLayout !== state.preferences.workspaceGridLayout),
      )
      if (!suppressNavigationSync && (workspaceChanged || visualPreferencesChanged)) {
        const nextState = { ...state, ...result } as ProjectsState
        const activeTabId = nextState.workspace.activeTabId
        const activeTab = nextState.workspace.tabs.find((tab) => tab.id === activeTabId)
        if (activeTab) {
          const snapshot = captureWorkspaceSnapshot({
            containers: nextState.workspace.containers,
            activeProjectId: nextState.activeProjectId,
            activeGroupId: nextState.workspace.activeGroupId,
            focusedTerminalId: nextState.workspace.focusedTerminalId,
            preferences: nextState.preferences,
          })
          const now = Date.now()
          // Só preserva/atualiza a identidade de GRUPO da aba ativa se o grupo
          // vivo for o MESMO que ela já representa. Se o activeGroupId vivo for
          // OUTRO grupo (ex.: abrir/juntar outro grupo — inclusive pela sidebar —
          // enquanto esta aba está ativa), o conteúdo virou composição cross-grupo;
          // NUNCA renomeia a aba pro outro grupo. Sem essa guarda, a aba do grupo A
          // era reescrita como grupo B e clicar em "A" caía no "Y".
          const liveGroupId = snapshot.activeGroupId
          const keepsGroupIdentity =
            !!liveGroupId && (activeTab.kind !== 'group' || activeTab.sourceId === liveGroupId)
          const groupForTab = keepsGroupIdentity
            ? nextState.groups.find((g) => g.id === liveGroupId)
            : undefined
          const updatedTab: WorkspaceTab = groupForTab
            ? {
                ...activeTab,
                kind: 'group',
                sourceId: groupForTab.id,
                sourceProjectId: undefined,
                label: groupForTab.name,
                color: groupForTab.color,
                iconUrl: groupForTab.iconUrl,
                snapshot,
                updatedAt: now,
              }
            : {
                ...activeTab,
                kind: 'composition',
                sourceId: undefined,
                sourceProjectId: undefined,
                label: compositionLabel(snapshot, nextState.projects),
                snapshot,
                updatedAt: now,
              }
          const tabs = nextState.workspace.tabs.map((tab) =>
            tab.id === activeTab.id ? updatedTab : tab,
          )
          result = {
            ...result,
            workspace: {
              ...nextState.workspace,
              tabs,
              history: replaceCurrentHistorySnapshot(
                nextState.workspace.history,
                nextState.workspace.historyIndex,
                updatedTab,
              ),
            },
          }
        }
      }
      changed = true
      return result
    })
    if (changed) scheduleSave(get)
  }

  const navigationUpdate = (mutator: (state: ProjectsState) => Partial<ProjectsState> | void) => {
    suppressNavigationSync = true
    try {
      update(mutator)
    } finally {
      suppressNavigationSync = false
    }
  }

  const updateProject = (projectId: string, fn: (p: Project) => Project) => {
    update((state) => ({
      projects: state.projects.map((p) => (p.id === projectId ? fn(p) : p)),
    }))
    scheduleProjectMarkerWrite(projectId, get)
  }

  const updateTerminal = (projectId: string, terminalId: string, fn: (t: Terminal) => Terminal) =>
    updateProject(projectId, (p) => ({
      ...p,
      terminals: p.terminals.map((t) => (t.id === terminalId ? fn(t) : t)),
    }))

  const updateSubTab = (
    projectId: string,
    terminalId: string,
    tabId: string,
    fn: (s: SubTab) => SubTab,
  ) =>
    updateTerminal(projectId, terminalId, (t) => ({
      ...t,
      tabs: t.tabs.map((s) => (s.id === tabId ? fn(s) : s)),
    }))

  const updateContainer = (projectId: string, fn: (c: WorkspaceContainer) => WorkspaceContainer) =>
    update((state) => ({
      workspace: {
        ...state.workspace,
        containers: state.workspace.containers.map((c) => (c.projectId === projectId ? fn(c) : c)),
      },
    }))

  const makeSnapshot = (
    state: ProjectsState,
    containers: WorkspaceContainer[],
    activeProjectId: string | null,
    activeGroupId: string | null,
    focusedTerminalId: string | null = null,
    visual?: Partial<
      Pick<Preferences, 'workspaceFlat' | 'fullscreenContainerId' | 'workspaceGridLayout'>
    >,
  ): WorkspaceViewSnapshot =>
    captureWorkspaceSnapshot({
      containers,
      activeProjectId,
      activeGroupId,
      focusedTerminalId,
      preferences: { ...state.preferences, ...visual },
    })

  const applyTabNavigation = (
    state: ProjectsState,
    tab: WorkspaceTab,
    options?: { addTab?: boolean; pushHistory?: boolean },
  ): Partial<ProjectsState> => {
    const snapshot = sanitizeWorkspaceSnapshot(tab.snapshot, state.projects)
    let tabs = options?.addTab
      ? [...state.workspace.tabs.filter((item) => item.id !== tab.id), tab]
      : state.workspace.tabs
    let history = state.workspace.history
    let historyIndex = state.workspace.historyIndex
    if (tabs.length > MAX_WORKSPACE_TABS) {
      // Nunca evicta tabs fixadas; só cai no fallback se TODAS forem fixadas.
      const removable =
        tabs.find((item) => item.id !== tab.id && !item.pinned) ??
        tabs.find((item) => item.id !== tab.id)
      if (removable) {
        const currentHistoryId = history[historyIndex]?.id
        tabs = tabs.filter((item) => item.id !== removable.id)
        history = history.filter((entry) => entry.tabId !== removable.id)
        historyIndex = currentHistoryId
          ? history.findIndex((entry) => entry.id === currentHistoryId)
          : history.length - 1
      } else {
        tabs = tabs.slice(-MAX_WORKSPACE_TABS)
      }
    }
    const navigation =
      options?.pushHistory === false
        ? { history, historyIndex }
        : pushWorkspaceHistory(history, historyIndex, {
            id: nanoid(),
            tabId: tab.id,
            label: tab.label,
            snapshot,
            visitedAt: Date.now(),
          })
    return {
      activeProjectId: snapshot.activeProjectId,
      preferences: {
        ...state.preferences,
        workspaceFlat: snapshot.workspaceFlat,
        fullscreenContainerId: snapshot.fullscreenContainerId,
        workspaceGridLayout: snapshot.workspaceGridLayout,
      },
      workspace: {
        ...state.workspace,
        containers: cloneWorkspaceSnapshot(snapshot).containers,
        tabs,
        activeTabId: tab.id,
        activeGroupId: snapshot.activeGroupId,
        focusedTerminalId: snapshot.focusedTerminalId,
        history: navigation.history,
        historyIndex: navigation.historyIndex,
      },
    }
  }

  const appendSnapshotToActive = (
    state: ProjectsState,
    incomingSnapshot: WorkspaceViewSnapshot,
  ): Partial<ProjectsState> | undefined => {
    const activeTab = state.workspace.tabs.find((tab) => tab.id === state.workspace.activeTabId)
    if (!activeTab) return
    const incoming = sanitizeWorkspaceSnapshot(incomingSnapshot, state.projects)
    const containers = state.workspace.containers.map((container) => ({
      ...container,
      paneIds: [...container.paneIds],
    }))
    for (const added of incoming.containers) {
      const existing = containers.find((container) => container.projectId === added.projectId)
      if (existing) {
        existing.paneIds = [...new Set([...existing.paneIds, ...added.paneIds])]
      } else {
        containers.push({ ...added, paneIds: [...added.paneIds] })
      }
    }
    const snapshot = makeSnapshot(
      state,
      containers,
      incoming.activeProjectId ?? state.activeProjectId,
      null,
      incoming.focusedTerminalId,
      { workspaceGridLayout: undefined, workspaceFlat: false, fullscreenContainerId: null },
    )
    const updatedTab: WorkspaceTab = {
      ...activeTab,
      kind: 'composition',
      sourceId: undefined,
      sourceProjectId: undefined,
      label: compositionLabel(snapshot, state.projects),
      snapshot,
      updatedAt: Date.now(),
    }
    return {
      activeProjectId: snapshot.activeProjectId,
      preferences: {
        ...state.preferences,
        workspaceGridLayout: undefined,
        workspaceFlat: false,
        fullscreenContainerId: null,
      },
      workspace: {
        ...state.workspace,
        containers,
        activeGroupId: null,
        focusedTerminalId: snapshot.focusedTerminalId,
        tabs: state.workspace.tabs.map((tab) => (tab.id === updatedTab.id ? updatedTab : tab)),
        history: replaceCurrentHistorySnapshot(
          state.workspace.history,
          state.workspace.historyIndex,
          updatedTab,
        ),
      },
    }
  }

  // Contexto injetado nas slices extraídas. Os 4 últimos (helpers de navegação)
  // ficam no create() porque compartilham o flag `suppressNavigationSync` com
  // `update`; só as AÇÕES de workspace foram pra slice, chamando-os via ctx.
  const sliceCtx = {
    set,
    get,
    update,
    updateProject,
    updateTerminal,
    updateSubTab,
    updateContainer,
    navigationUpdate,
    makeSnapshot,
    applyTabNavigation,
    appendSnapshotToActive,
  }

  return {
    ...EMPTY_PROJECTS_FILE,
    activeProfileId: 'default',
    profiles: [],
    hydrated: false,
    isCleaningOrphans: false,

    hydrate: async () => {
      // A profile switch replaces the in-memory document. Never let a delayed
      // save from the previous profile write into the newly selected namespace.
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      pendingSave = false
      let profileState: ProfilesState = {
        active_profile_id: 'default',
        profiles: [],
      }
      try {
        profileState = await listProfiles()
        setStorageNamespace(profileState.active_profile_id)
      } catch (err) {
        console.error('Falha ao carregar profiles.json — usando default', err)
        setStorageNamespace('default')
      }

      try {
        const raw = await loadProjectsFile()
        if (!raw) {
          set({
            hydrated: true,
            activeProfileId: profileState.active_profile_id,
            profiles: profileState.profiles,
          })
          return
        }
        const parsed = JSON.parse(raw)
        const migrated = migrate(parsed)
        set({
          ...migrated,
          hydrated: true,
          activeProfileId: profileState.active_profile_id,
          profiles: profileState.profiles,
        })
      } catch (err) {
        console.error('Falha ao carregar projects.json — usando estado vazio', err)
        set({
          hydrated: true,
          activeProfileId: profileState.active_profile_id,
          profiles: profileState.profiles,
        })
      }
    },

    ...createGroupsSlice(sliceCtx),
    ...createProjectsSlice(sliceCtx),
    ...createWorkspaceSlice(sliceCtx),
    ...createTerminalsSlice(sliceCtx),
    ...createContainersSlice(sliceCtx),
    ...createTodosSlice(sliceCtx),
    ...createSubTabsSlice(sliceCtx),
    ...createPreferencesSlice(sliceCtx),
  }
})

/* ------------ selectors ------------ */

/** Map de project.id → Project. Ideal pra usar com useMemo ou como selector. */
export function selectProjectsById(state: ProjectsState): Map<string, Project> {
  return new Map(state.projects.map((p) => [p.id, p]))
}

/** Map de group.id → Group. */
export function selectGroupsById(state: ProjectsState): Map<string, Group> {
  return new Map(state.groups.map((g) => [g.id, g]))
}

export function selectActiveProject(state: ProjectsState): Project | null {
  if (!state.activeProjectId) return null
  return state.projects.find((p) => p.id === state.activeProjectId) ?? null
}

/** Container do projeto ativo, se existir. */
export function selectActiveContainer(state: ProjectsState): WorkspaceContainer | null {
  if (!state.activeProjectId) return null
  return state.workspace.containers.find((c) => c.projectId === state.activeProjectId) ?? null
}

export type RecentTerminalEntry = {
  projectId: string
  projectName: string
  projectColor: string | undefined
  terminal: Terminal
  lastUsedAt: number
}

/**
 * Retorna os N terminais mais recentemente usados (cross-projeto), ordenados
 * por lastUsedAt descendente. Terminais sem lastUsedAt caem pro final.
 */
export function selectRecentTerminals(n: number) {
  return (state: ProjectsState): RecentTerminalEntry[] => {
    const entries: RecentTerminalEntry[] = []
    for (const p of state.projects) {
      for (const t of p.terminals) {
        entries.push({
          projectId: p.id,
          projectName: p.name,
          projectColor: p.color,
          terminal: t,
          lastUsedAt: t.lastUsedAt ?? 0,
        })
      }
    }
    entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    return entries.slice(0, n)
  }
}
