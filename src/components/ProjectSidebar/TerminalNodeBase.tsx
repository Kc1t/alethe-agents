import { useDraggable } from '@dnd-kit/core'
import { FileText, MoreHorizontal } from 'lucide-react'

import { useSidebarChatTitle } from '../../hooks/useSidebarChatTitle'
import { useT } from '../../lib/i18n'
import type { AgentType, Project, Terminal } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { Favicon } from '../Favicon'
import { AgentIcon } from '../icons/AgentIcons'
import { DotmCircular2 } from '../ui/dotm-circular-2'

export type TerminalNodeProps = {
  project: Project
  terminal: Terminal
  selected: boolean
  focused?: boolean
  onClick: () => void
  onDoubleClick: () => void
  onMenu: (event: React.MouseEvent) => void
}

type TerminalNodeBaseProps = TerminalNodeProps & {
  styles: Record<string, string>
  menuButtonClass: string
  activitySize: number
  showUnreadCompletion: boolean
}

export function TerminalNodeBase({
  project,
  terminal,
  selected,
  focused,
  onClick,
  onDoubleClick,
  onMenu,
  styles,
  menuButtonClass,
  activitySize,
  showUnreadCompletion,
}: TerminalNodeBaseProps) {
  const t = useT()
  const terminalTheme = useProjectsStore(
    (state) => state.preferences.terminalTheme ?? state.preferences.uiTheme,
  )
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `term:${project.id}:${terminal.id}`,
  })
  const activeTab = terminal.tabs.find((tab) => tab.id === terminal.activeTabId) ?? terminal.tabs[0]
  const chatTitle = useSidebarChatTitle(activeTab)
  const displayName = chatTitle ?? activeTab?.name ?? terminal.name
  const uniqueTypes = Array.from(new Set(terminal.tabs.map((tab) => tab.type))) as AgentType[]
  const orderedTypes =
    activeTab && uniqueTypes.length > 1
      ? [activeTab.type, ...uniqueTypes.filter((type) => type !== activeTab.type)]
      : uniqueTypes
  const hasUnreadCompletion =
    showUnreadCompletion && terminal.tabs.some((tab) => tab.completionUnread)
  const isWorking = useTerminalsStore((state) =>
    terminal.tabs.some((tab) => tab.ptyId && state.byPtyId[tab.ptyId]?.status === 'working'),
  )

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`${styles.terminalRow} ${focused ? styles.terminalFocused : ''} ${
        !selected ? styles.terminalHidden : ''
      } ${terminal.disabled ? styles.terminalDisabled : ''} ${isDragging ? styles.dragging : ''}`}
      onClick={onClick}
      onDoubleClick={(event) => {
        event.stopPropagation()
        onDoubleClick()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onMenu(event)
      }}
      title={terminal.url || terminal.filePath || displayName}
    >
      <span className={styles.agentStack}>
        {terminal.kind === 'web' ? (
          <span className={styles.agentIcon}>
            <Favicon url={terminal.url ?? ''} size={14} />
          </span>
        ) : terminal.kind && terminal.kind !== 'terminal' ? (
          <span className={styles.agentIcon}>
            <FileText size={14} />
          </span>
        ) : (
          orderedTypes.map((type, index) => (
            <span
              key={type}
              className={styles.agentIcon}
              style={{ marginLeft: index === 0 ? 0 : 2, zIndex: orderedTypes.length - index }}
            >
              <AgentIcon type={type} size={14} theme={terminalTheme} />
            </span>
          ))
        )}
      </span>
      <span className={styles.terminalName}>{displayName}</span>
      {terminal.tabs.length > 1 ? (
        <span className={styles.tabCount}>{terminal.tabs.length}</span>
      ) : null}
      <span
        className={`${styles.rowEndSlot} ${isWorking || hasUnreadCompletion ? styles.rowEndSlotActive : ''}`}
      >
        {isWorking ? (
          <DotmCircular2
            size={activitySize}
            dotSize={2}
            cellPadding={1}
            speed={1.2}
            bloom
            ariaLabel={t('ui.terminal.working')}
            className={`${styles.terminalLoading} ${styles.rowStatusIndicator}`}
          />
        ) : hasUnreadCompletion ? (
          <span
            className={`${styles.doneBadge} ${styles.rowStatusIndicator}`}
            title={t('ui.terminal.responseReady')}
          >
            !
          </span>
        ) : null}
        <button
          type="button"
          className={`${menuButtonClass} ${styles.rowEndAction}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onMenu(event)
          }}
          title={t('ui.terminal.moreActions')}
          aria-label={t('ui.terminal.moreActions')}
        >
          <MoreHorizontal size={13} />
        </button>
      </span>
    </div>
  )
}
