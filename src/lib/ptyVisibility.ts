import { useSyncExternalStore } from 'react'

import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

export type PtyVisibilitySets = {
  visible: Set<string>
  focused: Set<string>
}

/**
 * Fonte única da definição de "painel visível" (pertence à visão de
 * workspace ativa, ou ao agent canvas, e não está num container colapsado).
 * Usada pelo `useResourceSupervisor` (proteção contra suspensão por
 * pressão de memória) e pelo gate de streaming do XTermView (`usePtyPanelVisible`).
 *
 * Aproximação conservadora: não distingue aba de grupo inativa dentro do
 * workspace — pode marcar como "visível" um pane cuja aba de grupo não é a
 * ativa (perde uma otimização), mas nunca o contrário (nunca esconde algo
 * que está de fato na tela).
 */
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

  // Fullscreen de container isolando UMA pane só (gaveta GSD Sync) — o
  // terminal fica de propósito FORA de `paneIds` (nunca deve aparecer na
  // grade normal), mas quando é exatamente o `isolatedPaneId` atual ele está
  // tão visível quanto qualquer pane normal aberta — sem essa checagem extra
  // ele nunca seria marcado visível e ficaria preso pra sempre no sinal
  // leve/espaçado de painel em segundo plano, nunca desenhando a tela cheia
  // de verdade.
  const isolatedPaneId = projectsState.preferences.isolatedPaneId

  for (const project of projectsState.projects) {
    const container = projectsState.workspace.containers.find(
      (entry) => entry.projectId === project.id,
    )
    for (const terminal of project.terminals) {
      const activeTab = terminal.tabs.find((tab) => tab.id === terminal.activeTabId)
      const inNormalGrid =
        container && !container.collapsed && container.paneIds.includes(terminal.id)
      const isIsolatedPane = terminal.id === isolatedPaneId
      if (activeTab?.ptyId && workspaceVisible && (inNormalGrid || isIsolatedPane)) {
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
  const unsubProjects = useProjectsStore.subscribe(() => {
    cached = null
    callback()
  })
  const unsubUi = useUiStore.subscribe(() => {
    cached = null
    callback()
  })
  return () => {
    unsubProjects()
    unsubUi()
  }
}

// `useSyncExternalStore` chama getSnapshot por pane inscrito a cada emissão de
// store, e o cálculo é O(projetos × terminais). Com N panes abertos isso vira
// N varreduras completas por escrita de store — numa feature cujo objetivo é
// justamente reduzir custo de frontend. Invalidado no subscribe acima, então o
// cache nunca sobrevive a uma mudança de estado.
let cached: PtyVisibilitySets | null = null

function visibilitySets(): PtyVisibilitySets {
  if (!cached) cached = computeVisibleFocusedPtyIds()
  return cached
}

/**
 * true enquanto o painel deste PTY está de fato na visão ativa do workspace
 * (ou no agent canvas) e não colapsado. Reage imediatamente (sem polling) a
 * troca de foco, colapso de container ou troca de view — usado pelo
 * `XTermView` pra chamar `setPtyVisible` assim que o painel entra/sai de
 * tela, sem esperar o polling de 5s do `useResourceSupervisor`.
 */
export function usePtyPanelVisible(ptyId: string | undefined): boolean {
  return useSyncExternalStore(subscribePtyVisibility, () => {
    if (!ptyId) return false
    return visibilitySets().visible.has(ptyId)
  })
}
