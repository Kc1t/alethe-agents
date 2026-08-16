import { useDroppable } from '@dnd-kit/core'
import { Ungroup } from 'lucide-react'
import { Panel, Separator } from 'react-resizable-panels'

import {
  autoGridLayout,
  cellStyle,
  freeCells,
  gridContainerStyle,
  reconcileGridLayout,
} from '../../lib/gridLayout'
import { useT } from '../../lib/i18n'
import type { GridLayout, LayoutMode, Terminal } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { DiffPane } from '../DiffPane'
import { lazy, Suspense } from 'react'

import { GridCellHandles } from '../GridCellHandles'

const GraphifyView = lazy(() => import('../GraphifyView').then(m => ({ default: m.GraphifyView })))
const MarkdownPane = lazy(() => import('../MarkdownPane').then(m => ({ default: m.MarkdownPane })))
import { TerminalPane } from '../TerminalPane'
import { VideoPane } from '../VideoPane'
import { WebPane } from '../WebPane'
import { PersistentPanelGroup as Group } from './PersistentPanelGroup'
import styles from './WorkspaceView.module.css'

const EMPTY_PANE_GROUPS: { id: string; paneIds: string[] }[] = []

function Pane({
  projectId,
  terminal,
  paneDragEnabled = true,
  grouped = false,
}: {
  projectId: string
  terminal: Terminal
  paneDragEnabled?: boolean
  grouped?: boolean
}) {
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId))
  const group = !grouped
    ? project?.paneGroups?.find((candidate) => candidate.paneIds[0] === terminal.id)
    : undefined
  if (group) return <PaneGroupView projectId={projectId} group={group} />
  if (terminal.kind === 'graphify') {
    return (
      <Suspense fallback={<div className={styles.paneLoading}>Loading graph...</div>}>
        <GraphifyView repo={terminal.cwd} projectId={projectId} terminalId={terminal.id} />
      </Suspense>
    )
  }
  if (terminal.kind === 'markdown' || terminal.kind === 'file') {
    return (
      <Suspense fallback={<div className={styles.paneLoading}>Loading markdown...</div>}>
        <MarkdownPane projectId={projectId} terminal={terminal} />
      </Suspense>
    )
  }
  if (terminal.kind === 'web') {
    return <WebPane projectId={projectId} terminal={terminal} />
  }
  if (terminal.kind === 'video') {
    return <VideoPane projectId={projectId} terminal={terminal} />
  }
  if (terminal.kind === 'diff') {
    return <DiffPane projectId={projectId} terminal={terminal} />
  }
  return (
    <TerminalPane projectId={projectId} terminal={terminal} paneDragEnabled={paneDragEnabled} />
  )
}

function PaneGroupView({
  projectId,
  group,
}: {
  projectId: string
  group: { id: string; paneIds: string[] }
}) {
  const t = useT()
  const ungroupPanes = useProjectsStore((s) => s.ungroupPanes)
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId))
  const terminals = group.paneIds
    .map((id) => project?.terminals.find((terminal) => terminal.id === id))
    .filter((terminal): terminal is Terminal => Boolean(terminal))
  return (
    <section className={styles.paneGroup}>
      <header className={styles.paneGroupHeader}>
        <span>{t('ws.paneGroup.title')}</span>
        <button
          type="button"
          className={styles.paneGroupAction}
          title={t('ws.paneGroup.ungroup')}
          aria-label={t('ws.paneGroup.ungroup')}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => ungroupPanes(projectId, group.id)}
        >
          <Ungroup size={14} />
        </button>
      </header>
      <div className={styles.paneGroupBody}>
        {terminals.map((terminal) => (
          <div key={terminal.id} className={styles.paneGroupItem}>
            <Pane projectId={projectId} terminal={terminal} grouped />
          </div>
        ))}
      </div>
    </section>
  )
}

export type PaneAreaProps = {
  projectId: string

  idPrefix: string
  terminals: Terminal[]
  layoutMode: LayoutMode
}

export function PaneArea({ projectId, idPrefix, terminals, layoutMode }: PaneAreaProps) {
  const groups = useProjectsStore(
    (s) => s.projects.find((p) => p.id === projectId)?.paneGroups ?? EMPTY_PANE_GROUPS,
  )
  if (terminals.length === 0) return null
  const groupedIds = new Set(groups.flatMap((group) => group.paneIds.slice(1)))
  const visibleTerminals = terminals.filter((terminal) => !groupedIds.has(terminal.id))
  if (visibleTerminals.length === 1) {
    return (
      <div className={styles.singlePane}>
        <Pane projectId={projectId} terminal={visibleTerminals[0]} paneDragEnabled={false} />
      </div>
    )
  }
  if (layoutMode === 'grid')
    return <GridLayoutComponent projectId={projectId} terminals={visibleTerminals} />
  if (layoutMode === 'spotlight')
    return (
      <SpotlightLayout projectId={projectId} idPrefix={idPrefix} terminals={visibleTerminals} />
    )
  if (layoutMode === 'sidebar')
    return <SidebarLayout projectId={projectId} idPrefix={idPrefix} terminals={visibleTerminals} />
  return <AutoLayout projectId={projectId} idPrefix={idPrefix} terminals={visibleTerminals} />
}

function GridLayoutComponent({
  projectId,
  terminals,
}: {
  projectId: string
  terminals: Terminal[]
}) {
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId))
  const setProjectGridLayout = useProjectsStore((s) => s.setProjectGridLayout)
  const layout: GridLayout | undefined = project?.gridLayout
  const ids = terminals.map((t) => t.id)
  const reconciled = layout ? reconcileGridLayout(layout, ids) : autoGridLayout(ids, 2)
  return (
    <div style={gridContainerStyle(reconciled)}>
      {freeCells(reconciled, ids).map((slot) => (
        <EmptyGridSlot
          key={`slot-${slot.col}-${slot.row}`}
          dropId={`cell:pane:${projectId}:${slot.col}:${slot.row}`}
          col={slot.col}
          row={slot.row}
        />
      ))}
      {terminals.map((t) => {
        const cell = reconciled.cells[t.id]
        if (!cell) return null
        return (
          <div key={t.id} className={styles.gridCell} style={cellStyle(cell)}>
            <Pane projectId={projectId} terminal={t} />
            <GridCellHandles
              cellId={t.id}
              childIds={ids}
              layout={reconciled}
              onUpdate={(next) => setProjectGridLayout(projectId, next)}
            />
          </div>
        )
      })}
    </div>
  )
}

function EmptyGridSlot({ dropId, col, row }: { dropId: string; col: number; row: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId })
  return (
    <div
      ref={setNodeRef}
      className={`${styles.emptySlot} ${isOver ? styles.emptySlotOver : ''}`}
      style={{ gridColumn: col, gridRow: row }}
    />
  )
}

type LayoutProps = {
  projectId: string
  idPrefix: string
  terminals: Terminal[]
}

function AutoLayout({ projectId, idPrefix, terminals }: LayoutProps) {
  if (terminals.length === 2) {
    const panelIds = terminals.map((terminal) => `${idPrefix}-p-${terminal.id}`)
    return (
      <Group
        orientation="horizontal"
        className={styles.fullSize}
        persistenceId={`pane-${idPrefix}-auto-columns`}
        panelIds={panelIds}
      >
        <Panel id={`${idPrefix}-p-${terminals[0].id}`} minSize="15%">
          <Pane projectId={projectId} terminal={terminals[0]} />
        </Panel>
        <Separator className={styles.sepH} />
        <Panel id={`${idPrefix}-p-${terminals[1].id}`} minSize="15%">
          <Pane projectId={projectId} terminal={terminals[1]} />
        </Panel>
      </Group>
    )
  }
  const rows = chunkInto(terminals, 2)
  const rowPanelIds = rows.map((_, rowIndex) => `${idPrefix}-row-${rowIndex}`)
  return (
    <Group
      orientation="vertical"
      className={styles.fullSize}
      persistenceId={`pane-${idPrefix}-auto-rows`}
      panelIds={rowPanelIds}
    >
      {rows.map((row, ri) => (
        <RowFragment
          key={ri}
          projectId={projectId}
          idPrefix={`${idPrefix}-r${ri}`}
          rowId={`${idPrefix}-row-${ri}`}
          terminals={row}
          isLast={ri === rows.length - 1}
        />
      ))}
    </Group>
  )
}

function RowFragment({
  projectId,
  idPrefix,
  rowId,
  terminals,
  isLast,
}: {
  projectId: string
  idPrefix: string
  rowId: string
  terminals: Terminal[]
  isLast: boolean
}) {
  return (
    <>
      <Panel id={rowId} minSize="10%">
        {terminals.length === 1 ? (
          <Pane projectId={projectId} terminal={terminals[0]} />
        ) : (
          <Group
            orientation="horizontal"
            className={styles.fullSize}
            persistenceId={`pane-${idPrefix}-columns`}
            panelIds={terminals.map((terminal) => `${idPrefix}-p-${terminal.id}`)}
          >
            {terminals.map((t, i) => (
              <FragmentCol
                key={t.id}
                projectId={projectId}
                idPrefix={idPrefix}
                terminal={t}
                isLast={i === terminals.length - 1}
              />
            ))}
          </Group>
        )}
      </Panel>
      {isLast ? null : <Separator className={styles.sepV} />}
    </>
  )
}

function FragmentCol({
  projectId,
  idPrefix,
  terminal,
  isLast,
}: {
  projectId: string
  idPrefix: string
  terminal: Terminal
  isLast: boolean
}) {
  return (
    <>
      <Panel id={`${idPrefix}-p-${terminal.id}`} minSize="10%">
        <Pane projectId={projectId} terminal={terminal} />
      </Panel>
      {isLast ? null : <Separator className={styles.sepH} />}
    </>
  )
}

function FragmentRow({
  projectId,
  idPrefix,
  terminal,
  isLast,
}: {
  projectId: string
  idPrefix: string
  terminal: Terminal
  isLast: boolean
}) {
  return (
    <>
      <Panel id={`${idPrefix}-p-${terminal.id}`} minSize="10%">
        <Pane projectId={projectId} terminal={terminal} />
      </Panel>
      {isLast ? null : <Separator className={styles.sepV} />}
    </>
  )
}

function SpotlightLayout({ projectId, idPrefix, terminals }: LayoutProps) {
  const [main, ...rest] = terminals
  const mainPanelId = `${idPrefix}-spot-main-${main.id}`
  const stackPanelId = `${idPrefix}-spot-stack`
  return (
    <Group
      orientation="horizontal"
      className={styles.fullSize}
      persistenceId={`pane-${idPrefix}-spotlight`}
      panelIds={[mainPanelId, stackPanelId]}
    >
      <Panel id={mainPanelId} defaultSize="65%" minSize="25%">
        <Pane projectId={projectId} terminal={main} />
      </Panel>
      <Separator className={styles.sepH} />
      <Panel id={stackPanelId} defaultSize="35%" minSize="15%">
        <Group
          orientation="vertical"
          className={styles.fullSize}
          persistenceId={`pane-${idPrefix}-spotlight-stack`}
          panelIds={rest.map((terminal) => `${idPrefix}-p-${terminal.id}`)}
        >
          {rest.map((t, i) => (
            <FragmentRow
              key={t.id}
              projectId={projectId}
              idPrefix={idPrefix}
              terminal={t}
              isLast={i === rest.length - 1}
            />
          ))}
        </Group>
      </Panel>
    </Group>
  )
}

function SidebarLayout({ projectId, idPrefix, terminals }: LayoutProps) {
  const [main, ...rest] = terminals
  const listPanelId = `${idPrefix}-side-list`
  const mainPanelId = `${idPrefix}-side-main-${main.id}`
  return (
    <Group
      orientation="horizontal"
      className={styles.fullSize}
      persistenceId={`pane-${idPrefix}-sidebar`}
      panelIds={[listPanelId, mainPanelId]}
    >
      <Panel id={listPanelId} defaultSize="22%" minSize="15%">
        <Group
          orientation="vertical"
          className={styles.fullSize}
          persistenceId={`pane-${idPrefix}-sidebar-list`}
          panelIds={rest.map((terminal) => `${idPrefix}-p-${terminal.id}`)}
        >
          {rest.map((t, i) => (
            <FragmentRow
              key={t.id}
              projectId={projectId}
              idPrefix={idPrefix}
              terminal={t}
              isLast={i === rest.length - 1}
            />
          ))}
        </Group>
      </Panel>
      <Separator className={styles.sepH} />
      <Panel id={mainPanelId} defaultSize="78%" minSize="40%">
        <Pane projectId={projectId} terminal={main} />
      </Panel>
    </Group>
  )
}

function chunkInto<T>(arr: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size))
  }
  return result
}
