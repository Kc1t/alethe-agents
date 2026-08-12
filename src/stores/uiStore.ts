import { create } from 'zustand'

import { basename } from '../lib/paths'
import type {
  AntigravityUsage,
  ClaudeUsage,
  CodexUsage,
  MemoryStats,
  RuntimeSnapshot,
} from '../lib/tauri'
import type { AgentType } from '../lib/types'
import type { UpdateInfo } from '../lib/updater'

/** Ephemeral UI state. Persisted state belongs in `projectsStore`. */

type ModalKind =
  | 'newProject'
  | 'newGroup'
  | 'editGroup'
  | 'editProject'
  | 'newTerminal'
  | 'addContent'
  | 'newSubTab'
  | 'preferences'
  | 'findJump'
  | 'onboarding'
  | 'welcome'
  | 'layoutDesigner'
  | 'suspendGroup'
  | 'memoryAnalytics'
  | 'aiUsage'
  | 'themePicker'
  | 'profiles'
  | 'sync'
  | 'todoSettings'
  | 'topbarSettings'
  | 'updateAvailable'
  | 'whatsNew'
  | 'remoteControl'
  | 'confirmWorktreeCommit'
  | null

export type ActiveView = 'home' | 'workspace' | 'agentCanvas' | 'agentSandbox'
export type RightSidebarMode = 'todo' | 'markdown' | 'git' | 'gsdSync'

export type MemorySample = MemoryStats & {
  ts: number
}

export type InAppToast = {
  id: string
  title: string
  body: string
  createdAt: number
  /** Agent that originated the notification and determines its icon and color. */
  agent?: AgentType
}

const MAX_MEMORY_HISTORY = 720
const MAX_TOASTS = 4
const MAX_NOTIFICATIONS = 12

type UiState = {
  openModal: ModalKind
  modalContext: Record<string, unknown> | null
  showMainMenu: boolean
  ramMb: number | null
  memoryStats: MemoryStats | null
  runtimeSnapshot: RuntimeSnapshot | null
  memoryHistory: MemorySample[]
  claudeUsage: ClaudeUsage | null
  codexUsage: CodexUsage | null
  antigravityUsage: AntigravityUsage | null
  /** ID do terminal em focus mode (overlay fullscreen blur). null = sem focus. */
  focusedTerminalId: string | null
  /** Pulse that requests focus for a specific pane. */
  focusRequest: { terminalId: string; ts: number } | null
  activeTerminal: { projectId: string; terminalId: string } | null
  selectedPanes: { projectId: string; terminalId: string }[]
  /** View principal sendo exibida no main. */
  activeView: ActiveView
  /** Conteúdo contextual da sidebar direita. */
  rightSidebarMode: RightSidebarMode
  rightSidebarMarkdown: { path: string; title: string } | null
  /** POC do agent canvas: pasta escolhida + id do PTY do claude embutido. */
  agentCanvasSession: { folder: string; ptyId: string } | null
  /** Teto de gasto (USD) da sessão do canvas. null = sem teto. */
  agentCanvasBudgetUsd: number | null
  /** Ephemeral in-app notifications. */
  toasts: InAppToast[]
  /** Recent notification history used by Home. */
  notifications: InAppToast[]
  /** Update disponível (checado em silêncio no boot). null = atualizado/sem info. */
  updateInfo: UpdateInfo | null
  /** URL aberta no visualizador in-app (overlay com iframe). null = fechado. */
  linkViewerUrl: string | null
  /** Sessão-filha do GSD Sync aberta no feed de atividade somente-leitura
   *  (overlay próprio, sem terminal PTY nenhum). null = fechado. */
  gsdSyncActivityView: { worktreePath: string; sessionId: string; title: string } | null

  openModal_: (kind: Exclude<ModalKind, null>, context?: Record<string, unknown>) => void
  closeModal: () => void
  closeMainMenu: () => void
  toggleMainMenu: () => void
  setRamMb: (value: number | null) => void
  addMemorySample: (value: MemoryStats) => void
  setRuntimeSnapshot: (value: RuntimeSnapshot | null) => void
  clearMemoryHistory: () => void
  setClaudeUsage: (value: ClaudeUsage | null) => void
  setCodexUsage: (value: CodexUsage | null) => void
  setAntigravityUsage: (value: AntigravityUsage | null) => void
  setFocusedTerminal: (id: string | null) => void
  requestPaneFocus: (terminalId: string) => void
  setActiveTerminal: (projectId: string, terminalId: string) => void
  selectPane: (projectId: string, terminalId: string, extend: boolean) => void
  clearPaneSelection: () => void
  setActiveView: (v: ActiveView) => void
  toggleHome: () => void
  openMarkdownSidebar: (path: string, title?: string) => void
  showMarkdownSidebar: () => void
  showTodoSidebar: () => void
  showGitSidebar: () => void
  showGsdSyncSidebar: () => void
  setAgentCanvasSession: (session: { folder: string; ptyId: string } | null) => void
  setAgentCanvasBudget: (usd: number | null) => void
  pushToast: (toast: {
    title: string
    body: string
    agent?: AgentType
    /** Record in history without showing an ephemeral banner. */
    silent?: boolean
  }) => void
  dismissToast: (id: string) => void
  clearNotifications: () => void
  setUpdateInfo: (info: UpdateInfo | null) => void
  openLinkViewer: (url: string) => void
  closeLinkViewer: () => void
  setGsdSyncActivityView: (
    view: { worktreePath: string; sessionId: string; title: string } | null,
  ) => void
}

export const useUiStore = create<UiState>((set) => ({
  openModal: null,
  modalContext: null,
  showMainMenu: false,
  ramMb: null,
  memoryStats: null,
  runtimeSnapshot: null,
  memoryHistory: [],
  claudeUsage: null,
  codexUsage: null,
  antigravityUsage: null,
  focusedTerminalId: null,
  focusRequest: null,
  activeTerminal: null,
  selectedPanes: [],
  activeView: 'workspace',
  rightSidebarMode: 'todo',
  rightSidebarMarkdown: null,
  agentCanvasSession: null,
  agentCanvasBudgetUsd: null,
  toasts: [],
  notifications: [],
  updateInfo: null,
  linkViewerUrl: null,
  gsdSyncActivityView: null,

  openModal_: (kind, context) =>
    set({ openModal: kind, modalContext: context ?? null, showMainMenu: false }),
  closeModal: () => set({ openModal: null, modalContext: null }),
  closeMainMenu: () => set({ showMainMenu: false }),
  toggleMainMenu: () => set((s) => ({ showMainMenu: !s.showMainMenu })),
  setRamMb: (value) => set({ ramMb: value }),
  addMemorySample: (value) =>
    set((s) => ({
      ramMb: value.total_mb,
      memoryStats: value,
      memoryHistory: [...s.memoryHistory, { ...value, ts: Date.now() }].slice(-MAX_MEMORY_HISTORY),
    })),
  setRuntimeSnapshot: (value) => set({ runtimeSnapshot: value }),
  clearMemoryHistory: () => set({ memoryHistory: [] }),
  setClaudeUsage: (value) => set({ claudeUsage: value }),
  setCodexUsage: (value) => set({ codexUsage: value }),
  setAntigravityUsage: (value) => set({ antigravityUsage: value }),
  setFocusedTerminal: (id) => set({ focusedTerminalId: id }),
  requestPaneFocus: (terminalId) => set({ focusRequest: { terminalId, ts: Date.now() } }),
  setActiveTerminal: (projectId, terminalId) => set({ activeTerminal: { projectId, terminalId } }),
  selectPane: (projectId, terminalId, extend) =>
    set((state) => {
      if (!extend) return { selectedPanes: [{ projectId, terminalId }] }
      const exists = state.selectedPanes.some(
        (pane) => pane.projectId === projectId && pane.terminalId === terminalId,
      )
      return {
        selectedPanes: exists
          ? state.selectedPanes.filter(
              (pane) => !(pane.projectId === projectId && pane.terminalId === terminalId),
            )
          : [...state.selectedPanes, { projectId, terminalId }],
      }
    }),
  clearPaneSelection: () => set({ selectedPanes: [] }),
  setActiveView: (v) => set((s) => (s.activeView === v ? s : { activeView: v })),
  toggleHome: () => set((s) => ({ activeView: s.activeView === 'home' ? 'workspace' : 'home' })),
  openMarkdownSidebar: (path, title) =>
    set({
      rightSidebarMode: 'markdown',
      rightSidebarMarkdown: { path, title: title || basename(path) || path },
    }),
  showMarkdownSidebar: () => set({ rightSidebarMode: 'markdown' }),
  showTodoSidebar: () => set({ rightSidebarMode: 'todo', rightSidebarMarkdown: null }),
  showGitSidebar: () => set({ rightSidebarMode: 'git' }),
  showGsdSyncSidebar: () => set({ rightSidebarMode: 'gsdSync' }),
  setAgentCanvasSession: (session) => set({ agentCanvasSession: session }),
  setAgentCanvasBudget: (usd) => set({ agentCanvasBudgetUsd: usd }),
  pushToast: ({ title, body, agent, silent }) =>
    set((s) => {
      const entry: InAppToast = {
        id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
        title,
        body,
        createdAt: Date.now(),
        agent,
      }
      const notifications = [entry, ...s.notifications].slice(0, MAX_NOTIFICATIONS)
      if (silent) return { notifications }
      const toasts = [...s.toasts, entry].slice(-MAX_TOASTS)
      return { toasts, notifications }
    }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((toast) => toast.id !== id) })),
  clearNotifications: () => set({ notifications: [] }),
  setUpdateInfo: (info) => set({ updateInfo: info }),
  openLinkViewer: (url) => set({ linkViewerUrl: url }),
  closeLinkViewer: () => set({ linkViewerUrl: null }),
  setGsdSyncActivityView: (view) => set({ gsdSyncActivityView: view }),
}))
