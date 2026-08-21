import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  ChevronRight,
  GripVertical,
  Maximize2,
  Minimize2,
  Minus,
  Network,
  Plus,
  TerminalSquare,
} from 'lucide-react'
import { memo, useMemo } from 'react'

import { useT } from '../../lib/i18n'
import type { Group, Project, Terminal, WorkspaceContainer } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { EmptyState } from '../EmptyState'
import { PaneArea } from './PaneArea'
import styles from './ProjectContainer.module.css'

export type ProjectContainerProps = {
  container: WorkspaceContainer
  project: Project
  group: Group | null

  isFullscreen?: boolean

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
  const openModal = useUiStore((s) => s.openModal_)

  const dragId = `cont:${project.id}`
  const draggable = useDraggable({ id: dragId, disabled: isFullscreen })
  const droppable = useDroppable({ id: dragId, disabled: isFullscreen })
  const setRefs = (node: HTMLDivElement | null) => {
    draggable.setNodeRef(node)
    droppable.setNodeRef(node)
  }
  const isDropTarget = droppable.isOver && !draggable.isDragging

  // renderizados. O terminal isolado busca direto em `project.terminals`,

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

  const storedAccent = project.color || group?.color
  const accent = storedAccent && CSS.supports('color', storedAccent) ? storedAccent : '#6ea8ff'
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
          <span
            className={`${styles.bullet} ${isRainbow ? 'swatch-rgb-rainbow' : ''}`}
            style={isRainbow ? undefined : { background: accent }}
          />
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
      style={{ ['--container-accent' as string]: accent }}
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
            <button
              type="button"
              className={styles.tagBtn}
              onClick={(e) => {
                e.stopPropagation()
                openModal('newTerminal', { projectId: project.id })
              }}
              title={t('ws.addPaneHere')}
              aria-label={t('ws.addPaneHere')}
            >
              <Plus size={11} />
            </button>
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
    </div>
  )
})
