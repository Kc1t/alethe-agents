import { MessageSquare, ListChecks, Archive } from 'lucide-react'
import { useState } from 'react'

import { useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import { ChatPanel } from './ChatPanel'
import styles from './CollaborationView.module.css'
import { TasksPanel } from './TasksPanel'
import { VaultPanel } from './VaultPanel'

type CollaborationTab = 'chat' | 'tasks' | 'vault'

export function CollaborationView() {
  const t = useT()
  const projects = useProjectsStore((s) => s.projects)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0]
  const [tab, setTab] = useState<CollaborationTab>('chat')

  return (
    <div className={styles.container}>
      <div className={styles.tabBar}>
        <button
          type="button"
          className={`${styles.tabButton} ${tab === 'chat' ? styles.tabButtonActive : ''}`}
          onClick={() => setTab('chat')}
        >
          <MessageSquare size={14} />
          <span>{t('collaborationView.chatTab')}</span>
        </button>
        <button
          type="button"
          className={`${styles.tabButton} ${tab === 'tasks' ? styles.tabButtonActive : ''}`}
          onClick={() => setTab('tasks')}
        >
          <ListChecks size={14} />
          <span>{t('collaborationView.tasksTab')}</span>
        </button>
        <button
          type="button"
          className={`${styles.tabButton} ${tab === 'vault' ? styles.tabButtonActive : ''}`}
          onClick={() => setTab('vault')}
        >
          <Archive size={14} />
          <span>{t('collaborationView.vaultTab')}</span>
        </button>
      </div>
      <div className={styles.content}>
        {!activeProject ? (
          <div className={styles.empty}>{t('collaborationView.noProject')}</div>
        ) : tab === 'chat' ? (
          <ChatPanel projectId={activeProject.id} />
        ) : tab === 'tasks' ? (
          <TasksPanel projectId={activeProject.id} />
        ) : (
          <VaultPanel projectId={activeProject.id} />
        )}
      </div>
    </div>
  )
}
