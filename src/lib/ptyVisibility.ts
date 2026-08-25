import { useSyncExternalStore } from 'react'

import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

export type PtyVisibilitySets = {
  visible: Set<string>
  focused: Set<string>
}

   
                                                                    
                                                                            
                                                                    
                                                                                    
  
                                                                         
                                                                           
                                                                          
                             
   
export function computeVisibleFocusedPtyIds(): PtyVisibilitySets {
  const projectsState = useProjectsStore.getState()
  const ui = useUiStore.getState()
  const visible = new Set<string>()
  const focused = new Set<string>()
  const workspaceVisible = ui.activeView === 'workspace'
  const focusedTerminalIds = new Set(
    [ui.focusedTerminalId, ui.activeTerminal?.terminalId].filter(
      (id): id is string => typeof id === 'string',
    ),
  )

                                                                       
                                                                         
                                                                             
                                                                             
                                                                        
                                                                            
  // de verdade.
  const isolatedPaneId = projectsState.preferences.isolatedPaneId

  // Panes of hidden-but-mounted workspace tabs count as visible: they keep streaming so
  // switching back to their tab costs nothing.
  const keptAlivePaneIds = new Set(ui.keptAlivePaneIds)

  for (const project of projectsState.projects) {
    const container = projectsState.workspace.containers.find(
      (entry) => entry.projectId === project.id,
    )
    for (const terminal of project.terminals) {
      const activeTab = terminal.tabs.find((tab) => tab.id === terminal.activeTabId)
      const inNormalGrid =
        container &&
        !container.collapsed &&
        container.paneIds.includes(terminal.id)
      const isIsolatedPane = terminal.id === isolatedPaneId
      const isKeptAlive = keptAlivePaneIds.has(terminal.id)
      if (activeTab?.ptyId && workspaceVisible && (inNormalGrid || isIsolatedPane || isKeptAlive)) {
        visible.add(activeTab.ptyId)
      }
      if (activeTab?.ptyId && (focusedTerminalIds.has(terminal.id) || isIsolatedPane)) {
        focused.add(activeTab.ptyId)
      }
    }
  }

  const canvasId = ui.agentCanvasSession?.ptyId
  if (canvasId && ui.activeView === 'agentCanvas') {
    visible.add(canvasId)
    focused.add(canvasId)
  }

  return { visible, focused }
}

function subscribePtyVisibility(callback: () => void): () => void {
  // Only invalidate the visibility cache when the fields that drive the
  // computation actually change, not on every store mutation (recordIo,
  // memory samples, toast pushes, etc.).
  const unsubProjects = useProjectsStore.subscribe((state, prevState) => {
    if (
      state.preferences.isolatedPaneId !== prevState.preferences.isolatedPaneId ||
      state.projects !== prevState.projects ||
      state.workspace.containers !== prevState.workspace.containers
    ) {
      cached = null
      callback()
    }
  })
  const unsubUi = useUiStore.subscribe((state, prevState) => {
    if (
      state.activeView !== prevState.activeView ||
      state.focusedTerminalId !== prevState.focusedTerminalId ||
      state.activeTerminal?.terminalId !== prevState.activeTerminal?.terminalId ||
      state.keptAlivePaneIds !== prevState.keptAlivePaneIds ||
      state.agentCanvasSession?.ptyId !== prevState.agentCanvasSession?.ptyId
    ) {
      cached = null
      callback()
    }
  })
  return () => {
    unsubProjects()
    unsubUi()
  }
}

                                                                               
                                                                              
                                                                             
                                                                               
                                                 
let cached: PtyVisibilitySets | null = null

function visibilitySets(): PtyVisibilitySets {
  if (!cached) cached = computeVisibleFocusedPtyIds()
  return cached
}

   
                                                                            
                                                                            
                                                                    
                                                                         
                                                                
   
export function usePtyPanelVisible(ptyId: string | undefined): boolean {
  return useSyncExternalStore(subscribePtyVisibility, () => {
    if (!ptyId) return false
    return visibilitySets().visible.has(ptyId)
  })
}
