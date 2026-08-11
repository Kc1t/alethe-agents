import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  ChevronRight,
  GripVertical,
  Maximize2,
  Minimize2,
  Minus,
  Network,
  TerminalSquare,
} from 'lucide-react'
import { memo, useMemo } from 'react'

import type { Group, Project, Terminal, WorkspaceContainer } from '../../lib/types'
import { useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import { EmptyState } from '../EmptyState'
import { PaneArea } from './PaneArea'
import styles from './ProjectContainer.module.css'

export type ProjectContainerProps = {
  container: WorkspaceContainer
  project: Project
  group: Group | null
  /** True quando o container é o único visível (fullscreen). */
  isFullscreen?: boolean
  /** Cabeçalho é redundante quando a workspace tem apenas um container. */
  showHeader?: boolean
}

export const ProjectContainer = memo(function ProjectContainer({
  container,
  project,
  group,
  isFullscreen = false,
  showHeader = true,
}: ProjectContainerProps) {
  const t = useT()
  const setCollapsed = useProjectsStore((s) => s.setContainerCollapsed)
  const setFullscreen = useProjectsStore((s) => s.setFullscreenContainer)
  const isolatedPaneId = useProjectsStore((s) => s.preferences.isolatedPaneId)
  const setWorkspaceFlat = useProjectsStore((s) => s.setWorkspaceFlat)
  const closeContainer = useProjectsStore((s) => s.closeContainer)
  const openContainerWithAllPanes = useProjectsStore((s) => s.openContainerWithAllPanes)
  const createGraphifyPane = useProjectsStore((s) => s.createGraphifyPane)
  const setGraphifyEnabled = useProjectsStore((s) => s.setGraphifyEnabled)
  const setWorkspaceGridLayout = useProjectsStore((s) => s.setWorkspaceGridLayout)
  const setGroupGridLayout = useProjectsStore((s) => s.setGroupGridLayout)
  const workspaceGridLayout = useProjectsStore((s) => s.preferences.workspaceGridLayout)
  const activeGroupGrid = useMemo(() => {
    if (!group) return null
    if (group.layoutMode !== 'grid' || !group.gridLayout) return null
    return { groupId: group.id, layout: group.gridLayout }
  }, [group])

  // Resize LIVRE: arrasta o canto inferior-direito pra ajustar a proporção
  // `fr` da última col/row que esse container ocupa, roubando da col/row
  // adjacente. Diferente do LayoutDesigner que muda colSpan inteiro — aqui
  // o ajuste é contínuo (alguns pixels = poucos %).
  const startGridResize = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const grid = workspaceGridLayout
      ? { kind: 'workspace' as const, layout: workspaceGridLayout }
      : activeGroupGrid
        ? {
            kind: 'group' as const,
            groupId: activeGroupGrid.groupId,
            layout: activeGroupGrid.layout,
          }
        : null
    if (!grid) return
    const cell = grid.layout.cells[project.id]
    if (!cell) return

    const node = (e.currentTarget as HTMLElement).closest(
      '[data-pane-box="1"]',
    ) as HTMLElement | null
    if (!node) return
    let gridEl: HTMLElement | null = node.parentElement
    while (gridEl && getComputedStyle(gridEl).display !== 'grid') {
      gridEl = gridEl.parentElement
    }
    if (!gridEl) return

    const rect = gridEl.getBoundingClientRect()
    const initialCols = (
      grid.layout.colSizes && grid.layout.colSizes.length === grid.layout.cols
        ? grid.layout.colSizes
        : Array(grid.layout.cols).fill(1)
    ).slice()
    const initialRows = (
      grid.layout.rowSizes && grid.layout.rowSizes.length === grid.layout.rows
        ? grid.layout.rowSizes
        : Array(grid.layout.rows).fill(1)
    ).slice()
    const totalColUnits = initialCols.reduce((a, b) => a + b, 0)
    const totalRowUnits = initialRows.reduce((a, b) => a + b, 0)

    // 0-based índices da última col/row da célula
    const lastColIdx = cell.col + cell.colSpan - 2 // a col que cresce
    const nextColIdx = lastColIdx + 1 // a col que encolhe
    const lastRowIdx = cell.row + cell.rowSpan - 2
    const nextRowIdx = lastRowIdx + 1

    const canResizeX = nextColIdx >= 0 && nextColIdx < grid.layout.cols
    const canResizeY = nextRowIdx >= 0 && nextRowIdx < grid.layout.rows

    const startX = e.clientX
    const startY = e.clientY
    const minFr = 0.1

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      const colSizes = initialCols.slice()
      const rowSizes = initialRows.slice()

      if (canResizeX) {
        const deltaFr = (dx * totalColUnits) / rect.width
        const combined = initialCols[lastColIdx] + initialCols[nextColIdx]
        const grown = Math.max(minFr, Math.min(combined - minFr, initialCols[lastColIdx] + deltaFr))
        colSizes[lastColIdx] = grown
        colSizes[nextColIdx] = combined - grown
      }
      if (canResizeY) {
        const deltaFr = (dy * totalRowUnits) / rect.height
        const combined = initialRows[lastRowIdx] + initialRows[nextRowIdx]
        const grown = Math.max(minFr, Math.min(combined - minFr, initialRows[lastRowIdx] + deltaFr))
        rowSizes[lastRowIdx] = grown
        rowSizes[nextRowIdx] = combined - grown
      }
      if (!canResizeX && !canResizeY) return

      const next = { ...grid.layout, colSizes, rowSizes }
      if (grid.kind === 'workspace') setWorkspaceGridLayout(next)
      else setGroupGridLayout(grid.groupId, next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const showResizeHandle = Boolean(workspaceGridLayout || activeGroupGrid) && !isFullscreen

  // Drag-and-drop pra reordenar containers entre si na workspace.
  // Disabled em fullscreen (não faz sentido reordenar quando só tem 1).
  const dragId = `cont:${project.id}`
  const draggable = useDraggable({ id: dragId, disabled: isFullscreen })
  const droppable = useDroppable({ id: dragId, disabled: isFullscreen })
  const setRefs = (node: HTMLDivElement | null) => {
    draggable.setNodeRef(node)
    droppable.setNodeRef(node)
  }
  const isDropTarget = droppable.isOver && !draggable.isDragging

  // Fullscreen isolando UMA pane só (gaveta GSD Sync) — reaproveita o mesmo
  // fullscreen de container de sempre, só troca quais terminais são
  // renderizados. O terminal isolado busca direto em `project.terminals`,
  // não em `container.paneIds`, porque a pane "GSD Sync" nunca é inserida
  // na grade normal — só existe pra esse fullscreen isolado.
  const terminals = useMemo<Terminal[]>(() => {
    if (isFullscreen && isolatedPaneId) {
      const isolated = project.terminals.find((term) => term.id === isolatedPaneId)
      if (isolated) return [isolated]
    }
    const map = new Map(project.terminals.map((t) => [t.id, t]))
    return container.paneIds.map((id) => map.get(id)).filter((t): t is Terminal => Boolean(t))
  }, [project.terminals, container.paneIds, isFullscreen, isolatedPaneId])
  const graphifyPaneOpen = terminals.some((terminal) => terminal.kind === 'graphify')
  const graphifyEnabled = useProjectsStore((s) => s.preferences.enabledFeatures.graphify)
  const graphifyCwd = terminals.find(
    (terminal) => terminal.kind !== 'graphify' && terminal.cwd,
  )?.cwd

  // Cor do container = cor do PROJETO (cada projeto fica visualmente único).
  // Cor do grupo fica reservada pro bullet/tag na sidebar (organização).
  // Fallback pro neutro se o projeto não tem cor.
  const accent = project.color || group?.color || 'var(--border-strong)'
  const isRainbow = accent === 'rgb-rainbow'

  if (container.collapsed) {
    return (
      <div
        className={`${styles.collapsed} ${isRainbow ? 'rainbow-container-border' : ''}`}
        style={{ ['--container-accent' as string]: isRainbow ? undefined : accent }}
        onClick={() => setCollapsed(project.id, false)}
        title={`${group ? group.name + ' · ' : ''}${t('ws.containerExpandHint', { name: project.name })}`}
      >
        {project.iconUrl ? (
          <img src={project.iconUrl} alt="" className={styles.projectIcon} />
        ) : (
          <span className={`${styles.bullet} ${isRainbow ? 'swatch-rgb-rainbow' : ''}`} style={isRainbow ? undefined : { background: accent }} />
        )}
        <span className={styles.collapsedName}>{project.name}</span>
        <span className={styles.collapsedCount}>{container.paneIds.length}</span>
      </div>
    )
  }

  return (
    <div
      ref={setRefs}
      data-pane-box="1"
      className={`${styles.box} ${isRainbow ? 'rainbow-container-border' : ''} ${draggable.isDragging ? styles.boxDragging : ''} ${
        isDropTarget ? styles.boxDropTarget : ''
      }`}
      style={{ ['--container-accent' as string]: isRainbow ? undefined : accent }}
    >
      {showHeader ? (
        <div className={styles.tag}>
          {!isFullscreen ? (
            <button
              type="button"
              className={styles.dragHandle}
              {...draggable.attributes}
              {...draggable.listeners}
              title={t('ws.dragToReorderContainer')}
              aria-label={t('ws.dragContainer')}
            >
              <GripVertical size={11} />
            </button>
          ) : null}
          {project.iconUrl ? (
            <img src={project.iconUrl} alt="" className={styles.projectIcon} />
          ) : (
            <span className={styles.bullet} style={{ background: accent }} />
          )}
          <span className={styles.tagName} title={project.name}>
            {project.name}
          </span>
          <span className={styles.tagCount}>{terminals.length}</span>
          <div className={styles.tagActions}>
            {graphifyEnabled && !graphifyPaneOpen && graphifyCwd ? (
              <button
                type="button"
                className={styles.tagBtn}
                onClick={(e) => {
                  e.stopPropagation()
                  setGraphifyEnabled(project.id, true)
                  createGraphifyPane(project.id, graphifyCwd)
                }}
                title={t('graphify.startInProject')}
                aria-label={t('graphify.startInProject')}
              >
                <Network size={11} />
              </button>
            ) : null}
            <button
              type="button"
              className={styles.tagBtn}
              onClick={(e) => {
                e.stopPropagation()
                setCollapsed(project.id, true)
              }}
              title={t('ws.collapseContainer')}
              aria-label={t('ws.collapse')}
            >
              <ChevronRight size={11} />
            </button>
            <button
              type="button"
              className={styles.tagBtn}
              onClick={(e) => {
                e.stopPropagation()
                if (isFullscreen) {
                  setFullscreen(null)
                  return
                }
                setWorkspaceFlat(false)
                setFullscreen(project.id)
              }}
              title={isFullscreen ? t('ws.exitFullscreen') : t('ws.containerFullscreen')}
              aria-label={t('ws.toggleFullscreen')}
            >
              {isFullscreen ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
            </button>
            <button
              type="button"
              className={styles.tagBtn}
              onClick={(e) => {
                e.stopPropagation()
                closeContainer(project.id)
              }}
              title={t('ws.closeContainer')}
              aria-label={t('ws.close')}
            >
              <Minus size={11} />
            </button>
          </div>
        </div>
      ) : null}
      <div className={styles.body}>
        {terminals.length === 0 ? (
          <div className={styles.emptyShell}>
            <EmptyState
              compact
              icon={<TerminalSquare size={18} />}
              title={t('ws.panesEmptyTitle')}
              description={t('ws.panesEmptyDesc')}
              primaryAction={{
                label: t('ws.panesEmptyAction'),
                onClick: () => openContainerWithAllPanes(project.id),
              }}
            />
          </div>
        ) : (
          <PaneArea
            projectId={project.id}
            idPrefix={`c-${project.id}`}
            terminals={terminals}
            layoutMode={container.internalLayout}
          />
        )}
      </div>

      {showResizeHandle ? (
        <div
          className={styles.gridResize}
          onPointerDown={startGridResize}
          title={t('ws.dragToResizeSpan')}
        />
      ) : null}
    </div>
  )
})
