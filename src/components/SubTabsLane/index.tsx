import { Plus, X } from 'lucide-react'
import type { ReactNode } from 'react'

import { useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import type { SubTab } from '../../lib/types'
import { AgentIcon } from '../icons/AgentIcons'
import styles from './SubTabsLane.module.css'

export type SubTabsLaneProps = {
  tabs: SubTab[]
  activeTabId: string
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onAdd: () => void
  leadingControl?: ReactNode
}

export function SubTabsLane({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onAdd,
  leadingControl,
}: SubTabsLaneProps) {
  const t = useT()
  const terminalTheme = useProjectsStore(
    (s) => s.preferences.terminalTheme ?? s.preferences.uiTheme,
  )

  return (
    <div className={styles.lane}>
      {leadingControl ? <div className={styles.leadingControl}>{leadingControl}</div> : null}
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId
        return (
          <div key={tab.id} className={`${styles.itemWrap} ${isActive ? styles.active : ''}`}>
            <button
              type="button"
              className={styles.item}
              onClick={() => onActivate(tab.id)}
              title={tab.name || tab.type}
              aria-label={tab.name || tab.type}
            >
              <AgentIcon type={tab.type} size={14} theme={terminalTheme} />
              {tab.completionUnread ? (
                <span className={styles.doneBadge} aria-label={t('ui.terminal.responseReady')}>
                  !
                </span>
              ) : null}
            </button>
            {tabs.length > 1 ? (
              <button
                type="button"
                className={styles.close}
                onClick={(e) => {
                  e.stopPropagation()
                  if (
                    window.confirm(t('ui.subtabs.confirmCloseTab', { name: tab.name || tab.type }))
                  )
                    onClose(tab.id)
                }}
                title={t('ui.subtabs.closeTab')}
                aria-label={t('ui.subtabs.closeTab')}
              >
                <X size={8} />
              </button>
            ) : null}
          </div>
        )
      })}
      <button
        type="button"
        className={styles.add}
        onClick={onAdd}
        title={t('ui.subtabs.newTab')}
        aria-label={t('ui.subtabs.newTab')}
      >
        <Plus size={12} />
      </button>
    </div>
  )
}
