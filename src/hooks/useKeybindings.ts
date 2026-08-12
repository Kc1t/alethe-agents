import { useEffect } from 'react'

import {
  MAX_RECENT_PROJECT_TABS,
  selectActiveContainer,
  selectActiveProject,
  UI_ZOOM_LIMITS,
  useProjectsStore,
} from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

/**
 * Atalhos globais. Ignora se o foco estiver num input/textarea editáveis —
 * exceto Esc, que sempre fecha o modal aberto.
 */
export function useKeybindings() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc fecha modal aberto
      if (e.key === 'Escape') {
        const ui = useUiStore.getState()
        if (ui.openModal) {
          e.preventDefault()
          ui.closeModal()
          return
        }
        const projects = useProjectsStore.getState()
        if (projects.preferences.fullscreenContainerId) {
          e.preventDefault()
          projects.setFullscreenContainer(null)
          return
        }
      }

      const target = e.target as HTMLElement | null
      const inEditable =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault()
        useUiStore.getState().openModal_('audit')
        return
      }

      if (ctrl && !e.altKey && isZoomKey(e)) {
        e.preventDefault()
        const projects = useProjectsStore.getState()
        const current = projects.preferences.uiZoom
        if (isZoomResetKey(e)) {
          projects.setUiZoom(1)
        } else {
          const direction = isZoomInKey(e) ? 1 : -1
          projects.setUiZoom(current + direction * UI_ZOOM_LIMITS.step)
        }
        return
      }

      if (!ctrl && inEditable) return

      // R → reinicia o terminal selecionado quando o foco está na UI.
      // Dentro do xterm o helper é um textarea, então a digitação normal de "r" é preservada.
      if (!ctrl && !e.shiftKey && !e.altKey && (e.key === 'r' || e.key === 'R')) {
        const projects = useProjectsStore.getState()
        const selected = useUiStore.getState().activeTerminal
        const project = selected
          ? projects.projects.find((item) => item.id === selected.projectId)
          : null
        const terminal = project?.terminals.find((item) => item.id === selected?.terminalId)
        if (
          !selected ||
          !terminal ||
          terminal.disabled ||
          (terminal.kind && terminal.kind !== 'terminal')
        ) {
          return
        }
        e.preventDefault()
        window.dispatchEvent(
          new CustomEvent('alethe:terminal-restart-request', {
            detail: { terminalId: selected.terminalId },
          }),
        )
        return
      }

      // Ctrl+T → abre o modal de novo terminal
      if (ctrl && !e.shiftKey && !e.altKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault()
        const project = selectActiveProject(useProjectsStore.getState())
        if (!project) return
        useUiStore.getState().openModal_('newTerminal', { projectId: project.id })
        return
      }

      // Ctrl+Shift+T → reabre a última tab fechada
      if (ctrl && e.shiftKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault()
        useProjectsStore.getState().reopenClosedWorkspaceTab()
        return
      }

      // Ctrl+Shift+A → modal de conteúdo (Markdown ou browser)
      if (ctrl && e.shiftKey && !e.altKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault()
        const project = selectActiveProject(useProjectsStore.getState())
        if (!project) return
        useUiStore.getState().openModal_('addContent', { projectId: project.id })
        return
      }

      // Ctrl+W → fecha (oculta) o primeiro pane do container ativo
      if (ctrl && !e.shiftKey && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault()
        const projects = useProjectsStore.getState()
        const container = selectActiveContainer(projects)
        if (!container || container.paneIds.length === 0) return
        projects.closePane(container.projectId, container.paneIds[0])
        return
      }

      // Ctrl+P → busca/jump (find)
      if (ctrl && !e.shiftKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        useUiStore.getState().openModal_('findJump')
        return
      }

      // Ctrl+Shift+P → modal novo projeto
      if (ctrl && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault()
        useUiStore.getState().openModal_('newProject')
        return
      }

      // Ctrl+Shift+G → modal novo grupo
      if (ctrl && e.shiftKey && (e.key === 'G' || e.key === 'g')) {
        e.preventDefault()
        useUiStore.getState().openModal_('newGroup')
        return
      }

      // Ctrl+Shift+H → toggle Home ↔ workspace
      if (ctrl && e.shiftKey && (e.key === 'H' || e.key === 'h')) {
        e.preventDefault()
        useUiStore.getState().toggleHome()
        return
      }

      // Ctrl+1..9 → pula pra projeto N (na ordem da sidebar)
      if (ctrl && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault()
        const idx = Number(e.key) - 1
        const projects = useProjectsStore.getState()
        const target = projects.projects[idx]
        if (target) projects.openProjectWorkspace(target.id)
        return
      }

      // Alt+Left / Alt+Right → histórico persistente da workspace.
      if (e.altKey && !ctrl && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        const projects = useProjectsStore.getState()
        projects.navigateWorkspaceHistory(e.key === 'ArrowLeft' ? -1 : 1)
        useUiStore.getState().setActiveView('workspace')
        return
      }

      // Shift+Tab → próximo terminal dentro do grupo/projeto atual.
      if (!ctrl && e.shiftKey && !e.altKey && e.key === 'Tab') {
        e.preventDefault()
        const projects = useProjectsStore.getState()
        const ui = useUiStore.getState()
        const activeGroupId = projects.workspace.activeGroupId
        const scopedProjectIds = activeGroupId
          ? collectGroupProjectIds(activeGroupId, projects.groups)
          : projects.activeProjectId
            ? new Set([projects.activeProjectId])
            : null
        const terminals = projects.workspace.containers.flatMap((container) => {
          if (scopedProjectIds && !scopedProjectIds.has(container.projectId)) return []
          const project = projects.projects.find((item) => item.id === container.projectId)
          if (!project) return []
          return container.paneIds.flatMap((terminalId) => {
            const terminal = project.terminals.find((item) => item.id === terminalId)
            return terminal && !terminal.disabled
              ? [{ projectId: container.projectId, terminalId }]
              : []
          })
        })
        if (terminals.length === 0) return

        const activeTerminalId =
          ui.activeTerminal?.terminalId ?? projects.workspace.focusedTerminalId
        const currentIndex = terminals.findIndex((item) => item.terminalId === activeTerminalId)
        const next = terminals[(currentIndex + 1) % terminals.length]
        projects.focusWorkspaceTerminal(next.projectId, next.terminalId)
        ui.setActiveTerminal(next.projectId, next.terminalId)
        ui.requestPaneFocus(next.terminalId)
        ui.setActiveView('workspace')
        return
      }

      // Ctrl+Tab → alterna tabs de projeto da topbar sem reordenar os slots.
      if (ctrl && e.key === 'Tab') {
        e.preventDefault()
        const projects = useProjectsStore.getState()
        const ui = useUiStore.getState()
        const topTabs = projects.workspace.tabs.slice(0, MAX_RECENT_PROJECT_TABS)
        if (topTabs.length < 2) return
        const currentIndex = topTabs.findIndex((tab) => tab.id === projects.workspace.activeTabId)
        const direction = e.shiftKey ? -1 : 1
        const nextIndex =
          currentIndex === -1 ? 0 : (currentIndex + direction + topTabs.length) % topTabs.length
        const nextTab = topTabs[nextIndex]
        projects.activateWorkspaceTab(nextTab.id)
        ui.setActiveView('workspace')
        return
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

function collectGroupProjectIds(
  groupId: string,
  groups: ReturnType<typeof useProjectsStore.getState>['groups'],
): Set<string> {
  const projectIds = new Set<string>()
  const pending = [groupId]
  while (pending.length > 0) {
    const currentId = pending.shift()!
    const group = groups.find((item) => item.id === currentId)
    if (!group) continue
    for (const projectId of group.projectIds) projectIds.add(projectId)
    for (const child of groups) {
      if (child.parentGroupId === currentId) pending.push(child.id)
    }
  }
  return projectIds
}

function isZoomKey(e: KeyboardEvent): boolean {
  return isZoomInKey(e) || isZoomOutKey(e) || isZoomResetKey(e)
}

function isZoomInKey(e: KeyboardEvent): boolean {
  return e.key === '+' || e.key === '=' || e.code === 'NumpadAdd'
}

function isZoomOutKey(e: KeyboardEvent): boolean {
  return e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract'
}

function isZoomResetKey(e: KeyboardEvent): boolean {
  return e.key === '0' || e.code === 'Numpad0'
}
