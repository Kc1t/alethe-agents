import { useEffect } from 'react'

import { APP_SHELL_ID } from '../lib/appShell'
import { getLocale, translate } from '../lib/i18n'
import {
  MAX_RECENT_PROJECT_TABS,
  selectActiveContainer,
  selectActiveProject,
  selectFirstWorkspaceTerminal,
  UI_ZOOM_LIMITS,
  useProjectsStore,
} from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

export function useKeybindings() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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

      if (ctrl && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        const projects = useProjectsStore.getState()
        projects.setPreferences({
          leftSidebarVisible: !projects.preferences.leftSidebarVisible,
        })
        return
      }

      if (ctrl && !e.shiftKey && !e.altKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault()
        const project = selectActiveProject(useProjectsStore.getState())
        if (!project) return
        useUiStore.getState().openModal_('newTerminal', { projectId: project.id })
        return
      }

      // Ctrl+Alt+T repeats the last terminal configuration without reopening the picker.
      if (ctrl && e.altKey && !e.shiftKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault()
        const projects = useProjectsStore.getState()
        const project = selectActiveProject(projects)
        if (!project) return
        const creation = projects.preferences.lastTerminalCreation
        if (!creation) {
          useUiStore.getState().openModal_('newTerminal', { projectId: project.id })
          return
        }
        void projects
          .createAgentTerminal(project.id, {
            ...creation,
            firstTab: {
              ...creation.firstTab,
              extraArgs: creation.firstTab.extraArgs?.slice(),
            },
          })
          .catch((error) => {
            const locale = getLocale()
            useUiStore.getState().pushToast({
              title: translate(locale, 'term.repeatCreationFailed'),
              body: String(error),
            })
          })
        return
      }

      if (ctrl && e.shiftKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault()
        useProjectsStore.getState().reopenClosedWorkspaceTab()
        return
      }

      if (ctrl && e.shiftKey && !e.altKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault()
        const project = selectActiveProject(useProjectsStore.getState())
        if (!project) return
        useUiStore.getState().openModal_('addContent', { projectId: project.id })
        return
      }

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

      if (ctrl && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault()
        useUiStore.getState().openModal_('newProject')
        return
      }

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

      if (ctrl && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault()
        const idx = Number(e.key) - 1
        const projects = useProjectsStore.getState()
        const target = projects.projects[idx]
        if (target) projects.openProjectWorkspace(target.id)
        return
      }

      if (e.altKey && !ctrl && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        const projects = useProjectsStore.getState()
        projects.navigateWorkspaceHistory(e.key === 'ArrowLeft' ? -1 : 1)
        useUiStore.getState().setActiveView('workspace')
        return
      }

      const cycleTerminalDirection =
        ctrl && !e.altKey && (e.key === 'PageUp' || e.key === 'PageDown')
          ? e.key === 'PageUp'
            ? -1
            : 1
          : !ctrl && e.shiftKey && !e.altKey && e.key === 'Tab'
            ? 1
            : 0
      if (cycleTerminalDirection !== 0) {
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
        const nextIndex =
          currentIndex === -1
            ? 0
            : (currentIndex + cycleTerminalDirection + terminals.length) % terminals.length
        const next = terminals[nextIndex]
        projects.focusWorkspaceTerminal(next.projectId, next.terminalId)
        ui.setActiveTerminal(next.projectId, next.terminalId)
        ui.requestPaneFocus(next.terminalId)
        ui.setActiveView('workspace')
        return
      }

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
        const entry = selectFirstWorkspaceTerminal(useProjectsStore.getState())
        if (entry) {
          projects.focusWorkspaceTerminal(entry.projectId, entry.terminalId)
          ui.setActiveTerminal(entry.projectId, entry.terminalId)
          ui.requestPaneFocus(entry.terminalId)
        }
        return
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Coming back to the app can leave the webview with no focused element, and
  // WebView2 then keeps Ctrl+Tab for its own focus traversal instead of handing
  // the key to the page. Parking focus on the shell keeps the shortcuts alive
  // without pulling it away from a terminal, an input, or a modal.
  useEffect(() => {
    const restoreShellFocus = () => {
      if (document.visibilityState === 'hidden') return
      const active = document.activeElement
      if (active && active !== document.body) return
      document.getElementById(APP_SHELL_ID)?.focus({ preventScroll: true })
    }
    const onWindowFocus = () => {
      restoreShellFocus()
      window.requestAnimationFrame(restoreShellFocus)
    }
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onWindowFocus)
    onWindowFocus()
    return () => {
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onWindowFocus)
    }
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
