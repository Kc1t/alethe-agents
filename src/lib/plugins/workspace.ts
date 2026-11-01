import {
  getProjectDefaultCwd,
  selectActiveProject,
  useProjectsStore,
} from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { agentLabel } from '../agentProviders'
import { writePty } from '../tauri'
import { type AgentType, isShellAgentType, type Project, type Terminal } from '../types'
import type { PluginWorkspace, WorkspaceSnapshot, WorkspaceTerminal } from './types'

type Located = { project: Project; terminal: Terminal }

function isPlainTerminal(terminal: Terminal): boolean {
  return !terminal.kind || terminal.kind === 'terminal'
}

function activeTab(terminal: Terminal) {
  return terminal.tabs.find((tab) => tab.id === terminal.activeTabId) ?? terminal.tabs[0]
}

function liveProjects(): Project[] {
  return useProjectsStore.getState().projects.filter((project) => !project.archived)
}

function locate(terminalId: string): Located {
  for (const project of liveProjects()) {
    const terminal = project.terminals.find((item) => item.id === terminalId)
    if (terminal && isPlainTerminal(terminal)) return { project, terminal }
  }
  throw new Error(`unknown_terminal:${terminalId}`)
}

function enabledAgents(): AgentType[] {
  const enabled = useProjectsStore.getState().preferences.enabledAgents
  return (Object.keys(enabled) as AgentType[]).filter(
    (agent) => enabled[agent] && !isShellAgentType(agent),
  )
}

export function workspaceSnapshot(): WorkspaceSnapshot {
  const state = useProjectsStore.getState()
  const runtime = useTerminalsStore.getState().byPtyId
  const live = liveProjects()

  const terminals: WorkspaceTerminal[] = []
  for (const project of live) {
    for (const terminal of project.terminals) {
      if (!isPlainTerminal(terminal)) continue
      const tab = activeTab(terminal)
      if (!tab) continue
      terminals.push({
        id: terminal.id,
        projectId: project.id,
        projectName: project.name,
        name: terminal.name,
        agent: String(tab.type),
        agentLabel: agentLabel(tab.type),
        cwd: tab.cwd || terminal.cwd,
        running: Boolean(tab.ptyId),
        busy: tab.ptyId ? runtime[tab.ptyId]?.status === 'working' : false,
      })
    }
  }

  return {
    projects: live.map((project) => ({
      id: project.id,
      name: project.name,
      path: getProjectDefaultCwd(project, state.projects),
    })),
    terminals,
    agents: enabledAgents().map((agent) => ({ id: String(agent), label: agentLabel(agent) })),
    focusedProjectId: selectActiveProject(state)?.id ?? null,
    focusedTerminalId: useUiStore.getState().activeTerminal?.terminalId ?? null,
  }
}

function focusTerminal(terminalId: string) {
  const { project } = locate(terminalId)
  const projects = useProjectsStore.getState()
  projects.setActiveProjectOnly(project.id)
  projects.focusWorkspaceTerminal(project.id, terminalId)
  const ui = useUiStore.getState()
  ui.setActiveTerminal(project.id, terminalId)
  ui.requestPaneFocus(terminalId)
  ui.requestPaneFlash(terminalId)
}

export function createPluginWorkspace(require: (capability: string) => void): PluginWorkspace {
  return {
    snapshot: () => {
      require('workspace.read')
      return workspaceSnapshot()
    },
    focusTerminal: (terminalId) => {
      require('workspace.control')
      focusTerminal(terminalId)
    },
    closeTerminal: (terminalId) => {
      require('workspace.control')
      const { project } = locate(terminalId)
      useProjectsStore.getState().deleteTerminal(project.id, terminalId)
    },
    openAgentTerminal: async (projectId, options) => {
      require('workspace.control')
      const state = useProjectsStore.getState()
      const project = liveProjects().find((item) => item.id === projectId)
      if (!project) throw new Error(`unknown_project:${projectId}`)
      const agent = enabledAgents().find((item) => item === options.agent)
      if (!agent) throw new Error(`agent_not_enabled:${options.agent}`)
      const cwd = getProjectDefaultCwd(project, state.projects)
      const created = await state.createAgentTerminal(projectId, {
        name: options.name?.trim() || agentLabel(agent),
        cwd,
        firstTab: { type: agent, cwd, initialInput: options.prompt || undefined },
      })
      return created.id
    },
    writeToTerminal: async (terminalId, text) => {
      require('terminal.write')
      const ptyId = activeTab(locate(terminalId).terminal)?.ptyId
      if (!ptyId) throw new Error(`terminal_not_running:${terminalId}`)
      await writePty(ptyId, text)
    },
  }
}
