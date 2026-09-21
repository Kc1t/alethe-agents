import { ChevronDown, Grid2X2, MoreHorizontal, Plus } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { useT } from '../../lib/i18n'
import {
  activeProjectGrid,
  DEFAULT_GRID_ID,
  gridTerminals,
  hasCustomProjectGrids,
  projectGrids,
} from '../../lib/projectGrids'
import type { Project, Terminal } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { Collapse } from '../ui/Collapse'
import { ContextMenu, type MenuItem } from './ContextMenu'
import styles from './ProjectGrids.module.css'

export function ProjectGrids({
  project,
  isActive,
  children,
}: {
  project: Project
  isActive: boolean
  children: (terminal: Terminal) => ReactNode
}) {
  const t = useT()
  const openGrid = useProjectsStore((state) => state.openProjectGrid)
  const toggleCollapsed = useProjectsStore((state) => state.toggleProjectGridCollapsed)
  const openModal = useUiStore((state) => state.openModal_)
  const setActiveView = useUiStore((state) => state.setActiveView)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  if (project.mode === 'agentSandbox')
    return <>{project.terminals.filter((term) => !term.gsdSyncViewer).map(children)}</>
  const activate = (gridId: string) => {
    openGrid(project.id, gridId)
    setActiveView('workspace')
  }
  const addTerminal = (gridId: string) => {
    activate(gridId)
    openModal('newTerminal', { projectId: project.id, gridId })
  }
  if (!hasCustomProjectGrids(project))
    return <>{project.terminals.filter((term) => !term.gsdSyncViewer).map(children)}</>
  return (
    <div className={styles.grids}>
      {project.terminals.filter((term) => !term.gsdSyncViewer && !term.gridId).map(children)}
      {projectGrids(project)
        .filter((grid) => grid.id !== DEFAULT_GRID_ID)
        .map((grid) => {
          const name = grid.id === DEFAULT_GRID_ID ? t('projectGrid.default') : grid.name
          const terminals = gridTerminals(project, grid.id).filter((term) => !term.gsdSyncViewer)
          const showMenu = (event: React.MouseEvent) => {
            event.preventDefault()
            event.stopPropagation()
            const items: MenuItem[] = [
              {
                kind: 'item',
                label: t('projectGrid.create'),
                onClick: () =>
                  openModal('projectGrid', { projectId: project.id, action: 'create' }),
              },
              {
                kind: 'item',
                label: t('ui.sidebar.newTerminalHere'),
                onClick: () => addTerminal(grid.id),
              },
              {
                kind: 'item',
                label: t('ui.sidebar.designLayout'),
                onClick: () => {
                  activate(grid.id)
                  openModal('layoutDesigner', { kind: 'project', id: project.id })
                },
              },
            ]
            if (grid.id !== DEFAULT_GRID_ID)
              items.push(
                {
                  kind: 'item',
                  label: t('projectGrid.rename'),
                  onClick: () =>
                    openModal('projectGrid', {
                      projectId: project.id,
                      gridId: grid.id,
                      action: 'rename',
                    }),
                },
                {
                  kind: 'item',
                  label: t('projectGrid.delete'),
                  danger: true,
                  onClick: () =>
                    openModal('projectGrid', {
                      projectId: project.id,
                      gridId: grid.id,
                      action: 'delete',
                    }),
                },
              )
            setMenu({ x: event.clientX, y: event.clientY, items })
          }
          return (
            <div key={grid.id}>
              <div
                className={`${styles.row} ${isActive && activeProjectGrid(project).id === grid.id ? styles.active : ''}`}
                onContextMenu={showMenu}
              >
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => toggleCollapsed(project.id, grid.id)}
                  aria-label={grid.collapsed ? t('ui.sidebar.expand') : t('ui.sidebar.collapse')}
                  aria-expanded={!grid.collapsed}
                >
                  <ChevronDown size={12} className={grid.collapsed ? styles.closed : ''} />
                </button>
                <button
                  type="button"
                  className={styles.name}
                  onClick={() => activate(grid.id)}
                  title={name}
                >
                  <Grid2X2 size={12} />
                  <span>{name}</span>
                  <span className={styles.count}>{terminals.length}</span>
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => addTerminal(grid.id)}
                  aria-label={t('ui.sidebar.newTerminalHere')}
                >
                  <Plus size={12} />
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={showMenu}
                  aria-label={t('ui.sidebar.moreActions')}
                >
                  <MoreHorizontal size={12} />
                </button>
              </div>
              <Collapse open={!grid.collapsed}>
                <div className={styles.terminals}>{terminals.map(children)}</div>
              </Collapse>
            </div>
          )
        })}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
