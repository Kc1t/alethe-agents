import { useShallow } from 'zustand/react/shallow'

import type { Project } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'

export function useProjectNodeState(project: Project) {
  const visibleTerminals = project.terminals.filter((terminal) => !terminal.gsdSyncViewer)
  const runningCount = useTerminalsStore((state) =>
    visibleTerminals.reduce(
      (count, terminal) =>
        count +
        (terminal.tabs.some((tab) => tab.ptyId && state.byPtyId[tab.ptyId]?.status === 'working')
          ? 1
          : 0),
      0,
    ),
  )
  const focusedTerminalId = useUiStore((state) =>
    state.activeTerminal?.projectId === project.id ? state.activeTerminal.terminalId : undefined,
  )

  return {
    allDisabled:
      visibleTerminals.length > 0 && visibleTerminals.every((terminal) => terminal.disabled),
    expanded: !project.collapsed,
    focusedTerminalId,
    isEmpty: visibleTerminals.length === 0,
    runningCount,
    visibleTerminals,
  }
}

export function useSidebarData() {
  return useProjectsStore(
    useShallow((state) => ({
      activeProjectId: state.activeProjectId,
      containers: state.workspace.containers,
      groups: state.groups,
      preferences: state.preferences,
      projects: state.projects,
      showGitControl: state.preferences.enabledFeatures.git,
      ungroupedOrder: state.ungroupedOrder,
    })),
  )
}

/** Shared behavior contract for every visual ProjectSidebar variant. */
export function useSidebarActions() {
  return useProjectsStore(
    useShallow((state) => ({
      setActiveProject: state.setActiveProject,
      openGroupScope: state.openGroupScope,
      openProjectWorkspace: state.openProjectWorkspace,
      addProjectToWorkspace: state.addProjectToWorkspace,
      openGroupWorkspace: state.openGroupWorkspace,
      openTerminalWorkspace: state.openTerminalWorkspace,
      addTerminalToWorkspace: state.addTerminalToWorkspace,
      focusWorkspaceTerminal: state.focusWorkspaceTerminal,
      toggleProjectCollapsed: state.toggleProjectCollapsed,
      toggleGroupCollapsed: state.toggleGroupCollapsed,
      archiveGroup: state.archiveGroup,
      renameProject: state.renameProject,
      archiveProject: state.archiveProject,
      deleteProject: state.deleteProject,
      renameGroup: state.renameGroup,
      deleteGroup: state.deleteGroup,
      resumeGroup: state.resumeGroup,
      setProjectDisabled: state.setProjectDisabled,
      renameTerminal: state.renameTerminal,
      killTerminal: state.killTerminal,
      deleteTerminal: state.deleteTerminal,
      deleteTerminalWithWorktreeCleanup: state.deleteTerminalWithWorktreeCleanup,
      setTerminalDisabled: state.setTerminalDisabled,
      moveTerminal: state.moveTerminal,
      moveProjectToGroup: state.moveProjectToGroup,
      moveGroupToParent: state.moveGroupToParent,
      reorderProjectInGroup: state.reorderProjectInGroup,
      reorderUngrouped: state.reorderUngrouped,
      reorderGroups: state.reorderGroups,
      togglePane: state.togglePane,
      setLaneVisible: state.setLaneVisible,
      setTerminalRemoteExcluded: state.setTerminalRemoteExcluded,
      setSubTabCompletionUnread: state.setSubTabCompletionUnread,
      createFilePane: state.createFilePane,
      setFullscreenPane: state.setFullscreenPane,
    })),
  )
}

export function useSidebarUi() {
  return useUiStore(
    useShallow((state) => ({
      activeTerminalRef: state.activeTerminal,
      activeView: state.activeView,
      openMarkdownSidebar: state.openMarkdownSidebar,
      openModal: state.openModal_,
      requestPaneFocus: state.requestPaneFocus,
      setActiveTerminal: state.setActiveTerminal,
      setActiveView: state.setActiveView,
      setFocusedTerminal: state.setFocusedTerminal,
    })),
  )
}
