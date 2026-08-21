import { create } from 'zustand'

import {
  addMarkdownSidebarHistoryEntry,
  readMarkdownSidebarHistory,
  writeMarkdownSidebarHistory,
} from '../lib/markdownSidebarHistory'
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
  | 'addBrowser'
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
  | 'audit'
  | 'recentChats'
  | 'handoff'
  | 'mcpManager'
  | 'mcpIntro'
  | null

export type ActiveView = 'home' | 'workspace' | 'agentCanvas' | 'agentSandbox'
export type RightSidebarMode = 'todo' | 'markdown' | 'git' | 'gsdSync' | 'mcp'
export type MarkdownSidebarTab = { path: string; title: string }

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
  /** Offers next steps. A toast carrying any waits longer before dismissing itself. */
  actions?: { label: string; run: () => void; quiet?: boolean }[]
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

  focusedTerminalId: string | null
  /**
   * Panes of workspace tabs that stay mounted while hidden. They keep streaming so switching
   * back to their tab needs no resync — see WorkspaceView's keep-alive.
   */
  keptAlivePaneIds: string[]
  /**
   * Panes of every mounted workspace tab, streaming or not. They are one switch away from being
   * looked at, so the resource supervisor must not suspend them for being idle.
   */
  mountedPaneIds: string[]
  /** Pulse that requests focus for a specific pane. */
  focusRequest: { terminalId: string; ts: number } | null
  activeTerminal: { projectId: string; terminalId: string } | null
  selectedPanes: { projectId: string; terminalId: string }[]
  /** View principal sendo exibida no main. */
  activeView: ActiveView

  rightSidebarMode: RightSidebarMode
  rightSidebarMarkdown: { path: string; title: string } | null
  rightSidebarMarkdownTabs: MarkdownSidebarTab[]

  agentCanvasSession: { folder: string; ptyId: string } | null

  agentCanvasBudgetUsd: number | null
  /** Ephemeral in-app notifications. */
  toasts: InAppToast[]
  /** Recent notification history used by Home. */
  notifications: InAppToast[]

  updateInfo: UpdateInfo | null
  /** URL aberta no visualizador in-app (overlay com iframe). null = fechado. */
  linkViewerUrl: string | null
  /** GSD Sync child session open in the read-only activity feed (its own
   *  overlay, no PTY terminal involved). null = closed. */
  gsdSyncActivityView: { worktreePath: string; sessionId: string; title: string } | null

  openModal_: (kind: Exclude<ModalKind, null>, context?: Record<string, unknown>) => void
  closeModal: () => void
  closeMainMenu: () => void
  toggleMainMenu: () => void
  setKeptAlivePanes: (ids: string[]) => void
  setMountedPanes: (ids: string[]) => void
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
  closeMarkdownSidebarTab: (path: string) => void
  restoreMarkdownSidebarHistory: () => void
  showMarkdownSidebar: () => void
  showTodoSidebar: () => void
  showGitSidebar: () => void
  showGsdSyncSidebar: () => void
  showMcpSidebar: () => void
  setAgentCanvasSession: (session: { folder: string; ptyId: string } | null) => void
  setAgentCanvasBudget: (usd: number | null) => void
  pushToast: (toast: {
    title: string
    body: string
    agent?: AgentType
    actions?: { label: string; run: () => void; quiet?: boolean }[]
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
  keptAlivePaneIds: [],
  mountedPaneIds: [],
  focusRequest: null,
  activeTerminal: null,
  selectedPanes: [],
  activeView: 'workspace',
  rightSidebarMode: 'todo',
  rightSidebarMarkdown: null,
  rightSidebarMarkdownTabs: [],
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
  setKeptAlivePanes: (ids) =>
    set((state) => {
      const unchanged =
        state.keptAlivePaneIds.length === ids.length &&
        state.keptAlivePaneIds.every((id, index) => id === ids[index])
      return unchanged ? state : { keptAlivePaneIds: ids }
    }),
  setMountedPanes: (ids) =>
    set((state) => {
      const unchanged =
        state.mountedPaneIds.length === ids.length &&
        state.mountedPaneIds.every((id, index) => id === ids[index])
      return unchanged ? state : { mountedPaneIds: ids }
    }),
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
    set((state) => {
      const tab = { path, title: title || basename(path) || path }
      const tabs = addMarkdownSidebarHistoryEntry(state.rightSidebarMarkdownTabs, tab)
      if (tabs !== state.rightSidebarMarkdownTabs) {
        writeMarkdownSidebarHistory(tabs, tab.path)
      }
      return {
        rightSidebarMode: 'markdown',
        rightSidebarMarkdown: tab,
        rightSidebarMarkdownTabs: tabs,
      }
    }),
  closeMarkdownSidebarTab: (path) =>
    set((state) => {
      const tabs = state.rightSidebarMarkdownTabs.filter((entry) => entry.path !== path)
      if (state.rightSidebarMarkdown?.path !== path) {
        writeMarkdownSidebarHistory(tabs, state.rightSidebarMarkdown?.path ?? null)
        return { rightSidebarMarkdownTabs: tabs }
      }
      const next = tabs[tabs.length - 1] ?? null
      writeMarkdownSidebarHistory(tabs, next?.path ?? null)
      return {
        rightSidebarMarkdownTabs: tabs,
        rightSidebarMarkdown: next,
        rightSidebarMode: next ? 'markdown' : 'todo',
      }
    }),
  restoreMarkdownSidebarHistory: () =>
    set(() => {
      const history = readMarkdownSidebarHistory()
      const active = history.tabs.find((tab) => tab.path === history.activePath) ?? null
      return {
        rightSidebarMarkdownTabs: history.tabs,
        rightSidebarMarkdown: active,
      }
    }),
  showMarkdownSidebar: () => set({ rightSidebarMode: 'markdown' }),
  showTodoSidebar: () => set({ rightSidebarMode: 'todo' }),
  showGitSidebar: () => set({ rightSidebarMode: 'git' }),
  showGsdSyncSidebar: () => set({ rightSidebarMode: 'gsdSync' }),
  showMcpSidebar: () => set({ rightSidebarMode: 'mcp' }),
  setAgentCanvasSession: (session) => set({ agentCanvasSession: session }),
  setAgentCanvasBudget: (usd) => set({ agentCanvasBudgetUsd: usd }),
  pushToast: ({ title, body, agent, actions, silent }) =>
    set((s) => {
      const entry: InAppToast = {
        id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
        title,
        body,
        actions,
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
