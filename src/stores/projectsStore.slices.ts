/** Store action slices. Each slice receives the shared mutator context. */

import { nanoid } from 'nanoid'
import type { StoreApi } from 'zustand'

import { customAgentIconComponent } from '../components/icons/customAgentIcons'
import { syncCustomAgentProviders } from '../lib/agentProviders'
import { sanitizeCustomAgents } from '../lib/customAgents'
import { removeCustomAgentIconAsset } from '../lib/customAgentIconAssets'
import { resolveTerminalCwd, touchTerminalUsage } from '../lib/terminalFactory'
import { cleanupPtys } from '../lib/terminalLifecycle'
import type {
  CustomAgentDefinition,
  Project,
  SubTab,
  Terminal,
  WorkspaceContainer,
} from '../lib/types'
import type { ProjectsState } from './projectsStore'
import { clampUiZoom } from './projectsStore.constants'

/** Mutators do closure do store, injetados nas slices. */
export type SliceCtx = {
  set: StoreApi<ProjectsState>['setState']
  get: () => ProjectsState
  update: (mutator: (state: ProjectsState) => Partial<ProjectsState> | void) => void
  updateProject: (projectId: string, fn: (p: Project) => Project) => void
  updateTerminal: (projectId: string, terminalId: string, fn: (t: Terminal) => Terminal) => void
  updateSubTab: (
    projectId: string,
    terminalId: string,
    tabId: string,
    fn: (s: SubTab) => SubTab,
  ) => void
  updateContainer: (projectId: string, fn: (c: WorkspaceContainer) => WorkspaceContainer) => void
}

type SubTabsSlice = Pick<
  ProjectsState,
  | 'createSubTab'
  | 'closeSubTab'
  | 'setActiveTab'
  | 'setSubTabPtyId'
  | 'setSubTabCwd'
  | 'setSubTabCompletionUnread'
  | 'setSubTabSessionId'
  | 'setSubTabName'
  | 'setSubTabInitialInput'
  | 'setSubTabHandoff'
>

export function createSubTabsSlice({ updateTerminal, updateSubTab }: SliceCtx): SubTabsSlice {
  return {
    createSubTab: (projectId, terminalId, args) => {
      const now = Date.now()
      let tab: SubTab = {
        id: nanoid(),
        type: args.type,
        name: args.name ?? args.type,
        cwd: args.cwd,
        lastUsedAt: now,
        ptyId: null,
        extraArgs: args.extraArgs,
        handoff: args.handoff,
        runtimeProfile: args.runtimeProfile,
      }
      updateTerminal(projectId, terminalId, (t) => ({
        ...t,
        lastUsedAt: now,
        tabs: [
          ...t.tabs,
          (tab = {
            ...tab,
            cwd: args.cwd.trim() || resolveTerminalCwd(t),
          }),
        ],
        activeTabId: tab.id,
      }))
      return tab
    },

    closeSubTab: (projectId, terminalId, tabId) =>
      updateTerminal(projectId, terminalId, (t) => {
        const closingTab = t.tabs.find((s) => s.id === tabId)
        if (closingTab?.ptyId) cleanupPtys([closingTab.ptyId])
        const closingIndex = t.tabs.findIndex((tab) => tab.id === tabId)
        const remaining = t.tabs.filter((s) => s.id !== tabId)
        if (remaining.length === 0) return t
        const adjacentTab =
          closingIndex >= 0
            ? (t.tabs[closingIndex + 1] ?? t.tabs[closingIndex - 1])
            : undefined
        const activeTabId =
          t.activeTabId === tabId
            ? (adjacentTab?.id ?? remaining[0].id)
            : (remaining.some((tab) => tab.id === t.activeTabId) ? t.activeTabId : remaining[0].id)
        const next = { ...t, tabs: remaining, activeTabId }
        return activeTabId ? touchTerminalUsage(next, activeTabId) : next
      }),

    setActiveTab: (projectId, terminalId, tabId) =>
      updateTerminal(projectId, terminalId, (t) => {
        if (!t.tabs.some((tab) => tab.id === tabId)) return t
        const now = Date.now()
        return {
          ...t,
          lastUsedAt: now,
          activeTabId: tabId,
          tabs: t.tabs.map((tab) =>
            tab.id === tabId ? { ...tab, completionUnread: false, lastUsedAt: now } : tab,
          ),
        }
      }),

    setSubTabPtyId: (projectId, terminalId, tabId, ptyId) =>
      updateSubTab(projectId, terminalId, tabId, (s) => ({ ...s, ptyId })),

    setSubTabCwd: (projectId, terminalId, tabId, cwd) =>
      updateSubTab(projectId, terminalId, tabId, (s) => ({ ...s, cwd })),

    setSubTabCompletionUnread: (projectId, terminalId, tabId, unread) =>
      updateSubTab(projectId, terminalId, tabId, (s) => ({
        ...s,
        completionUnread: unread,
      })),

    setSubTabSessionId: (projectId, terminalId, tabId, sessionId) =>
      updateSubTab(projectId, terminalId, tabId, (s) => ({ ...s, sessionId })),

    setSubTabName: (projectId, terminalId, tabId, name) =>
      updateSubTab(projectId, terminalId, tabId, (s) => ({
        ...s,
        name: name.trim() || s.type,
      })),

    setSubTabInitialInput: (projectId, terminalId, tabId, initialInput) =>
      updateSubTab(projectId, terminalId, tabId, (s) => ({ ...s, initialInput })),

    setSubTabHandoff: (projectId, terminalId, tabId, handoff) =>
      updateSubTab(projectId, terminalId, tabId, (s) => ({ ...s, handoff })),
  }
}

type PreferencesSlice = Pick<
  ProjectsState,
  | 'setLanguage'
  | 'setUiTheme'
  | 'setUiZoom'
  | 'setTerminalTheme'
  | 'setAgentEnabled'
  | 'setOnboardingDone'
  | 'setPreferences'
  | 'setCliPath'
  | 'addCustomAgent'
  | 'updateCustomAgent'
  | 'removeCustomAgent'
>

export function syncCustomAgentsFromState(customAgents: readonly CustomAgentDefinition[]): void {
  syncCustomAgentProviders(customAgents, (definition) =>
    customAgentIconComponent(definition.iconSpec ?? definition.icon ?? 'bot'),
  )
}

export function createPreferencesSlice({ update }: SliceCtx): PreferencesSlice {
  return {
    setLanguage: (language) =>
      update((state) => ({ preferences: { ...state.preferences, language } })),

    setUiTheme: (theme) =>
      update((state) => ({ preferences: { ...state.preferences, uiTheme: theme } })),

    setUiZoom: (zoom) =>
      update((state) => {
        const uiZoom = clampUiZoom(zoom)
        if (state.preferences.uiZoom === uiZoom) return
        return { preferences: { ...state.preferences, uiZoom } }
      }),

    setTerminalTheme: (theme) =>
      update((state) => ({ preferences: { ...state.preferences, terminalTheme: theme } })),

    setAgentEnabled: (agent, enabled) =>
      update((state) => ({
        preferences: {
          ...state.preferences,
          enabledAgents: { ...state.preferences.enabledAgents, [agent]: enabled },
        },
      })),

    setOnboardingDone: (done) =>
      update((state) => ({ preferences: { ...state.preferences, onboardingDone: done } })),

    setPreferences: (patch) =>
      update((state) => {
        const preferences = { ...state.preferences, ...patch }
        if (patch.customAgents) {
          preferences.customAgents = sanitizeCustomAgents(patch.customAgents)
          syncCustomAgentsFromState(preferences.customAgents)
        }
        return { preferences }
      }),

    setCliPath: (agent, path) =>
      update((state) => {
        const cliPaths = { ...state.cliPaths }
        if (path === null) delete cliPaths[agent]
        else cliPaths[agent] = path
        return { cliPaths }
      }),

    addCustomAgent: (definition) =>
      update((state) => {
        const customAgents = sanitizeCustomAgents([...state.preferences.customAgents, definition])
        syncCustomAgentsFromState(customAgents)
        return { preferences: { ...state.preferences, customAgents } }
      }),

    updateCustomAgent: (id, patch) =>
      update((state) => {
        const next = state.preferences.customAgents.map((item) =>
          item.id === id ? { ...item, ...patch, id } : item,
        )
        const customAgents = sanitizeCustomAgents(next)
        syncCustomAgentsFromState(customAgents)
        return { preferences: { ...state.preferences, customAgents } }
      }),

    removeCustomAgent: (id) =>
      update((state) => {
        const customAgents = state.preferences.customAgents.filter((item) => item.id !== id)
        syncCustomAgentsFromState(customAgents)
        const enabledAgents = { ...state.preferences.enabledAgents }
        delete enabledAgents[id]
        const cliPaths = { ...state.cliPaths }
        delete cliPaths[id]
        void removeCustomAgentIconAsset(id).catch((error: unknown) => {
          console.error('Failed to remove custom agent icon asset', error)
        })
        return { preferences: { ...state.preferences, customAgents, enabledAgents }, cliPaths }
      }),
  }
}
