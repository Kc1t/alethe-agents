import { useDraggable, useDroppable } from '@dnd-kit/core'
import { FolderOpen, MoreHorizontal, Network, Pause, TerminalSquare } from 'lucide-react'

import { useT } from '../../lib/i18n'
import { type SidebarDropEdge } from '../../lib/sidebarDrag'
import { type Project, type Terminal } from '../../lib/types'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { DotmCircular2 } from '../ui/dotm-circular-2'
import styles from './ProjectSidebar.module.css'
import { Monogram } from './sidebarPrimitives'
import { TerminalNode } from './TerminalNode'
import { useProjectBranch } from './useProjectBranch'

/** cwd representativo do projeto = primeiro terminal com cwd (aba ativa preferida). */
function projectRepresentativeCwd(project: Project): string | undefined {
  for (const term of project.terminals) {
    const tab = term.tabs.find((x) => x.id === term.activeTabId) ?? term.tabs[0]
    const cwd = tab?.cwd || term.cwd
    if (cwd) return cwd
  }
  return undefined
}

export type ProjectNodeProps = {
  project: Project
  isActive: boolean
  openPanes: Set<string> | undefined
  onActivate: () => void
  onToggleCollapsed: () => void
  onTerminalClick: (t: Terminal) => void
  onTerminalDoubleClick: (t: Terminal) => void
  onProjectMenu: (e: React.MouseEvent) => void
  onTerminalMenu: (t: Terminal, e: React.MouseEvent) => void
  onAddTerminal: () => void
  onQuickOpen: () => void
  onToggleDisabled: () => void
  dropEdge: SidebarDropEdge | null
}

export function ProjectNode({
  project,
  isActive,
  openPanes,
  onActivate,
  onToggleCollapsed,
  onTerminalClick,
  onTerminalDoubleClick,
  onProjectMenu,
  onTerminalMenu,
  onAddTerminal,
  onQuickOpen,
  onToggleDisabled,
  dropEdge,
}: ProjectNodeProps) {
  const t = useT()
  const { setNodeRef: dropRef } = useDroppable({ id: `proj:${project.id}` })
  const draggable = useDraggable({ id: `proj:${project.id}` })
  const isDragging = draggable.isDragging
  const setInactiveRefs = (node: HTMLDivElement | null) => {
    dropRef(node)
    draggable.setNodeRef(node)
  }
  const dropClass =
    dropEdge === 'before'
      ? styles.dropBefore
      : dropEdge === 'after'
        ? styles.dropAfter
        : dropEdge === 'inside'
          ? styles.dropInside
          : ''

  // Terminal "viewer" da gaveta GSD Sync: só leitura (sem como digitar nele),
  // não faz sentido misturado com os terminais normais/interativos aqui —
  // fica escondido dessa árvore inteira (lista, contadores, "tudo pausado").
  // Único jeito de vê-lo continua sendo a gaveta GSD Sync.
  const visibleTerminals = project.terminals.filter((term) => !term.gsdSyncViewer)

  const allDisabled = visibleTerminals.length > 0 && visibleTerminals.every((term) => term.disabled)
  const branch = useProjectBranch(projectRepresentativeCwd(project))
  const runningCount = useTerminalsStore((state) =>
    visibleTerminals.reduce(
      (n, term) =>
        n +
        (term.tabs.some((tab) => tab.ptyId && state.byPtyId[tab.ptyId]?.status === 'working')
          ? 1
          : 0),
      0,
    ),
  )
  const totalCount = visibleTerminals.length
  const focusedTerminalId = useUiStore((s) =>
    s.activeTerminal?.projectId === project.id ? s.activeTerminal?.terminalId : undefined,
  )
  const countLabel = runningCount > 0 ? `${runningCount}/${totalCount}` : String(totalCount)
  const countTitle = t('ui.sidebar.agentsRunningOf', { running: runningCount, total: totalCount })

  if (isActive) {
    return (
      <div
        ref={draggable.setNodeRef}
        className={`${styles.activeCard} ${isDragging ? styles.dragSource : ''} ${
          allDisabled ? styles.projectDisabled : ''
        }`}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onProjectMenu(e)
        }}
      >
        <div
          ref={dropRef}
          className={`${styles.activeCardHeader} ${dropClass}`}
          onClick={onToggleCollapsed}
          {...draggable.attributes}
          {...draggable.listeners}
        >
          <Monogram name={project.name} iconUrl={project.iconUrl} color={project.color} size={20} />
          {project.mode === 'agentSandbox' ? (
            <Network size={13} className={styles.agentProjectIcon} />
          ) : null}
          <span className={styles.activeCardTitle} title={project.name}>
            {project.name}
          </span>
          <span className={styles.badgePrimary}>{t('ui.sidebar.primary')}</span>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={(e) => {
              e.stopPropagation()
              onQuickOpen()
            }}
            title={t('ui.workspace.openIndividually')}
          >
            <FolderOpen size={12} />
          </button>
          <button
            type="button"
            className={styles.rowMenuBtn}
            onClick={(e) => {
              e.stopPropagation()
              onProjectMenu(e)
            }}
            title={t('ui.sidebar.moreActions')}
            aria-label={t('ui.sidebar.moreActions')}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>

        {!project.collapsed && visibleTerminals.length > 0 ? (
          <div className={styles.activeCardAgentsList}>
            {visibleTerminals.map((term) => (
              <TerminalNode
                key={term.id}
                project={project}
                terminal={term}
                selected={openPanes?.has(term.id) ?? false}
                focused={focusedTerminalId === term.id}
                onClick={() => onTerminalClick(term)}
                onDoubleClick={() => onTerminalDoubleClick(term)}
                onMenu={(e) => onTerminalMenu(term, e)}
              />
            ))}
          </div>
        ) : null}

        <button
          type="button"
          className={styles.activeCardAddTerminal}
          onClick={(event) => {
            event.stopPropagation()
            onAddTerminal()
          }}
        >
          <TerminalSquare size={13} />
          <span>{t('ui.sidebar.newTerminal')}</span>
        </button>
      </div>
    )
  }

  return (
    <div
      ref={setInactiveRefs}
      className={`${styles.inactiveProjectNode} ${isDragging ? styles.dragSource : ''} ${allDisabled ? styles.projectDisabled : ''} ${
        dropClass
      }`}
      onClick={onActivate}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onProjectMenu(e)
      }}
      {...draggable.attributes}
      {...draggable.listeners}
    >
      <span className={styles.stateGutter}>
        {runningCount > 0 ? (
          <DotmCircular2
            size={14}
            dotSize={2}
            cellPadding={1}
            speed={1.2}
            bloom
            ariaLabel={t('ui.terminal.working')}
            className={styles.rosterLoading}
          />
        ) : (
          <span
            className={`${styles.inactiveDot} ${
              visibleTerminals.some((term) => !term.disabled) ? styles.inactiveDotActive : ''
            }`}
            onClick={(e) => {
              e.stopPropagation()
              onToggleDisabled()
            }}
          />
        )}
      </span>
      <Monogram name={project.name} iconUrl={project.iconUrl} color={project.color} size={18} />
      <div className={styles.inactiveMain}>
        <span className={styles.projectName} title={project.name}>
          {project.name}
        </span>
        {project.mode === 'agentSandbox' ? (
          <span className={styles.agentProjectLabel}>Agent Sandbox</span>
        ) : null}
        {branch ? (
          <span className={styles.inactiveBranch} title={branch}>
            {branch}
          </span>
        ) : null}
      </div>
      {allDisabled && <Pause size={10} className={styles.projectPauseIcon} />}
      <span className={styles.count} title={countTitle}>
        {countLabel}
      </span>
      <button
        type="button"
        className={styles.rowMenuBtn}
        onClick={(e) => {
          e.stopPropagation()
          onProjectMenu(e)
        }}
        title={t('ui.sidebar.moreActions')}
        aria-label={t('ui.sidebar.moreActions')}
      >
        <MoreHorizontal size={14} />
      </button>
    </div>
  )
}
