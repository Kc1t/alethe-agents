import { useDraggable } from '@dnd-kit/core'
import { UserPlus } from 'lucide-react'

import type { AgentTemplate } from '../../lib/agentLibrary'
import { useT } from '../../lib/i18n'
import styles from './AgentCanvasPOC.module.css'
import { AgentChip } from './AgentChip'

export function LibraryItem({
  template,
  installed,
  onInstall,
}: {
  template: AgentTemplate
  installed: boolean
  onInstall: () => void
}) {
  const t = useT()
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `lib:${template.name}`,
    disabled: installed,
  })
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className={styles.libraryChipWrap}>
      <AgentChip
        name={template.name}
        cost={template.cost}
        summary={template.summary}
        installed={installed}
        draggable={!installed}
        dragging={isDragging}
        action={
          installed ? (
            <span className={styles.libraryInstalledTag}>{t('ws.installed')}</span>
          ) : (
            <button
              type="button"
              className={styles.chipAction}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onInstall}
              title={t('ws.installAgent')}
              aria-label={t('ws.installAgentName', { name: template.name })}
            >
              <UserPlus size={13} />
            </button>
          )
        }
      />
    </div>
  )
}
